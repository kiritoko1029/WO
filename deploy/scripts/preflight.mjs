import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  readFile,
  realpath,
  stat,
  statfs,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSocket } from 'node:dgram';

import {
  firewallSummary,
  semverAtLeast,
  validateDeploymentEnvironment,
  validateGeneratedSecret,
  validateTurnTlsIdentity,
} from './lib.mjs';
import {
  argumentValue,
  composeArguments,
  deployDirectory,
  hasArgument,
  integrationComposeArguments,
  loadDeploymentEnvironment,
} from './ops.mjs';

const minimumComposeVersion = '2.24.4';
const minimumFreeBytes = 5 * 1024 * 1024 * 1024;

function resolvedFromDeploy(path) {
  return resolve(deployDirectory, path);
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
        `${fileName} is not readable (${error.code ?? 'unknown error'})`,
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
      `turn_tls_cert.pem is not readable (${error.code ?? 'unknown error'})`,
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
      `turn_tls_key.pem is not readable (${error.code ?? 'unknown error'})`,
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

export async function checkPortConflicts(environment, host = '0.0.0.0') {
  const turnPort = Number(environment.TURN_PORT);
  const turnTlsPort = Number(environment.TURN_TLS_PORT);
  const relayMinimum = Number(environment.TURN_RELAY_MIN_PORT);
  const relayMaximum = Number(environment.TURN_RELAY_MAX_PORT);
  if (
    ![turnPort, turnTlsPort, relayMinimum, relayMaximum].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
    ) ||
    relayMinimum > relayMaximum ||
    relayMaximum - relayMinimum + 1 > 200
  ) {
    return ['Port conflict check requires a valid bounded TURN port plan'];
  }
  const tcpPorts = [80, 443, turnPort, turnTlsPort];
  if (new Set(tcpPorts).size !== tcpPorts.length) {
    return ['TCP listener port plan contains an internal conflict'];
  }
  const udpPorts = [
    turnPort,
    turnTlsPort,
    ...Array.from(
      {
        length: relayMaximum - relayMinimum + 1,
      },
      (_, index) => relayMinimum + index,
    ),
  ];
  const issues = [];
  for (const [protocol, ports, check] of [
    ['TCP', tcpPorts, checkTcpPort],
    ['UDP', udpPorts, checkUdpPort],
  ]) {
    for (const port of ports) {
      try {
        await check(port, host);
      } catch (error) {
        issues.push(
          `${protocol} port ${port} is unavailable (${error.code ?? 'bind failed'})`,
        );
      }
    }
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
        `${field} DNS lookup failed (${error.code ?? 'unknown error'})`,
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
      `BACKUP_DIR is not writable (${error.code ?? 'unknown error'})`,
    );
  }
  return issues;
}

async function checkDiskAndPaths(environment) {
  return checkBackupDirectory(resolvedFromDeploy(environment.BACKUP_DIR));
}

function checkDocker(envFile, integration) {
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
    const result = spawnSync(
      'docker',
      compose(envFile, 'config', '--format', 'json'),
      { encoding: 'utf8', cwd: deployDirectory },
    );
    if (result.status !== 0) {
      issues.push(`docker compose config failed: ${result.stderr.trim()}`);
    } else if (result.stdout.includes('${')) {
      issues.push(
        'Rendered Compose configuration contains unresolved variables',
      );
    }
  } catch (error) {
    issues.push(error.message);
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
  issues.push(...checkDocker(envFile, integration));
  issues.push(...(await checkDiskAndPaths(environment)));
  if (!integration) {
    issues.push(...(await checkDns(environment)));
  }
  if (!hasArgument('--allow-running') && environmentIssues.length === 0) {
    issues.push(
      ...(await checkPortConflicts(
        environment,
        integration ? '127.0.0.1' : '0.0.0.0',
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
      process.stderr.write(`Preflight failed (${error.name ?? 'Error'})\n`);
      process.exitCode = 1;
    });
}
