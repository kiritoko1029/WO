import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { arch, platform } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createSecureContext } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildFirewallInvocation,
  firewallRuleEvidenceForNetworkFault,
  matchesFirewallNetworkFaultRuleEvidence,
  validateFirewallConfiguration,
  verifyFirewallCleanupEvidence,
  verifyFirewallInstallEvidence,
  verifyFirewallNetworkFaultEvidence,
} from './firewall-policy.mjs';
import { parseAcceptanceEnvelope } from './protocol.mjs';

const AGENT_ARGUMENTS = Object.freeze([
  'listen',
  'cert-file',
  'key-file',
  'token-file',
  'desktop-package',
  'desktop-package-sha256-file',
  'work-dir',
]);
const ARGUMENT_SET = new Set(AGENT_ARGUMENTS);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const COMMAND_TYPES = new Set([
  'run.prepare',
  'run.start',
  'network.fault.apply',
  'network.fault.clear',
  'run.stop',
  'run.cancel',
]);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export class AgentError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'AgentError';
    this.code = code;
    this.detail = detail;
  }
}

function plainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, code = 'INVALID_REQUEST') {
  if (!plainObject(value)) throw new AgentError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new AgentError(code, { actual, expected: wanted });
  }
}

function parseArguments(argv) {
  const result = Object.create(null);
  for (const argument of argv) {
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new AgentError('CLI_FORMAT');
    }
    const separator = argument.indexOf('=');
    if (separator < 3) throw new AgentError('CLI_FORMAT');
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!ARGUMENT_SET.has(name)) {
      throw new AgentError('CLI_UNKNOWN', { name });
    }
    if (Object.hasOwn(result, name)) {
      throw new AgentError('CLI_DUPLICATE', { name });
    }
    if (value.length === 0) throw new AgentError('CLI_FORMAT', { name });
    result[name] = value;
  }
  for (const required of AGENT_ARGUMENTS) {
    if (!Object.hasOwn(result, required)) {
      throw new AgentError('CLI_REQUIRED', { name: required });
    }
  }
  return result;
}

function absolutePath(value, name) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new AgentError('CLI_INVALID', { name });
  }
  return value;
}

function parseListenUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError('CLI_INVALID', { name: 'listen' });
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new AgentError('CLI_INVALID', { name: 'listen' });
  }
  return url;
}

export function parseAgentCli(argv) {
  const values = parseArguments(argv);
  return Object.freeze({
    listen: parseListenUrl(values.listen),
    certFile: absolutePath(values['cert-file'], 'cert-file'),
    keyFile: absolutePath(values['key-file'], 'key-file'),
    tokenFile: absolutePath(values['token-file'], 'token-file'),
    desktopPackage: absolutePath(values['desktop-package'], 'desktop-package'),
    desktopPackageSha256File: absolutePath(
      values['desktop-package-sha256-file'],
      'desktop-package-sha256-file',
    ),
    workDir: absolutePath(values['work-dir'], 'work-dir'),
  });
}

async function readRestrictedText(path, options = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new AgentError(options.code ?? 'FILE_INVALID');
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > (options.maximumBytes ?? 64 * 1024)
  ) {
    throw new AgentError(options.code ?? 'FILE_INVALID');
  }
  if (
    options.restricted === true &&
    process.platform !== 'win32' &&
    (metadata.mode & 0o077) !== 0
  ) {
    throw new AgentError('FILE_PERMISSIONS');
  }
  return readFile(path, 'utf8');
}

function commandSpec(value, name) {
  exactKeys(value, ['command', 'args'], 'COMMAND_CONFIG_INVALID');
  if (!isAbsolute(value.command) || resolve(value.command) !== value.command) {
    throw new AgentError('COMMAND_CONFIG_INVALID', { name });
  }
  if (
    !Array.isArray(value.args) ||
    value.args.length > 64 ||
    value.args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 2_048 ||
        argument.includes('\0') ||
        /(?:--?(?:token|password|credential|secret)(?:=|$))/iu.test(argument),
    )
  ) {
    throw new AgentError('COMMAND_CONFIG_INVALID', { name });
  }
  return Object.freeze({
    command: value.command,
    args: Object.freeze([...value.args]),
  });
}

function parseCommandConfiguration(value, config) {
  exactKeys(
    value,
    [
      'install',
      'desktop',
      'motion',
      'audio',
      'driver',
      'artifacts',
      'firewall',
    ],
    'COMMAND_CONFIG_INVALID',
  );
  const install =
    value.install === null ? null : commandSpec(value.install, 'install');
  if (install !== null && install.command !== config.desktopPackage) {
    throw new AgentError('COMMAND_CONFIG_INVALID', { name: 'install' });
  }
  const desktop = commandSpec(value.desktop, 'desktop');
  const motion = commandSpec(value.motion, 'motion');
  const audio = commandSpec(value.audio, 'audio');
  const driver = commandSpec(value.driver, 'driver');
  exactKeys(
    value.artifacts,
    ['executable', 'asar', 'resources'],
    'COMMAND_CONFIG_INVALID',
  );
  if (
    !isAbsolute(value.artifacts.executable) ||
    !isAbsolute(value.artifacts.asar) ||
    desktop.command !== value.artifacts.executable ||
    !Array.isArray(value.artifacts.resources) ||
    value.artifacts.resources.length > 64 ||
    value.artifacts.resources.some((path) => !isAbsolute(path))
  ) {
    throw new AgentError('COMMAND_CONFIG_INVALID', { name: 'artifacts' });
  }
  let firewall;
  try {
    firewall = validateFirewallConfiguration(value.firewall);
  } catch {
    throw new AgentError('COMMAND_CONFIG_INVALID', { name: 'firewall' });
  }
  return Object.freeze({
    install,
    desktop,
    motion,
    audio,
    driver,
    artifacts: Object.freeze({
      executable: resolve(value.artifacts.executable),
      asar: resolve(value.artifacts.asar),
      resources: Object.freeze(
        value.artifacts.resources.map((path) => resolve(path)),
      ),
    }),
    firewall,
  });
}

export async function loadAgentConfiguration(config) {
  let workDirectory;
  try {
    workDirectory = await stat(config.workDir);
  } catch {
    throw new AgentError('WORK_DIR_INVALID');
  }
  if (!workDirectory.isDirectory()) throw new AgentError('WORK_DIR_INVALID');
  const commandFile = resolve(config.workDir, 'acceptance-commands.json');
  const [cert, key, tokenText, hashText, commandText] = await Promise.all([
    readRestrictedText(config.certFile, {
      code: 'TLS_CONFIGURATION_INVALID',
      maximumBytes: 1024 * 1024,
    }),
    readRestrictedText(config.keyFile, {
      code: 'TLS_CONFIGURATION_INVALID',
      maximumBytes: 1024 * 1024,
      restricted: true,
    }),
    readRestrictedText(config.tokenFile, {
      code: 'TOKEN_FILE_INVALID',
      maximumBytes: 4_096,
      restricted: true,
    }),
    readRestrictedText(config.desktopPackageSha256File, {
      code: 'PACKAGE_HASH_FILE_INVALID',
      maximumBytes: 256,
    }),
    readRestrictedText(commandFile, {
      code: 'COMMAND_CONFIG_INVALID',
      maximumBytes: 1024 * 1024,
      restricted: true,
    }),
  ]);
  try {
    createSecureContext({ cert, key, minVersion: 'TLSv1.3' });
  } catch {
    throw new AgentError('TLS_CONFIGURATION_INVALID');
  }
  const token = tokenText.trim();
  const expectedPackageSha256 = hashText.trim().toLowerCase();
  if (
    token.length < 16 ||
    token.length > 512 ||
    /\s/u.test(token) ||
    !HASH_PATTERN.test(expectedPackageSha256)
  ) {
    throw new AgentError(
      !HASH_PATTERN.test(expectedPackageSha256)
        ? 'PACKAGE_HASH_FILE_INVALID'
        : 'TOKEN_FILE_INVALID',
    );
  }
  let rawCommands;
  try {
    rawCommands = JSON.parse(commandText);
  } catch {
    throw new AgentError('COMMAND_CONFIG_INVALID');
  }
  return Object.freeze({
    ...config,
    cert,
    key,
    token,
    expectedPackageSha256,
    commands: parseCommandConfiguration(rawCommands, config),
  });
}

function tokenMatches(expected, authorization) {
  if (
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ')
  ) {
    return false;
  }
  const presented = authorization.slice('Bearer '.length);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', () =>
      rejectPromise(new AgentError('ARTIFACT_UNREADABLE')),
    );
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function runInvocation(invocation, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let outputBytes = 0;
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_BODY_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
    });
    child.on('error', () => rejectPromise(new AgentError('COMMAND_FAILED')));
    child.on('close', (code) => {
      if (code !== 0 || outputBytes > MAX_BODY_BYTES) {
        rejectPromise(new AgentError('COMMAND_FAILED'));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

export function buildNativeSignatureInvocations(
  packagePath,
  executablePath,
  osPlatform,
) {
  if (osPlatform === 'win32') {
    const script =
      "$s=Get-AuthenticodeSignature -LiteralPath $args[0]; if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate){exit 3}";
    return Object.freeze(
      [...new Set([packagePath, executablePath])].map((path) =>
        Object.freeze({
          command:
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          args: Object.freeze([
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
            path,
          ]),
        }),
      ),
    );
  }
  if (osPlatform === 'darwin') {
    const invocations = [
      {
        command: '/usr/bin/codesign',
        args: ['--verify', '--deep', '--strict', executablePath],
      },
      {
        command: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'execute', '--verbose=2', executablePath],
      },
      {
        command: '/usr/bin/xcrun',
        args: ['stapler', 'validate', executablePath],
      },
    ];
    if (/\.(?:dmg|pkg)$/iu.test(packagePath)) {
      invocations.push({
        command: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'install', '--verbose=2', packagePath],
      });
      invocations.push({
        command: '/usr/bin/xcrun',
        args: ['stapler', 'validate', packagePath],
      });
    }
    return Object.freeze(
      invocations.map((invocation) =>
        Object.freeze({
          command: invocation.command,
          args: Object.freeze(invocation.args),
        }),
      ),
    );
  }
  throw new AgentError('UNSUPPORTED_PLATFORM');
}

async function verifyPackageSignature(packagePath, executablePath, osPlatform) {
  const invocations = buildNativeSignatureInvocations(
    packagePath,
    executablePath,
    osPlatform,
  );
  for (const invocation of invocations) await runInvocation(invocation);
  return true;
}

function childEnvironment() {
  const names = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'DISPLAY',
  ];
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
  );
}

function spawnTracked(spec, options = {}) {
  const child = spawn(spec.command, spec.args, {
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise((resolvePromise) => {
    child.once('error', () => resolvePromise(127));
    child.once('close', (code) => resolvePromise(code));
  });
  return Object.freeze({
    pid: child.pid,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      try {
        if (process.platform === 'win32') {
          await runInvocation({
            command: 'C:\\Windows\\System32\\taskkill.exe',
            args: ['/pid', String(child.pid), '/t', '/f'],
          });
        } else {
          process.kill(-child.pid, 'SIGTERM');
          await Promise.race([
            exited,
            new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, 'SIGKILL');
          }
        }
        await exited;
        return true;
      } catch {
        return child.exitCode !== null || child.signalCode !== null;
      }
    },
  });
}

async function parseJsonFile(path, maximumBytes) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    return null;
  }
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new AgentError('EVIDENCE_INVALID');
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new AgentError('EVIDENCE_INVALID');
  }
}

async function readEvidence(run) {
  const samplePath = resolve(run.directory, 'samples.json');
  const bitratePath = resolve(run.directory, 'bitrate-events.json');
  const [samples, bitrateEvents] = await Promise.all([
    parseJsonFile(samplePath, MAX_EVIDENCE_BYTES),
    parseJsonFile(bitratePath, MAX_EVIDENCE_BYTES),
  ]);
  if (
    (samples !== null && !Array.isArray(samples)) ||
    (bitrateEvents !== null && !Array.isArray(bitrateEvents))
  ) {
    throw new AgentError('EVIDENCE_INVALID');
  }
  return { samples: samples ?? [], bitrateEvents: bitrateEvents ?? [] };
}

async function readFirewallStatus(request) {
  let status;
  try {
    status = JSON.parse(
      await runInvocation(
        buildFirewallInvocation(REPOSITORY_ROOT, request, 'status'),
      ),
    );
  } catch {
    throw new AgentError('FIREWALL_STATUS_UNPROVEN');
  }
  if (typeof status !== 'object' || status === null || Array.isArray(status)) {
    throw new AgentError('FIREWALL_STATUS_UNPROVEN');
  }
  return status;
}

async function installFirewall(config, run) {
  run.firewallInstallAttempted = true;
  const request = {
    platform: platform(),
    runId: run.id,
    ...config.commands.firewall,
    desktopExecutable: config.commands.artifacts.executable,
    stateFile: resolve(run.directory, 'firewall-state.json'),
  };
  run.firewallRequest = request;
  await runInvocation(
    buildFirewallInvocation(REPOSITORY_ROOT, request, 'install'),
  );
  const state = await parseJsonFile(request.stateFile, MAX_BODY_BYTES);
  run.firewallState = state;
  const status = await readFirewallStatus(request);
  run.firewallStatus = status;
  const evidence = verifyFirewallInstallEvidence({
    platform: request.platform,
    elevated: status.elevated,
    watchdogArmed: state?.watchdogArmed,
    installed: true,
    manifestRules: state?.ruleIds,
    rules: status.installedRuleIds,
    ruleCount: status.ruleCount,
    defaultBlockInstalled: status.defaultBlockInstalled,
  });
  if (status.runId !== run.id || evidence.pass !== true) {
    throw new AgentError('FIREWALL_INSTALL_UNPROVEN');
  }
  run.firewallInstalled = true;
  return { installed: true };
}

async function removeFirewall(_config, run) {
  if (!run.firewallInstallAttempted) return { pass: true };
  if (run.firewallRequest === null) return { pass: false };
  let output;
  try {
    output = await runInvocation(
      buildFirewallInvocation(REPOSITORY_ROOT, run.firewallRequest, 'remove'),
    );
  } catch {
    return { pass: false };
  }
  let removed;
  try {
    removed = JSON.parse(output);
  } catch {
    return { pass: false };
  }
  let status;
  try {
    status = await readFirewallStatus(run.firewallRequest);
  } catch {
    return { pass: false };
  }
  const before =
    run.firewallState?.policyHashBefore ?? run.firewallState?.snapshot?.hash;
  if (status.runId !== run.id) return { pass: false };
  return verifyFirewallCleanupEvidence({
    elevated: status.elevated,
    removed: removed?.removed === true,
    residualRules: status.installedRuleIds,
    residualRuleCount: status.ruleCount,
    policyHashBefore: before,
    policyHashAfter: removed?.policyHashAfter,
  });
}

async function readNetworkFault(run, profile, active) {
  if (run.firewallRequest === null) {
    throw new AgentError('NETWORK_FAULT_UNSUPPORTED');
  }
  let status;
  try {
    status = await readFirewallStatus(run.firewallRequest);
  } catch {
    throw new AgentError(
      active ? 'NETWORK_FAULT_APPLY_UNPROVEN' : 'NETWORK_FAULT_CLEAR_UNPROVEN',
    );
  }
  const evidence = verifyFirewallNetworkFaultEvidence(
    {
      platform: run.firewallRequest.platform,
      elevated: status.elevated,
      enabledRules: status.enabledRuleIds,
      disabledRules: status.disabledRuleIds,
      ruleCount: status.ruleCount,
      defaultBlockInstalled: status.defaultBlockInstalled,
    },
    active ? profile : null,
  );
  if (status.runId !== run.id || evidence.pass !== true) {
    throw new AgentError(
      active ? 'NETWORK_FAULT_APPLY_UNPROVEN' : 'NETWORK_FAULT_CLEAR_UNPROVEN',
    );
  }
  const ruleEvidence = firewallRuleEvidenceForNetworkFault(
    active ? profile : null,
  );
  return Object.freeze({
    profile,
    scope: 'client-egress',
    active,
    enabledRuleIds: ruleEvidence.enabledRuleIds,
    disabledRuleIds: ruleEvidence.disabledRuleIds,
  });
}

async function setNetworkFault(run, profile, active) {
  if (run.firewallRequest === null) {
    throw new AgentError('NETWORK_FAULT_UNSUPPORTED');
  }
  try {
    await runInvocation(
      buildFirewallInvocation(
        REPOSITORY_ROOT,
        run.firewallRequest,
        active ? 'fault-apply' : 'fault-clear',
        profile,
      ),
    );
  } catch {
    throw new AgentError(
      active ? 'NETWORK_FAULT_APPLY_UNPROVEN' : 'NETWORK_FAULT_CLEAR_UNPROVEN',
    );
  }
  return readNetworkFault(run, profile, active);
}

function applyNetworkFault(_config, run, profile) {
  return setNetworkFault(run, profile, true);
}

function clearNetworkFault(_config, run, profile) {
  return setNetworkFault(run, profile, false);
}

function inspectNetworkFault(_config, run, profile, active) {
  return readNetworkFault(run, profile, active);
}

async function installPackage(spec, options) {
  if (spec === null) return;
  await runInvocation(spec, options);
}

function runtimeDefaults() {
  return {
    now: Date.now,
    monotonicNow: () => performance.now(),
    hashFile,
    verifyPackageSignature,
    installPackage,
    spawnTracked,
    installFirewall,
    removeFirewall,
    applyNetworkFault,
    clearNetworkFault,
    inspectNetworkFault,
    readEvidence,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
}

function safeAgentId(config) {
  const certificateIdentity =
    typeof config.cert === 'string' && config.cert.length > 0
      ? config.cert
      : config.listen.href;
  return `${platform()}-${arch()}-${createHash('sha256')
    .update(certificateIdentity)
    .digest('hex')
    .slice(0, 16)}`;
}

function safeFailureCode(error) {
  return error instanceof AgentError &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : 'INTERNAL_ERROR';
}

export function createAgentRuntime(config, dependencyOverrides = {}) {
  const dependencies = { ...runtimeDefaults(), ...dependencyOverrides };
  const runs = new Map();
  let activeRunId = null;

  const enqueueRunCommand = (run, operation) => {
    const flight = run.commandFlight.then(operation);
    run.commandFlight = flight.catch(() => undefined);
    return flight;
  };

  const authenticate = (authorization) => {
    if (!tokenMatches(config.token, authorization)) {
      throw new AgentError('AUTH_FAILED');
    }
  };

  const emit = (run, type, payload) => {
    run.eventSequence += 1;
    run.lastEventMonotonicMs = Math.max(
      dependencies.monotonicNow(),
      run.lastEventMonotonicMs + 0.001,
    );
    const event = parseAcceptanceEnvelope({
      version: 1,
      type,
      runId: run.id,
      sequence: run.eventSequence,
      wallClockMs: dependencies.now(),
      monotonicMs: run.lastEventMonotonicMs,
      payload,
    });
    run.events.push(event);
    return event;
  };

  const eventsAfter = (run, after = 0) => {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new AgentError('INVALID_REQUEST');
    }
    return run.events.filter((event) => event.sequence > after);
  };

  const captureEvidence = async (run) => {
    const evidence = await dependencies.readEvidence(run);
    if (
      !plainObject(evidence) ||
      !Array.isArray(evidence.samples) ||
      !Array.isArray(evidence.bitrateEvents)
    ) {
      throw new AgentError('EVIDENCE_INVALID');
    }
    for (const sample of evidence.samples.slice(run.sampleCount)) {
      if (!plainObject(sample)) throw new AgentError('EVIDENCE_INVALID');
      emit(run, 'run.sample', { metrics: sample });
    }
    run.sampleCount = evidence.samples.length;
    for (const event of evidence.bitrateEvents.slice(run.bitrateEventCount)) {
      if (!plainObject(event)) throw new AgentError('EVIDENCE_INVALID');
      emit(run, 'run.sample', {
        metrics: { recordType: 'bitrate', event },
      });
    }
    run.bitrateEventCount = evidence.bitrateEvents.length;
  };

  const cleanupRun = async (run) => {
    if (
      run.cleanup?.restoredFirewall === true &&
      run.cleanup.childrenStopped === true
    ) {
      return run.cleanup;
    }
    if (run.cleanupFlight !== null) return run.cleanupFlight;
    run.cleanupFlight = (async () => {
      if (run.heartbeatTimer !== null) {
        dependencies.clearInterval(run.heartbeatTimer);
        run.heartbeatTimer = null;
      }
      if (run.timeoutTimer !== null) {
        dependencies.clearTimeout(run.timeoutTimer);
        run.timeoutTimer = null;
      }
      let childrenStopped = run.cleanup?.childrenStopped === true;
      if (!childrenStopped) {
        const stopped = await Promise.allSettled(
          run.children.map((child) => child.stop()),
        );
        childrenStopped = stopped.every(
          (result) => result.status === 'fulfilled' && result.value === true,
        );
      }
      let restoredFirewall = run.cleanup?.restoredFirewall === true;
      if (!restoredFirewall) {
        try {
          const firewall = await dependencies.removeFirewall(config, run);
          restoredFirewall = firewall?.pass === true;
        } catch {
          restoredFirewall = false;
        }
      }
      run.cleanup = Object.freeze({ restoredFirewall, childrenStopped });
      return run.cleanup;
    })();
    try {
      return await run.cleanupFlight;
    } finally {
      run.cleanupFlight = null;
    }
  };

  const emitCleanup = (run) => {
    const cleanupEventKey = `${String(run.cleanup.restoredFirewall)}:${String(
      run.cleanup.childrenStopped,
    )}`;
    if (run.cleanupEventKey !== cleanupEventKey) {
      run.cleanupEventKey = cleanupEventKey;
      emit(run, 'cleanup.ack', run.cleanup);
    }
    if (
      run.cleanup.restoredFirewall === true &&
      run.cleanup.childrenStopped === true &&
      activeRunId === run.id
    ) {
      activeRunId = null;
    }
  };

  const failRun = async (run, error) => {
    if (run.failureFlight !== null) return run.failureFlight;
    run.failureFlight = (async () => {
      if (!['failed', 'cleaned'].includes(run.state)) {
        run.state = 'failed';
        emit(run, 'run.failure', {
          code: safeFailureCode(error),
          message: '',
        });
      }
      await cleanupRun(run);
      emitCleanup(run);
      run.state = 'cleaned';
    })();
    return run.failureFlight;
  };

  const buildManifest = async () => {
    const signatureVerified = await dependencies.verifyPackageSignature(
      config.desktopPackage,
      config.commands.artifacts.executable,
      platform(),
    );
    if (signatureVerified !== true) {
      throw new AgentError('PACKAGE_SIGNATURE_INVALID');
    }
    const files = [
      ['package', config.desktopPackage],
      ['executable', config.commands.artifacts.executable],
      ['app.asar', config.commands.artifacts.asar],
      ...config.commands.artifacts.resources.map((path, index) => [
        `resource-${index + 1}-${basename(path)}`,
        path,
      ]),
    ];
    const hashed = await Promise.all(
      files.map(async ([name, path]) => ({
        name,
        sha256: await dependencies.hashFile(path),
      })),
    );
    if (hashed[0].sha256 !== config.expectedPackageSha256) {
      throw new AgentError('PACKAGE_HASH_MISMATCH');
    }
    return { files: hashed };
  };

  const validateCommandClock = (run, message) => {
    if (message.sequence !== run.commandSequence + 1) {
      throw new AgentError('SEQUENCE_REPLAY');
    }
    if (message.monotonicMs <= run.lastCommandMonotonicMs) {
      throw new AgentError('MONOTONIC_REPLAY');
    }
    if (Math.abs(message.wallClockMs - dependencies.now()) > 5_000) {
      throw new AgentError('CLOCK_SKEW');
    }
    run.commandSequence = message.sequence;
    run.lastCommandMonotonicMs = message.monotonicMs;
  };

  const prepareRun = async (run, message, context) => {
    if (run.state !== 'capable') throw new AgentError('INVALID_STATE');
    exactKeys(context, ['role', 'serverUrl']);
    if (!['publisher', 'receiver'].includes(context.role)) {
      throw new AgentError('INVALID_REQUEST');
    }
    let serverUrl;
    try {
      serverUrl = new URL(context.serverUrl);
    } catch {
      throw new AgentError('INVALID_REQUEST');
    }
    if (
      serverUrl.protocol !== 'https:' ||
      serverUrl.username !== '' ||
      serverUrl.password !== '' ||
      serverUrl.hash !== ''
    ) {
      throw new AgentError('INVALID_REQUEST');
    }
    const actualHash = await dependencies.hashFile(config.desktopPackage);
    if (
      actualHash !== config.expectedPackageSha256 ||
      message.payload.packageSha256 !== config.expectedPackageSha256
    ) {
      throw new AgentError('PACKAGE_HASH_MISMATCH');
    }
    await dependencies.installPackage(config.commands.install, {
      cwd: run.directory,
      env: childEnvironment(),
    });
    const signatureVerified = await dependencies.verifyPackageSignature(
      config.desktopPackage,
      config.commands.artifacts.executable,
      platform(),
    );
    if (signatureVerified !== true) {
      throw new AgentError('PACKAGE_SIGNATURE_INVALID');
    }
    run.context = Object.freeze({
      role: context.role,
      serverUrl: serverUrl.href,
      source: message.payload.source,
      path: message.payload.path,
    });
    await writeFile(
      resolve(run.directory, 'run-config.json'),
      `${JSON.stringify({
        runId: run.id,
        ...run.context,
        samplesFile: resolve(run.directory, 'samples.json'),
        bitrateEventsFile: resolve(run.directory, 'bitrate-events.json'),
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    if (message.payload.path === 'relay') {
      run.firewallInstallAttempted = true;
      const firewall = await dependencies.installFirewall(config, run);
      if (firewall?.installed !== true) {
        throw new AgentError('FIREWALL_INSTALL_UNPROVEN');
      }
      run.firewallInstalled = true;
    }
    run.signatureVerified = true;
    run.state = 'prepared';
    emit(run, 'run.prepare', message.payload);
    return {
      packageSha256: actualHash,
      signatureVerified: true,
    };
  };

  const startRun = async (run, message) => {
    if (run.state !== 'prepared') throw new AgentError('INVALID_STATE');
    const runConfigArgument = `--run-config-file=${resolve(
      run.directory,
      'run-config.json',
    )}`;
    const specifications = [
      config.commands.desktop,
      config.commands.motion,
      config.commands.audio,
      {
        command: config.commands.driver.command,
        args: [...config.commands.driver.args, runConfigArgument],
      },
    ];
    run.children = [];
    for (const specification of specifications) {
      run.children.push(
        dependencies.spawnTracked(specification, {
          cwd: run.directory,
          env: childEnvironment(),
        }),
      );
    }
    run.state = 'running';
    emit(run, 'run.start', message.payload);
    for (const child of run.children) {
      void child.exited.then((code) => {
        if (run.state === 'running' && code !== null) {
          void failRun(run, new AgentError('CHILD_EXITED'));
        }
      });
    }
    run.heartbeatTimer = dependencies.setInterval(() => {
      if (run.state !== 'running') return;
      emit(run, 'run.heartbeat', {});
      void captureEvidence(run).catch((error) => failRun(run, error));
    }, 1_000);
    run.timeoutTimer = dependencies.setTimeout(() => {
      if (run.state === 'running') {
        void failRun(run, new AgentError('RUN_TIMEOUT'));
      }
    }, message.payload.durationMs + 10_000);
    return {};
  };

  const applyNetworkFaultCommand = async (run, message) => {
    if (run.state !== 'running') throw new AgentError('INVALID_STATE');
    if (run.firewallInstalled !== true) {
      throw new AgentError('NETWORK_FAULT_UNSUPPORTED');
    }
    const profile = message.payload.profile;
    if (profile === 'turn-relay-range') {
      throw new AgentError('NETWORK_FAULT_REQUIRES_SERVICE');
    }
    if (run.activeNetworkFault !== null && run.activeNetworkFault !== profile) {
      throw new AgentError('NETWORK_FAULT_ACTIVE');
    }
    const changed = run.activeNetworkFault === null;
    const fault = changed
      ? await dependencies.applyNetworkFault(config, run, profile)
      : await dependencies.inspectNetworkFault(config, run, profile, true);
    if (
      fault?.profile !== profile ||
      fault.scope !== 'client-egress' ||
      fault.active !== true ||
      !matchesFirewallNetworkFaultRuleEvidence(fault, profile)
    ) {
      throw new AgentError('NETWORK_FAULT_APPLY_UNPROVEN');
    }
    const ruleEvidence = firewallRuleEvidenceForNetworkFault(profile);
    run.activeNetworkFault = profile;
    emit(run, 'network.fault.apply', message.payload);
    return {
      networkFault: Object.freeze({
        profile,
        scope: 'client-egress',
        active: true,
        changed,
        enabledRuleIds: ruleEvidence.enabledRuleIds,
        disabledRuleIds: ruleEvidence.disabledRuleIds,
      }),
    };
  };

  const clearNetworkFaultCommand = async (run, message) => {
    if (run.state !== 'running') throw new AgentError('INVALID_STATE');
    if (run.firewallInstalled !== true) {
      throw new AgentError('NETWORK_FAULT_UNSUPPORTED');
    }
    const profile = message.payload.profile;
    if (profile === 'turn-relay-range') {
      throw new AgentError('NETWORK_FAULT_REQUIRES_SERVICE');
    }
    if (run.activeNetworkFault !== null && run.activeNetworkFault !== profile) {
      throw new AgentError('NETWORK_FAULT_ACTIVE');
    }
    const changed = run.activeNetworkFault === profile;
    const fault = changed
      ? await dependencies.clearNetworkFault(config, run, profile)
      : await dependencies.inspectNetworkFault(config, run, profile, false);
    if (
      fault?.profile !== profile ||
      fault.scope !== 'client-egress' ||
      fault.active !== false ||
      !matchesFirewallNetworkFaultRuleEvidence(fault)
    ) {
      throw new AgentError('NETWORK_FAULT_CLEAR_UNPROVEN');
    }
    const ruleEvidence = firewallRuleEvidenceForNetworkFault();
    run.activeNetworkFault = null;
    emit(run, 'network.fault.clear', message.payload);
    return {
      networkFault: Object.freeze({
        profile,
        scope: 'client-egress',
        active: false,
        changed,
        enabledRuleIds: ruleEvidence.enabledRuleIds,
        disabledRuleIds: ruleEvidence.disabledRuleIds,
      }),
    };
  };

  const stopRun = async (run) => {
    if (run.state !== 'running') throw new AgentError('INVALID_STATE');
    await captureEvidence(run);
    run.state = 'stopping';
    emit(run, 'run.stop', {});
    await cleanupRun(run);
    const manifest = await buildManifest();
    emit(run, 'artifact.manifest', manifest);
    emitCleanup(run);
    run.state = 'cleaned';
    return { cleanup: run.cleanup, manifest };
  };

  const cancelRun = async (run, message) => {
    const retryingCleanup =
      run.cleanup !== null &&
      (run.cleanup.restoredFirewall !== true ||
        run.cleanup.childrenStopped !== true);
    if (
      run.cleanup?.restoredFirewall === true &&
      run.cleanup.childrenStopped === true
    ) {
      return { cleanup: run.cleanup };
    }
    if (
      !retryingCleanup &&
      !['capable', 'prepared', 'running', 'stopping'].includes(run.state)
    ) {
      throw new AgentError('INVALID_STATE');
    }
    if (!retryingCleanup) {
      run.state = 'canceling';
      emit(run, 'run.cancel', message.payload);
    }
    await cleanupRun(run);
    emitCleanup(run);
    run.state = 'cleaned';
    return { cleanup: run.cleanup };
  };

  return Object.freeze({
    async register(request) {
      exactKeys(request, ['authorization', 'runId']);
      authenticate(request.authorization);
      if (!RUN_ID_PATTERN.test(request.runId ?? '')) {
        throw new AgentError('INVALID_RUN_ID');
      }
      if (activeRunId !== null) throw new AgentError('RUN_BUSY');
      const directory = resolve(config.workDir, request.runId);
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const run = {
        id: request.runId,
        directory,
        state: 'capable',
        events: [],
        eventSequence: 0,
        commandSequence: 0,
        commandFlight: Promise.resolve(),
        lastEventMonotonicMs: -1,
        lastCommandMonotonicMs: -1,
        children: [],
        cleanup: null,
        cleanupEventKey: null,
        cleanupFlight: null,
        failureFlight: null,
        heartbeatTimer: null,
        timeoutTimer: null,
        sampleCount: 0,
        bitrateEventCount: 0,
        context: null,
        signatureVerified: false,
        firewallInstallAttempted: false,
        firewallInstalled: false,
        firewallRequest: null,
        firewallState: null,
        firewallStatus: null,
        activeNetworkFault: null,
      };
      runs.set(run.id, run);
      activeRunId = run.id;
      emit(run, 'agent.register', {
        agentId: safeAgentId(config),
        platform: platform(),
        architecture: arch(),
      });
      emit(run, 'capability.report', {
        screenSources: ['window', 'monitor'],
        canInstallFirewall: ['win32', 'darwin'].includes(platform()),
        canVerifySignature: ['win32', 'darwin'].includes(platform()),
      });
      return {
        packageSha256: config.expectedPackageSha256,
        events: eventsAfter(run),
      };
    },
    async command(request) {
      const expectedKeys =
        request.context === undefined
          ? ['authorization', 'message']
          : ['authorization', 'message', 'context'];
      exactKeys(request, expectedKeys);
      authenticate(request.authorization);
      const message = parseAcceptanceEnvelope(request.message);
      if (!COMMAND_TYPES.has(message.type)) {
        throw new AgentError('INVALID_COMMAND');
      }
      const run = runs.get(message.runId);
      if (run === undefined) throw new AgentError('RUN_NOT_FOUND');
      return enqueueRunCommand(run, async () => {
        validateCommandClock(run, message);
        try {
          switch (message.type) {
            case 'run.prepare':
              return await prepareRun(run, message, request.context);
            case 'run.start':
              if (request.context !== undefined)
                throw new AgentError('INVALID_REQUEST');
              return await startRun(run, message);
            case 'network.fault.apply':
              if (request.context !== undefined)
                throw new AgentError('INVALID_REQUEST');
              return await applyNetworkFaultCommand(run, message);
            case 'network.fault.clear':
              if (request.context !== undefined)
                throw new AgentError('INVALID_REQUEST');
              return await clearNetworkFaultCommand(run, message);
            case 'run.stop':
              if (request.context !== undefined)
                throw new AgentError('INVALID_REQUEST');
              return await stopRun(run);
            case 'run.cancel':
              if (request.context !== undefined)
                throw new AgentError('INVALID_REQUEST');
              return await cancelRun(run, message);
            default:
              throw new AgentError('INVALID_COMMAND');
          }
        } catch (error) {
          await failRun(run, error);
          throw new AgentError(safeFailureCode(error));
        }
      });
    },
    poll(request) {
      exactKeys(request, ['authorization', 'runId', 'after']);
      authenticate(request.authorization);
      const run = runs.get(request.runId);
      if (run === undefined) throw new AgentError('RUN_NOT_FOUND');
      return { events: eventsAfter(run, request.after) };
    },
    async shutdown() {
      if (activeRunId === null) return;
      const run = runs.get(activeRunId);
      if (run !== undefined) {
        await enqueueRunCommand(run, () =>
          cancelRun(
            run,
            parseAcceptanceEnvelope({
              version: 1,
              type: 'run.cancel',
              runId: run.id,
              sequence: run.commandSequence + 1,
              wallClockMs: dependencies.now(),
              monotonicMs: dependencies.monotonicNow(),
              payload: { reason: 'agent shutdown' },
            }),
          ),
        );
      }
    },
    getSnapshot() {
      return Object.freeze({ activeRunId, runCount: runs.size });
    },
  });
}

function readRequestBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new AgentError('REQUEST_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new AgentError('INVALID_JSON'));
      }
    });
    request.on('error', () => rejectPromise(new AgentError('INVALID_REQUEST')));
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function statusForError(error) {
  if (error?.code === 'AUTH_FAILED') return 401;
  if (['RUN_BUSY', 'INVALID_STATE', 'SEQUENCE_REPLAY'].includes(error?.code)) {
    return 409;
  }
  if (error?.code === 'RUN_NOT_FOUND') return 404;
  return 400;
}

export function createAgentHttpsService(config, runtime) {
  const server = createHttpsServer(
    {
      cert: config.cert,
      key: config.key,
      minVersion: 'TLSv1.3',
      requestCert: false,
    },
    async (request, response) => {
      try {
        const target = new URL(request.url, config.listen);
        const authorization = request.headers.authorization;
        if (request.method === 'POST' && target.pathname === '/v1/register') {
          const body = await readRequestBody(request);
          exactKeys(body, ['runId']);
          sendJson(
            response,
            200,
            await runtime.register({ authorization, runId: body.runId }),
          );
          return;
        }
        if (request.method === 'POST' && target.pathname === '/v1/command') {
          const body = await readRequestBody(request);
          const expectedKeys =
            body.context === undefined
              ? ['message', 'after']
              : ['message', 'after', 'context'];
          exactKeys(body, expectedKeys);
          const result = await runtime.command({
            authorization,
            message: body.message,
            ...(body.context === undefined ? {} : { context: body.context }),
          });
          const polled = runtime.poll({
            authorization,
            runId: body.message?.runId,
            after: body.after,
          });
          sendJson(response, 200, { ...result, events: polled.events });
          return;
        }
        if (request.method === 'GET' && target.pathname === '/v1/events') {
          if (
            [...target.searchParams.keys()].sort().join(',') !== 'after,runId'
          ) {
            throw new AgentError('INVALID_REQUEST');
          }
          const after = Number(target.searchParams.get('after'));
          sendJson(
            response,
            200,
            runtime.poll({
              authorization,
              runId: target.searchParams.get('runId'),
              after,
            }),
          );
          return;
        }
        sendJson(response, 404, { code: 'NOT_FOUND' });
      } catch (error) {
        const code = safeFailureCode(error);
        sendJson(response, statusForError(error), { code });
      }
    },
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function mainAgent(argv = process.argv.slice(2)) {
  const parsed = parseAgentCli(argv);
  const config = await loadAgentConfiguration(parsed);
  const runtime = createAgentRuntime(config);
  const server = createAgentHttpsService(config, runtime);
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(
      Number(config.listen.port),
      config.listen.hostname,
      resolvePromise,
    );
  });
  console.log(
    JSON.stringify({
      event: 'agent_listening',
      host: config.listen.hostname,
      port: Number(config.listen.port),
    }),
  );
  const close = async () => {
    await runtime.shutdown();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  mainAgent().catch((error) => {
    console.error(
      JSON.stringify({ event: 'agent_failed', code: safeFailureCode(error) }),
    );
    process.exitCode = 1;
  });
}
