import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  argumentValue,
  deployDirectory,
  deploymentProcessEnvironment,
  failureMessage,
  hasArgument,
  loadDeploymentEnvironment,
  releaseApplyLockDirectoryName,
  rootComposeArguments,
  run,
  sha256File,
} from './ops.mjs';
import {
  loadAndVerifyReleaseBundle,
  readAndVerifyReleaseBundle,
  releaseImageOverrideSource,
} from './release.mjs';
import { turnNetworkMode } from './lib.mjs';
import { validateRootOwnedDirectoryAncestors } from './preflight.mjs';
import { runtimeComposeImageOverrideSource } from './runtime-compose-override.mjs';
import { productionSmokeAccounts } from './smoke.mjs';

const maximumBackupAgeMilliseconds = 4 * 60 * 60 * 1_000;
const applyServices = Object.freeze(['server', 'coturn']);
const rootSecretFiles = Object.freeze({
  jwt_access_secret: 'jwt_access_secret',
  postgres_password: 'postgres_password',
  turn_shared_secret: 'turn_shared_secret',
  turn_tls_cert: 'turn_tls_cert.pem',
  turn_tls_key: 'turn_tls_key.pem',
});
const profiles = Object.freeze({
  'root-managed-db': Object.freeze({
    composeFile: 'docker-compose.yml',
    managesPostgres: true,
  }),
  'external-db': Object.freeze({
    composeFile: 'docker-compose.external-db.yml',
    managesPostgres: false,
  }),
});

export function releaseProfile(name) {
  const profile = profiles[name];
  if (profile === undefined) {
    throw new Error(
      '--profile must be root-managed-db or external-db for this release entrypoint',
    );
  }
  return profile;
}

async function assertSecureRootDirectory(
  directory,
  label,
  {
    ancestorValidator = validateRootOwnedDirectoryAncestors,
    requireRootOwner = process.platform === 'linux',
  } = {},
) {
  if (!isAbsolute(directory)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const ancestorIssues = await ancestorValidator(directory);
  if (ancestorIssues.length > 0) {
    throw new Error(
      `${label} has unsafe ancestors: ${ancestorIssues.join('; ')}`,
    );
  }
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (requireRootOwner && metadata.uid !== 0)
  ) {
    throw new Error(`${label} must be a root-owned 0700 directory`);
  }
  return realpath(directory);
}

function checksumEntryForPostgresDump(source) {
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})[ \t]+[* ]?(.+)$/u.exec(line);
    if (match !== null && resolve('/', match[2]).endsWith('/postgres.dump')) {
      return { file: match[2], sha256: match[1] };
    }
  }
  throw new Error('Backup SHA256SUMS does not contain postgres.dump');
}

export async function assertBackupEvidence(
  directory,
  {
    ancestorValidator,
    now = Date.now(),
    requireRootOwner = process.platform === 'linux',
  } = {},
) {
  const canonicalDirectory = await assertSecureRootDirectory(
    resolve(directory),
    'Backup evidence directory',
    { ancestorValidator, requireRootOwner },
  );
  const dump = resolve(canonicalDirectory, 'postgres.dump');
  const sums = resolve(canonicalDirectory, 'SHA256SUMS');
  for (const [file, label] of [
    [dump, 'PostgreSQL backup'],
    [sums, 'Backup checksum file'],
  ]) {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (now - metadata.mtimeMs > maximumBackupAgeMilliseconds) {
      throw new Error(`${label} must be refreshed within four hours`);
    }
  }
  const dumpMetadata = await stat(dump);
  if (dumpMetadata.size <= 0) {
    throw new Error('PostgreSQL backup is empty');
  }
  const entry = checksumEntryForPostgresDump(await readFile(sums, 'utf8'));
  const referencedDump = isAbsolute(entry.file)
    ? resolve(entry.file)
    : resolve(canonicalDirectory, entry.file);
  if ((await realpath(referencedDump)) !== (await realpath(dump))) {
    throw new Error('Backup SHA256SUMS references a different postgres.dump');
  }
  if ((await sha256File(dump)) !== entry.sha256) {
    throw new Error('PostgreSQL backup checksum mismatch');
  }
  return canonicalDirectory;
}

function composeFor(envFile, profile, ...arguments_) {
  return rootComposeArguments(envFile, profile.composeFile, ...arguments_);
}

function composeOverrideArguments(overrides) {
  return overrides.flatMap((override) => ['-f', override]);
}

function composeNetworkNames(service) {
  return Array.isArray(service?.networks)
    ? service.networks
    : Object.keys(service?.networks ?? {});
}

function rootComposeBoundaryIssues(
  configuration,
  profile,
  environment,
  images,
  expectedPostgresImageId,
) {
  const issues = [];
  const services = configuration?.services;
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    services === null ||
    typeof services !== 'object'
  ) {
    return ['Rendered root Compose configuration is invalid'];
  }
  if (configuration.name !== 'wo') {
    issues.push('Rendered root Compose project name is not wo');
  }
  const expectedServices = profile.managesPostgres
    ? ['coturn', 'postgres', 'server']
    : ['coturn', 'server'];
  if (Object.keys(services).sort().join(',') !== expectedServices.join(',')) {
    issues.push('Rendered root Compose service topology is invalid');
  }

  for (const serviceName of applyServices) {
    const service = services[serviceName] ?? {};
    if (
      service.image !== images[serviceName].imageId ||
      (service.build !== undefined && service.build !== null) ||
      service.pull_policy !== 'never' ||
      service.platform !== 'linux/amd64'
    ) {
      issues.push(
        `Rendered ${serviceName} release image boundary is not immutable`,
      );
    }
  }

  const secretDirectory = environment.DEPLOY_SECRET_DIR?.trim() ?? '';
  const secrets = configuration.secrets;
  if (
    !isAbsolute(secretDirectory) ||
    secrets === null ||
    typeof secrets !== 'object' ||
    Object.keys(secrets).sort().join(',') !==
      Object.keys(rootSecretFiles).sort().join(',')
  ) {
    issues.push(
      'Rendered root Compose secrets do not use the absolute preflight directory',
    );
  } else {
    for (const [secretName, fileName] of Object.entries(rootSecretFiles)) {
      if (secrets[secretName]?.file !== resolve(secretDirectory, fileName)) {
        issues.push(
          `Rendered ${secretName} does not use the absolute preflight directory`,
        );
      }
    }
  }

  const server = services.server ?? {};
  const serverPorts = Array.isArray(server.ports) ? server.ports : [];
  if (
    serverPorts.length === 0 ||
    serverPorts.some(
      ({ host_ip: hostIp }) => !['127.0.0.1', '::1'].includes(hostIp),
    )
  ) {
    issues.push('Rendered server port boundary is not loopback-only');
  }
  if (profile.managesPostgres) {
    if (
      services.postgres === undefined ||
      services.postgres.platform !== 'linux/amd64' ||
      server.depends_on?.postgres?.condition !== 'service_healthy' ||
      server.environment?.POSTGRES_HOST !== 'postgres'
    ) {
      issues.push('Rendered root-managed PostgreSQL boundary is invalid');
    }
    if (
      expectedPostgresImageId !== undefined &&
      (services.postgres.image !== expectedPostgresImageId ||
        (services.postgres.build !== undefined &&
          services.postgres.build !== null) ||
        services.postgres.pull_policy !== 'never')
    ) {
      issues.push('Rendered PostgreSQL image boundary is not immutable');
    }
  } else {
    if (
      services.postgres !== undefined ||
      server.depends_on?.postgres !== undefined
    ) {
      issues.push('Rendered external database profile includes PostgreSQL');
    }
    for (const [field, fallback] of [
      ['POSTGRES_DB', ''],
      ['POSTGRES_HOST', ''],
      ['POSTGRES_PORT', '5432'],
      ['POSTGRES_USER', ''],
    ]) {
      const expected = environment[field]?.trim() || fallback;
      if (String(server.environment?.[field] ?? '') !== expected) {
        issues.push(
          `Rendered external database ${field} differs from the selected env file`,
        );
      }
    }
  }

  const coturn = services.coturn ?? {};
  for (const [field, expected] of [
    ['TURN_EXTERNAL_IP', environment.PUBLIC_IPV4],
    ['TURN_REALM', environment.TURN_REALM],
    ['TURN_RELAY_MIN_PORT', environment.TURN_RELAY_MIN_PORT],
    ['TURN_RELAY_MAX_PORT', environment.TURN_RELAY_MAX_PORT],
  ]) {
    if (String(coturn.environment?.[field] ?? '') !== expected) {
      issues.push(
        `Rendered coturn ${field} differs from the selected env file`,
      );
    }
  }
  const hostMode = turnNetworkMode(environment) === 'host';
  const networks = composeNetworkNames(coturn);
  if (hostMode) {
    const stateVolume = (coturn.volumes ?? []).find(
      ({ target }) => target === '/var/lib/coturn',
    );
    if (
      coturn.network_mode !== 'host' ||
      (coturn.ports ?? []).length !== 0 ||
      networks.length !== 0 ||
      coturn.environment?.TURN_INTERNAL_IP !== environment.TURN_INTERNAL_IP ||
      String(coturn.environment?.TURN_LISTEN_PORT) !== environment.TURN_PORT ||
      String(coturn.environment?.TURN_TLS_LISTEN_PORT) !==
        environment.TURN_TLS_PORT ||
      (coturn.volumes ?? []).length !== 1 ||
      stateVolume?.type !== 'bind' ||
      stateVolume?.source !== environment.TURN_STATE_EMPTY_DIR ||
      stateVolume?.read_only !== true
    ) {
      issues.push('Rendered coturn host-network boundary is invalid');
    }
  } else if (
    coturn.network_mode === 'host' ||
    (coturn.ports ?? []).length === 0 ||
    (coturn.ports ?? []).some(({ host_ip: hostIp }) => hostIp !== '0.0.0.0') ||
    !networks.includes('turn_edge') ||
    (coturn.environment?.TURN_INTERNAL_IP ?? '') !== ''
  ) {
    issues.push('Rendered coturn bridge-network boundary is invalid');
  }
  return issues;
}

function renderAndValidateRootCompose(
  envFile,
  profile,
  provenance,
  overrides,
  environment,
  images,
  execute,
  expectedPostgresImageId,
) {
  const source = execute(
    'docker',
    composeFor(
      envFile,
      profile,
      ...composeOverrideArguments(overrides),
      'config',
      '--format',
      'json',
    ),
    {
      composeProvenance: provenance,
      label: 'Release Compose validation',
    },
  );
  let configuration;
  try {
    configuration = JSON.parse(source);
  } catch {
    throw new Error('Rendered root Compose configuration is not valid JSON');
  }
  const issues = rootComposeBoundaryIssues(
    configuration,
    profile,
    environment,
    images,
    expectedPostgresImageId,
  );
  if (issues.length > 0) {
    throw new Error(`Root Compose preflight failed: ${issues.join('; ')}`);
  }
  return configuration;
}

function localPostgresImageId(configuration, execute) {
  const reference = configuration.services?.postgres?.image;
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new Error('Rendered PostgreSQL image reference is unavailable');
  }
  const imageId = execute(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', reference],
    { label: 'PostgreSQL image prerequisite' },
  ).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
    throw new Error(
      'The configured PostgreSQL image must already exist locally as an immutable image ID',
    );
  }
  return imageId;
}

function runningContainerIds(
  envFile,
  profile,
  provenance,
  execute,
  { label = 'container lookup', services = applyServices } = {},
) {
  return Object.fromEntries(
    services.map((service) => [
      service,
      execute(
        'docker',
        composeFor(envFile, profile, 'ps', '--all', '-q', service),
        {
          composeProvenance: provenance,
          label: `${service} ${label}`,
        },
      ).trim(),
    ]),
  );
}

export function validateApplyModeState(mode, containerIds) {
  if (!['initial', 'upgrade'].includes(mode)) {
    throw new Error('--mode must be initial or upgrade');
  }
  const present = applyServices.filter(
    (service) => (containerIds?.[service] ?? '').length > 0,
  );
  if (mode === 'initial' && present.length > 0) {
    throw new Error(
      'Initial apply requires both release services to be absent',
    );
  }
  if (mode === 'upgrade' && present.length !== applyServices.length) {
    throw new Error('Upgrade apply requires both release services to exist');
  }
}

function inspectActivatedContainer(
  containerId,
  service,
  expectedImageId,
  execute,
) {
  const source = execute(
    'docker',
    ['inspect', '--format', '{{json .}}', containerId],
    { label: `${service} activated container inspection` },
  ).trim();
  let inspection;
  try {
    inspection = JSON.parse(source);
  } catch {
    throw new Error(`${service} activated container inspection is invalid`);
  }
  if (
    inspection === null ||
    typeof inspection !== 'object' ||
    inspection.State?.Running !== true
  ) {
    throw new Error(`${service} activated container is not running`);
  }
  const healthStatus = inspection.State?.Health?.Status;
  if (healthStatus !== 'healthy') {
    throw new Error(
      `${service} activated container health status is ${healthStatus ?? 'unavailable'}, not healthy`,
    );
  }
  if (expectedImageId !== undefined && inspection.Image !== expectedImageId) {
    throw new Error(
      `${service} running container does not use the verified image ID`,
    );
  }
}

function assertRunningImages(
  envFile,
  profile,
  provenance,
  images,
  execute,
  services = applyServices,
) {
  const containerIds = runningContainerIds(
    envFile,
    profile,
    provenance,
    execute,
    { label: 'activated container lookup', services },
  );
  for (const service of services) {
    if (containerIds[service].length === 0) {
      throw new Error(`${service} activated container is unavailable`);
    }
    inspectActivatedContainer(
      containerIds[service],
      service,
      images?.[service]?.imageId,
      execute,
    );
  }
}

function applyImages(envFile, profile, provenance, overrides, execute, label) {
  execute(
    'docker',
    composeFor(
      envFile,
      profile,
      ...composeOverrideArguments(overrides),
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      '--wait',
      '--no-build',
      '--pull',
      'never',
      ...applyServices,
    ),
    {
      composeProvenance: provenance,
      label,
      stdio: 'inherit',
    },
  );
}

function bootstrapPostgres(envFile, profile, provenance, overrides, execute) {
  execute(
    'docker',
    composeFor(
      envFile,
      profile,
      ...composeOverrideArguments(overrides),
      'up',
      '-d',
      '--no-deps',
      '--wait',
      '--no-build',
      '--pull',
      'never',
      'postgres',
    ),
    {
      composeProvenance: provenance,
      label: 'PostgreSQL bootstrap',
      stdio: 'inherit',
    },
  );
}

function runProductionPreflight(envFile, execute) {
  execute(
    process.execPath,
    [
      resolve(import.meta.dirname, 'preflight.mjs'),
      `--env-file=${envFile}`,
      '--allow-running',
    ],
    {
      env: deploymentProcessEnvironment({}, process.env),
      label: 'Production preflight',
      stdio: 'inherit',
    },
  );
}

function runInternalSmoke(envFile, environment, execute) {
  const port = environment.WO_HTTP_PORT?.trim() || '18080';
  if (!/^[0-9]+$/u.test(port)) {
    throw new Error('WO_HTTP_PORT is invalid');
  }
  execute(
    process.execPath,
    [
      resolve(import.meta.dirname, 'smoke.mjs'),
      `--env-file=${envFile}`,
      `--base-url=http://127.0.0.1:${port}`,
    ],
    {
      env: deploymentProcessEnvironment({}, process.env),
      label: 'Post-apply internal smoke',
      stdio: 'inherit',
    },
  );
}

function cleanupInitialActivation(
  envFile,
  profile,
  provenance,
  overrides,
  postgresExisted,
  execute,
) {
  const cleanupErrors = [];
  const services = [
    ...applyServices,
    ...(profile.managesPostgres && !postgresExisted ? ['postgres'] : []),
  ];
  for (const service of services) {
    try {
      execute(
        'docker',
        composeFor(
          envFile,
          profile,
          ...composeOverrideArguments(overrides),
          'rm',
          '--stop',
          '--force',
          service,
        ),
        {
          composeProvenance: provenance,
          label: `${service} initial cleanup`,
          stdio: 'inherit',
        },
      );
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `${service} initial cleanup failed: ${failureMessage(error)}`,
          { cause: error },
        ),
      );
    }
    try {
      const remainingContainerId = runningContainerIds(
        envFile,
        profile,
        provenance,
        execute,
        {
          label: 'post-cleanup container lookup',
          services: [service],
        },
      )[service];
      if (remainingContainerId.length > 0) {
        throw new Error(`${service} container remains after cleanup`);
      }
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `${service} initial cleanup verification failed: ${failureMessage(error)}`,
          { cause: error },
        ),
      );
    }
  }
  return cleanupErrors;
}

async function writeOverride(directory, name, source) {
  const file = resolve(directory, name);
  await writeFile(file, source, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return file;
}

async function recordFailure(directory, status) {
  try {
    await writeFile(
      resolve(directory, 'result.json'),
      `${JSON.stringify({ status }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch {
    // The original activation or cleanup failure remains authoritative.
  }
}

async function acquireReleaseApplyLock(lockRoot) {
  const lockDirectory = resolve(lockRoot, releaseApplyLockDirectoryName);
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `Release apply lock already exists; confirm that no apply, backup, restore, or upgrade is running before removing ${lockDirectory}`,
        { cause: error },
      );
    }
    throw error;
  }
  return lockDirectory;
}

function combineApplyCleanupFailures(primaryError, cleanupError, message) {
  return new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
}

export async function applyRelease(
  {
    confirmApply,
    envFile,
    execute = run,
    expectedManifestSha256,
    manifestFile,
    mode,
    profileName,
    rollbackRoot,
  } = {},
  {
    assertRollbackRoot = assertSecureRootDirectory,
    loadEnvironment = loadDeploymentEnvironment,
    loadReleaseBundle = loadAndVerifyReleaseBundle,
    operationLockRoot = deployDirectory,
    readReleaseBundle = readAndVerifyReleaseBundle,
    removeDirectory = rm,
  } = {},
) {
  if (!confirmApply) {
    throw new Error('--confirm-apply is required');
  }
  if (mode === 'upgrade') {
    throw new Error(
      'Upgrade apply is disabled until transactional database preflight and rollback are implemented; image restoration alone is not a safe rollback',
    );
  }
  if (mode !== 'initial') {
    throw new Error('--mode must be initial or upgrade');
  }
  if (
    typeof manifestFile !== 'string' ||
    typeof expectedManifestSha256 !== 'string' ||
    typeof envFile !== 'string' ||
    typeof rollbackRoot !== 'string'
  ) {
    throw new Error(
      '--manifest, --expected-manifest-sha256, --env-file, and --rollback-root are required',
    );
  }
  const profile = releaseProfile(profileName);
  const resolvedEnvFile = resolve(envFile);
  const environment = loadEnvironment(resolvedEnvFile);
  if (!isAbsolute(environment.DEPLOY_SECRET_DIR?.trim() ?? '')) {
    throw new Error(
      'DEPLOY_SECRET_DIR must be an absolute path before production preflight',
    );
  }
  productionSmokeAccounts(environment);
  const canonicalRollbackRoot = await assertRollbackRoot(
    resolve(rollbackRoot),
    'Rollback root',
  );
  const lockDirectory = await acquireReleaseApplyLock(operationLockRoot);
  let applyError;
  let applyFailed = false;
  try {
    const verifiedBundle = await readReleaseBundle(manifestFile, {
      expectedManifestSha256,
    });
    const provenance = verifiedBundle.manifest.provenance;
    runProductionPreflight(resolvedEnvFile, execute);
    const previousContainerIds = runningContainerIds(
      resolvedEnvFile,
      profile,
      provenance,
      execute,
      { label: 'existing container lookup' },
    );
    validateApplyModeState(mode, previousContainerIds);
    const postgresExisted = profile.managesPostgres
      ? runningContainerIds(resolvedEnvFile, profile, provenance, execute, {
          label: 'existing container lookup',
          services: ['postgres'],
        }).postgres.length > 0
      : false;
    const loadedBundle = await loadReleaseBundle(manifestFile, {
      execute,
      expectedManifestSha256,
    });

    const workspace = await mkdtemp(
      resolve(canonicalRollbackRoot, 'wo-release-apply-'),
    );
    let activationAttempted = false;
    let overrides = [];
    try {
      await chmod(workspace, 0o700);
      const releaseOverride = await writeOverride(
        workspace,
        'release.compose.yaml',
        releaseImageOverrideSource(loadedBundle.images, applyServices),
      );
      overrides = [releaseOverride];
      const rootConfiguration = renderAndValidateRootCompose(
        resolvedEnvFile,
        profile,
        provenance,
        overrides,
        environment,
        loadedBundle.images,
        execute,
      );
      const postgresImageId =
        profile.managesPostgres && !postgresExisted
          ? localPostgresImageId(rootConfiguration, execute)
          : undefined;
      if (postgresImageId !== undefined) {
        const postgresOverride = await writeOverride(
          workspace,
          'postgres.compose.yaml',
          runtimeComposeImageOverrideSource('postgres', postgresImageId),
        );
        overrides.push(postgresOverride);
        renderAndValidateRootCompose(
          resolvedEnvFile,
          profile,
          provenance,
          overrides,
          environment,
          loadedBundle.images,
          execute,
          postgresImageId,
        );
      }

      if (profile.managesPostgres) {
        if (!postgresExisted) {
          activationAttempted = true;
          bootstrapPostgres(
            resolvedEnvFile,
            profile,
            provenance,
            overrides,
            execute,
          );
        }
        assertRunningImages(
          resolvedEnvFile,
          profile,
          provenance,
          postgresImageId === undefined
            ? undefined
            : { postgres: { imageId: postgresImageId } },
          execute,
          ['postgres'],
        );
      }
      activationAttempted = true;
      applyImages(
        resolvedEnvFile,
        profile,
        provenance,
        overrides,
        execute,
        'Release activation',
      );
      assertRunningImages(
        resolvedEnvFile,
        profile,
        provenance,
        loadedBundle.images,
        execute,
      );
      runInternalSmoke(resolvedEnvFile, environment, execute);
    } catch (error) {
      if (!activationAttempted) {
        try {
          await removeDirectory(workspace, { force: true, recursive: true });
        } catch (cleanupError) {
          throw combineApplyCleanupFailures(
            error,
            cleanupError,
            `Initial release apply failed before activation and workspace cleanup was incomplete: ${workspace}`,
          );
        }
        throw error;
      }
      const cleanupErrors = cleanupInitialActivation(
        resolvedEnvFile,
        profile,
        provenance,
        overrides,
        postgresExisted,
        execute,
      );
      if (cleanupErrors.length > 0) {
        await recordFailure(workspace, 'cleanup-incomplete');
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Initial release apply failed and cleanup was incomplete; workspace retained at ${workspace}`,
          { cause: error },
        );
      }
      await recordFailure(workspace, 'initial-apply-cleaned');
      throw new Error(
        `Initial release apply failed; activated containers were removed and workspace retained at ${workspace}: ${failureMessage(error)}`,
        { cause: error },
      );
    }

    await removeDirectory(workspace, { force: true, recursive: true });
    process.stdout.write(
      `RELEASE_APPLIED version=${provenance.BUILD_VERSION} revision=${provenance.BUILD_REVISION} profile=${profileName} mode=${mode} activated=${applyServices.join(',')} verified_not_activated=caddy\n`,
    );
  } catch (error) {
    applyFailed = true;
    applyError = error;
  }
  try {
    await removeDirectory(lockDirectory, { force: true, recursive: true });
  } catch (cleanupError) {
    if (applyFailed) {
      throw combineApplyCleanupFailures(
        applyError,
        cleanupError,
        `Release apply failed and lock cleanup was incomplete: ${lockDirectory}`,
      );
    }
    throw cleanupError;
  }
  if (applyFailed) {
    throw applyError;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  applyRelease({
    confirmApply: hasArgument('--confirm-apply'),
    envFile: argumentValue('--env-file'),
    expectedManifestSha256: argumentValue('--expected-manifest-sha256'),
    manifestFile: argumentValue('--manifest'),
    mode: argumentValue('--mode'),
    profileName: argumentValue('--profile'),
    rollbackRoot: argumentValue('--rollback-root'),
  }).catch((error) => {
    process.stderr.write(`Release apply failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
