import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  parseDotEnv,
  validateDeploymentEnvironment,
  validateGeneratedSecret,
} from './lib.mjs';
import {
  composeProcessEnvironment,
  deploymentProcessEnvironment,
  failureMessage,
  withDeploymentOperationLock,
} from './ops.mjs';
import {
  deriveReleaseProvenance,
  integrationReleaseProvenance,
  validateReleaseProvenance,
} from './provenance.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const generatedSecrets = [
  'jwt_access_secret',
  'postgres_password',
  'turn_shared_secret',
];
const actions = new Set(['up', 'configure', 'status', 'logs', 'renew', 'stop']);
const optionNames = new Set([
  'project',
  'state-dir',
  'domain',
  'email',
  'admin-email',
  'public-ip',
  'turn-host',
  'http-port',
  'https-port',
  'turn-port',
  'turn-tls-port',
  'relay-min',
  'relay-max',
  'password-file',
]);
const booleanNames = new Set([
  'local',
  'non-interactive',
  'prepare-only',
  'finish',
  'help',
]);

export function parseSetupArguments(argv) {
  const options = { action: 'up' };
  let selectedAction = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      if (selectedAction || !actions.has(argument))
        throw new Error('Unknown deployment action; use --help');
      options.action = argument;
      selectedAction = true;
      continue;
    }
    const [name, ...parts] = argument.slice(2).split('=');
    if (Object.hasOwn(options, name))
      throw new Error(`Duplicate option: --${name}`);
    if (booleanNames.has(name) && parts.length === 0) options[name] = true;
    else if (optionNames.has(name)) {
      const value = parts.length > 0 ? parts.join('=') : argv[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value: --${name}`);
      options[name] = value;
    } else throw new Error('Unknown setup option; use --help');
  }
  return options;
}

function portablePath(value) {
  return value.split(sep).join('/');
}

export function setupStateDirectory(options, root = repositoryRoot) {
  const project = options.project ?? (options.local ? 'wo-local' : 'wo');
  if (!/^[a-z][a-z0-9-]{1,39}$/u.test(project))
    throw new Error(
      'Project must contain 2-40 lowercase letters, digits or hyphens and start with a letter',
    );
  const value = options['state-dir'] ?? `deploy/.managed/${project}`;
  if (isAbsolute(value) || /[\p{Cc}$'"`#]/u.test(value))
    throw new Error(
      'State directory must be a literal relative path inside deploy/.managed',
    );
  const stateDirectory = resolve(root, value);
  const within = relative(resolve(root, 'deploy/.managed'), stateDirectory);
  if (within.length === 0 || within.startsWith('..') || isAbsolute(within))
    throw new Error('State directory must be below deploy/.managed');
  return {
    project,
    stateDirectory,
    statePath: portablePath(relative(root, stateDirectory)),
  };
}

async function assertPrivateDirectory(directory, boundary) {
  const parent = dirname(directory);
  if (directory !== boundary && parent !== directory)
    await assertPrivateDirectory(parent, boundary);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      'Setup state must use real directories, not symbolic links',
    );
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

async function privateWrite(file, contents, exclusive = false) {
  if (existsSync(file)) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Setup files must be regular files, not symbolic links');
  }
  await writeFile(file, contents, {
    mode: 0o600,
    flag: exclusive ? 'wx' : 'w',
  });
  if (process.platform !== 'win32') await chmod(file, 0o600);
}

function literal(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\p{Cc}\s$'"`#\\]/u.test(value)
  )
    throw new Error(
      `${label} must be a literal value without spaces or configuration syntax`,
    );
  return value;
}

function emailAddress(value, label) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!+_%=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/u.test(value)
  )
    throw new Error(`${label} must be a valid email address`);
  return literal(value.toLowerCase(), label);
}

function validatePassword(value) {
  if (
    typeof value !== 'string' ||
    value.length < 12 ||
    value.length > 128 ||
    /\p{Cc}/u.test(value)
  )
    throw new Error(
      'Administrator password must contain 12-128 characters and no control characters',
    );
  return value;
}

export function createSetupEnvironment(
  options,
  paths,
  provenance,
  platform = process.platform,
) {
  const local = options.local === true;
  const appDomain = literal(
    options.domain ?? (local ? 'wo.localhost' : ''),
    'Domain',
  ).toLowerCase();
  const turnHost = literal(
    options['turn-host'] ?? appDomain,
    'TURN hostname',
  ).toLowerCase();
  if (turnHost !== appDomain)
    throw new Error(
      'Guided setup uses one hostname for HTTPS and TURN; use the advanced deployment for separate names',
    );
  const adminEmail = emailAddress(
    options['admin-email'] ?? (local ? 'admin@wo.localhost' : ''),
    'Administrator email',
  );
  const httpPort = literal(
    options['http-port'] ?? (local ? '18080' : '80'),
    'HTTP port',
  );
  const httpsPort = literal(
    options['https-port'] ?? (local ? '18443' : '443'),
    'HTTPS port',
  );
  if (!local && (httpPort !== '80' || httpsPort !== '443'))
    throw new Error('Public ACME deployment requires host ports 80 and 443');
  const turnPort = literal(
    options['turn-port'] ?? (local ? '13478' : '3478'),
    'TURN port',
  );
  const turnTlsPort = literal(
    options['turn-tls-port'] ?? (local ? '15349' : '5349'),
    'TURN TLS port',
  );
  const authority =
    httpsPort === '443' ? appDomain : `${appDomain}:${httpsPort}`;
  const environment = {
    APP_DOMAIN: appDomain,
    ACME_EMAIL: emailAddress(
      options.email ?? (local ? 'operator@wo.localhost' : ''),
      'ACME email',
    ),
    BOOTSTRAP_ADMIN_EMAIL: adminEmail,
    SUPER_ADMIN_EMAILS: adminEmail,
    POSTGRES_DB: 'wo',
    POSTGRES_USER: 'wo',
    PUBLIC_IPV4: literal(
      options['public-ip'] ?? (local ? '127.0.0.1' : ''),
      'Public IPv4',
    ),
    TURN_HOST: turnHost,
    TURN_REALM: turnHost,
    TURN_NETWORK_MODE: 'bridge',
    TURN_PORT: turnPort,
    TURN_TLS_PORT: turnTlsPort,
    TURN_RELAY_MIN_PORT: literal(
      options['relay-min'] ?? (local ? '55000' : '49160'),
      'Relay minimum',
    ),
    TURN_RELAY_MAX_PORT: literal(
      options['relay-max'] ?? (local ? '55020' : '49200'),
      'Relay maximum',
    ),
    TURN_URLS: `stun:${turnHost}:${turnPort},turn:${turnHost}:${turnPort}?transport=udp,turn:${turnHost}:${turnPort}?transport=tcp,turns:${turnHost}:${turnTlsPort}?transport=tcp`,
    WO_TLS_MODE: local ? 'local' : 'acme',
    WO_HTTP_PORT: httpPort,
    WO_HTTPS_PORT: httpsPort,
    WO_PUBLIC_ORIGIN: `https://${authority}`,
    WO_PUBLIC_AUTHORITY: authority,
    DEPLOY_SECRET_DIR: `./${portablePath(relative(resolve(repositoryRoot, 'deploy'), paths.stateDirectory))}/secrets`,
    BACKUP_DIR: `./${portablePath(relative(resolve(repositoryRoot, 'deploy'), paths.stateDirectory))}/backups`,
    ...provenance,
    WO_DEPLOYMENT_ID: paths.deploymentId,
  };
  const ports = [httpPort, httpsPort, turnPort, turnTlsPort].map(Number);
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    new Set(ports).size !== ports.length
  )
    throw new Error(
      'HTTP, HTTPS, TURN and TURN TLS ports must be distinct integers between 1 and 65535',
    );
  const relayMin = Number(environment.TURN_RELAY_MIN_PORT);
  const relayMax = Number(environment.TURN_RELAY_MAX_PORT);
  if (ports.some((port) => port >= relayMin && port <= relayMax))
    throw new Error('Listener ports must not overlap the relay range');
  const issues = validateDeploymentEnvironment(environment, {
    platform,
    integration: local,
  });
  if (issues.length > 0) throw new Error(issues.join('; '));
  return environment;
}

function serializeEnvironment(environment) {
  const source =
    Object.entries(environment)
      .map(([key, value]) => `${key}='${value}'`)
      .join('\n') + '\n';
  const parsed = parseDotEnv(source);
  if (Object.keys(environment).some((key) => parsed[key] !== environment[key]))
    throw new Error('Generated configuration cannot be serialized safely');
  return source;
}

export function managedPortOverlay(environment) {
  const host = environment.WO_TLS_MODE === 'local' ? '127.0.0.1' : '0.0.0.0';
  const port = (target, published, protocol = 'tcp') =>
    `      - target: ${target}\n        published: '${published}'\n        protocol: ${protocol}\n        host_ip: ${host}\n`;
  const relayPorts = [];
  for (
    let value = Number(environment.TURN_RELAY_MIN_PORT);
    value <= Number(environment.TURN_RELAY_MAX_PORT);
    value += 1
  )
    relayPorts.push(port(value, value, 'udp'));
  const localServer =
    environment.WO_TLS_MODE === 'local'
      ? '  server:\n    environment:\n      NODE_ENV: test\n'
      : '';
  return `# Generated by guided setup. Do not edit.\nservices:\n${localServer}  caddy:\n    ports: !override\n${port(80, environment.WO_HTTP_PORT)}${port(443, environment.WO_HTTPS_PORT)}  coturn:\n    ports: !override\n${port(3478, environment.TURN_PORT)}${port(3478, environment.TURN_PORT, 'udp')}${port(5349, environment.TURN_TLS_PORT)}${relayPorts.join('')}`;
}

async function promptOptions(options) {
  if (options['non-interactive'] || options.local) return options;
  if (!process.stdin.isTTY)
    throw new Error(
      'Use --non-interactive with --domain, --email, --admin-email and --public-ip, or --local',
    );
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const result = { ...options };
  try {
    for (const [key, label] of [
      ['domain', 'Public domain (DNS A record pointing to this server)'],
      ['email', 'ACME contact email'],
      ['admin-email', 'Initial administrator email'],
      ['public-ip', 'Server public IPv4'],
    ]) {
      if (result[key] === undefined)
        result[key] = (await input.question(`${label}: `)).trim();
    }
  } finally {
    input.close();
  }
  if (result['password-file'] === undefined) {
    result.initialPassword = await readHiddenPassword();
    if (result.initialPassword.length > 0)
      validatePassword(result.initialPassword);
  }
  return result;
}

async function readHiddenPassword() {
  process.stdout.write(
    'Initial administrator password (hidden; Enter generates a strong password): ',
  );
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePassword, rejectPassword) => {
    let value = '';
    const finish = (cancelled) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (cancelled) rejectPassword(new Error('Setup cancelled'));
      else resolvePassword(value);
    };
    const onData = (data) => {
      for (const character of data.toString()) {
        if (character === '\u0003') {
          finish(true);
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(false);
          return;
        }
        if (character === '\u007f' || character === '\b')
          value = value.slice(0, -1);
        else if (value.length < 129) value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function ensureSetupSecrets(
  stateDirectory,
  passwordFile,
  initialPassword,
) {
  const directory = resolve(stateDirectory, 'secrets');
  await assertPrivateDirectory(directory, stateDirectory);
  const readyFile = resolve(stateDirectory, 'secrets-ready');
  if (
    existsSync(readyFile) ||
    existsSync(resolve(stateDirectory, 'started.json'))
  ) {
    for (const name of [...generatedSecrets, 'bootstrap_admin_password']) {
      if (!existsSync(resolve(directory, name)))
        throw new Error(
          'An existing deployment secret is missing; restore the original file instead of generating a replacement',
        );
    }
  }
  const values = [];
  for (const name of generatedSecrets) {
    const file = resolve(directory, name);
    if (!existsSync(file))
      await privateWrite(
        file,
        `${randomBytes(32).toString('base64url')}\n`,
        true,
      );
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Existing secret is not a regular file');
    const value = (await readFile(file, 'utf8')).trim();
    if (validateGeneratedSecret(value) !== null || values.includes(value))
      throw new Error(
        'Existing generated secrets are invalid or not independent; restore the original secret files',
      );
    values.push(value);
    if (process.platform !== 'win32') await chmod(file, 0o600);
  }
  const adminFile = resolve(directory, 'bootstrap_admin_password');
  if (existsSync(adminFile)) {
    const info = await lstat(adminFile);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Bootstrap secret is not a regular file');
    const existing = validatePassword(
      (await readFile(adminFile, 'utf8')).replace(/\r?\n$/u, ''),
    );
    if (
      passwordFile !== undefined &&
      existing !==
        validatePassword(
          (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/u, ''),
        )
    )
      throw new Error(
        'Bootstrap password is already configured; change your password through the application',
      );
    if (process.platform !== 'win32') await chmod(adminFile, 0o600);
    if (!existsSync(readyFile)) await privateWrite(readyFile, '1\n', true);
    return;
  }
  const password =
    passwordFile === undefined
      ? initialPassword || randomBytes(32).toString('base64url')
      : validatePassword(
          (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/u, ''),
        );
  await privateWrite(adminFile, `${password}\n`, true);
  await privateWrite(readyFile, '1\n', true);
}

export async function configureSetup(
  options,
  {
    root = repositoryRoot,
    platform = process.platform,
    provenanceProvider = deriveReleaseProvenance,
  } = {},
) {
  const paths = setupStateDirectory(options, root);
  await assertPrivateDirectory(
    paths.stateDirectory,
    resolve(root, 'deploy/.managed'),
  );
  const manifestFile = resolve(paths.stateDirectory, 'settings.json');
  const previous = existsSync(manifestFile)
    ? JSON.parse(await readFile(manifestFile, 'utf8'))
    : null;
  if (
    previous !== null &&
    (previous.schema !== 1 || previous.project !== paths.project)
  )
    throw new Error(
      'Existing setup identity does not match; use its original project and state directory',
    );
  const effectiveOptions =
    previous === null
      ? await promptOptions(options)
      : {
          ...previous.options,
          ...options,
          local: options.local ?? previous.options.local,
        };
  paths.deploymentId = previous?.environment?.WO_DEPLOYMENT_ID ?? randomUUID();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      paths.deploymentId,
    )
  )
    throw new Error('Stored deployment identity is invalid');
  const migrateIdentity =
    previous !== null && previous.environment.WO_DEPLOYMENT_ID === undefined;
  if (
    previous === null &&
    options.action !== 'up' &&
    options.action !== 'configure'
  )
    throw new Error('No configured deployment; run the setup command first');
  const provenance =
    previous?.provenance ??
    (effectiveOptions.local
      ? integrationReleaseProvenance
      : provenanceProvider({ root }));
  const provenanceIssues = validateReleaseProvenance(provenance, {
    production: !effectiveOptions.local,
  });
  if (provenanceIssues.length > 0)
    throw new Error('Stored release provenance is invalid');
  if (previous !== null && options.action === 'up' && !effectiveOptions.local) {
    const current = provenanceProvider({ root });
    if (JSON.stringify(current) !== JSON.stringify(provenance))
      throw new Error(
        'Checkout revision differs from the configured deployment; restore that revision. Up does not silently upgrade an existing installation',
      );
  }
  const environment = createSetupEnvironment(
    effectiveOptions,
    paths,
    provenance,
    platform,
  );
  // Relative paths remain valid when the generator runs inside the Node helper container.
  const relativeState = portablePath(
    relative(resolve(root, 'deploy'), paths.stateDirectory),
  );
  environment.DEPLOY_SECRET_DIR = `./${relativeState}/secrets`;
  environment.BACKUP_DIR = `./${relativeState}/backups`;
  const source = serializeEnvironment(environment);
  if (migrateIdentity)
    previous.environment.WO_DEPLOYMENT_ID = paths.deploymentId;
  if (
    previous !== null &&
    JSON.stringify(previous.environment) !== JSON.stringify(environment)
  )
    throw new Error(
      'Configuration differs from the existing deployment; use the original values. Domain/IP/account changes require a planned migration',
    );
  const envFile = resolve(paths.stateDirectory, '.env');
  if (existsSync(envFile)) {
    const existingSource = await readFile(envFile, 'utf8');
    const withoutIdentity = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key !== 'WO_DEPLOYMENT_ID'),
    );
    if (
      existingSource !== source &&
      (!migrateIdentity ||
        existingSource !== serializeEnvironment(withoutIdentity))
    )
      throw new Error(
        'Generated environment differs from saved settings; restore it before continuing',
      );
  }
  if (previous === null) {
    const savedOptions = Object.fromEntries(
      Object.entries(effectiveOptions).filter(
        ([key]) => optionNames.has(key) && key !== 'password-file',
      ),
    );
    savedOptions.local = effectiveOptions.local === true;
    await privateWrite(
      manifestFile,
      JSON.stringify(
        {
          schema: 1,
          project: paths.project,
          options: savedOptions,
          provenance,
          environment,
        },
        null,
        2,
      ) + '\n',
      true,
    );
  }
  if (migrateIdentity) {
    await privateWrite(manifestFile, JSON.stringify(previous, null, 2) + '\n');
    await privateWrite(envFile, source);
  }
  const passwordFile =
    effectiveOptions['password-file'] === undefined
      ? undefined
      : resolve(root, effectiveOptions['password-file']);
  await ensureSetupSecrets(
    paths.stateDirectory,
    passwordFile,
    effectiveOptions.initialPassword,
  );
  if (!existsSync(envFile)) await privateWrite(envFile, source, true);
  const overlayFile = resolve(paths.stateDirectory, 'compose.ports.yaml');
  const overlay = managedPortOverlay(environment);
  if (existsSync(overlayFile)) {
    const existingOverlay = await readFile(overlayFile, 'utf8');
    const previousLocalOverlay = overlay.replace(
      '  server:\n    environment:\n      NODE_ENV: test\n',
      '',
    );
    if (existingOverlay !== overlay) {
      if (
        environment.WO_TLS_MODE === 'local' &&
        existingOverlay === previousLocalOverlay
      )
        await privateWrite(overlayFile, overlay);
      else
        throw new Error(
          'Generated port configuration was modified; restore it before continuing',
        );
    }
  }
  if (!existsSync(overlayFile)) await privateWrite(overlayFile, overlay, true);
  const receiptFile = resolve(paths.stateDirectory, 'first-login.txt');
  if (!existsSync(receiptFile)) {
    const password = (
      await readFile(
        resolve(paths.stateDirectory, 'secrets/bootstrap_admin_password'),
        'utf8',
      )
    ).replace(/\r?\n$/u, '');
    await privateWrite(
      receiptFile,
      `WO first login\nURL: ${environment.WO_PUBLIC_ORIGIN}\nEmail: ${environment.BOOTSTRAP_ADMIN_EMAIL}\nPassword: ${password}\n\nKeep this file private. Change the password after first login.\n`,
      true,
    );
  }
  return {
    ...paths,
    environment,
    provenance,
    root,
    envFile,
    overlayFile,
    receiptFile,
    started: existsSync(resolve(paths.stateDirectory, 'started.json')),
  };
}

export function managedComposeArguments(setup, ...args) {
  return [
    'compose',
    '--project-name',
    setup.project,
    '--env-file',
    setup.envFile,
    '-f',
    resolve(setup.root, 'deploy/compose.yaml'),
    '-f',
    resolve(setup.root, 'deploy/compose.managed.yaml'),
    '-f',
    setup.overlayFile,
    ...args,
  ];
}

export function managedProcessEnvironment(command, environment = process.env) {
  const clean =
    command[0] === 'compose'
      ? composeProcessEnvironment(command, environment)
      : deploymentProcessEnvironment({}, environment);
  // Docker Desktop locates its CLI plugins and OS libraries through these
  // Windows runtime paths. Application/deployment values remain excluded.
  for (const field of [
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'LOCALAPPDATA',
    'APPDATA',
    'PATHEXT',
    'ComSpec',
  ]) {
    const key = Object.keys(environment).find(
      (name) => name.toLowerCase() === field.toLowerCase(),
    );
    if (key !== undefined) clean[key] = environment[key];
  }
  return clean;
}

export function assertManagedResourceIdentity(identity, expectedIdentity) {
  if (identity.trim() !== expectedIdentity)
    throw new Error(
      'This Compose project already contains resources from another deployment. Select a different --project and state directory; existing resources were preserved',
    );
}

export function verifyManagedResourceOwnership(setup, dockerRunner) {
  const runner =
    dockerRunner ??
    ((command) => {
      const result = spawnSync('docker', command, {
        cwd: setup.root,
        env: managedProcessEnvironment(command),
        encoding: 'utf8',
      });
      if (result.status !== 0)
        throw new Error(
          'Unable to verify existing Docker resource ownership; check Docker before retrying',
        );
      return result.stdout.trim();
    });
  const filter = `label=com.docker.compose.project=${setup.project}`;
  for (const [kind, command, label] of [
    [
      'container',
      ['ps', '--all', '--no-trunc', '--quiet', '--filter', filter],
      '{{ index .Config.Labels "io.wo.managed.deployment-id" }}',
    ],
    [
      'volume',
      ['volume', 'ls', '--quiet', '--filter', `name=^${setup.project}_`],
      '{{ index .Labels "io.wo.managed.deployment-id" }}',
    ],
  ]) {
    const output = runner(command).trim();
    if (!output) continue;
    for (const resource of output.split(/\r?\n/u)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(resource))
        throw new Error('Docker returned an invalid resource identity');
      assertManagedResourceIdentity(
        runner([kind, 'inspect', '--format', label, resource]),
        setup.deploymentId,
      );
    }
  }
}

export async function verifyManagedDns(environment, lookup = resolve4) {
  if (environment.WO_TLS_MODE === 'local') return;
  let addresses;
  try {
    addresses = await lookup(environment.APP_DOMAIN);
  } catch (error) {
    throw new Error(
      'Public domain has no resolvable DNS A record; point it to the server public IPv4 before starting',
      { cause: error },
    );
  }
  if (!addresses.includes(environment.PUBLIC_IPV4))
    throw new Error(
      'Public domain DNS A records do not include the configured server public IPv4',
    );
}

export function runManagedCompose(setup, command) {
  const result = spawnSync('docker', command, {
    cwd: setup.root,
    env: managedProcessEnvironment(command),
    stdio: 'inherit',
  });
  if (result.status !== 0)
    throw new Error(
      'Docker Compose failed; inspect the command output, then run status or logs before retrying',
    );
}

export function managedActionCommands(setup, action) {
  if (action === 'configure') return [];
  if (action === 'up')
    return [
      managedComposeArguments(
        setup,
        ...(setup.started
          ? ['start', '--wait', '--wait-timeout', '600']
          : ['up', '-d', '--build', '--wait', '--wait-timeout', '600']),
      ),
    ];
  if (action === 'status')
    return [managedComposeArguments(setup, 'ps', '--all')];
  if (action === 'logs')
    return [managedComposeArguments(setup, 'logs', '--tail', '100')];
  if (action === 'renew')
    return [
      managedComposeArguments(
        setup,
        'exec',
        '-T',
        'certificates',
        '/opt/wo/certificates.sh',
        '--renew-now',
      ),
    ];
  if (action === 'stop') return [managedComposeArguments(setup, 'stop')];
  throw new Error('Unknown deployment action');
}

async function writeLaunchPlan(setup, options) {
  const directory = resolve(setup.root, 'deploy/.managed/launch-plan');
  await assertPrivateDirectory(
    directory,
    resolve(setup.root, 'deploy/.managed'),
  );
  const commands = managedActionCommands(setup, options.action).map((args) =>
    args.map((arg) =>
      isAbsolute(arg) && arg.startsWith(setup.root)
        ? portablePath(relative(setup.root, arg))
        : arg,
    ),
  );
  const environmentKeys = new Set(Object.keys(setup.environment));
  for (const file of ['deploy/compose.yaml', 'deploy/compose.managed.yaml']) {
    const source = await readFile(resolve(setup.root, file), 'utf8');
    for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu))
      environmentKeys.add(match[1]);
  }
  await privateWrite(
    resolve(directory, 'plan.json'),
    JSON.stringify(
      {
        commands,
        environmentKeys: [...environmentKeys],
        finish: options.action === 'up' && !setup.started,
        project: setup.project,
        deploymentId: setup.deploymentId,
      },
      null,
      2,
    ),
  );
  await privateWrite(resolve(directory, 'count'), `${commands.length}\n`);
  await privateWrite(resolve(directory, 'project'), `${setup.project}\n`);
  await privateWrite(
    resolve(directory, 'deployment-id'),
    `${setup.deploymentId}\n`,
  );
  await privateWrite(
    resolve(directory, 'environment-keys'),
    [...environmentKeys].join('\n') + '\n',
  );
  await privateWrite(
    resolve(directory, 'finish'),
    options.action === 'up' && !setup.started ? 'yes\n' : 'no\n',
  );
  for (const [index, command] of commands.entries())
    await privateWrite(
      resolve(directory, `${index}.args`),
      command.join('\n') + '\n',
    );
}

async function markStarted(setup) {
  const file = resolve(setup.stateDirectory, 'started.json');
  if (!existsSync(file))
    await privateWrite(
      file,
      JSON.stringify({
        schema: 1,
        startedAt: new Date().toISOString(),
        provenance: setup.provenance,
      }) + '\n',
      true,
    );
}

export async function runSetup(argv = process.argv.slice(2)) {
  const options = parseSetupArguments(argv);
  if (options.help) {
    process.stdout.write(
      'WO guided deployment\n\n./deploy.sh [up|configure|status|logs|renew|stop] [--local] [--project=wo]\nPowerShell: ./deploy.ps1 --local\n\nProduction: Linux + Docker Compose >=2.24.4 + Git; DNS A record and ports 80/443, 3478 TCP/UDP, 5349 TCP, 49160-49200 UDP.\nUse --non-interactive --domain=rtc.your-domain.com --email=you@your-domain.com --admin-email=admin@your-domain.com --public-ip=YOUR_PUBLIC_IPV4.\nUse --password-file=relative/path for a custom initial password; otherwise one is generated.\nLocal ports: --http-port=18080 --https-port=18443 --turn-port=13478 --turn-tls-port=15349 --relay-min=55000 --relay-max=55020.\nState: --state-dir=deploy/.managed/name (preserved on reruns).\nRerunning up starts existing containers without rebuilding or changing passwords.\n',
    );
    return;
  }
  const operation = async () => {
    const setup = await configureSetup(options);
    if (options.finish) {
      await markStarted(setup);
      return;
    }
    if (options.action === 'up') await verifyManagedDns(setup.environment);
    if (options['prepare-only']) await writeLaunchPlan(setup, options);
    else {
      if (options.action !== 'configure') verifyManagedResourceOwnership(setup);
      for (const command of managedActionCommands(setup, options.action))
        runManagedCompose(setup, command);
      if (options.action === 'up') await markStarted(setup);
    }
    process.stdout.write(
      `Deployment ${setup.project}: ${setup.environment.WO_PUBLIC_ORIGIN}\nPrivate login receipt: ${setup.statePath}/first-login.txt\n`,
    );
    if (setup.environment.WO_TLS_MODE === 'local')
      process.stdout.write(
        'Local certificates are for testing; export/trust the local CA before browser and client use.\n',
      );
  };
  if (options['prepare-only'] || options.finish) await operation();
  else
    await withDeploymentOperationLock(
      resolve(repositoryRoot, 'deploy'),
      operation,
    );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runSetup().catch((error) => {
    process.stderr.write(`Setup failed: ${failureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
