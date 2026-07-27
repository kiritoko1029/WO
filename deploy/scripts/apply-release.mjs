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
import {
  assertExternalIngressUpgradeArguments,
  assertExternalPostgresUpgradeArguments,
  retainExternalUpgradeRollbackResources,
  runExternalDatabaseUpgrade,
} from './external-db-upgrade.mjs';
import { turnNetworkMode } from './lib.mjs';
import { validateRootOwnedDirectoryAncestors } from './preflight.mjs';
import { runtimeComposeImageOverrideSource } from './runtime-compose-override.mjs';
import { productionSmokeAccounts } from './smoke.mjs';
import {
  acquireRollbackImageLeases,
  assertRollbackComposeRuntimeEquivalent,
  captureRollbackImages,
  createRollbackWorkspace,
  releaseRollbackImageLeases,
  releaseRollbackResources,
  rollbackComposeEquivalenceOverrideSource,
  restoreImageTags,
} from './upgrade.mjs';

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

function applyImages(
  envFile,
  profile,
  provenance,
  overrides,
  execute,
  label,
  services = applyServices,
) {
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
      ...services,
    ),
    {
      composeProvenance: provenance,
      label,
      stdio: 'inherit',
    },
  );
}

function stopImages(
  envFile,
  profile,
  provenance,
  execute,
  label,
  services,
  expectedImages,
) {
  const containerIds = runningContainerIds(
    envFile,
    profile,
    provenance,
    execute,
    { label: `${label} target lookup`, services },
  );
  for (const service of services) {
    const containerId = containerIds[service];
    if (!/^[a-f0-9]{64}$/u.test(containerId)) {
      throw new Error(`${service} exact stop target is unavailable`);
    }
    let runningInspection;
    try {
      runningInspection = JSON.parse(
        execute('docker', ['inspect', '--format', '{{json .}}', containerId], {
          label: `${label}: ${service} target inspection`,
        }),
      );
    } catch (error) {
      throw new Error(`${service} stop target inspection is invalid`, {
        cause: error,
      });
    }
    if (
      runningInspection?.Id !== containerId ||
      (expectedImages?.[service]?.containerId !== undefined &&
        expectedImages[service].containerId !== containerId) ||
      (expectedImages?.[service]?.imageId !== undefined &&
        expectedImages[service].imageId !== runningInspection.Image)
    ) {
      throw new Error(`${service} exact stop target identity changed`);
    }
    execute('docker', ['stop', '--time', '30', containerId], {
      label: `${label}: ${service}`,
      stdio: 'inherit',
    });
  }
  const stoppedContainerIds = runningContainerIds(
    envFile,
    profile,
    provenance,
    execute,
    { label: `${label} verification lookup`, services },
  );
  for (const service of services) {
    const containerId = containerIds[service];
    if (stoppedContainerIds[service] !== containerId) {
      throw new Error(`${service} exact stop target changed during quiesce`);
    }
    let inspection;
    try {
      inspection = JSON.parse(
        execute('docker', ['inspect', '--format', '{{json .}}', containerId], {
          label: `${label}: ${service} stopped inspection`,
        }),
      );
    } catch (error) {
      throw new Error(`${service} stopped container inspection is invalid`, {
        cause: error,
      });
    }
    if (
      inspection?.Id !== containerId ||
      inspection?.State?.Running !== false
    ) {
      throw new Error(`${service} exact container did not stop`);
    }
  }
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

function runInternalSmoke(
  envFile,
  environment,
  execute,
  label = 'Post-apply internal smoke',
) {
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
      label,
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

export async function applyExternalDatabaseRelease(
  {
    canonicalRollbackRoot,
    environment,
    execute,
    expectedIngressImageId,
    expectedManifestSha256,
    expectedPostgresMajor,
    expectedPostgresSystemIdentifier,
    ingressContainerId,
    manifestFile,
    postgresAdmin,
    postgresContainerId,
    profile,
    provenance,
    resolvedEnvFile,
  },
  {
    acquireImageLeases = acquireRollbackImageLeases,
    assertRollbackRuntimeEquivalent = assertRollbackComposeRuntimeEquivalent,
    captureImages = captureRollbackImages,
    createWorkspace = createRollbackWorkspace,
    loadReleaseBundle = loadAndVerifyReleaseBundle,
    releaseImageLeases = releaseRollbackImageLeases,
    releaseResources = releaseRollbackResources,
    removeDirectory = rm,
    restoreTags = restoreImageTags,
    runDatabaseUpgrade = runExternalDatabaseUpgrade,
  } = {},
) {
  const selectedServices = applyServices;
  const composeArgumentsForProfile = (selectedEnvFile, ...arguments_) =>
    composeFor(selectedEnvFile, profile, ...arguments_);
  const capturedImages = captureImages(resolvedEnvFile, {
    composeArgumentsForProfile,
    execute,
    selectedServices,
  });
  const rollbackImages = acquireImageLeases(capturedImages, {
    execute,
    selectedServices,
  });
  let rollbackWorkspace;
  try {
    rollbackWorkspace = await createWorkspace(rollbackImages, {
      selectedServices,
      workspaceRoot: canonicalRollbackRoot,
    });
  } catch (error) {
    let cleanupFailed = false;
    let cleanupError;
    try {
      releaseImageLeases(rollbackImages, false, {
        execute,
        selectedServices,
      });
    } catch (caughtCleanupError) {
      cleanupFailed = true;
      cleanupError = caughtCleanupError;
    }
    if (cleanupFailed) {
      throw combineApplyCleanupFailures(
        error,
        cleanupError,
        'External database rollback workspace preparation failed and image lease cleanup was incomplete',
      );
    }
    throw error;
  }

  const { directory: workspace, override: rollbackOverride } =
    rollbackWorkspace;
  let operationFailed = false;
  let operationError;
  let result;
  let retainRollbackResources = false;
  try {
    const rollbackEquivalenceOverride = await writeOverride(
      workspace,
      'rollback-equivalence.compose.yaml',
      rollbackComposeEquivalenceOverrideSource(rollbackImages),
    );
    assertRollbackRuntimeEquivalent(
      resolvedEnvFile,
      rollbackOverride,
      rollbackImages,
      {
        composeArgumentsForProfile,
        composeProvenance: provenance,
        equivalenceOverride: rollbackEquivalenceOverride,
        execute,
      },
    );
    const loadedBundle = await loadReleaseBundle(manifestFile, {
      execute,
      expectedManifestSha256,
    });
    const releaseOverride = await writeOverride(
      workspace,
      'release.compose.yaml',
      releaseImageOverrideSource(loadedBundle.images, selectedServices),
    );
    renderAndValidateRootCompose(
      resolvedEnvFile,
      profile,
      provenance,
      [releaseOverride],
      environment,
      loadedBundle.images,
      execute,
    );
    result = await runDatabaseUpgrade({
      activateServices: ({ label, overrides, services }) =>
        applyImages(
          resolvedEnvFile,
          profile,
          provenance,
          overrides,
          execute,
          label,
          services,
        ),
      assertRunningServices: (images, services) =>
        assertRunningImages(
          resolvedEnvFile,
          profile,
          provenance,
          images,
          execute,
          services,
        ),
      backupRoot: canonicalRollbackRoot,
      applicationRole: environment.POSTGRES_USER,
      databaseName: environment.POSTGRES_DB,
      execute,
      expectedIngressImageId,
      expectedPostgresMajor,
      expectedPostgresSystemIdentifier,
      ingressContainerId,
      postgresAdmin,
      postgresContainerId,
      releaseImages: loadedBundle.images,
      releaseOverride,
      restoreImageTags: (images, services) =>
        restoreTags(images, services, { execute }),
      rollbackImages,
      rollbackOverride,
      runSmoke: (label) =>
        runInternalSmoke(resolvedEnvFile, environment, execute, label),
      stopServices: ({ expectedImages, label, services }) =>
        stopImages(
          resolvedEnvFile,
          profile,
          provenance,
          execute,
          label,
          services,
          expectedImages,
        ),
      workspace,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    retainRollbackResources = retainExternalUpgradeRollbackResources(error);
  }

  let cleanupFailed = false;
  let cleanupError;
  try {
    const removed = await releaseResources(
      workspace,
      rollbackImages,
      retainRollbackResources,
      {
        execute,
        removeDirectory,
        selectedServices,
      },
    );
    if (!removed) {
      process.stderr.write(
        `External database rollback workspace retained: ${workspace}\n`,
      );
    }
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed) {
    if (cleanupFailed) {
      throw combineApplyCleanupFailures(
        operationError,
        cleanupError,
        'External database release failed and rollback resource cleanup was incomplete',
      );
    }
    throw operationError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  return result;
}

export async function applyRelease(
  {
    confirmApply,
    envFile,
    execute = run,
    expectedIngressImageId,
    expectedManifestSha256,
    expectedPostgresMajor,
    expectedPostgresSystemIdentifier,
    externalPostgresAdmin,
    externalPostgresContainerId,
    externalIngressContainerId,
    manifestFile,
    mode,
    profileName,
    rollbackRoot,
  } = {},
  {
    applyExternalRelease = applyExternalDatabaseRelease,
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
  if (!['initial', 'upgrade'].includes(mode)) {
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
  if (mode === 'upgrade' && profile.managesPostgres) {
    throw new Error(
      'Upgrade apply is supported only for the external-db profile; root-managed-db must use the separately verified upgrade workflow',
    );
  }
  const normalizedExpectedPostgresMajor =
    typeof expectedPostgresMajor === 'number'
      ? expectedPostgresMajor
      : Number(expectedPostgresMajor);
  if (
    mode === 'upgrade' &&
    (typeof externalPostgresAdmin !== 'string' ||
      typeof externalPostgresContainerId !== 'string' ||
      typeof externalIngressContainerId !== 'string' ||
      typeof expectedIngressImageId !== 'string' ||
      typeof expectedPostgresSystemIdentifier !== 'string')
  ) {
    throw new Error(
      'External database upgrade requires --external-postgres-container-id, --external-postgres-admin, --expected-postgres-major, --expected-postgres-system-id, --external-ingress-container-id, and --expected-ingress-image-id',
    );
  }
  const resolvedEnvFile = resolve(envFile);
  const environment = loadEnvironment(resolvedEnvFile);
  if (!isAbsolute(environment.DEPLOY_SECRET_DIR?.trim() ?? '')) {
    throw new Error(
      'DEPLOY_SECRET_DIR must be an absolute path before production preflight',
    );
  }
  productionSmokeAccounts(environment);
  if (mode === 'upgrade') {
    assertExternalPostgresUpgradeArguments({
      applicationRole: environment.POSTGRES_USER,
      databaseName: environment.POSTGRES_DB,
      expectedPostgresMajor: normalizedExpectedPostgresMajor,
      expectedPostgresSystemIdentifier,
      postgresAdmin: externalPostgresAdmin,
      postgresContainerId: externalPostgresContainerId,
    });
    assertExternalIngressUpgradeArguments({
      expectedIngressImageId,
      ingressContainerId: externalIngressContainerId,
    });
  }
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
    let backupEvidence;
    if (mode === 'upgrade') {
      const upgradeResult = await applyExternalRelease(
        {
          canonicalRollbackRoot,
          environment,
          execute,
          expectedIngressImageId,
          expectedManifestSha256,
          expectedPostgresMajor: normalizedExpectedPostgresMajor,
          expectedPostgresSystemIdentifier,
          ingressContainerId: externalIngressContainerId,
          manifestFile,
          postgresAdmin: externalPostgresAdmin,
          postgresContainerId: externalPostgresContainerId,
          profile,
          provenance,
          resolvedEnvFile,
        },
        { loadReleaseBundle, removeDirectory },
      );
      backupEvidence = upgradeResult.backupDirectory;
    } else {
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
    }
    process.stdout.write(
      `RELEASE_APPLIED version=${provenance.BUILD_VERSION} revision=${provenance.BUILD_REVISION} profile=${profileName} mode=${mode} activated=${applyServices.join(',')} verified_not_activated=caddy${backupEvidence === undefined ? '' : ` backup=${backupEvidence}`}\n`,
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
    expectedIngressImageId: argumentValue('--expected-ingress-image-id'),
    expectedPostgresMajor: argumentValue('--expected-postgres-major'),
    expectedPostgresSystemIdentifier: argumentValue(
      '--expected-postgres-system-id',
    ),
    externalPostgresAdmin: argumentValue('--external-postgres-admin'),
    externalPostgresContainerId: argumentValue(
      '--external-postgres-container-id',
    ),
    externalIngressContainerId: argumentValue(
      '--external-ingress-container-id',
    ),
    manifestFile: argumentValue('--manifest'),
    mode: argumentValue('--mode'),
    profileName: argumentValue('--profile'),
    rollbackRoot: argumentValue('--rollback-root'),
  }).catch((error) => {
    process.stderr.write(`Release apply failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
