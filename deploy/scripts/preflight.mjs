import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
  statfs,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSocket } from 'node:dgram';

import {
  firewallSummary,
  semverAtLeast,
  turnNetworkMode,
  turnRelayPortLimit,
  validateDeploymentEnvironment,
  validateGeneratedSecret,
  validateTurnTlsIdentity,
} from './lib.mjs';
import {
  argumentValue,
  composeArguments,
  composeProcessEnvironment,
  deployDirectory,
  failureMessage,
  hasArgument,
  integrationComposeArguments,
  loadDeploymentEnvironment,
} from './ops.mjs';
import {
  deriveReleaseProvenance,
  integrationReleaseProvenance,
  releaseProvenanceFields,
} from './provenance.mjs';

const minimumComposeVersion = '2.24.4';
const minimumFreeBytes = 5 * 1024 * 1024 * 1024;

function resolvedFromDeploy(path) {
  return resolve(deployDirectory, path);
}

function failureCodeOrMessage(error, fallback) {
  try {
    if (typeof error?.code === 'string' && error.code.length > 0) {
      return error.code;
    }
  } catch {
    // Fall through to the arbitrary-value formatter.
  }
  const message = failureMessage(error);
  return message.length > 0 ? message : fallback;
}

async function validateSecretFiles(environment, integration) {
  const issues = [];
  const directory = resolvedFromDeploy(environment.DEPLOY_SECRET_DIR);
  const generatedFiles = [
    'jwt_access_secret',
    'postgres_password',
    'turn_shared_secret',
  ];
  for (const fileName of generatedFiles) {
    const file = resolve(directory, fileName);
    try {
      const value = (await readFile(file, 'utf8')).trim();
      const issue = validateGeneratedSecret(value);
      if (issue !== null) {
        issues.push(`${fileName}: ${issue}`);
      }
      if (!integration && process.platform === 'linux') {
        const metadata = await stat(file);
        if ((metadata.mode & 0o077) !== 0) {
          issues.push(
            `${fileName} must not be readable by group or other users`,
          );
        }
      }
    } catch (error) {
      issues.push(
        `${fileName} is not readable (${failureCodeOrMessage(error, 'unknown error')})`,
      );
    }
  }

  const certificateFile = resolve(directory, 'turn_tls_cert.pem');
  const privateKeyFile = resolve(directory, 'turn_tls_key.pem');
  let certificate;
  let privateKey;
  try {
    certificate = await readFile(certificateFile, 'utf8');
  } catch (error) {
    issues.push(
      `turn_tls_cert.pem is not readable (${failureCodeOrMessage(error, 'unknown error')})`,
    );
  }
  try {
    privateKey = await readFile(privateKeyFile, 'utf8');
    if (!integration && process.platform === 'linux') {
      const metadata = await stat(privateKeyFile);
      if ((metadata.mode & 0o077) !== 0) {
        issues.push(
          'turn_tls_key.pem must not be readable by group or other users',
        );
      }
    }
  } catch (error) {
    issues.push(
      `turn_tls_key.pem is not readable (${failureCodeOrMessage(error, 'unknown error')})`,
    );
  }
  if (certificate !== undefined && privateKey !== undefined) {
    issues.push(
      ...validateTurnTlsIdentity({
        certificatePem: certificate,
        privateKeyPem: privateKey,
        hostname: environment.TURN_HOST,
        production: !integration,
      }),
    );
  }
  return issues;
}

function commandVersion(command, arguments_, label) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${label} is unavailable`);
  }
  return result.stdout.trim();
}

async function checkTcpPort(port, host) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  });
}

async function checkUdpPort(port, host) {
  await new Promise((resolvePromise, reject) => {
    const socket = createSocket('udp4');
    socket.unref();
    socket.once('error', reject);
    socket.bind({ address: host, port, exclusive: true }, () =>
      socket.close(() => resolvePromise()),
    );
  });
}

export function integrationEdgePorts(
  environment,
  shellEnvironment = process.env,
) {
  const composeValue = (name, fallback) => {
    const value = Object.hasOwn(shellEnvironment, name)
      ? shellEnvironment[name]
      : environment[name];
    return value === undefined || value === '' ? fallback : value;
  };
  return {
    httpPort: composeValue('WO_INTEGRATION_HTTP_PORT', '80'),
    httpsPort: composeValue('WO_INTEGRATION_HTTPS_PORT', '443'),
  };
}

export async function checkPortConflicts(
  environment,
  host = '0.0.0.0',
  edgePorts = { httpPort: 80, httpsPort: 443 },
) {
  const httpPort = Number(edgePorts.httpPort);
  const httpsPort = Number(edgePorts.httpsPort);
  const turnPort = Number(environment.TURN_PORT);
  const turnTlsPort = Number(environment.TURN_TLS_PORT);
  const relayMinimum = Number(environment.TURN_RELAY_MIN_PORT);
  const relayMaximum = Number(environment.TURN_RELAY_MAX_PORT);
  if (
    ![httpPort, httpsPort].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
    )
  ) {
    return ['Port conflict check requires valid HTTP and HTTPS ports'];
  }
  if (
    ![turnPort, turnTlsPort, relayMinimum, relayMaximum].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
    ) ||
    relayMinimum > relayMaximum ||
    relayMaximum - relayMinimum + 1 > turnRelayPortLimit(environment)
  ) {
    return ['Port conflict check requires a valid bounded TURN port plan'];
  }
  const tcpPorts = [httpPort, httpsPort, turnPort, turnTlsPort];
  if (new Set(tcpPorts).size !== tcpPorts.length) {
    return ['TCP listener port plan contains an internal conflict'];
  }
  const udpPorts = [
    turnPort,
    ...Array.from(
      {
        length: relayMaximum - relayMinimum + 1,
      },
      (_, index) => relayMinimum + index,
    ),
  ];
  const turnHost =
    turnNetworkMode(environment) === 'host'
      ? environment.TURN_INTERNAL_IP
      : host;
  const issues = [];
  for (const [protocol, ports, check, bindHost] of [
    ['TCP', [httpPort, httpsPort], checkTcpPort, host],
    ['TCP', [turnPort, turnTlsPort], checkTcpPort, turnHost],
    ['UDP', udpPorts, checkUdpPort, turnHost],
  ]) {
    for (const port of ports) {
      try {
        await check(port, bindHost);
      } catch (error) {
        issues.push(
          `${protocol} port ${port} is unavailable (${failureCodeOrMessage(error, 'bind failed')})`,
        );
      }
    }
  }
  return issues;
}

export function parseReservedPortRanges(source) {
  if (source.trim().length === 0) {
    return [];
  }
  const ranges = [];
  for (const item of source.trim().split(',')) {
    const match = /^([0-9]+)(?:-([0-9]+))?$/u.exec(item.trim());
    if (match === null) {
      return null;
    }
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < 1 ||
      last > 65_535 ||
      first > last
    ) {
      return null;
    }
    ranges.push([first, last]);
  }
  return ranges;
}

function portRangeIsCovered(first, last, ranges) {
  let cursor = first;
  for (const [rangeFirst, rangeLast] of [...ranges].sort(
    ([left], [right]) => left - right,
  )) {
    if (rangeLast < cursor) {
      continue;
    }
    if (rangeFirst > cursor) {
      return false;
    }
    cursor = rangeLast + 1;
    if (cursor > last) {
      return true;
    }
  }
  return cursor > last;
}

export function validateTurnHostKernelState(
  environment,
  { interfaceMap = networkInterfaces(), ephemeralPortRange, reservedPorts },
) {
  const issues = [];
  const internalIp = environment.TURN_INTERNAL_IP;
  const assignedAddresses = Object.values(interfaceMap)
    .flatMap((addresses) => addresses ?? [])
    .filter(({ family }) => family === 'IPv4' || family === 4)
    .map(({ address }) => address);
  if (!assignedAddresses.includes(internalIp)) {
    issues.push('TURN_INTERNAL_IP is not assigned to a local IPv4 interface');
  }

  const ephemeralMatch = /^\s*([0-9]+)\s+([0-9]+)\s*$/u.exec(
    ephemeralPortRange,
  );
  const reservedRanges = parseReservedPortRanges(reservedPorts);
  if (ephemeralMatch === null || reservedRanges === null) {
    issues.push('Linux local port range settings could not be parsed');
    return issues;
  }
  const ephemeralFirst = Number(ephemeralMatch[1]);
  const ephemeralLast = Number(ephemeralMatch[2]);
  const turnRanges = [
    [Number(environment.TURN_PORT), Number(environment.TURN_PORT)],
    [Number(environment.TURN_TLS_PORT), Number(environment.TURN_TLS_PORT)],
    [
      Number(environment.TURN_RELAY_MIN_PORT),
      Number(environment.TURN_RELAY_MAX_PORT),
    ],
  ].filter(
    ([first, last]) => Number.isInteger(first) && Number.isInteger(last),
  );
  for (const [first, last] of turnRanges) {
    const overlapFirst = Math.max(ephemeralFirst, first);
    const overlapLast = Math.min(ephemeralLast, last);
    if (
      overlapFirst <= overlapLast &&
      !portRangeIsCovered(overlapFirst, overlapLast, reservedRanges)
    ) {
      issues.push(
        'TURN listener and relay ports overlapping ip_local_port_range must be fully present in ip_local_reserved_ports',
      );
      break;
    }
  }
  return issues;
}

export async function validateRootOwnedDirectoryAncestors(
  directory,
  { expectedUid = 0, metadataLookup = lstat } = {},
) {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(/[\\/]/u).filter(Boolean);
  const ancestors = [root];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    ancestors.push(current);
  }
  for (const ancestor of ancestors) {
    const metadata = await metadataLookup(ancestor);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o022) !== 0
    ) {
      return [
        'TURN_STATE_EMPTY_DIR ancestors must be root-owned directories without symbolic links or group/other write access',
      ];
    }
  }
  return [];
}

export async function validateTurnStateEmptyDirectory(
  stateDirectory,
  {
    ancestorValidator = validateRootOwnedDirectoryAncestors,
    directoryEntries = readdir,
    expectedUid = 0,
    linkDetector = containsSymbolicLink,
    metadataLookup = lstat,
  } = {},
) {
  const issues = [];
  try {
    const metadata = await metadataLookup(stateDirectory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (await linkDetector(stateDirectory))
    ) {
      issues.push(
        'TURN_STATE_EMPTY_DIR must be a real directory without symbolic links',
      );
      return issues;
    }
    issues.push(
      ...(await ancestorValidator(stateDirectory, {
        expectedUid,
        metadataLookup,
      })),
    );
    if (
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o005) !== 0o005
    ) {
      issues.push(
        'TURN_STATE_EMPTY_DIR must be root-owned, traversable, and not writable by group or others',
      );
    } else if ((await directoryEntries(stateDirectory)).length > 0) {
      issues.push('TURN_STATE_EMPTY_DIR must be empty');
    }
  } catch (error) {
    let code;
    try {
      code = error?.code;
    } catch {
      // Fall back to safe formatting for arbitrary thrown values.
    }
    issues.push(
      `TURN_STATE_EMPTY_DIR is not usable (${
        typeof code === 'string' && code.length > 0
          ? code
          : failureMessage(error)
      })`,
    );
  }
  return issues;
}

async function checkTurnHostPrerequisites(environment) {
  if (turnNetworkMode(environment) !== 'host') {
    return [];
  }
  const issues = await validateTurnStateEmptyDirectory(
    environment.TURN_STATE_EMPTY_DIR,
  );
  try {
    const [ephemeralPortRange, reservedPorts] = await Promise.all([
      readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'),
      readFile('/proc/sys/net/ipv4/ip_local_reserved_ports', 'utf8'),
    ]);
    issues.push(
      ...validateTurnHostKernelState(environment, {
        ephemeralPortRange,
        reservedPorts,
      }),
    );
  } catch (error) {
    issues.push(
      `Linux local port settings are not readable (${failureCodeOrMessage(error, 'unknown error')})`,
    );
  }
  return issues;
}

async function checkDns(environment) {
  const issues = [];
  for (const field of ['APP_DOMAIN', 'TURN_HOST']) {
    try {
      const addresses = await resolve4(environment[field]);
      if (!addresses.includes(environment.PUBLIC_IPV4)) {
        issues.push(`${field} does not resolve to PUBLIC_IPV4`);
      }
    } catch (error) {
      issues.push(
        `${field} DNS lookup failed (${failureCodeOrMessage(error, 'unknown error')})`,
      );
    }
  }
  return issues;
}

function normalizedPath(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function containsSymbolicLink(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export async function checkBackupDirectory(
  directory,
  { minimumFreeBytesRequired = minimumFreeBytes } = {},
) {
  const issues = [];
  const backupDirectory = resolve(directory);
  const dangerousDirectories = new Set(
    [
      parse(backupDirectory).root,
      resolve(deployDirectory, '..'),
      deployDirectory,
    ].map(normalizedPath),
  );
  if (dangerousDirectories.has(normalizedPath(backupDirectory))) {
    return ['BACKUP_DIR resolves to a dangerous directory'];
  }
  try {
    const metadata = await lstat(backupDirectory);
    if (metadata.isSymbolicLink()) {
      return ['BACKUP_DIR must not contain a symbolic link'];
    }
    if (!metadata.isDirectory()) {
      return ['BACKUP_DIR must be a provisioned directory'];
    }
    if (await containsSymbolicLink(backupDirectory)) {
      return ['BACKUP_DIR must not contain a symbolic link'];
    }
    const canonicalDirectory = await realpath(backupDirectory);
    if (dangerousDirectories.has(normalizedPath(canonicalDirectory))) {
      return ['BACKUP_DIR resolves to a dangerous directory'];
    }
    await access(backupDirectory, constants.R_OK | constants.W_OK);
    const disk = await statfs(backupDirectory);
    if (Number(disk.bavail) * Number(disk.bsize) < minimumFreeBytesRequired) {
      issues.push('BACKUP_DIR has less than 5 GiB free');
    }
  } catch (error) {
    issues.push(
      `BACKUP_DIR is not writable (${failureCodeOrMessage(error, 'unknown error')})`,
    );
  }
  return issues;
}

async function checkDiskAndPaths(environment) {
  return checkBackupDirectory(resolvedFromDeploy(environment.BACKUP_DIR));
}

function checkDocker(envFile, integration, environment) {
  const issues = [];
  try {
    commandVersion(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      'Docker Engine',
    );
    const composeVersion = commandVersion(
      'docker',
      ['compose', 'version', '--short'],
      'Docker Compose',
    );
    if (!semverAtLeast(composeVersion, minimumComposeVersion)) {
      issues.push(
        `Docker Compose ${minimumComposeVersion} or newer is required`,
      );
    }
    const compose = integration
      ? integrationComposeArguments
      : composeArguments;
    const composeCommand = compose(envFile, 'config', '--format', 'json');
    const provenance = integration
      ? integrationReleaseProvenance
      : deriveReleaseProvenance();
    const composeEnvironment = composeProcessEnvironment(
      composeCommand,
      process.env,
      provenance,
    );
    const result = spawnSync('docker', composeCommand, {
      encoding: 'utf8',
      cwd: deployDirectory,
      env: composeEnvironment,
    });
    if (result.status !== 0) {
      issues.push(`docker compose config failed: ${result.stderr.trim()}`);
    } else {
      const configuration = JSON.parse(result.stdout);
      const coturn = configuration.services?.coturn ?? {};
      const expectedBuildArguments = Object.fromEntries(
        releaseProvenanceFields.map((field) => [
          field,
          composeEnvironment[field],
        ]),
      );
      for (const service of ['caddy', 'server', 'coturn']) {
        const buildArguments = configuration.services?.[service]?.build?.args;
        if (
          buildArguments === undefined ||
          Object.entries(expectedBuildArguments).some(
            ([field, value]) => buildArguments[field] !== value,
          )
        ) {
          issues.push(
            `Rendered ${service} build metadata differs from the selected release identity`,
          );
        }
      }
      const hostMode = !integration && turnNetworkMode(environment) === 'host';
      const networks = Array.isArray(coturn.networks)
        ? coturn.networks
        : Object.keys(coturn.networks ?? {});
      if (
        coturn.environment?.TURN_EXTERNAL_IP !== environment.PUBLIC_IPV4 ||
        coturn.environment?.TURN_REALM !== environment.TURN_REALM ||
        String(coturn.environment?.TURN_RELAY_MIN_PORT) !==
          environment.TURN_RELAY_MIN_PORT ||
        String(coturn.environment?.TURN_RELAY_MAX_PORT) !==
          environment.TURN_RELAY_MAX_PORT
      ) {
        issues.push(
          'Rendered coturn environment differs from the selected env file',
        );
      }
      if (hostMode) {
        const stateVolume = (coturn.volumes ?? []).find(
          ({ target }) => target === '/var/lib/coturn',
        );
        if (
          coturn.network_mode !== 'host' ||
          (coturn.ports ?? []).length !== 0 ||
          networks.length !== 0 ||
          coturn.environment?.TURN_INTERNAL_IP !==
            environment.TURN_INTERNAL_IP ||
          String(coturn.environment?.TURN_LISTEN_PORT) !==
            environment.TURN_PORT ||
          String(coturn.environment?.TURN_TLS_LISTEN_PORT) !==
            environment.TURN_TLS_PORT ||
          (coturn.volumes ?? []).length !== 1 ||
          stateVolume?.type !== 'bind' ||
          stateVolume?.source !== environment.TURN_STATE_EMPTY_DIR ||
          stateVolume?.read_only !== true
        ) {
          issues.push('Rendered coturn host-network boundary is incomplete');
        }
      } else if (
        coturn.network_mode === 'host' ||
        (coturn.ports ?? []).length === 0 ||
        !networks.includes('turn_edge') ||
        (coturn.environment?.TURN_INTERNAL_IP ?? '') !== ''
      ) {
        issues.push('Rendered coturn bridge-network boundary is incomplete');
      }
    }
  } catch (error) {
    issues.push(failureMessage(error));
  }
  return issues;
}

export async function runPreflight() {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env')),
  );
  const integration = hasArgument('--integration');
  const environment = loadDeploymentEnvironment(envFile);
  const environmentIssues = validateDeploymentEnvironment(environment, {
    platform: hasArgument('--allow-non-linux') ? 'linux' : process.platform,
    integration,
  });
  const issues = [...environmentIssues];
  issues.push(...(await validateSecretFiles(environment, integration)));
  issues.push(...checkDocker(envFile, integration, environment));
  issues.push(...(await checkDiskAndPaths(environment)));
  if (environmentIssues.length === 0) {
    issues.push(...(await checkTurnHostPrerequisites(environment)));
  }
  if (!integration) {
    issues.push(...(await checkDns(environment)));
  }
  if (!hasArgument('--allow-running') && environmentIssues.length === 0) {
    issues.push(
      ...(await checkPortConflicts(
        environment,
        integration ? '127.0.0.1' : '0.0.0.0',
        integration ? integrationEdgePorts(environment) : undefined,
      )),
    );
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(`ERROR: ${issue}\n`);
    }
    return 1;
  }
  process.stdout.write(
    'Deployment preflight passed. Open these firewall ports:\n',
  );
  for (const line of firewallSummary(environment)) {
    process.stdout.write(`  ${line}\n`);
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPreflight()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.exitCode = 1;
      process.stderr.write(`Preflight failed (${failureMessage(error)})\n`);
    });
}
