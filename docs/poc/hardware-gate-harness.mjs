import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  createServer as createNetServer,
  connect as connectTcp,
} from 'node:net';
import { createSocket } from 'node:dgram';
import { arch, cpus, hostname, release, type, version } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BITRATE_SETTLE_WINDOW_MS,
  BITRATE_TARGETS_MBPS,
  evaluateBitrateGate,
  evaluateCodecGate,
  evaluateHardwareRoleGate,
  evaluateLegacyDesktopCertificationScope,
  evaluateLegacyHardwareGate,
  QUALITY_TARGET_BITRATE_BPS,
} from './hardware-gate-policy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const resultsRoot = join(scriptDirectory, 'results');
const repositoryRoot = resolve(scriptDirectory, '../..');
const motionAppDirectory = join(scriptDirectory, 'hardware-gate-motion-source');
const desktopAppDirectory = join(repositoryRoot, 'apps/media-lab-desktop');
const serverEntry = join(repositoryRoot, 'apps/media-lab-server/dist/index.js');
const electronExecutable = join(
  desktopAppDirectory,
  'node_modules/electron/dist/electron.exe',
);
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const WSS_PORT = 4_443;
const RTC_PORT = 44_444;
const WSS_URL = `wss://127.0.0.1:${WSS_PORT}`;
const PRODUCT_EXPORT_TITLE = 'Export media lab stats';
const EXPECTED_WINDOWS_CODEC = Object.freeze({
  mimeType: 'video/H264',
  profileLevelId: '42001f',
});
const CAPTURE_SCOPE = Object.freeze({
  separatePhysicalDevices: false,
  sourceType: 'window',
  validates: 'window-desktop-share-path',
  validatesWholeMonitor: false,
});

function printHelp() {
  console.log(`Local 1080p60 hardware gate (does not use external RTC services)

Usage:
  node docs/poc/hardware-gate-harness.mjs --preflight
  node docs/poc/hardware-gate-harness.mjs --duration=600

Options:
  --preflight               Run bitrate checks plus a 45 second quality window. Never marks hardware PASS.
  --duration=<seconds>      Quality-window duration; this same-host harness remains non-certifying.
  --proxy-server=<url>      Explicit Chromium proxy (default http://127.0.0.1:7890).
  --output=<relative-path>  Result directory below docs/poc/results/.
  --skip-build              Reuse existing product build outputs; still generates a run TLS cert.
  --help                    Show this help.

Environment:
  WO_HARDWARE_GATE_PROXY    Explicit proxy alternative to --proxy-server.
`);
}

function parseArguments(arguments_) {
  const values = new Map();
  const flags = new Set();
  for (const argument of arguments_) {
    if (!argument.startsWith('--'))
      throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf('=');
    if (separator === -1) flags.add(argument.slice(2));
    else
      values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }

  const allowedFlags = new Set(['preflight', 'skip-build', 'help']);
  const allowedValues = new Set(['duration', 'proxy-server', 'output']);
  for (const flag of flags) {
    if (!allowedFlags.has(flag)) throw new Error(`Unknown option: --${flag}`);
  }
  for (const key of values.keys()) {
    if (!allowedValues.has(key)) throw new Error(`Unknown option: --${key}`);
  }

  const preflight = flags.has('preflight');
  const durationText = values.get('duration');
  const durationSeconds = durationText
    ? Number(durationText)
    : preflight
      ? 45
      : 600;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 30) {
    throw new Error('--duration must be an integer of at least 30 seconds');
  }
  if (preflight && durationText) {
    throw new Error('Use either --preflight or --duration, not both');
  }

  const proxyServer =
    values.get('proxy-server') ??
    process.env.WO_HARDWARE_GATE_PROXY ??
    'http://127.0.0.1:7890';
  const proxyUrl = new URL(proxyServer);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxyUrl.protocol)) {
    throw new Error('--proxy-server must use http, https, socks4, or socks5');
  }
  if (proxyUrl.username || proxyUrl.password) {
    throw new Error(
      'Proxy credentials must not be embedded in the harness arguments',
    );
  }
  if (
    (proxyUrl.pathname && proxyUrl.pathname !== '/') ||
    proxyUrl.search ||
    proxyUrl.hash
  ) {
    throw new Error('Proxy URL must contain only a scheme, host, and port');
  }
  const normalizedProxyServer = `${proxyUrl.protocol}//${proxyUrl.host}`;

  const runId = `hardware-gate-${new Date()
    .toISOString()
    .replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const requestedOutput = values.get('output');
  if (requestedOutput && isAbsolute(requestedOutput)) {
    throw new Error('--output must be relative to docs/poc/results');
  }
  const outputDirectory = resolve(
    resultsRoot,
    requestedOutput ?? join('runs', runId),
  );
  const outputRelative = relative(resultsRoot, outputDirectory);
  if (outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
    throw new Error('--output must remain below docs/poc/results');
  }

  return Object.freeze({
    help: flags.has('help'),
    preflight,
    formal: !preflight && durationSeconds >= 600,
    durationSeconds,
    proxyServer: normalizedProxyServer,
    proxyBypassList: '127.0.0.1;localhost;[::1]',
    outputDirectory,
    runId,
    skipBuild: flags.has('skip-build'),
  });
}

function sanitizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return { name: 'Error', message: String(error), stack: null };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function createOrValidateEmptyOutputDirectory(path) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { recursive: false });
    return { created: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(
        `Output directory must be new or empty; found ${entries.length} existing item(s): ${path}`,
        { cause: error },
      );
    }
    return { created: false };
  }
}

function createLogger(path) {
  const stream = createWriteStream(path, { flags: 'wx', encoding: 'utf8' });
  return {
    log(event, details = {}) {
      const record = { timestamp: new Date().toISOString(), event, ...details };
      const line = `${JSON.stringify(record)}\n`;
      stream.write(line);
      console.log(`[${record.timestamp}] ${event}`);
    },
    child(name, channel, chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line) this.log('child-output', { name, channel, line });
      }
    },
    close() {
      return new Promise((resolveClose) => stream.end(resolveClose));
    },
  };
}

function spawnProcess(name, command, arguments_, options, logger, managed) {
  logger.log('process-spawn', { name, command, arguments: arguments_ });
  const child = spawn(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logger.child(name, 'stdout', chunk));
  child.stderr.on('data', (chunk) => logger.child(name, 'stderr', chunk));
  child.once('error', (error) =>
    logger.log('process-error', { name, error: sanitizeError(error) }),
  );
  child.once('exit', (code, signal) =>
    logger.log('process-exit', { name, code, signal }),
  );
  if (managed) {
    managed.push({
      name,
      child,
      rootPid: Number.isInteger(child.pid) ? child.pid : null,
      rootIdentity: null,
      ownedIdentities: new Map(),
      trackingErrors: [],
    });
  }
  return child;
}

async function runCommand(name, command, arguments_, options, logger) {
  const child = spawnProcess(
    name,
    command,
    arguments_,
    { ...options, windowsHide: true },
    logger,
    null,
  );
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (exitCode) => resolveExit(exitCode));
  });
  if (code !== 0) throw new Error(`${name} exited with code ${code}`);
}

async function runCapture(command, arguments_, options = {}) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', rejectCapture);
    child.once('exit', (code) => {
      if (code === 0) resolveCapture({ stdout, stderr });
      else
        rejectCapture(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function windowsProcessIdentity(processRecord) {
  return {
    pid: Number(processRecord.pid ?? processRecord.processId),
    parentPid: Number(processRecord.parentPid ?? processRecord.parentProcessId),
    name: String(processRecord.name ?? ''),
    creationDate: processRecord.creationDate ?? null,
  };
}

function processIdentityKey(identity) {
  return `${identity.pid}:${identity.creationDate ?? 'missing'}`;
}

function sameWindowsProcessIdentity(identity, processRecord) {
  return (
    identity.creationDate !== null &&
    Number(processRecord?.pid ?? processRecord?.processId) === identity.pid &&
    processRecord?.creationDate === identity.creationDate
  );
}

async function listWindowsProcesses() {
  const script = String.raw`
$items = @(
  Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
      processId = [int]$_.ProcessId
      parentProcessId = [int]$_.ParentProcessId
      name = [string]$_.Name
      creationDate = if ($null -eq $_.CreationDate) {
        $null
      } else {
        $_.CreationDate.ToUniversalTime().ToString('o')
      }
    }
  }
)
ConvertTo-Json -InputObject $items -Depth 3 -Compress
`;
  const { stdout } = await runCapture(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { env: process.env },
  );
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(
    windowsProcessIdentity,
  );
}

async function refreshManagedProcessTrees(managed, logger) {
  if (process.platform !== 'win32') return;
  const processes = await listWindowsProcesses();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const childrenByParent = new Map();
  for (const processRecord of processes) {
    const children = childrenByParent.get(processRecord.parentPid) ?? [];
    children.push(processRecord);
    childrenByParent.set(processRecord.parentPid, children);
  }

  for (const entry of managed) {
    let newlyRecorded = 0;
    const rootProcess = Number.isInteger(entry.rootPid)
      ? byPid.get(entry.rootPid)
      : null;
    if (!entry.rootIdentity && rootProcess) {
      entry.rootIdentity = windowsProcessIdentity(rootProcess);
    }
    if (entry.rootIdentity) {
      const key = processIdentityKey(entry.rootIdentity);
      if (!entry.ownedIdentities.has(key)) newlyRecorded += 1;
      entry.ownedIdentities.set(key, entry.rootIdentity);
    }

    const queued = [];
    const visitedPids = new Set();
    for (const identity of entry.ownedIdentities.values()) {
      const current = byPid.get(identity.pid);
      if (sameWindowsProcessIdentity(identity, current))
        queued.push(identity.pid);
    }
    while (queued.length > 0) {
      const parentPid = queued.shift();
      if (visitedPids.has(parentPid)) continue;
      visitedPids.add(parentPid);
      for (const child of childrenByParent.get(parentPid) ?? []) {
        const identity = windowsProcessIdentity(child);
        const key = processIdentityKey(identity);
        if (!entry.ownedIdentities.has(key)) newlyRecorded += 1;
        entry.ownedIdentities.set(key, identity);
        queued.push(identity.pid);
      }
    }

    if (!entry.rootIdentity && Number.isInteger(entry.rootPid)) {
      const message = `Root PID ${entry.rootPid} exited before its Windows process identity could be recorded`;
      if (!entry.trackingErrors.includes(message))
        entry.trackingErrors.push(message);
    }
    for (const identity of entry.ownedIdentities.values()) {
      if (identity.creationDate === null) {
        const message = `PID ${identity.pid} has no creation-time identity and cannot be terminated safely`;
        if (!entry.trackingErrors.includes(message))
          entry.trackingErrors.push(message);
      }
    }
    if (newlyRecorded > 0) {
      logger.log('owned-process-identities-recorded', {
        name: entry.name,
        newlyRecorded,
        totalRecorded: entry.ownedIdentities.size,
      });
    }
  }
}

async function terminateWindowsProcessIdentity(identity) {
  if (identity.creationDate === null) {
    return { status: 'unsafe-missing-creation-date' };
  }
  const script = String.raw`
$pidValue = [int]$env:WO_OWNED_PID
$expectedCreation = $env:WO_OWNED_CREATION
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
if ($null -eq $process) {
  @{ status = 'absent' } | ConvertTo-Json -Compress
  exit 0
}
$actualCreation = $process.CreationDate.ToUniversalTime().ToString('o')
if ($actualCreation -ne $expectedCreation) {
  @{ status = 'identity-mismatch'; actualCreation = $actualCreation } | ConvertTo-Json -Compress
  exit 0
}
& taskkill.exe /PID $pidValue /T /F 2>$null | Out-Null
$taskkillExitCode = $LASTEXITCODE
@{ status = 'terminate-requested'; taskkillExitCode = $taskkillExitCode } | ConvertTo-Json -Compress
exit 0
`;
  const { stdout } = await runCapture(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        WO_OWNED_PID: String(identity.pid),
        WO_OWNED_CREATION: identity.creationDate,
      },
    },
  );
  return JSON.parse(stdout.trim());
}

async function isTcpPortFree(port) {
  return new Promise((resolveFree) => {
    const server = createNetServer();
    server.unref();
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () =>
      server.close(() => resolveFree(true)),
    );
  });
}

async function isUdpPortFree(port) {
  return new Promise((resolveFree) => {
    const socket = createSocket('udp4');
    socket.unref();
    socket.once('error', () => {
      socket.close();
      resolveFree(false);
    });
    socket.bind(port, '127.0.0.1', () => {
      socket.close(() => resolveFree(true));
    });
  });
}

async function isEndpointFree(endpoint) {
  return endpoint.protocol === 'udp'
    ? isUdpPortFree(endpoint.port)
    : isTcpPortFree(endpoint.port);
}

async function allocateTcpPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (port === null)
          rejectPort(new Error('Unable to allocate port'));
        else resolvePort(port);
      });
    });
  });
}

async function allocateUniqueTcpPorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await allocateTcpPort());
  return [...ports];
}

async function waitForTcpPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolveOpen) => {
      const socket = connectTcp({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolveOpen(true);
      });
      const fail = () => {
        socket.destroy();
        resolveOpen(false);
      };
      socket.once('error', fail);
      socket.once('timeout', fail);
    });
    if (open) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}

async function fetchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok)
    throw new Error(`DevTools endpoint returned ${response.status}`);
  return response.json();
}

async function waitForTargets(port, predicate, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = (await fetchTargets(port)).filter(predicate);
      if (lastTargets.length >= count) return lastTargets;
    } catch {
      // The debugger HTTP endpoint starts after the process itself.
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${count} DevTools target(s) on ${port}; found ${lastTargets.length}`,
  );
}

class DevtoolsClient {
  constructor(webSocketUrl, label) {
    this.webSocketUrl = webSocketUrl;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('Node 24 WebSocket support is required');
    }
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(
        () => rejectOpen(new Error(`${this.label} debugger open timed out`)),
        10_000,
      );
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolveOpen();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          rejectOpen(new Error(`${this.label} debugger connection failed`));
        },
        { once: true },
      );
    });
    this.socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${this.label} debugger closed`));
      }
      this.pending.clear();
    });
    await this.send('Runtime.enable');
    return this;
  }

  async handleMessage(data) {
    let text;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer)
      text = Buffer.from(data).toString('utf8');
    else if (typeof data?.arrayBuffer === 'function') {
      text = Buffer.from(await data.arrayBuffer()).toString('utf8');
    } else text = String(data);

    const message = JSON.parse(text);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.label} debugger is not open`));
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${this.label} ${method} timed out`));
      }, 20_000);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, options = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: options.userGesture ?? false,
    });
    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'Runtime.evaluate failed';
      throw new Error(`${this.label}: ${description}`);
    }
    return response.result?.value;
  }

  async click(selector) {
    const rectangle = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Missing element');
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error('Element is not visible');
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rectangle.x,
      y: rectangle.y,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rectangle.x,
      y: rectangle.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rectangle.x,
      y: rectangle.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async domClick(selector) {
    await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLButtonElement)) throw new Error('Missing button');
      if (element.disabled) throw new Error('Button is disabled');
      element.click();
    })()`);
  }

  close() {
    this.socket?.close();
  }
}

async function connectTarget(target, label) {
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`${label} target has no debugger WebSocket URL`);
  }
  return new DevtoolsClient(target.webSocketDebuggerUrl, label).connect();
}

const installRtcInstrumentationExpression = String.raw`(() => {
  if (globalThis.__woHardwareGateRtc) return { installed: true, reused: true };
  const peerConnections = [];
  const prototype = globalThis.RTCPeerConnection?.prototype;
  if (!prototype || typeof prototype.getStats !== 'function') {
    throw new Error('RTCPeerConnection.getStats is unavailable');
  }
  const nativeGetStats = prototype.getStats;
  const nativeAddTransceiver = prototype.addTransceiver;
  const recordPeerConnection = (connection) => {
    if (!peerConnections.includes(connection)) peerConnections.push(connection);
  };
  Object.defineProperty(prototype, 'getStats', {
    configurable: true,
    writable: true,
    value: function (...arguments_) {
      recordPeerConnection(this);
      return nativeGetStats.apply(this, arguments_);
    },
  });
  if (typeof nativeAddTransceiver === 'function') {
    Object.defineProperty(prototype, 'addTransceiver', {
      configurable: true,
      writable: true,
      value: function (...arguments_) {
        recordPeerConnection(this);
        return nativeAddTransceiver.apply(this, arguments_);
      },
    });
  }
  Object.defineProperty(globalThis, '__woHardwareGateRtc', {
    configurable: false,
    value: {
      peerConnections,
      nativeGetStats,
      nativeAddTransceiver,
      previousLuma: null,
      includeRtcStats: true,
    },
    writable: false,
  });
  return { installed: true, reused: false };
})()`;

const snapshotRendererExpression = String.raw`(async () => {
  const state = globalThis.__woHardwareGateRtc;
  if (!state) throw new Error('RTC instrumentation is not installed');
  const video = document.querySelector('#video');
  const track = video?.srcObject?.getVideoTracks?.()[0] ?? null;
  const captureSettings = track?.getSettings?.() ?? null;
  const captureConstraints = track?.getConstraints?.() ?? null;
  let captureCapabilities = null;
  try { captureCapabilities = track?.getCapabilities?.() ?? null; } catch {}

  const peerConnections = [];
  for (let index = 0; state.includeRtcStats && index < state.peerConnections.length; index += 1) {
    const connection = state.peerConnections[index];
    const entry = {
      index,
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      signalingState: connection.signalingState,
      stats: [],
      senders: [],
      receivers: [],
      error: null,
    };
    try {
      const report = await state.nativeGetStats.call(connection);
      entry.stats = [...report.values()].map((record) => ({ ...record }));
      entry.senders = connection.getSenders().map((sender) => ({
        track: sender.track
          ? { kind: sender.track.kind, settings: sender.track.getSettings() }
          : null,
        parameters: sender.getParameters(),
      }));
      entry.receivers = connection.getReceivers().map((receiver) => ({
        track: receiver.track
          ? { kind: receiver.track.kind, settings: receiver.track.getSettings() }
          : null,
        parameters: receiver.getParameters(),
      }));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    peerConnections.push(entry);
  }

  let videoSignal = {
    readyState: video?.readyState ?? 0,
    videoWidth: video?.videoWidth ?? 0,
    videoHeight: video?.videoHeight ?? 0,
    currentTime: video?.currentTime ?? 0,
    brightnessMean: null,
    blackPixelRatio: null,
    meanAbsoluteDelta: null,
    changedPixelRatio: null,
    totalVideoFrames: null,
    droppedVideoFrames: null,
    error: null,
  };
  if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 36;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const luma = new Uint8Array(canvas.width * canvas.height);
      let total = 0;
      let black = 0;
      let totalDelta = 0;
      let changed = 0;
      for (let pixel = 0; pixel < luma.length; pixel += 1) {
        const offset = pixel * 4;
        const value = Math.round(
          rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722,
        );
        luma[pixel] = value;
        total += value;
        if (value < 10) black += 1;
        if (state.previousLuma?.length === luma.length) {
          const delta = Math.abs(value - state.previousLuma[pixel]);
          totalDelta += delta;
          if (delta >= 8) changed += 1;
        }
      }
      const previousExists = state.previousLuma?.length === luma.length;
      state.previousLuma = luma;
      const quality = video.getVideoPlaybackQuality?.();
      videoSignal = {
        ...videoSignal,
        brightnessMean: Math.round((total / luma.length) * 100) / 100,
        blackPixelRatio: Math.round((black / luma.length) * 10_000) / 10_000,
        meanAbsoluteDelta: previousExists
          ? Math.round((totalDelta / luma.length) * 100) / 100
          : null,
        changedPixelRatio: previousExists
          ? Math.round((changed / luma.length) * 10_000) / 10_000
          : null,
        totalVideoFrames: quality?.totalVideoFrames ?? null,
        droppedVideoFrames: quality?.droppedVideoFrames ?? null,
      };
    } catch (error) {
      videoSignal.error = error instanceof Error ? error.message : String(error);
    }
  }

  const text = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
  let renderedCaptureSettings = null;
  try { renderedCaptureSettings = JSON.parse(text('captureSettings') ?? 'null'); } catch {}
  return {
    capturedAt: new Date().toISOString(),
    role: document.body.dataset.role ?? null,
    status: text('statusText'),
    captureSettings,
    captureConstraints,
    captureCapabilities,
    renderedCaptureSettings,
    rtcStatsIncluded: state.includeRtcStats,
    videoSignal,
    metrics: {
      bitrate: text('metricBitrate'),
      codec: text('metricCodec'),
      codecImplementation: text('metricCodecImplementation'),
      direction: text('metricDirection'),
      fps: text('metricFps'),
      rtt: text('metricRtt'),
      loss: text('metricLoss'),
      jitter: text('metricJitter'),
      qualityLimitationReason: text('metricQuality'),
      framesEncoded: text('framesEncoded'),
      framesDecoded: text('framesDecoded'),
      sampleCount: text('sampleCount'),
    },
    peerConnections,
  };
})()`;

async function waitForRendererStatus(
  client,
  expected,
  expectedState = 'ready',
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await client.evaluate(`(() => ({
      text: document.querySelector('#statusText')?.textContent?.trim() ?? null,
      state: document.querySelector('#statusDot')?.dataset?.state ?? null,
    }))()`);
    if (latest.text === expected && latest.state === expectedState)
      return latest;
    if (latest.state === 'error') {
      throw new Error(`${client.label} entered error state: ${latest.text}`);
    }
    await delay(250);
  }
  throw new Error(
    `${client.label} did not reach ${expected}: ${JSON.stringify(latest)}`,
  );
}

async function waitForMotionSourceReady(client, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await client.evaluate(`(() => ({
      ready: globalThis.__WO_MOTION_READY === true,
      dimensions: globalThis.__WO_MOTION_DIMENSIONS ?? null,
      frame: globalThis.__WO_MOTION_FRAME ?? null,
      title: document.title,
    }))()`);
    if (
      latest.ready &&
      latest.dimensions?.width === 1_920 &&
      latest.dimensions?.height === 1_080 &&
      latest.dimensions?.fps === 60
    ) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(
    `Dynamic material did not initialize within ${timeoutMs}ms: ${JSON.stringify(latest)}`,
  );
}

async function selectMotionSource(client, sourceTitle) {
  return client.evaluate(`(async () => {
    const select = document.querySelector('#sourceSelect');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Source select missing');
    let matches = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      matches = [...select.options].filter((option) => option.text.includes(${JSON.stringify(sourceTitle)}));
      if (matches.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (matches.length !== 1) {
      throw new Error('Expected exactly one dynamic material source option, found ' + matches.length);
    }
    const option = matches[0];
    if (!option.value.startsWith('window:')) {
      throw new Error('Dynamic material source is not a window source');
    }
    await window.mediaLab.selectSource(option.value);
    select.value = option.value;
    if (select.value !== option.value) throw new Error('Source option is not present in product UI');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { id: option.value, name: option.text, sourceType: 'window' };
  })()`);
}

async function waitForPeerConnection(client, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await client.evaluate(
      'globalThis.__woHardwareGateRtc?.peerConnections?.length ?? 0',
    );
    if (count > 0) return count;
    await delay(250);
  }
  throw new Error(
    `${client.label} did not expose a captured RTCPeerConnection`,
  );
}

async function waitForVideoDimensions(
  client,
  expectedWidth,
  expectedHeight,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await client.evaluate(`(() => {
      const video = document.querySelector('#video');
      const track = video?.srcObject?.getVideoTracks?.()[0] ?? null;
      return {
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        trackSettings: track?.getSettings?.() ?? null,
      };
    })()`);
    if (
      latest.videoWidth === expectedWidth &&
      latest.videoHeight === expectedHeight
    ) {
      return latest;
    }
    await delay(250);
  }
  throw new Error(
    `${client.label} did not render ${expectedWidth}x${expectedHeight}: ${JSON.stringify(latest)}`,
  );
}

async function installExportDialogQueue(mainClient, exportPaths) {
  return mainClient.evaluate(`(async () => {
    const electronModule =
      typeof require === 'function'
        ? require('electron')
        : process.mainModule?.require
          ? process.mainModule.require('electron')
          : await import('electron');
    const electron = electronModule.default ?? electronModule;
    const dialog = electron.dialog;
    if (!dialog || typeof dialog.showSaveDialog !== 'function') {
      throw new Error('Electron dialog API is unavailable');
    }
    const queue = ${JSON.stringify(exportPaths)};
    const original = dialog.showSaveDialog.bind(dialog);
    const replacement = async (...arguments_) => {
      const options = arguments_.at(-1);
      if (options?.title !== ${JSON.stringify(PRODUCT_EXPORT_TITLE)}) {
        return original(...arguments_);
      }
      const filePath = queue.shift();
      if (!filePath) throw new Error('Hardware gate export queue is empty');
      return { canceled: false, filePath };
    };
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      writable: true,
      value: replacement,
    });
    globalThis.__woHardwareGateDialog = { queue, original, installed: true };
    return { installed: dialog.showSaveDialog === replacement, queued: queue.length };
  })()`);
}

async function waitForJsonFile(path, notBeforeMs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs < notBeforeMs) {
        throw new Error(
          `Export file predates its product click (${metadata.mtimeMs} < ${notBeforeMs})`,
        );
      }
      return { data: await readJson(path), mtimeMs: metadata.mtimeMs };
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for product export ${path}: ${lastError}`);
}

async function collectWindowsMachineInfo() {
  if (process.platform !== 'win32')
    return { available: false, reason: 'not-windows' };
  const script = String.raw`$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, VideoProcessor, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate)
$computer = Get-CimInstance Win32_ComputerSystem
[pscustomobject]@{
  os = [pscustomobject]@{ Caption = $os.Caption; Version = $os.Version; BuildNumber = $os.BuildNumber; OSArchitecture = $os.OSArchitecture }
  computer = [pscustomobject]@{ Manufacturer = $computer.Manufacturer; Model = $computer.Model; TotalPhysicalMemory = $computer.TotalPhysicalMemory }
  cpu = $cpu
  gpu = $gpu
} | ConvertTo-Json -Depth 7 -Compress`;
  try {
    const { stdout } = await runCapture('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    return { available: true, ...JSON.parse(stdout.trim()) };
  } catch (error) {
    return { available: false, error: sanitizeError(error) };
  }
}

async function collectMachineInfo(options) {
  const [windows, desktopPackage, serverPackage] = await Promise.all([
    collectWindowsMachineInfo(),
    readJson(join(desktopAppDirectory, 'package.json')),
    readJson(join(repositoryRoot, 'apps/media-lab-server/package.json')),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    target: {
      os: 'Windows 11 x64',
      gpu: 'NVIDIA GeForce RTX 4080',
      display: '2560x1440 @ 359Hz',
      nodeMajor: 24,
      electronMajor: 43,
    },
    runtime: {
      platform: process.platform,
      arch: arch(),
      hostname: hostname(),
      osType: type(),
      osRelease: release(),
      osVersion: version(),
      node: process.versions,
      cpuSummary: cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
      desktopDependencies: desktopPackage.devDependencies,
      serverDependencies: serverPackage.dependencies,
    },
    windows,
    network: {
      wssUrl: WSS_URL,
      proxyServer: options.proxyServer,
      proxyBypassList: options.proxyBypassList,
    },
  };
}

function flattenSenderMaxBitrates(snapshot) {
  const values = [];
  for (const connection of snapshot.peerConnections ?? []) {
    for (const sender of connection.senders ?? []) {
      if (sender.track?.kind !== 'video') continue;
      for (const encoding of sender.parameters?.encodings ?? []) {
        if (Number.isFinite(encoding.maxBitrate))
          values.push(encoding.maxBitrate);
      }
    }
  }
  return values;
}

function extractPublisherCodecEvidence(snapshot) {
  const candidates = [];
  for (const connection of snapshot.peerConnections ?? []) {
    if (connection.connectionState !== 'connected') continue;
    const stats = connection.stats ?? [];
    const codecs = new Map(
      stats
        .filter((item) => item.type === 'codec')
        .map((item) => [item.id, item]),
    );
    for (const item of stats) {
      if (item.type !== 'outbound-rtp' || item.kind !== 'video') continue;
      const codec = codecs.get(item.codecId);
      candidates.push({
        area:
          (Number.isFinite(item.frameWidth) ? item.frameWidth : 0) *
          (Number.isFinite(item.frameHeight) ? item.frameHeight : 0),
        framesEncoded: Number.isFinite(item.framesEncoded)
          ? item.framesEncoded
          : 0,
        mimeType: codec?.mimeType ?? null,
        sdpFmtpLine: codec?.sdpFmtpLine ?? null,
        encoderImplementation: item.encoderImplementation ?? null,
        powerEfficientEncoder: item.powerEfficientEncoder ?? null,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.area - left.area || right.framesEncoded - left.framesEncoded,
  );
  const selected = candidates[0];
  if (!selected) return null;
  return {
    mimeType: selected.mimeType,
    sdpFmtpLine: selected.sdpFmtpLine,
    encoderImplementation: selected.encoderImplementation,
    powerEfficientEncoder: selected.powerEfficientEncoder,
  };
}

function evaluateMachineGate(machine, electronRuntime) {
  const gpuEntries = Array.isArray(machine.windows?.gpu)
    ? machine.windows.gpu
    : machine.windows?.gpu
      ? [machine.windows.gpu]
      : [];
  const gpuMatch = gpuEntries.some((gpu) => /RTX\s*4080/i.test(gpu.Name ?? ''));
  const displayMatch = gpuEntries.some(
    (gpu) =>
      Number(gpu.CurrentHorizontalResolution) === 2_560 &&
      Number(gpu.CurrentVerticalResolution) === 1_440 &&
      Number(gpu.CurrentRefreshRate) >= 350,
  );
  const checks = {
    windowsX64:
      process.platform === 'win32' &&
      arch() === 'x64' &&
      /Windows 11/i.test(machine.windows?.os?.Caption ?? ''),
    node24: Number(process.versions.node.split('.')[0]) === 24,
    electron43:
      Number(String(electronRuntime?.electron ?? '').split('.')[0]) === 43,
    rtx4080: gpuMatch,
    display2560x1440At359Class: displayMatch,
  };
  return { checks, pass: Object.values(checks).every(Boolean), gpuEntries };
}

async function prepareArtifacts(options, certificateDirectory, logger) {
  await runCommand(
    'generate-run-certificate',
    pnpmExecutable,
    [
      '--filter',
      '@wo/media-lab-server',
      'exec',
      'node',
      'scripts/generate-cert.mjs',
      certificateDirectory,
    ],
    { cwd: repositoryRoot, env: process.env },
    logger,
  );
  if (!options.skipBuild) {
    await runCommand(
      'build-media-lab-server',
      pnpmExecutable,
      ['--filter', '@wo/media-lab-server', 'build'],
      { cwd: repositoryRoot, env: process.env },
      logger,
    );
    await runCommand(
      'build-media-lab-desktop',
      pnpmExecutable,
      ['--filter', '@wo/media-lab-desktop', 'build'],
      { cwd: repositoryRoot, env: process.env },
      logger,
    );
  }
  for (const path of [electronExecutable, serverEntry]) {
    if (!(await pathExists(path)))
      throw new Error(`Required artifact is missing: ${path}`);
  }
}

async function cleanupManagedProcesses(managed, logger) {
  const refreshErrors = [];
  if (process.platform === 'win32') {
    try {
      await refreshManagedProcessTrees(managed, logger);
    } catch (error) {
      refreshErrors.push(sanitizeError(error));
    }
  }

  const results = [];
  for (const entry of [...managed].reverse()) {
    const { name, child, rootPid } = entry;
    const terminationAttempts = [];
    if (process.platform === 'win32') {
      const identities = [...entry.ownedIdentities.values()].sort(
        (left, right) =>
          Number(right.pid === rootPid) - Number(left.pid === rootPid),
      );
      for (const identity of identities) {
        try {
          const outcome = await terminateWindowsProcessIdentity(identity);
          terminationAttempts.push({ identity, ...outcome });
          logger.log('cleanup-process-identity', {
            name,
            identity,
            outcome,
          });
        } catch (error) {
          const detail = sanitizeError(error);
          terminationAttempts.push({
            identity,
            status: 'terminate-failed',
            error: detail,
          });
          logger.log('cleanup-process-identity', {
            name,
            identity,
            status: 'terminate-failed',
            error: detail,
          });
        }
      }
    } else if (Number.isInteger(rootPid) && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
        await delay(1_000);
        if (child.exitCode === null) child.kill('SIGKILL');
        terminationAttempts.push({
          pid: rootPid,
          status: 'terminate-requested',
        });
      } catch (error) {
        terminationAttempts.push({
          pid: rootPid,
          status: 'terminate-failed',
          error: sanitizeError(error),
        });
      }
    }

    results.push({
      name,
      rootPid,
      recordedIdentities: [...entry.ownedIdentities.values()],
      trackingErrors: entry.trackingErrors,
      terminationAttempts,
      remainingOwnedIdentities: [],
      allRecordedOwnedIdentitiesGone: false,
    });
  }

  if (process.platform === 'win32') {
    let processes = [];
    let lastSnapshotError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        processes = await listWindowsProcesses();
        lastSnapshotError = null;
      } catch (error) {
        lastSnapshotError = sanitizeError(error);
        break;
      }
      const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
      const anyRemaining = results.some((result) =>
        result.recordedIdentities.some((identity) =>
          sameWindowsProcessIdentity(identity, byPid.get(identity.pid)),
        ),
      );
      if (!anyRemaining) break;
      await delay(250);
    }
    if (lastSnapshotError) refreshErrors.push(lastSnapshotError);
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    for (const result of results) {
      result.remainingOwnedIdentities = result.recordedIdentities.filter(
        (identity) =>
          sameWindowsProcessIdentity(identity, byPid.get(identity.pid)),
      );
      result.allRecordedOwnedIdentitiesGone =
        result.remainingOwnedIdentities.length === 0;
    }
  } else {
    for (const result of results) {
      result.allRecordedOwnedIdentitiesGone =
        result.terminationAttempts.every(
          (attempt) => attempt.status !== 'terminate-failed',
        ) &&
        (!Number.isInteger(result.rootPid) ||
          managed.find((entry) => entry.name === result.name)?.child
            .exitCode !== null);
    }
  }

  const allOwnedProcessIdentitiesGone =
    refreshErrors.length === 0 &&
    results.every(
      (result) =>
        result.trackingErrors.length === 0 &&
        result.allRecordedOwnedIdentitiesGone &&
        result.terminationAttempts.every(
          (attempt) => attempt.status !== 'terminate-failed',
        ),
    );
  return {
    processes: results,
    refreshErrors,
    allOwnedProcessIdentitiesGone,
  };
}

async function runHarness(
  options,
  logger,
  managed,
  clients,
  interrupted,
  runtimeState,
) {
  const fixedEndpoints = [
    { port: WSS_PORT, protocol: 'tcp', purpose: 'wss' },
    { port: RTC_PORT, protocol: 'tcp', purpose: 'mediasoup-rtc' },
    { port: RTC_PORT, protocol: 'udp', purpose: 'mediasoup-rtc' },
  ];
  for (const endpoint of fixedEndpoints) {
    if (!(await isEndpointFree(endpoint))) {
      throw new Error(
        `${endpoint.protocol.toUpperCase()} port ${endpoint.port} is already occupied; the harness will not kill an unrelated process`,
      );
    }
  }

  const [materialDebugPort, rendererDebugPort, mainInspectorPort] =
    await allocateUniqueTcpPorts(3);
  const exclusivePorts = [
    WSS_PORT,
    RTC_PORT,
    materialDebugPort,
    rendererDebugPort,
    mainInspectorPort,
  ];
  const exclusiveEndpoints = [
    ...fixedEndpoints,
    {
      port: materialDebugPort,
      protocol: 'tcp',
      purpose: 'motion-renderer-cdp',
    },
    {
      port: rendererDebugPort,
      protocol: 'tcp',
      purpose: 'product-renderers-cdp',
    },
    {
      port: mainInspectorPort,
      protocol: 'tcp',
      purpose: 'electron-main-inspector',
    },
  ];
  runtimeState.exclusivePorts = exclusivePorts;
  runtimeState.exclusiveEndpoints = exclusiveEndpoints;
  const certificateDirectory = join(options.outputDirectory, 'certs');
  const publisherExportPath = join(
    options.outputDirectory,
    'publisher-product.json',
  );
  const receiverExportPath = join(
    options.outputDirectory,
    'receiver-product.json',
  );
  const samplesPath = join(options.outputDirectory, 'harness-samples.jsonl');
  const motionUserDataDirectory = join(
    options.outputDirectory,
    'motion-electron-user-data',
  );
  const productUserDataDirectory = join(
    options.outputDirectory,
    'product-electron-user-data',
  );
  const sourceTitle = `WO 1080p60 Motion Source ${options.runId}`;
  runtimeState.samplesFile = await open(samplesPath, 'wx');

  await prepareArtifacts(options, certificateDirectory, logger);
  const machine = await collectMachineInfo(options);
  await writeFile(
    join(options.outputDirectory, 'machine.json'),
    `${JSON.stringify(machine, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  const childEnvironment = {
    ...process.env,
    HTTP_PROXY: options.proxyServer,
    HTTPS_PROXY: options.proxyServer,
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
  spawnProcess(
    'media-lab-wss',
    process.execPath,
    [serverEntry],
    {
      cwd: repositoryRoot,
      env: { ...childEnvironment, MEDIA_LAB_CERT_DIR: certificateDirectory },
      windowsHide: true,
    },
    logger,
    managed,
  );
  await waitForTcpPort(WSS_PORT);
  await refreshManagedProcessTrees(managed, logger);

  spawnProcess(
    'motion-source',
    electronExecutable,
    [
      `--remote-debugging-port=${materialDebugPort}`,
      `--proxy-server=${options.proxyServer}`,
      `--proxy-bypass-list=${options.proxyBypassList}`,
      `--user-data-dir=${motionUserDataDirectory}`,
      motionAppDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: { ...childEnvironment, WO_MOTION_SOURCE_TITLE: sourceTitle },
    },
    logger,
    managed,
  );
  const [materialTarget] = await waitForTargets(
    materialDebugPort,
    (target) => target.type === 'page',
    1,
  );
  const materialClient = await connectTarget(
    materialTarget,
    'motion-source-renderer',
  );
  clients.push(materialClient);
  const materialReady = await waitForMotionSourceReady(materialClient);
  logger.log('motion-source-ready', materialReady);
  await refreshManagedProcessTrees(managed, logger);

  spawnProcess(
    'media-lab-desktop',
    electronExecutable,
    [
      `--inspect=${mainInspectorPort}`,
      `--remote-debugging-port=${rendererDebugPort}`,
      `--proxy-server=${options.proxyServer}`,
      `--proxy-bypass-list=${options.proxyBypassList}`,
      `--user-data-dir=${productUserDataDirectory}`,
      desktopAppDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...childEnvironment,
        MEDIA_LAB_ALLOW_SELF_SIGNED: '1',
        MEDIA_LAB_URL: WSS_URL,
      },
    },
    logger,
    managed,
  );

  const productTargets = await waitForTargets(
    rendererDebugPort,
    (target) =>
      target.type === 'page' &&
      (target.url.includes('role=publisher') ||
        target.url.includes('role=receiver')),
    2,
  );
  const byRole = new Map();
  for (const target of productTargets) {
    const role = new URL(target.url).searchParams.get('role');
    if (role === 'publisher' || role === 'receiver') byRole.set(role, target);
  }
  if (byRole.size !== 2)
    throw new Error('Could not identify both product renderer roles');
  const publisher = await connectTarget(
    byRole.get('publisher'),
    'publisher-renderer',
  );
  const receiver = await connectTarget(
    byRole.get('receiver'),
    'receiver-renderer',
  );
  clients.push(publisher, receiver);

  const [mainTarget] = await waitForTargets(
    mainInspectorPort,
    (target) => Boolean(target.webSocketDebuggerUrl),
    1,
  );
  const mainClient = await connectTarget(mainTarget, 'electron-main');
  clients.push(mainClient);
  await refreshManagedProcessTrees(managed, logger);
  const electronRuntime = await mainClient.evaluate('process.versions');
  const dialogPatch = await installExportDialogQueue(mainClient, [
    publisherExportPath,
    receiverExportPath,
  ]);
  if (!dialogPatch.installed || dialogPatch.queued !== 2) {
    throw new Error(
      `Product export dialog patch failed: ${JSON.stringify(dialogPatch)}`,
    );
  }

  await Promise.all([
    publisher.evaluate(installRtcInstrumentationExpression),
    receiver.evaluate(installRtcInstrumentationExpression),
  ]);
  await publisher.evaluate(
    "document.querySelector('#codecSelect').value = 'H264'",
  );
  await publisher.click('#refreshSources');
  const source = await selectMotionSource(publisher, sourceTitle);
  logger.log('capture-source-selected', source);
  if (source.sourceType !== 'window')
    throw new Error('Selected sourceType is not window');

  await publisher.click('#startButton');
  await waitForRendererStatus(publisher, 'Streaming', 'ready', 45_000);
  await waitForPeerConnection(publisher);
  await waitForVideoDimensions(publisher, 1_920, 1_080);
  const initialPublisher = await publisher.evaluate(snapshotRendererExpression);
  const capture = initialPublisher.captureSettings;
  if (
    capture?.width !== 1_920 ||
    capture?.height !== 1_080 ||
    !Number.isFinite(capture?.frameRate) ||
    capture.frameRate < 55
  ) {
    throw new Error(
      `CAPTURE_SETTINGS_GATE_FAILED: expected 1920x1080 at 60-class fps, received ${JSON.stringify(capture)}`,
    );
  }

  await receiver.click('#startButton');
  await waitForRendererStatus(receiver, 'Streaming', 'ready', 45_000);
  await waitForPeerConnection(receiver);
  await waitForVideoDimensions(receiver, 1_920, 1_080);
  const initialReceiver = await receiver.evaluate(snapshotRendererExpression);
  if (
    initialReceiver.videoSignal?.videoWidth !== 1_920 ||
    initialReceiver.videoSignal?.videoHeight !== 1_080
  ) {
    throw new Error(
      `RECEIVER_DIMENSIONS_GATE_FAILED: ${JSON.stringify(initialReceiver.videoSignal)}`,
    );
  }

  const overallStartedAtMs = Date.now();
  const bitrateSamples = { publisher: [], receiver: [] };
  const qualitySamples = { publisher: [], receiver: [] };
  const switchSchedule = [];
  let sampleNumber = 0;

  const captureSample = async ({
    phase,
    phaseStartedAtMs,
    targetBitrateBps,
    samples,
  }) => {
    const elapsedSeconds = (Date.now() - overallStartedAtMs) / 1_000;
    const phaseElapsedSeconds = (Date.now() - phaseStartedAtMs) / 1_000;
    const [publisherSnapshot, receiverSnapshot] = await Promise.all([
      publisher.evaluate(snapshotRendererExpression),
      receiver.evaluate(snapshotRendererExpression),
    ]);
    for (const [role, snapshot] of [
      ['publisher', publisherSnapshot],
      ['receiver', receiverSnapshot],
    ]) {
      snapshot.sourceType = source.sourceType;
      snapshot.sourceName = source.name;
      snapshot.sampleNumber = sampleNumber;
      snapshot.elapsedSeconds = elapsedSeconds;
      snapshot.phase = phase;
      snapshot.phaseElapsedSeconds = phaseElapsedSeconds;
      snapshot.targetBitrateBps = targetBitrateBps;
      snapshot.senderMaxBitrates = flattenSenderMaxBitrates(snapshot);
      snapshot.codecEvidence =
        role === 'publisher' ? extractPublisherCodecEvidence(snapshot) : null;
      samples[role].push({
        capturedAt: snapshot.capturedAt,
        videoSignal: snapshot.videoSignal,
        captureSettings: snapshot.captureSettings,
        senderMaxBitrates: snapshot.senderMaxBitrates,
        codecEvidence: snapshot.codecEvidence,
        phase,
        targetBitrateBps,
      });
    }
    await runtimeState.samplesFile.write(
      `${JSON.stringify({
        schemaVersion: 1,
        sampleNumber,
        phase,
        phaseElapsedSeconds,
        elapsedSeconds,
        targetBitrateBps,
        sourceType: source.sourceType,
        publisher: publisherSnapshot,
        receiver: receiverSnapshot,
      })}\n`,
    );
    sampleNumber += 1;
  };

  const samplePhase = async ({
    phase,
    durationMs,
    targetBitrateBps,
    samples,
  }) => {
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + durationMs;
    const firstSampleNumber = sampleNumber;
    let nextSampleAtMs = startedAtMs;
    while (Date.now() < deadlineMs) {
      if (interrupted.value) {
        throw new Error(`Interrupted by ${interrupted.value}`);
      }
      await captureSample({
        phase,
        phaseStartedAtMs: startedAtMs,
        targetBitrateBps,
        samples,
      });
      nextSampleAtMs += 1_000;
      if (nextSampleAtMs <= Date.now()) nextSampleAtMs = Date.now() + 1_000;
      await delay(
        Math.max(0, Math.min(nextSampleAtMs, deadlineMs) - Date.now()),
      );
    }
    return {
      phase,
      targetBitrateBps,
      startedAtMs,
      endedAtMs: Date.now(),
      sampleCount: sampleNumber - firstSampleNumber,
    };
  };

  const bitratePrecheckStartedAtMs = Date.now();
  for (const megabits of BITRATE_TARGETS_MBPS) {
    const targetBitrateBps = megabits * 1_000_000;
    await publisher.domClick(`[data-bitrate="${megabits}"]`);
    const item = {
      megabits,
      targetBitrateBps,
      clickedAt: new Date().toISOString(),
      completedAt: null,
      sampleCount: 0,
    };
    switchSchedule.push(item);
    logger.log('bitrate-click', item);
    const phaseResult = await samplePhase({
      phase: 'bitrate-precheck',
      durationMs: BITRATE_SETTLE_WINDOW_MS,
      targetBitrateBps,
      samples: bitrateSamples,
    });
    item.completedAt = new Date(phaseResult.endedAtMs).toISOString();
    item.sampleCount = phaseResult.sampleCount;
  }
  const bitratePrecheck = {
    startedAtMs: bitratePrecheckStartedAtMs,
    endedAtMs: Date.now(),
    sampleCount: bitrateSamples.publisher.length,
    perRoleSampleCount: bitrateSamples.publisher.length,
  };

  await Promise.all([
    publisher.evaluate(
      'globalThis.__woHardwareGateRtc.includeRtcStats = false',
    ),
    receiver.evaluate('globalThis.__woHardwareGateRtc.includeRtcStats = false'),
  ]);

  const qualityPhase = await samplePhase({
    phase: 'quality-8mbps',
    durationMs: options.durationSeconds * 1_000,
    targetBitrateBps: QUALITY_TARGET_BITRATE_BPS,
    samples: qualitySamples,
  });
  const measuredDurationSeconds =
    (qualityPhase.endedAtMs - qualityPhase.startedAtMs) / 1_000;
  const measurement = {
    phase: qualityPhase.phase,
    targetBitrateBps: qualityPhase.targetBitrateBps,
    startedAtMs: qualityPhase.startedAtMs,
    endedAtMs: qualityPhase.endedAtMs,
    expectedOneSecondSamples: Math.max(1, Math.floor(measuredDurationSeconds)),
  };
  await Promise.all([
    publisher.evaluate('globalThis.__woHardwareGateRtc.includeRtcStats = true'),
    receiver.evaluate('globalThis.__woHardwareGateRtc.includeRtcStats = true'),
  ]);
  const finalPublisherSnapshot = await publisher.evaluate(
    snapshotRendererExpression,
  );
  const finalCodecEvidence = extractPublisherCodecEvidence(
    finalPublisherSnapshot,
  );
  const codecEvidenceSamples = [
    ...bitrateSamples.publisher,
    {
      capturedAt: finalPublisherSnapshot.capturedAt,
      codecEvidence: finalCodecEvidence,
      phase: 'post-quality-codec-check',
    },
  ];
  await refreshManagedProcessTrees(managed, logger);
  if (await pathExists(publisherExportPath)) {
    throw new Error(
      `Publisher export path already exists: ${publisherExportPath}`,
    );
  }
  const publisherExportClickedAtMs = Date.now();
  await publisher.click('#exportButton');
  const publisherExportResult = await waitForJsonFile(
    publisherExportPath,
    publisherExportClickedAtMs,
  );
  if (await pathExists(receiverExportPath)) {
    throw new Error(
      `Receiver export path already exists: ${receiverExportPath}`,
    );
  }
  const receiverExportClickedAtMs = Date.now();
  await receiver.click('#exportButton');
  const receiverExportResult = await waitForJsonFile(
    receiverExportPath,
    receiverExportClickedAtMs,
  );
  const publisherExport = publisherExportResult.data;
  const receiverExport = receiverExportResult.data;

  await receiver.click('#stopButton');
  await publisher.click('#stopButton');
  await Promise.all([
    waitForRendererStatus(receiver, 'Idle', 'idle', 30_000),
    waitForRendererStatus(publisher, 'Idle', 'idle', 30_000),
  ]);

  const machineGate = evaluateMachineGate(machine, electronRuntime);
  const publisherGate = evaluateHardwareRoleGate(
    'publisher',
    publisherExport,
    qualitySamples.publisher,
    measurement,
  );
  const receiverGate = evaluateHardwareRoleGate(
    'receiver',
    receiverExport,
    qualitySamples.receiver,
    measurement,
  );
  const bitrateGate = evaluateBitrateGate(
    publisherExport,
    bitrateSamples.publisher,
  );
  const codecGate = evaluateCodecGate(
    codecEvidenceSamples,
    EXPECTED_WINDOWS_CODEC,
    (publisherExport.samples ?? []).filter(
      (sample) =>
        sample.direction === 'outbound' &&
        Number.isFinite(sample.timestampMs) &&
        sample.timestampMs >= measurement.startedAtMs &&
        sample.timestampMs <= measurement.endedAtMs,
    ),
  );
  const durationGate = measuredDurationSeconds >= options.durationSeconds;
  const certificationScopeGate =
    evaluateLegacyDesktopCertificationScope(CAPTURE_SCOPE);
  const productExports = {
    publisher: {
      path: publisherExportPath,
      role: publisherExport.role,
      samples: publisherExport.samples?.length ?? 0,
      clickedAtMs: publisherExportClickedAtMs,
      mtimeMs: publisherExportResult.mtimeMs,
    },
    receiver: {
      path: receiverExportPath,
      role: receiverExport.role,
      samples: receiverExport.samples?.length ?? 0,
      clickedAtMs: receiverExportClickedAtMs,
      mtimeMs: receiverExportResult.mtimeMs,
    },
  };
  const experimentChecks = {
    formalDurationRequested: options.formal,
    measuredDurationReached: durationGate,
    sourceTypeWindow: source.sourceType === 'window',
    validatesWindowDesktopSharePathOnly:
      CAPTURE_SCOPE.validates === 'window-desktop-share-path' &&
      CAPTURE_SCOPE.validatesWholeMonitor === false,
    publisherCapture1920x1080:
      capture.width === 1_920 && capture.height === 1_080,
    machine: machineGate.pass,
    publisher: publisherGate.pass,
    receiver: receiverGate.pass,
    bitrateChanges: bitrateGate.pass,
    codecPath: codecGate.pass,
  };
  const finalGate = evaluateLegacyHardwareGate({
    formal: options.formal,
    preflight: options.preflight,
    experimentChecks,
    certificationScopeGate,
  });

  return {
    status: finalGate.status,
    hardwarePass: finalGate.hardwarePass,
    experimentPass: finalGate.experimentPass,
    runId: options.runId,
    mode: options.preflight ? 'preflight' : 'formal',
    durationSecondsRequested: options.durationSeconds,
    measuredDurationSeconds,
    measurement,
    bitratePrecheck,
    sampleCount: sampleNumber,
    qualitySampleCount: qualityPhase.sampleCount,
    source: {
      ...source,
      ...CAPTURE_SCOPE,
      expectedTitle: sourceTitle,
      captureSettings: capture,
    },
    network: {
      wssUrl: WSS_URL,
      proxyServer: options.proxyServer,
      proxyBypassList: options.proxyBypassList,
    },
    runtime: { electron: electronRuntime },
    gateChecks: finalGate.gateChecks,
    certificationScopeGate,
    machineGate,
    publisherGate,
    receiverGate,
    bitrateGate,
    codecGate,
    switchSchedule,
    productExports,
    files: { machine: 'machine.json', samples: 'harness-samples.jsonl' },
    exclusivePorts,
    exclusiveEndpoints,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await createOrValidateEmptyOutputDirectory(options.outputDirectory);
  const logger = createLogger(
    join(options.outputDirectory, 'orchestrator.jsonl'),
  );
  const managed = [];
  const clients = [];
  const interrupted = { value: null };
  const runtimeState = {
    exclusivePorts: [WSS_PORT, RTC_PORT],
    exclusiveEndpoints: [
      { port: WSS_PORT, protocol: 'tcp', purpose: 'wss' },
      { port: RTC_PORT, protocol: 'tcp', purpose: 'mediasoup-rtc' },
      { port: RTC_PORT, protocol: 'udp', purpose: 'mediasoup-rtc' },
    ],
    samplesFile: null,
  };
  let summary = {
    status: 'HARNESS_FAILED',
    hardwarePass: false,
    runId: options.runId,
    mode: options.preflight ? 'preflight' : 'formal',
    durationSecondsRequested: options.durationSeconds,
  };
  let failure = null;

  const interrupt = (signal) => {
    interrupted.value = signal;
    logger.log('interrupt-requested', { signal });
  };
  process.once('SIGINT', () => interrupt('SIGINT'));
  process.once('SIGTERM', () => interrupt('SIGTERM'));

  try {
    logger.log('harness-start', {
      options: {
        ...options,
        outputDirectory: relative(repositoryRoot, options.outputDirectory),
      },
    });
    summary = await runHarness(
      options,
      logger,
      managed,
      clients,
      interrupted,
      runtimeState,
    );
  } catch (error) {
    failure = sanitizeError(error);
    summary = { ...summary, error: failure };
    logger.log('harness-failed', { error: failure });
  } finally {
    await runtimeState.samplesFile?.close();
    for (const client of clients.reverse()) client.close();
    const cleanupProcesses = await cleanupManagedProcesses(managed, logger);
    const cleanupPorts = [];
    for (const endpoint of runtimeState.exclusiveEndpoints) {
      let free = false;
      for (let attempt = 0; attempt < 20 && !free; attempt += 1) {
        free = await isEndpointFree(endpoint);
        if (!free) await delay(250);
      }
      cleanupPorts.push({ ...endpoint, free });
    }
    summary = {
      ...summary,
      completedAt: new Date().toISOString(),
      cleanup: {
        ownedProcessTrees: cleanupProcesses.processes,
        processTrackingErrors: cleanupProcesses.refreshErrors,
        allOwnedProcessIdentitiesGone:
          cleanupProcesses.allOwnedProcessIdentitiesGone,
        exclusiveEndpoints: cleanupPorts,
        allExclusiveEndpointsFree: cleanupPorts.every((entry) => entry.free),
      },
    };
    if (
      !summary.cleanup.allOwnedProcessIdentitiesGone ||
      !summary.cleanup.allExclusiveEndpointsFree ||
      cleanupProcesses.processes.some((entry) =>
        entry.terminationAttempts.some(
          (attempt) => attempt.status === 'terminate-failed',
        ),
      )
    ) {
      summary.hardwarePass = false;
      summary.status = 'GATE_FAILED';
    }
    await writeFile(
      join(options.outputDirectory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    logger.log('harness-complete', {
      status: summary.status,
      hardwarePass: summary.hardwarePass,
      summaryPath: join(options.outputDirectory, 'summary.json'),
    });
    await logger.close();
  }

  if (failure || summary.status === 'GATE_FAILED') process.exitCode = 1;
}

await main();
