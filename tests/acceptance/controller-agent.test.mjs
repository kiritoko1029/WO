import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { URL, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test, vi } from 'vitest';

import {
  ControllerError,
  createHttpsAgentClient,
  createSafeLogger,
  loadControllerCredentials,
  parseControllerCli,
  runController,
} from '../../scripts/acceptance/controller.mjs';
import {
  AgentError,
  buildNativeSignatureInvocations,
  createAgentRuntime,
  parseAgentCli,
} from '../../scripts/acceptance/agent.mjs';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const execFileAsync = promisify(execFile);

function controllerArguments(overrides = {}) {
  const values = {
    duration: '600',
    'publisher-agent': 'https://publisher.example.test:9443',
    'receiver-agent': 'https://receiver.example.test:9443',
    'server-url': 'https://rtc.example.test',
    path: 'direct',
    source: 'window',
    'ca-file': resolve('test-ca.pem'),
    'token-file': resolve('test-token.txt'),
    'run-dir': resolve('test-run'),
    ...overrides,
  };
  return Object.entries(values).map(([name, value]) => `--${name}=${value}`);
}

function agentArguments(overrides = {}) {
  const values = {
    listen: 'https://0.0.0.0:9443',
    'cert-file': resolve('agent-cert.pem'),
    'key-file': resolve('agent-key.pem'),
    'token-file': resolve('agent-token.txt'),
    'desktop-package': resolve('Wo.exe'),
    'desktop-package-sha256-file': resolve('Wo.exe.sha256'),
    'work-dir': resolve('agent-runs'),
    ...overrides,
  };
  return Object.entries(values).map(([name, value]) => `--${name}=${value}`);
}

function authorization(token = 'short-lived-secret') {
  return `Bearer ${token}`;
}

function command(type, sequence, payload, runId = 'run-1') {
  return {
    version: 1,
    type,
    runId,
    sequence,
    wallClockMs: 10_000,
    monotonicMs: sequence * 10,
    payload,
  };
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'wo-controller-agent-'));
}

async function writeRestricted(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function agentConfiguration(directory, overrides = {}) {
  return {
    listen: new URL('https://127.0.0.1:9443'),
    certFile: join(directory, 'agent-cert.pem'),
    keyFile: join(directory, 'agent-key.pem'),
    tokenFile: join(directory, 'token.txt'),
    desktopPackage: join(directory, 'Wo.exe'),
    desktopPackageSha256File: join(directory, 'Wo.exe.sha256'),
    workDir: directory,
    token: 'short-lived-secret',
    expectedPackageSha256: hash,
    commands: {
      install: null,
      desktop: { command: join(directory, 'Wo.exe'), args: [] },
      motion: { command: join(directory, 'motion.exe'), args: [] },
      audio: { command: join(directory, 'audio.exe'), args: [] },
      driver: { command: join(directory, 'driver.exe'), args: [] },
      artifacts: {
        executable: join(directory, 'Wo.exe'),
        asar: join(directory, 'app.asar'),
        resources: [],
      },
      firewall: {
        turnAddress: '203.0.113.20',
        turnUdpPort: 3478,
        turnTlsPort: 5349,
        controllerAddress: '203.0.113.10',
        controllerPort: 9443,
      },
    },
    ...overrides,
  };
}

function runtimeDependencies(overrides = {}) {
  const child = {
    pid: 123,
    exited: Promise.resolve(null),
    stop: vi.fn(async () => true),
  };
  return {
    now: () => 10_000,
    monotonicNow: (() => {
      let value = 0;
      return () => (value += 10);
    })(),
    hashFile: vi.fn(async () => hash),
    verifyPackageSignature: vi.fn(async () => true),
    installPackage: vi.fn(async () => undefined),
    spawnTracked: vi.fn(() => ({ ...child, stop: vi.fn(child.stop) })),
    installFirewall: vi.fn(async () => ({ installed: true })),
    removeFirewall: vi.fn(async () => ({ pass: true })),
    readEvidence: vi.fn(async () => ({ samples: [], bitrateEvents: [] })),
    ...overrides,
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function mockAgentRequest(clock, calls) {
  let eventSequence = 0;
  const event = (type, payload) => ({
    version: 1,
    type,
    runId: 'run-1',
    sequence: (eventSequence += 1),
    wallClockMs: clock.value,
    monotonicMs: eventSequence * 10,
    payload,
  });
  return (url, _options, callback) => {
    const request = new EventEmitter();
    let requestBody = '';
    request.write = (chunk) => {
      requestBody += chunk;
    };
    request.setTimeout = () => {};
    request.destroy = (error) => {
      if (error !== undefined) request.emit('error', error);
    };
    request.end = () => {
      calls.push(url.pathname);
      setImmediate(() => {
        let body;
        if (url.pathname === '/v1/register') {
          body = {
            packageSha256: hash,
            events: [
              event('agent.register', {
                agentId: 'publisher-agent',
                platform: 'win32',
                architecture: 'x64',
              }),
              event('capability.report', {
                screenSources: ['window'],
                canInstallFirewall: true,
                canVerifySignature: true,
              }),
            ],
          };
        } else if (url.pathname === '/v1/command') {
          const commandBody = JSON.parse(requestBody);
          if (commandBody.message.type === 'run.prepare') {
            body = {
              packageSha256: hash,
              signatureVerified: true,
              events: [event('run.prepare', commandBody.message.payload)],
            };
          } else {
            body = {
              events: [event('run.start', commandBody.message.payload)],
            };
          }
        } else {
          body = { events: [event('run.heartbeat', {})] };
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        setImmediate(() => {
          response.emit('data', Buffer.from(JSON.stringify(body)));
          response.emit('end');
        });
      });
    };
    return request;
  };
}

function fakeAgent(id, overrides = {}) {
  const calls = { cancel: [], connect: 0, stop: 0 };
  const client = {
    calls,
    async connect() {
      calls.connect += 1;
      return {
        agentId: id,
        platform: 'win32',
        architecture: 'x64',
        packageSha256: hash,
        capabilities: {
          screenSources: ['window', 'monitor'],
          canInstallFirewall: true,
          canVerifySignature: true,
        },
      };
    },
    async prepare() {
      return { packageSha256: hash, signatureVerified: true };
    },
    async start() {},
    async collect() {
      return { samples: [], bitrateEvents: [] };
    },
    async stop() {
      calls.stop += 1;
      return {
        cleanup: { restoredFirewall: true, childrenStopped: true },
        manifest: {
          files: [
            { name: 'package', sha256: hash },
            { name: 'executable', sha256: hash },
            { name: 'app.asar', sha256: hash },
          ],
        },
      };
    },
    async cancel(reason) {
      calls.cancel.push(reason);
      return { restoredFirewall: true, childrenStopped: true };
    },
    ...overrides,
  };
  return client;
}

describe('acceptance CLI', () => {
  test('controller rejects a missing required argument and every unknown flag', () => {
    const withoutDuration = controllerArguments();
    withoutDuration.shift();
    expect(() => parseControllerCli(withoutDuration)).toThrow(
      expect.objectContaining({ code: 'CLI_REQUIRED' }),
    );
    expect(() =>
      parseControllerCli([...controllerArguments(), '--token=leak']),
    ).toThrow(expect.objectContaining({ code: 'CLI_UNKNOWN' }));
  });

  test('agent rejects a missing required argument and shell-style command flags', () => {
    const withoutListen = agentArguments();
    withoutListen.shift();
    expect(() => parseAgentCli(withoutListen)).toThrow(
      expect.objectContaining({ code: 'CLI_REQUIRED' }),
    );
    expect(() =>
      parseAgentCli([...agentArguments(), '--motion-command=calc.exe']),
    ).toThrow(expect.objectContaining({ code: 'CLI_UNKNOWN' }));
  });
});

describe('controller credentials and logging', () => {
  test('rejects an invalid CA before opening an agent connection', async () => {
    const directory = await temporaryDirectory();
    const caFile = join(directory, 'ca.pem');
    const tokenFile = join(directory, 'token.txt');
    await writeRestricted(caFile, 'not a certificate');
    await writeRestricted(tokenFile, 'short-lived-secret\n');

    await expect(
      loadControllerCredentials({ caFile, tokenFile }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CA' }));
  });

  test('safe logger never writes a configured secret or sensitive fields', () => {
    const output = [];
    const logger = createSafeLogger(
      (line) => output.push(line),
      ['short-lived-secret'],
    );
    logger('agent_failed', {
      runId: 'run-1',
      token: 'short-lived-secret',
      message: 'Authorization: Bearer short-lived-secret',
    });
    expect(output.join('\n')).not.toContain('short-lived-secret');
    expect(output.join('\n')).not.toContain('Authorization');
    expect(output.join('\n')).toContain('agent_failed');
  });
});

describe('agent fail-closed lifecycle', () => {
  test('loads in native Node without the test runner transform layer', async () => {
    const moduleUrl = pathToFileURL(
      resolve('scripts/acceptance/agent.mjs'),
    ).href;
    await expect(
      execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(moduleUrl)})`,
      ]),
    ).resolves.toMatchObject({ stderr: '' });
  });

  test('requires Windows timestamps and macOS notarization without shell paths', () => {
    const packagePath = resolve('release', 'Wo Setup.exe');
    const executablePath = resolve('release', 'Wo.exe');
    const windows = buildNativeSignatureInvocations(
      packagePath,
      executablePath,
      'win32',
    );
    expect(windows).toHaveLength(2);
    expect(windows[0].args.join(' ')).toContain('TimeStamperCertificate');
    expect(windows[0].args.at(-1)).toBe(packagePath);
    expect(windows[1].args.at(-1)).toBe(executablePath);

    const mac = buildNativeSignatureInvocations(
      resolve('release', 'Wo.dmg'),
      resolve('release', 'Wo.app'),
      'darwin',
    );
    expect(mac).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: '/usr/bin/xcrun',
          args: ['stapler', 'validate', resolve('release', 'Wo.app')],
        }),
        expect.objectContaining({
          command: '/usr/bin/xcrun',
          args: ['stapler', 'validate', resolve('release', 'Wo.dmg')],
        }),
      ]),
    );
  });

  test('rejects a bad bearer token without allocating a run', async () => {
    const directory = await temporaryDirectory();
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      runtimeDependencies(),
    );
    await expect(
      runtime.register({
        authorization: authorization('wrong'),
        runId: 'run-1',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'AUTH_FAILED' }));
    expect(runtime.getSnapshot().activeRunId).toBeNull();
  });

  test('rejects an on-disk package whose SHA-256 differs from the approved file', async () => {
    const directory = await temporaryDirectory();
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      runtimeDependencies({ hashFile: vi.fn(async () => otherHash) }),
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });

    await expect(
      runtime.command({
        authorization: authorization(),
        message: command('run.prepare', 1, {
          packageSha256: hash,
          source: 'window',
          path: 'direct',
        }),
        context: {
          role: 'publisher',
          serverUrl: 'https://rtc.example.test',
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'PACKAGE_HASH_MISMATCH' }),
    );
  });

  test('allows only one active run', async () => {
    const directory = await temporaryDirectory();
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      runtimeDependencies(),
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    await expect(
      runtime.register({
        authorization: authorization(),
        runId: 'run-2',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BUSY' }));
  });

  test('derives distinct agent identities from distinct TLS certificates', async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const first = createAgentRuntime(
      agentConfiguration(firstDirectory, { cert: 'certificate-a' }),
      runtimeDependencies(),
    );
    const second = createAgentRuntime(
      agentConfiguration(secondDirectory, { cert: 'certificate-b' }),
      runtimeDependencies(),
    );

    const firstRegistration = await first.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    const secondRegistration = await second.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    expect(firstRegistration.events[0].payload.agentId).not.toBe(
      secondRegistration.events[0].payload.agentId,
    );
  });

  test('keeps event monotonic clocks strictly increasing within one timer tick', async () => {
    const directory = await temporaryDirectory();
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      runtimeDependencies({ monotonicNow: () => 10_000 }),
    );
    const registration = await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    expect(registration.events[1].monotonicMs).toBeGreaterThan(
      registration.events[0].monotonicMs,
    );
  });

  test('rejects relay preparation without positive firewall install evidence', async () => {
    const directory = await temporaryDirectory();
    const dependencies = runtimeDependencies({
      installFirewall: vi.fn(async () => ({ installed: false })),
    });
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      dependencies,
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });

    await expect(
      runtime.command({
        authorization: authorization(),
        message: command('run.prepare', 1, {
          packageSha256: hash,
          source: 'monitor',
          path: 'relay',
        }),
        context: {
          role: 'publisher',
          serverUrl: 'https://rtc.example.test',
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'FIREWALL_INSTALL_UNPROVEN' }),
    );
    expect(dependencies.removeFirewall).toHaveBeenCalledTimes(1);
  });

  test('keeps the single-run lock until manifest hashing and cleanup acknowledgement finish', async () => {
    const directory = await temporaryDirectory();
    const manifestHash = deferred();
    let hashCalls = 0;
    const dependencies = runtimeDependencies({
      hashFile: vi.fn(async () => {
        hashCalls += 1;
        return hashCalls === 1 ? hash : manifestHash.promise;
      }),
      spawnTracked: vi.fn(() => ({
        pid: 10,
        exited: new Promise(() => {}),
        stop: vi.fn(async () => true),
      })),
    });
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      dependencies,
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    await runtime.command({
      authorization: authorization(),
      message: command('run.prepare', 1, {
        packageSha256: hash,
        source: 'window',
        path: 'direct',
      }),
      context: {
        role: 'publisher',
        serverUrl: 'https://rtc.example.test',
      },
    });
    await runtime.command({
      authorization: authorization(),
      message: command('run.start', 2, { durationMs: 45_000 }),
    });
    const stopping = runtime.command({
      authorization: authorization(),
      message: command('run.stop', 3, {}),
    });
    await vi.waitFor(() => expect(hashCalls).toBeGreaterThanOrEqual(2));

    await expect(
      runtime.register({
        authorization: authorization(),
        runId: 'run-2',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BUSY' }));
    manifestHash.resolve(hash);
    await stopping;
    expect(dependencies.verifyPackageSignature).toHaveBeenCalledTimes(2);
  });

  test('cancellation stops every tracked child and emits proven cleanup', async () => {
    const directory = await temporaryDirectory();
    const children = [];
    const dependencies = runtimeDependencies({
      spawnTracked: vi.fn(() => {
        const child = {
          pid: children.length + 10,
          exited: new Promise(() => {}),
          stop: vi.fn(async () => true),
        };
        children.push(child);
        return child;
      }),
    });
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      dependencies,
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    await runtime.command({
      authorization: authorization(),
      message: command('run.prepare', 1, {
        packageSha256: hash,
        source: 'window',
        path: 'direct',
      }),
      context: {
        role: 'publisher',
        serverUrl: 'https://rtc.example.test',
      },
    });
    await runtime.command({
      authorization: authorization(),
      message: command('run.start', 2, { durationMs: 45_000 }),
    });
    const result = await runtime.command({
      authorization: authorization(),
      message: command('run.cancel', 3, { reason: 'peer failed' }),
    });

    expect(children).toHaveLength(4);
    expect(children.every((child) => child.stop.mock.calls.length === 1)).toBe(
      true,
    );
    expect(result.cleanup).toEqual({
      restoredFirewall: true,
      childrenStopped: true,
    });
  });

  test('stops already-started children when a later child fails to spawn', async () => {
    const directory = await temporaryDirectory();
    const children = [];
    let starts = 0;
    const dependencies = runtimeDependencies({
      spawnTracked: vi.fn(() => {
        starts += 1;
        if (starts === 3) throw new AgentError('SPAWN_FAILED');
        const child = {
          pid: starts,
          exited: new Promise(() => {}),
          stop: vi.fn(async () => true),
        };
        children.push(child);
        return child;
      }),
    });
    const runtime = createAgentRuntime(
      agentConfiguration(directory),
      dependencies,
    );
    await runtime.register({
      authorization: authorization(),
      runId: 'run-1',
    });
    await runtime.command({
      authorization: authorization(),
      message: command('run.prepare', 1, {
        packageSha256: hash,
        source: 'window',
        path: 'direct',
      }),
      context: {
        role: 'publisher',
        serverUrl: 'https://rtc.example.test',
      },
    });

    await expect(
      runtime.command({
        authorization: authorization(),
        message: command('run.start', 2, { durationMs: 45_000 }),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'SPAWN_FAILED' }));
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.stop.mock.calls.length === 1)).toBe(
      true,
    );
  });
});

describe('controller coordination', () => {
  test('paces agent event polling to one request per second', async () => {
    const clock = { value: 10_000 };
    const requests = [];
    let sleeps = 0;
    const client = createHttpsAgentClient({
      baseUrl: new URL('https://publisher.example.test:9443'),
      ca: 'test-ca',
      token: 'short-lived-secret',
      requestImpl: mockAgentRequest(clock, requests),
      now: () => clock.value,
      sleep: async (milliseconds) => {
        sleeps += 1;
        clock.value += milliseconds;
      },
    });
    await client.connect('run-1');
    await client.prepare({
      packageSha256: hash,
      source: 'window',
      path: 'direct',
      role: 'publisher',
      serverUrl: 'https://rtc.example.test/',
    });
    await client.start(2_000);
    await client.collect({ durationMs: 2_000 });

    expect(sleeps).toBe(2);
    expect(requests.filter((path) => path === '/v1/events')).toHaveLength(3);
  });

  test('one agent failure cancels and cleans both agents', async () => {
    const runDir = await temporaryDirectory();
    const publisher = fakeAgent('publisher', {
      async collect() {
        throw new ControllerError('AGENT_FAILED');
      },
    });
    const receiver = fakeAgent('receiver');

    const summary = await runController(
      {
        ...parseControllerCli(
          controllerArguments({ 'run-dir': join(runDir, 'failure-run') }),
        ),
        token: 'short-lived-secret',
        ca: 'test-ca',
      },
      {
        clients: [publisher, receiver],
        logger: () => {},
        probeServer: async () => true,
      },
    );

    expect(summary).toMatchObject({
      status: 'GATE_FAILED',
      hardwarePass: false,
      failure: { code: 'AGENT_FAILED' },
      cleanup: { publisher: true, receiver: true },
    });
    expect(publisher.calls.cancel).toHaveLength(1);
    expect(receiver.calls.cancel).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(runDir, 'failure-run', 'summary.json'), 'utf8'),
      ),
    ).toMatchObject({ hardwarePass: false });
  });

  test('waits for the peer event poll to settle before sending cancellation', async () => {
    const runDir = await temporaryDirectory();
    const publisher = fakeAgent('publisher', {
      async collect() {
        throw new ControllerError('AGENT_FAILED');
      },
    });
    let receiverPolling = false;
    const receiver = fakeAgent('receiver', {
      async collect({ signal }) {
        receiverPolling = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              setImmediate(() => {
                receiverPolling = false;
                reject(new ControllerError('RUN_CANCELED'));
              });
            },
            { once: true },
          );
        });
      },
      async cancel(reason) {
        if (receiverPolling) throw new ControllerError('POLL_STILL_ACTIVE');
        receiver.calls.cancel.push(reason);
        return { restoredFirewall: true, childrenStopped: true };
      },
    });

    const summary = await runController(
      {
        ...parseControllerCli(
          controllerArguments({ 'run-dir': join(runDir, 'poll-race-run') }),
        ),
        token: 'short-lived-secret',
        ca: 'test-ca',
      },
      {
        clients: [publisher, receiver],
        logger: () => {},
        probeServer: async () => true,
      },
    );

    expect(summary).toMatchObject({
      failure: { code: 'AGENT_FAILED' },
      cleanup: { publisher: true, receiver: true },
    });
    expect(receiver.calls.cancel).toHaveLength(1);
  });

  test('cannot pass when either cleanup acknowledgement is incomplete', async () => {
    const runDir = await temporaryDirectory();
    const publisher = fakeAgent('publisher');
    const receiver = fakeAgent('receiver', {
      async stop() {
        return {
          cleanup: { restoredFirewall: false, childrenStopped: true },
          manifest: null,
        };
      },
    });
    const evaluateGate = vi.fn(() => ({
      status: 'HARDWARE_PASS',
      hardwarePass: true,
      checks: {},
    }));

    const summary = await runController(
      {
        ...parseControllerCli(
          controllerArguments({ 'run-dir': join(runDir, 'cleanup-run') }),
        ),
        token: 'short-lived-secret',
        ca: 'test-ca',
      },
      {
        clients: [publisher, receiver],
        evaluateGate,
        logger: () => {},
        probeServer: async () => true,
      },
    );

    expect(summary).toMatchObject({
      status: 'GATE_FAILED',
      hardwarePass: false,
      failure: { code: 'CLEANUP_INCOMPLETE' },
    });
    expect(evaluateGate).not.toHaveBeenCalled();
  });

  test('records server network failure before allocating either agent run', async () => {
    const runDir = await temporaryDirectory();
    const publisher = fakeAgent('publisher');
    const receiver = fakeAgent('receiver');
    const summary = await runController(
      {
        ...parseControllerCli(
          controllerArguments({ 'run-dir': join(runDir, 'network-run') }),
        ),
        token: 'short-lived-secret',
        ca: 'test-ca',
      },
      {
        clients: [publisher, receiver],
        logger: () => {},
        probeServer: async () => false,
      },
    );

    expect(summary).toMatchObject({
      status: 'GATE_FAILED',
      hardwarePass: false,
      failure: { code: 'SERVER_UNAVAILABLE' },
      cleanup: { publisher: true, receiver: true },
    });
    expect(publisher.calls.connect).toBe(0);
    expect(receiver.calls.connect).toBe(0);
  });
});

test('exports stable typed error classes without secret-bearing messages', () => {
  expect(new ControllerError('TEST')).toMatchObject({ code: 'TEST' });
  expect(new AgentError('TEST')).toMatchObject({ code: 'TEST' });
});
