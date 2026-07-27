import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runBackup } from './backup.mjs';
import {
  argumentValue,
  composeArguments,
  deploymentOperationProcessEnvironment,
  deployDirectory,
  failureMessage,
  loadDeploymentEnvironment,
  run,
  withDeploymentOperationLock,
} from './ops.mjs';
import {
  validateRootOwnedDirectoryAncestors,
  validateTurnStateEmptyDirectory,
} from './preflight.mjs';
import {
  deriveReleaseProvenance,
  validateImageProvenance,
} from './provenance.mjs';
import { releaseImageOverrideSource, releaseServices } from './release.mjs';

export { releaseImageOverrideSource };

const services = Object.freeze(['caddy', 'server', 'postgres', 'coturn']);
const rollbackTurnEnvironmentFields = Object.freeze([
  'TURN_EXTERNAL_IP',
  'TURN_INTERNAL_IP',
  'TURN_LISTEN_PORT',
  'TURN_REALM',
  'TURN_RELAY_MAX_PORT',
  'TURN_RELAY_MIN_PORT',
  'TURN_TLS_LISTEN_PORT',
]);
const rollbackTurnMountTargets = new Set([
  '/etc/coturn/turnserver.wo.conf',
  '/opt/wo/turn-entrypoint.sh',
  '/var/lib/coturn',
]);
const rollbackTurnVolumeAlias = 'coturn_rollback_state';
const rollbackTurnConfigSnapshotNames = new Map([
  ['/etc/coturn/turnserver.wo.conf', 'turnserver.rollback.conf'],
  ['/opt/wo/turn-entrypoint.sh', 'turn-entrypoint.rollback.sh'],
]);
const immutableImageReferencePattern =
  /^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/u;
const rollbackImageLeasePattern =
  /^wo-rollback-lease:[a-z0-9][a-z0-9_.-]{0,127}$/u;

function rollbackServiceSelection(selectedServices) {
  if (!Array.isArray(selectedServices) || selectedServices.length === 0) {
    throw new Error('Rollback service selection must not be empty');
  }
  const selected = [];
  const seen = new Set();
  for (const service of selectedServices) {
    if (!services.includes(service)) {
      throw new Error(`Rollback service selection includes ${service}`);
    }
    if (seen.has(service)) {
      throw new Error(`Rollback service selection repeats ${service}`);
    }
    seen.add(service);
    selected.push(service);
  }
  return selected;
}

export function postgresMajorFromImage(image) {
  const match = /^postgres:([0-9]+)(?:[.-]|$)/u.exec(image);
  if (match === null) {
    throw new Error(`Cannot determine PostgreSQL major from image ${image}`);
  }
  return Number(match[1]);
}

export function assertPostgresMajorUnchanged(envFile) {
  const configuration = JSON.parse(
    run('docker', composeArguments(envFile, 'config', '--format', 'json'), {
      label: 'Compose config',
    }),
  );
  const desiredImage = configuration.services?.postgres?.image;
  if (typeof desiredImage !== 'string') {
    throw new Error('Rendered Compose has no PostgreSQL image');
  }
  const containerId = run(
    'docker',
    composeArguments(envFile, 'ps', '-q', 'postgres'),
    { label: 'PostgreSQL container lookup' },
  ).trim();
  if (containerId.length === 0) {
    throw new Error('PostgreSQL must be running before upgrade');
  }
  const currentEnvironment = run(
    'docker',
    [
      'inspect',
      '--format',
      '{{range .Config.Env}}{{println .}}{{end}}',
      containerId,
    ],
    { label: 'PostgreSQL version inspection' },
  );
  const currentMatch = /^PG_MAJOR=([0-9]+)$/mu.exec(currentEnvironment);
  if (currentMatch === null) {
    throw new Error('Running PostgreSQL image has no PG_MAJOR metadata');
  }
  const currentMajor = Number(currentMatch[1]);
  const desiredMajor = postgresMajorFromImage(desiredImage);
  if (currentMajor !== desiredMajor) {
    throw new Error(
      `PostgreSQL major upgrade ${currentMajor} -> ${desiredMajor} requires a separate migration`,
    );
  }
}

export function captureRollbackImages(
  envFile,
  {
    composeArgumentsForProfile = composeArguments,
    execute = run,
    selectedServices = services,
  } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  return Object.fromEntries(
    rollbackServices.map((service) => {
      const containerId = execute(
        'docker',
        composeArgumentsForProfile(envFile, 'ps', '--all', '-q', service),
        { label: `${service} container lookup` },
      ).trim();
      if (!/^[a-f0-9]{64}$/u.test(containerId)) {
        throw new Error(`${service} must be running before upgrade`);
      }
      let inspection;
      try {
        inspection = JSON.parse(
          execute(
            'docker',
            ['inspect', '--format', '{{json .}}', containerId],
            { label: `${service} rollback container inspection` },
          ),
        );
      } catch (error) {
        throw new Error(`${service} rollback container inspection is invalid`, {
          cause: error,
        });
      }
      const labels = inspection?.Config?.Labels;
      const imageId = inspection?.Image;
      const imageReference = inspection?.Config?.Image;
      const composeConfigHash = labels?.['com.docker.compose.config-hash'];
      if (
        inspection?.Id !== containerId ||
        inspection?.State?.Running !== true ||
        !/^sha256:[a-f0-9]{64}$/u.test(imageId) ||
        typeof imageReference !== 'string' ||
        imageReference.length === 0 ||
        labels?.['com.docker.compose.project'] !== 'wo' ||
        labels?.['com.docker.compose.service'] !== service ||
        labels?.['com.docker.compose.oneoff'] !== 'False' ||
        labels?.['com.docker.compose.container-number'] !== '1' ||
        !/^[a-f0-9]{64}$/u.test(composeConfigHash ?? '')
      ) {
        throw new Error(
          `${service} rollback container and Compose boundary cannot be pinned safely`,
        );
      }
      let imageInspection;
      try {
        const imageInspections = JSON.parse(
          execute('docker', ['image', 'inspect', imageId], {
            label: `${service} rollback image inspection`,
          }),
        );
        if (!Array.isArray(imageInspections) || imageInspections.length !== 1) {
          throw new Error('Rollback image inspection must return one image');
        }
        [imageInspection] = imageInspections;
      } catch (error) {
        throw new Error(`${service} rollback image inspection is invalid`, {
          cause: error,
        });
      }
      if (
        imageInspection?.Id !== imageId ||
        imageInspection?.Os !== 'linux' ||
        imageInspection?.Architecture !== 'amd64'
      ) {
        throw new Error(
          `${service} rollback image identity and platform cannot be pinned safely`,
        );
      }
      return [
        service,
        {
          architecture: imageInspection.Architecture,
          composeConfigHash,
          containerId,
          imageId,
          imageReference,
          os: imageInspection.Os,
        },
      ];
    }),
  );
}

function rollbackImageLeaseReference(service) {
  return `wo-rollback-lease:${service}-${randomUUID()}`;
}

function removeRollbackImageLeaseTags(images, selectedServices, execute) {
  const errors = [];
  for (const service of [...selectedServices].reverse()) {
    const leaseReference = images[service]?.leaseReference;
    if (
      typeof leaseReference !== 'string' ||
      !rollbackImageLeasePattern.test(leaseReference)
    ) {
      errors.push(
        new Error(`${service} rollback image lease reference is invalid`),
      );
      continue;
    }
    try {
      execute('docker', ['image', 'rm', leaseReference], {
        label: `${service} rollback image lease release`,
        stdio: 'inherit',
      });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function acquireRollbackImageLeases(
  images,
  {
    execute = run,
    leaseReferenceFactory = rollbackImageLeaseReference,
    selectedServices = services,
  } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  const acquiredServices = [];
  const leasedImages = {};
  const leaseReferences = new Set();

  try {
    for (const service of rollbackServices) {
      const image = images[service];
      if (
        image === undefined ||
        !/^sha256:[a-f0-9]{64}$/u.test(image.imageId)
      ) {
        throw new Error(`${service} rollback image ID is invalid`);
      }
      const leaseReference = leaseReferenceFactory(service);
      if (
        typeof leaseReference !== 'string' ||
        !rollbackImageLeasePattern.test(leaseReference) ||
        leaseReferences.has(leaseReference)
      ) {
        throw new Error(`${service} rollback image lease reference is invalid`);
      }
      execute('docker', ['image', 'tag', image.imageId, leaseReference], {
        label: `${service} rollback image lease acquisition`,
        stdio: 'inherit',
      });
      leaseReferences.add(leaseReference);
      acquiredServices.push(service);
      leasedImages[service] = { ...image, leaseReference };
    }
  } catch (error) {
    const cleanupErrors = removeRollbackImageLeaseTags(
      leasedImages,
      acquiredServices,
      execute,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Rollback image lease acquisition failed and cleanup was incomplete',
        { cause: error },
      );
    }
    throw error;
  }

  return leasedImages;
}

export function releaseRollbackImageLeases(
  images,
  retain,
  { execute = run, selectedServices = services } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  if (retain) {
    return false;
  }
  const cleanupErrors = removeRollbackImageLeaseTags(
    images,
    rollbackServices,
    execute,
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Rollback image lease cleanup was incomplete',
      { cause: cleanupErrors[0] },
    );
  }
  return true;
}

export async function createRollbackOverride(
  directory,
  images,
  {
    boundaryCapture = captureCoturnRollbackBoundary,
    mountSnapshotter = snapshotCoturnRollbackMounts,
    mountValidator = validateCoturnRollbackMountSources,
    selectedServices = services,
  } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  let coturnBoundary;
  if (rollbackServices.includes('coturn')) {
    coturnBoundary = boundaryCapture(images.coturn.containerId);
    await mountValidator(coturnBoundary.mounts, {
      hostMode: coturnBoundary.hostMode,
    });
    const rollbackMounts = await mountSnapshotter(
      directory,
      coturnBoundary.mounts,
    );
    coturnBoundary = { ...coturnBoundary, mounts: rollbackMounts };
  }
  const file = resolve(directory, 'rollback.compose.yaml');
  await writeFile(
    file,
    rollbackOverrideSource(images, coturnBoundary, {
      selectedServices: rollbackServices,
    }),
    {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    },
  );
  return file;
}

function metadataFailureCode(error) {
  try {
    return typeof error?.code === 'string' && error.code.length > 0
      ? error.code
      : 'invalid metadata';
  } catch {
    return 'invalid metadata';
  }
}

export async function validateCoturnRollbackMountSources(
  mounts,
  {
    ancestorValidator = validateRootOwnedDirectoryAncestors,
    expectedUid = 0,
    hostMode = false,
    hostStateValidator = validateTurnStateEmptyDirectory,
    metadataLookup = lstat,
  } = {},
) {
  for (const mount of mounts) {
    if (mount.type !== 'bind') {
      continue;
    }
    if (mount.target === '/var/lib/coturn') {
      if (hostMode) {
        const issues = await hostStateValidator(mount.source, {
          expectedUid,
          metadataLookup,
        });
        if (issues.length > 0) {
          throw new Error(
            `coturn host rollback state source is unsafe: ${issues.join('; ')}`,
          );
        }
      } else {
        try {
          const metadata = await metadataLookup(mount.source);
          const ancestorIssues = await ancestorValidator(mount.source, {
            expectedUid,
            metadataLookup,
          });
          if (
            metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            ancestorIssues.length > 0
          ) {
            throw new Error('unsafe metadata');
          }
        } catch (error) {
          throw new Error(
            `coturn bridge rollback state source is unsafe (${metadataFailureCode(error)})`,
            { cause: error },
          );
        }
      }
      continue;
    }

    try {
      const metadata = await metadataLookup(mount.source);
      const ancestorIssues = await ancestorValidator(mount.source, {
        expectedUid,
        metadataLookup,
      });
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.uid !== expectedUid ||
        (metadata.mode & 0o022) !== 0 ||
        ancestorIssues.length > 0
      ) {
        throw new Error('unsafe metadata');
      }
    } catch (error) {
      throw new Error(
        `coturn rollback config source is unsafe: ${mount.target} (${metadataFailureCode(error)})`,
        { cause: error },
      );
    }
  }
}

async function snapshotCoturnRollbackMounts(directory, mounts) {
  return Promise.all(
    mounts.map(async (mount) => {
      if (mount.type !== 'bind' || mount.target === '/var/lib/coturn') {
        return mount;
      }
      const snapshotName = rollbackTurnConfigSnapshotNames.get(mount.target);
      if (snapshotName === undefined) {
        throw new Error(
          `coturn rollback config snapshot target is unsupported: ${mount.target}`,
        );
      }
      const snapshot = resolve(directory, snapshotName);
      await copyFile(mount.source, snapshot);
      await chmod(snapshot, 0o600);
      return { ...mount, source: snapshot };
    }),
  );
}

export async function createRollbackWorkspace(
  images,
  {
    createOverride = createRollbackOverride,
    makeTemporaryDirectory = mkdtemp,
    removeDirectory = rm,
    selectedServices = services,
    workspaceRoot = tmpdir(),
  } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  const directory = await makeTemporaryDirectory(
    resolve(workspaceRoot, 'wo-upgrade-'),
  );
  try {
    return {
      directory,
      override: await createOverride(directory, images, {
        selectedServices: rollbackServices,
      }),
    };
  } catch (error) {
    let cleanupFailed = false;
    let cleanupError;
    try {
      await removeDirectory(directory, { force: true, recursive: true });
    } catch (caughtCleanupError) {
      cleanupFailed = true;
      cleanupError = caughtCleanupError;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        [error, cleanupError],
        'Rollback workspace preparation failed and cleanup was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function releaseRollbackWorkspace(
  directory,
  retain,
  { removeDirectory = rm } = {},
) {
  if (retain) {
    return false;
  }
  await removeDirectory(directory, { force: true, recursive: true });
  return true;
}

export async function releaseRollbackResources(
  directory,
  images,
  retain,
  { execute = run, removeDirectory = rm, selectedServices = services } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  const removed = await releaseRollbackWorkspace(directory, retain, {
    removeDirectory,
  });
  if (!removed) {
    return false;
  }
  releaseRollbackImageLeases(images, false, {
    execute,
    selectedServices: rollbackServices,
  });
  return true;
}

export function combineUpgradeCleanupFailures(upgradeError, cleanupError) {
  return new AggregateError(
    [upgradeError, cleanupError],
    `Upgrade failed (${failureMessage(upgradeError)}); rollback resource cleanup also failed (${failureMessage(cleanupError)})`,
    { cause: upgradeError },
  );
}

export function throwUpgradeCleanupFailures({
  cleanupError,
  cleanupFailed,
  upgradeError,
  upgradeFailed,
}) {
  if (upgradeFailed) {
    if (cleanupFailed) {
      throw combineUpgradeCleanupFailures(upgradeError, cleanupError);
    }
    throw upgradeError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

function inspectedEnvironment(entries) {
  return Object.fromEntries(
    (entries ?? []).flatMap((entry) => {
      const separator = entry.indexOf('=');
      return separator > 0
        ? [[entry.slice(0, separator), entry.slice(separator + 1)]]
        : [];
    }),
  );
}

export function normalizeCoturnPortBindings(portBindings) {
  const ports = [];
  for (const [targetAndProtocol, bindings] of Object.entries(
    portBindings ?? {},
  )) {
    const match = /^([0-9]+)\/(tcp|udp)$/u.exec(targetAndProtocol);
    if (match === null || !Array.isArray(bindings)) {
      throw new Error('Running coturn has an invalid port binding');
    }
    for (const binding of bindings) {
      if (
        !/^[0-9]+$/u.test(binding.HostPort ?? '') ||
        typeof binding.HostIp !== 'string'
      ) {
        throw new Error('Running coturn has an invalid host port binding');
      }
      ports.push({
        hostIp: binding.HostIp,
        protocol: match[2],
        published: Number(binding.HostPort),
        target: Number(match[1]),
      });
    }
  }
  return ports.sort(
    (left, right) =>
      left.target - right.target ||
      left.protocol.localeCompare(right.protocol) ||
      left.published - right.published ||
      left.hostIp.localeCompare(right.hostIp),
  );
}

export function normalizeCoturnRollbackMounts(mounts, hostMode) {
  if (!Array.isArray(mounts)) {
    throw new Error('Running coturn mounts are unavailable');
  }
  const normalized = [];
  const destinations = new Set();
  for (const mount of mounts) {
    const destination = mount?.Destination;
    if (typeof destination !== 'string' || destination.length === 0) {
      throw new Error('Running coturn has an invalid mount destination');
    }
    if (
      destination.startsWith('/run/secrets/') ||
      destination === '/run/wo-turn'
    ) {
      continue;
    }
    if (!rollbackTurnMountTargets.has(destination)) {
      throw new Error(`Running coturn has an unexpected mount: ${destination}`);
    }
    if (destinations.has(destination)) {
      throw new Error(`Running coturn has duplicate mount: ${destination}`);
    }
    destinations.add(destination);

    const type = mount.Type;
    const readOnly = mount.RW === false;
    if (!['bind', 'volume'].includes(type) || typeof mount.RW !== 'boolean') {
      throw new Error(`Running coturn mount is unsafe: ${destination}`);
    }
    if (destination !== '/var/lib/coturn' && (type !== 'bind' || !readOnly)) {
      throw new Error(`Running coturn config mount is unsafe: ${destination}`);
    }
    if (hostMode && (destination !== '/var/lib/coturn' || !readOnly)) {
      throw new Error('coturn host rollback mounts are unsafe');
    }

    if (type === 'bind') {
      if (
        typeof mount.Source !== 'string' ||
        !isAbsolute(mount.Source) ||
        resolve(mount.Source) !== mount.Source
      ) {
        throw new Error(`Running coturn bind source is unsafe: ${destination}`);
      }
      const propagation = mount.Propagation ?? '';
      if (!['', 'rprivate'].includes(propagation)) {
        throw new Error(
          `Running coturn bind propagation is unsafe: ${destination}`,
        );
      }
      normalized.push({
        propagation,
        readOnly,
        source: mount.Source,
        target: destination,
        type,
      });
      continue;
    }

    if (
      destination !== '/var/lib/coturn' ||
      typeof mount.Name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(mount.Name)
    ) {
      throw new Error('Running coturn state volume is unsafe');
    }
    normalized.push({
      readOnly,
      source: mount.Name,
      target: destination,
      type,
    });
  }
  if (
    hostMode &&
    (normalized.length !== 1 ||
      normalized[0].target !== '/var/lib/coturn' ||
      normalized[0].type !== 'bind')
  ) {
    throw new Error('coturn host rollback state mount is unavailable');
  }
  return normalized.sort((left, right) =>
    left.target.localeCompare(right.target),
  );
}

function captureCoturnRollbackBoundary(containerId) {
  const inspectionResult = JSON.parse(
    run('docker', ['inspect', containerId], {
      label: 'coturn rollback boundary inspection',
    }),
  );
  const inspection = inspectionResult[0];
  if (inspection === undefined) {
    throw new Error('coturn rollback boundary is unavailable');
  }
  const environment = inspectedEnvironment(inspection.Config?.Env);
  const turnEnvironment = Object.fromEntries(
    rollbackTurnEnvironmentFields.map((field) => [
      field,
      environment[field] ?? '',
    ]),
  );
  const hostMode = inspection.HostConfig?.NetworkMode === 'host';
  const healthcheck = inspection.Config?.Healthcheck;
  if (
    !Array.isArray(healthcheck?.Test) ||
    healthcheck.Test.length < 2 ||
    healthcheck.Test.some((value) => typeof value !== 'string')
  ) {
    throw new Error('coturn rollback healthcheck is unavailable');
  }
  const mounts = normalizeCoturnRollbackMounts(
    inspection.Mounts ?? [],
    hostMode,
  );
  if (hostMode && turnEnvironment.TURN_INTERNAL_IP.length === 0) {
    throw new Error('coturn host rollback address is unavailable');
  }
  return {
    healthcheck: {
      interval: healthcheck.Interval,
      retries: healthcheck.Retries,
      startInterval: healthcheck.StartInterval,
      startPeriod: healthcheck.StartPeriod,
      test: healthcheck.Test,
      timeout: healthcheck.Timeout,
    },
    hostMode,
    mounts,
    ports: normalizeCoturnPortBindings(inspection.HostConfig?.PortBindings),
    turnEnvironment,
  };
}

function appendHealthcheck(lines, healthcheck) {
  const escapedTest = healthcheck.test.map((value) =>
    value.replaceAll('$', () => '$$'),
  );
  lines.push('    healthcheck:', `      test: ${JSON.stringify(escapedTest)}`);
  for (const [field, value] of [
    ['interval', healthcheck.interval],
    ['timeout', healthcheck.timeout],
    ['start_period', healthcheck.startPeriod],
    ['start_interval', healthcheck.startInterval],
  ]) {
    if (Number.isInteger(value) && value > 0) {
      lines.push(`      ${field}: ${JSON.stringify(`${value}ns`)}`);
    }
  }
  if (Number.isInteger(healthcheck.retries) && healthcheck.retries > 0) {
    lines.push(`      retries: ${healthcheck.retries}`);
  }
}

function appendRollbackVolumes(lines, mounts) {
  if (mounts.length === 0) {
    lines.push('    volumes: !override []');
    return;
  }
  lines.push('    volumes: !override');
  for (const mount of mounts) {
    lines.push(
      `      - type: ${mount.type}`,
      `        source: ${
        mount.type === 'volume'
          ? rollbackTurnVolumeAlias
          : JSON.stringify(mount.source)
      }`,
      `        target: ${mount.target}`,
      `        read_only: ${mount.readOnly}`,
    );
    if (mount.type === 'bind') {
      lines.push('        bind:', '          create_host_path: false');
      if (mount.propagation.length > 0) {
        lines.push(`          propagation: ${mount.propagation}`);
      }
    }
  }
}

export function rollbackOverrideSource(
  images,
  coturnBoundary,
  { selectedServices = services } = {},
) {
  const rollbackServices = rollbackServiceSelection(selectedServices);
  if (rollbackServices.includes('coturn') && coturnBoundary === undefined) {
    throw new Error('coturn rollback boundary is unavailable');
  }
  const lines = ['services:'];
  for (const service of rollbackServices) {
    lines.push(`  ${service}:`);
    if (service === 'server' || service === 'coturn') {
      lines.push('    build: !reset null');
    }
    lines.push(
      `    image: ${images[service].imageId}`,
      '    pull_policy: never',
    );
    if (service !== 'coturn') {
      continue;
    }
    lines.push('    environment:');
    for (const field of rollbackTurnEnvironmentFields) {
      const value =
        field === 'TURN_INTERNAL_IP' && !coturnBoundary.hostMode
          ? ''
          : coturnBoundary.turnEnvironment[field];
      lines.push(`      ${field}: ${JSON.stringify(value)}`);
    }
    lines.push(
      `      TURN_NETWORK_MODE: ${JSON.stringify(coturnBoundary.hostMode ? 'host' : 'bridge')}`,
    );
    appendHealthcheck(lines, coturnBoundary.healthcheck);
    if (coturnBoundary.hostMode) {
      lines.push(
        '    network_mode: host',
        '    ports: !override []',
        '    networks: !override []',
      );
      appendRollbackVolumes(lines, coturnBoundary.mounts);
    } else {
      if (coturnBoundary.ports.length === 0) {
        throw new Error('coturn bridge rollback ports are unavailable');
      }
      lines.push(
        '    network_mode: !reset null',
        '    ports: !override',
        ...coturnBoundary.ports.flatMap((port) => [
          '      - target: ' + port.target,
          '        published: ' + JSON.stringify(String(port.published)),
          '        protocol: ' + port.protocol,
          '        host_ip: ' + JSON.stringify(port.hostIp),
        ]),
        '    networks: !override [turn_edge]',
      );
      appendRollbackVolumes(lines, coturnBoundary.mounts);
    }
  }
  const stateVolume = rollbackServices.includes('coturn')
    ? coturnBoundary.mounts.find(
        ({ type, target }) => type === 'volume' && target === '/var/lib/coturn',
      )
    : undefined;
  if (stateVolume !== undefined) {
    lines.push(
      'volumes:',
      `  ${rollbackTurnVolumeAlias}:`,
      '    external: true',
      `    name: ${JSON.stringify(stateVolume.source)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function rollbackComposeEquivalenceOverrideSource(images) {
  const imageReference = images?.server?.imageReference;
  if (typeof imageReference !== 'string' || imageReference.length === 0) {
    throw new Error('Server rollback image reference is unavailable');
  }
  return [
    'services:',
    '  server:',
    `    image: ${JSON.stringify(imageReference)}`,
    '',
  ].join('\n');
}

export function rollbackComposeLegacyPlatformOverrideSource() {
  return ['services:', '  server:', '    platform: !reset null', ''].join('\n');
}

export function assertRollbackComposeRuntimeEquivalent(
  envFile,
  rollbackOverride,
  images,
  {
    composeArgumentsForProfile = composeArguments,
    composeProvenance,
    equivalenceOverride,
    execute = run,
    legacyPlatformOverride,
  } = {},
) {
  const capturedHash = images?.server?.composeConfigHash;
  if (!/^[a-f0-9]{64}$/u.test(capturedHash ?? '')) {
    throw new Error('Server rollback Compose config hash is unavailable');
  }
  if (
    typeof equivalenceOverride !== 'string' ||
    equivalenceOverride.length === 0
  ) {
    throw new Error(
      'Server rollback Compose equivalence override is unavailable',
    );
  }
  const renderHash = (overrides, label) => {
    const rows = execute(
      'docker',
      composeArgumentsForProfile(
        envFile,
        ...overrides.flatMap((override) => ['-f', override]),
        'config',
        '--hash',
        'server',
      ),
      {
        composeProvenance,
        label,
      },
    )
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .filter(Boolean);
    const match =
      rows.length === 1 ? /^server ([a-f0-9]{64})$/u.exec(rows[0]) : null;
    return match?.[1];
  };
  const comparisonOverrides = [rollbackOverride, equivalenceOverride];
  const currentHash = renderHash(
    comparisonOverrides,
    'Server rollback Compose runtime equivalence',
  );
  if (currentHash === capturedHash) {
    return;
  }
  if (
    currentHash !== undefined &&
    typeof legacyPlatformOverride === 'string' &&
    legacyPlatformOverride.length > 0 &&
    renderHash(
      [...comparisonOverrides, legacyPlatformOverride],
      'Server rollback legacy platform Compose runtime equivalence',
    ) === capturedHash
  ) {
    return;
  }
  throw new Error(
    'Server rollback runtime configuration differs from the running Compose boundary',
  );
}

export function restoreImageTags(
  images,
  selectedServices = services,
  { execute = run } = {},
) {
  for (const service of selectedServices) {
    const imageReference = images[service].imageReference;
    if (immutableImageReferencePattern.test(imageReference)) {
      continue;
    }
    execute(
      'docker',
      ['image', 'tag', images[service].imageId, imageReference],
      { label: `${service} image tag rollback`, stdio: 'inherit' },
    );
  }
}

export function inspectBuiltReleaseImages(
  envFile,
  provenance,
  { execute = run } = {},
) {
  const composeOptions = {
    composeProvenance: provenance,
  };
  const configuration = JSON.parse(
    execute('docker', composeArguments(envFile, 'config', '--format', 'json'), {
      ...composeOptions,
      label: 'Built image Compose inspection',
    }),
  );
  const expectedArchitecture = execute(
    'docker',
    ['version', '--format', '{{.Server.Arch}}'],
    { label: 'Docker host architecture inspection' },
  ).trim();
  if (!/^[a-z0-9_]+$/u.test(expectedArchitecture)) {
    throw new Error('Docker host architecture is unavailable');
  }

  return Object.fromEntries(
    releaseServices.map((service) => {
      const imageReference = configuration.services?.[service]?.image;
      if (typeof imageReference !== 'string' || imageReference.length === 0) {
        throw new Error(`Rendered ${service} image reference is unavailable`);
      }
      const inspections = JSON.parse(
        execute('docker', ['image', 'inspect', imageReference], {
          label: `${service} release image inspection`,
        }),
      );
      if (!Array.isArray(inspections) || inspections.length !== 1) {
        throw new Error(`${service} release image inspection is incomplete`);
      }
      const inspection = inspections[0];
      const image = {
        architecture: inspection.Architecture,
        id: inspection.Id,
        labels: inspection.Config?.Labels ?? {},
        os: inspection.Os,
      };
      const issues = validateImageProvenance(image, provenance, {
        expectedArchitecture,
      });
      if (issues.length > 0) {
        throw new Error(
          `${service} release image provenance is invalid: ${issues.join('; ')}`,
        );
      }
      return [
        service,
        {
          architecture: image.architecture,
          imageId: image.id,
          imageReference,
        },
      ];
    }),
  );
}

async function createReleaseImageOverride(directory, images) {
  const file = resolve(directory, 'release.compose.yaml');
  await writeFile(file, releaseImageOverrideSource(images), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return file;
}

export function assertRunningReleaseImages(
  envFile,
  images,
  selectedServices = releaseServices,
  { execute = run } = {},
) {
  for (const service of selectedServices) {
    const containerId = execute(
      'docker',
      composeArguments(envFile, 'ps', '-q', service),
      { label: `${service} running container lookup` },
    ).trim();
    if (containerId.length === 0) {
      throw new Error(`${service} running container is unavailable`);
    }
    const imageId = execute(
      'docker',
      ['inspect', '--format', '{{.Image}}', containerId],
      { label: `${service} running image inspection` },
    ).trim();
    if (imageId !== images?.[service]?.imageId) {
      throw new Error(
        `${service} running image does not match the verified release image ID`,
      );
    }
  }
}

function runInternalSmoke(envFile, provenance, releaseOverride) {
  const containerDeployDirectory = '/opt/wo/deploy';
  run(
    'docker',
    composeArguments(
      envFile,
      '-f',
      releaseOverride,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      '--volume',
      `${resolve(deployDirectory, 'scripts')}:${containerDeployDirectory}/scripts:ro`,
      '--volume',
      `${envFile}:${containerDeployDirectory}/.env:ro`,
      'server',
      `${containerDeployDirectory}/scripts/smoke.mjs`,
      `--env-file=${containerDeployDirectory}/.env`,
      '--base-url=http://server:3000',
    ),
    {
      composeProvenance: provenance,
      label: 'Internal post-upgrade smoke',
      stdio: 'inherit',
    },
  );
}

async function upgrade(envFile, environment, operationLockToken) {
  const provenance = deriveReleaseProvenance();
  run(
    process.execPath,
    [
      resolve(import.meta.dirname, 'preflight.mjs'),
      `--env-file=${envFile}`,
      '--allow-running',
    ],
    { label: 'Preflight', stdio: 'inherit' },
  );
  assertPostgresMajorUnchanged(envFile);
  const rollbackImages = acquireRollbackImageLeases(
    captureRollbackImages(envFile),
  );
  let rollbackWorkspace;
  try {
    rollbackWorkspace = await createRollbackWorkspace(rollbackImages, {
      workspaceRoot: resolve(deployDirectory, environment.BACKUP_DIR),
    });
  } catch (error) {
    let leaseCleanupFailed = false;
    let leaseCleanupError;
    try {
      releaseRollbackImageLeases(rollbackImages, false);
    } catch (caughtCleanupError) {
      leaseCleanupFailed = true;
      leaseCleanupError = caughtCleanupError;
    }
    if (leaseCleanupFailed) {
      throw new AggregateError(
        [error, leaseCleanupError],
        'Rollback workspace preparation failed and image lease cleanup was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
  const { directory: rollbackDirectory, override: rollbackOverride } =
    rollbackWorkspace;
  let backupDirectory;
  let quiesceAttempted = false;
  let publicExposureAttempted = false;
  let retainRollbackWorkspace = false;
  let upgradeFailed = false;
  let upgradeError;

  try {
    try {
      run('docker', composeArguments(envFile, 'pull', 'postgres'), {
        label: 'Image pull',
        stdio: 'inherit',
      });
      run(
        'docker',
        composeArguments(
          envFile,
          'build',
          '--pull',
          'caddy',
          'server',
          'coturn',
        ),
        {
          composeProvenance: provenance,
          label: 'Application image build',
          stdio: 'inherit',
        },
      );
      const releaseImages = inspectBuiltReleaseImages(envFile, provenance);
      const releaseOverride = await createReleaseImageOverride(
        rollbackDirectory,
        releaseImages,
      );
      quiesceAttempted = true;
      run('docker', composeArguments(envFile, 'stop', 'caddy', 'server'), {
        label: 'Pre-upgrade write quiesce',
        stdio: 'inherit',
      });
      backupDirectory = await runBackup({ operationLockToken });
      run(
        'docker',
        composeArguments(
          envFile,
          '-f',
          releaseOverride,
          'up',
          '-d',
          '--wait',
          '--no-build',
          'postgres',
          'coturn',
          'server',
        ),
        {
          composeProvenance: provenance,
          label: 'Private upgrade',
          stdio: 'inherit',
        },
      );
      assertRunningReleaseImages(envFile, releaseImages, ['coturn', 'server']);
      runInternalSmoke(envFile, provenance, releaseOverride);
      publicExposureAttempted = true;
      run(
        'docker',
        composeArguments(
          envFile,
          '-f',
          releaseOverride,
          'up',
          '-d',
          '--wait',
          '--no-build',
          'caddy',
        ),
        {
          composeProvenance: provenance,
          label: 'Public edge activation',
          stdio: 'inherit',
        },
      );
      assertRunningReleaseImages(envFile, releaseImages);
    } catch (error) {
      const rollbackErrors = [];
      if (publicExposureAttempted) {
        try {
          restoreImageTags(rollbackImages, ['caddy']);
          run(
            'docker',
            composeArguments(
              envFile,
              '-f',
              rollbackOverride,
              'up',
              '-d',
              '--no-deps',
              '--wait',
              'caddy',
            ),
            { label: 'Caddy image rollback', stdio: 'inherit' },
          );
          run(
            process.execPath,
            [
              resolve(import.meta.dirname, 'smoke.mjs'),
              `--env-file=${envFile}`,
            ],
            { label: 'Caddy rollback smoke', stdio: 'inherit' },
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          retainRollbackWorkspace = true;
          throw new AggregateError(
            [error, ...rollbackErrors],
            'Caddy activation failed and its rollback was incomplete; application data was preserved',
            { cause: error },
          );
        }
        throw new Error(
          `Caddy activation failed; old Caddy restored without data rollback: ${failureMessage(error)}`,
          { cause: error },
        );
      }
      try {
        restoreImageTags(rollbackImages);
        if (backupDirectory !== undefined) {
          retainRollbackWorkspace = true;
          run(
            process.execPath,
            [
              resolve(import.meta.dirname, 'restore.mjs'),
              `--env-file=${envFile}`,
              `--backup-dir=${backupDirectory}`,
              `--compose-override=${rollbackOverride}`,
              '--confirm-restore',
            ],
            {
              env: deploymentOperationProcessEnvironment(operationLockToken),
              label: 'Pre-upgrade backup rollback',
              stdio: 'inherit',
            },
          );
        } else if (quiesceAttempted) {
          run(
            'docker',
            [
              'start',
              rollbackImages.server.containerId,
              rollbackImages.caddy.containerId,
            ],
            { label: 'Original container restart', stdio: 'inherit' },
          );
        }
        run(
          process.execPath,
          [resolve(import.meta.dirname, 'smoke.mjs'), `--env-file=${envFile}`],
          { label: 'Rollback smoke', stdio: 'inherit' },
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        retainRollbackWorkspace = true;
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Upgrade failed and rollback was incomplete',
          { cause: error },
        );
      }
      throw new Error(
        `Upgrade failed; rollback completed: ${failureMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  } catch (error) {
    upgradeFailed = true;
    upgradeError = error;
  }

  let cleanupFailed = false;
  let cleanupError;
  try {
    const removed = await releaseRollbackResources(
      rollbackDirectory,
      rollbackImages,
      retainRollbackWorkspace,
    );
    if (!removed) {
      process.stderr.write(
        `Rollback workspace retained for container restart safety: ${rollbackDirectory}\n`,
      );
    }
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  throwUpgradeCleanupFailures({
    cleanupError,
    cleanupFailed,
    upgradeError,
    upgradeFailed,
  });
}

export async function runUpgrade({ operationLockToken } = {}) {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env')),
  );
  const environment = loadDeploymentEnvironment(envFile);
  return withDeploymentOperationLock(
    deployDirectory,
    ({ token }) => upgrade(envFile, environment, token),
    { token: operationLockToken },
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runUpgrade().catch((error) => {
    process.stderr.write(`Upgrade failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
