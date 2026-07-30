import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import base, {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import electronPath from 'electron';

export { expect };

export type AcceptancePolicy = 'all' | 'relay';

export interface AcceptancePeer {
  readonly application: ElectronApplication;
  readonly page: Page;
  close(): Promise<void>;
}

export interface AcceptancePair {
  readonly first: AcceptancePeer;
  readonly second: AcceptancePeer;
  readonly motionTitle: string;
  launchAdditional(): Promise<AcceptancePeer>;
  close(): Promise<void>;
}

interface AcceptanceLauncher {
  launch(policy: AcceptancePolicy): Promise<AcceptancePair>;
}

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const integrationComposeArguments = [
  'compose',
  '--project-name',
  'wo-integration',
  '--env-file',
  'deploy/.env.integration',
  '-f',
  'deploy/compose.yaml',
  '-f',
  'deploy/compose.integration.yaml',
] as const;
const rendererDirectory = join(desktopDirectory, 'out-acceptance', 'renderer');
const mainEntry = join(desktopDirectory, 'out-acceptance', 'main', 'index.js');
const motionDirectory = join(
  repositoryDirectory,
  'docs',
  'poc',
  'hardware-gate-motion-source',
);
const caddyAuthority = join(
  repositoryDirectory,
  'deploy',
  '.certs',
  'caddy-authority',
  'root.crt',
);

export async function pauseIntegrationCoturn(): Promise<() => Promise<void>> {
  const commandOptions = {
    cwd: repositoryDirectory,
    timeout: 10_000,
    windowsHide: true,
  } as const;
  const { stdout } = await execFileAsync(
    'docker',
    [...integrationComposeArguments, 'ps', '-q', 'coturn'],
    commandOptions,
  );
  const containerIds = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (containerIds.length !== 1) {
    throw new Error(
      `Expected one wo-integration coturn container, found ${containerIds.length}`,
    );
  }
  const [containerId] = containerIds;
  await execFileAsync('docker', ['pause', containerId], commandOptions);

  let resumed = false;
  return async () => {
    if (resumed) return;
    await execFileAsync('docker', ['unpause', containerId], commandOptions);
    resumed = true;
  };
}

export async function restartIntegrationServer(): Promise<void> {
  const commandOptions = {
    cwd: repositoryDirectory,
    timeout: 60_000,
    windowsHide: true,
  } as const;
  await execFileAsync(
    'docker',
    [...integrationComposeArguments, 'restart', 'server'],
    commandOptions,
  );
  await execFileAsync(
    'docker',
    [
      ...integrationComposeArguments,
      'up',
      '-d',
      '--no-deps',
      '--wait',
      'server',
    ],
    commandOptions,
  );
}

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function startRendererServer(): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const requested =
        pathname === '/'
          ? 'index.acceptance.html'
          : decodeURIComponent(pathname.slice(1));
      const file = resolve(rendererDirectory, requested);
      const inside =
        file === rendererDirectory ||
        file.startsWith(`${rendererDirectory}${sep}`);
      if (!inside || relative(rendererDirectory, file).startsWith('..')) {
        response.writeHead(400).end();
        return;
      }
      try {
        const body = await readFile(file);
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': contentType(file),
        });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Acceptance renderer server has no TCP address');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function deterministicWav(seconds = 45): Buffer {
  const sampleRate = 48_000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = sampleRate * seconds;
  const dataBytes = samples * channels * (bitsPerSample / 8);
  const output = Buffer.allocUnsafe(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  output.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  output.writeUInt16LE(bitsPerSample, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    const first = Math.sin((2 * Math.PI * 440 * sample) / sampleRate);
    const second = Math.sin((2 * Math.PI * 660 * sample) / sampleRate);
    output.writeInt16LE(
      Math.round((first * 0.7 + second * 0.2) * 12_000),
      44 + sample * 2,
    );
  }
  return output;
}

async function forceProcessTreeExit(
  processHandle: ChildProcess,
): Promise<void> {
  if (
    processHandle.exitCode === null &&
    processHandle.pid !== undefined &&
    process.platform === 'win32'
  ) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    await execFileAsync(
      join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(processHandle.pid), '/T', '/F'],
      { windowsHide: true },
    ).catch(() => undefined);
  } else if (processHandle.exitCode === null) {
    processHandle.kill('SIGKILL');
  }
  if (processHandle.exitCode === null) {
    await Promise.race([
      once(processHandle, 'exit').then(() => undefined),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
  }
}

async function closeApplication(
  application: ElectronApplication | null,
): Promise<void> {
  if (application === null) return;
  let processHandle: ChildProcess | null = null;
  try {
    processHandle = application.process();
  } catch {
    // The Playwright transport is already gone, so there is no live handle to kill.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, 8_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (processHandle !== null) await forceProcessTreeExit(processHandle);
  }
}

function peer(application: ElectronApplication, page: Page): AcceptancePeer {
  let closed = false;
  return Object.freeze({
    application,
    page,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeApplication(application);
    },
  });
}

async function launchPair(policy: AcceptancePolicy): Promise<AcceptancePair> {
  const apiEndpoint = new URL(
    process.env.WO_E2E_BASE_URL ?? 'https://rtc.localhost',
  );
  if (
    apiEndpoint.protocol !== 'https:' ||
    apiEndpoint.hostname !== 'rtc.localhost' ||
    apiEndpoint.username !== '' ||
    apiEndpoint.password !== ''
  ) {
    throw new Error(
      'WO_E2E_BASE_URL must use trusted https://rtc.localhost[:port]',
    );
  }
  const apiOrigin = apiEndpoint.origin;
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wo-desktop-e2e-'));
  const audioFile = join(temporaryRoot, 'deterministic-nonsilent.wav');
  await writeFile(audioFile, deterministicWav(), { mode: 0o600 });
  const motionTitle = `WO E2E Motion ${Date.now()} ${policy}`;
  let rendererServer: Server | null = null;
  let motionApplication: ElectronApplication | null = null;
  let firstApplication: ElectronApplication | null = null;
  let secondApplication: ElectronApplication | null = null;
  try {
    const renderer = await startRendererServer();
    rendererServer = renderer.server;
    const baseEnvironment = environment();
    delete baseEnvironment.ELECTRON_RUN_AS_NODE;
    delete baseEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
    delete baseEnvironment.WO_DEV_PROFILE;

    motionApplication = await electron.launch({
      executablePath: electronPath,
      args: [
        `--user-data-dir=${join(temporaryRoot, 'motion-profile')}`,
        motionDirectory,
      ],
      cwd: motionDirectory,
      env: { ...baseEnvironment, WO_MOTION_SOURCE_TITLE: motionTitle },
      timeout: 30_000,
    });
    const motionPage = await motionApplication.firstWindow();
    await motionPage.waitForFunction(
      () =>
        (globalThis as unknown as { __WO_MOTION_READY?: boolean })
          .__WO_MOTION_READY === true &&
        ((globalThis as unknown as { __WO_MOTION_FRAME?: number })
          .__WO_MOTION_FRAME ?? 0) > 10,
      undefined,
      { timeout: 15_000 },
    );

    const launchPeer = async (name: string): Promise<AcceptancePeer> => {
      let application: ElectronApplication | null = null;
      try {
        application = await electron.launch({
          executablePath: electronPath,
          args: [
            '--host-resolver-rules=MAP rtc.localhost 127.0.0.1',
            mainEntry,
          ],
          cwd: desktopDirectory,
          env: {
            ...baseEnvironment,
            ELECTRON_RENDERER_URL: renderer.url,
            NODE_EXTRA_CA_CERTS: caddyAuthority,
            WO_API_ORIGIN: apiOrigin,
            WO_ACCEPTANCE_AUDIO_FILE: audioFile,
            WO_ACCEPTANCE_ICE_POLICY: policy,
            WO_ACCEPTANCE_USER_DATA_DIR: join(temporaryRoot, `${name}-profile`),
          },
          timeout: 30_000,
        });
        application.process().stderr?.on('data', (chunk: Buffer) => {
          const message = chunk.toString('utf8');
          if (/WO_ACCEPTANCE_|DESKTOP_STARTUP_FAILED/u.test(message)) {
            process.stderr.write(`[${name}-main] ${message}`);
          }
        });
        const page = await application.firstWindow();
        page.on('console', (message) => {
          const text = message.text();
          if (
            !text.startsWith('failed to asynchronously prepare wasm:') &&
            !text.startsWith('Aborted(')
          ) {
            return;
          }
          const details = text
            .replaceAll(renderer.url, 'renderer:///')
            .slice(0, 1_024);
          process.stderr.write(`[${name}-renderer] ${details}\n`);
        });
        page.on('pageerror', (error) => {
          const details = (error.stack ?? error.message)
            .replaceAll(renderer.url, 'renderer:///')
            .slice(0, 4_096);
          process.stderr.write(`[${name}] ${details}\n`);
        });
        await page.getByRole('heading', { name: '登录 WO' }).waitFor({
          timeout: 30_000,
        });
        return peer(application, page);
      } catch (error) {
        await closeApplication(application);
        throw error;
      }
    };

    const first = await launchPeer('first');
    firstApplication = first.application;
    const second = await launchPeer('second');
    secondApplication = second.application;
    const additionalPeers: AcceptancePeer[] = [];
    let additionalPeerSequence = 0;
    let closed = false;
    return Object.freeze({
      first,
      second,
      motionTitle,
      launchAdditional: async () => {
        if (closed) {
          throw new Error(
            'Cannot launch a peer after the acceptance pair closed',
          );
        }
        additionalPeerSequence += 1;
        const additionalPeer = await launchPeer(
          `additional-${additionalPeerSequence}`,
        );
        if (closed) {
          await additionalPeer.close();
          throw new Error(
            'Acceptance pair closed while an additional peer was launching',
          );
        }
        additionalPeers.push(additionalPeer);
        return additionalPeer;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([
          first.close(),
          second.close(),
          ...additionalPeers.map((additionalPeer) => additionalPeer.close()),
        ]);
        await closeApplication(motionApplication);
        if (rendererServer !== null) await closeServer(rendererServer);
        await rm(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 250,
        });
      },
    });
  } catch (error) {
    await Promise.allSettled([
      closeApplication(firstApplication),
      closeApplication(secondApplication),
      closeApplication(motionApplication),
    ]);
    if (rendererServer !== null) await closeServer(rendererServer);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
    throw error;
  }
}

export const test = base.extend<{ acceptance: AcceptanceLauncher }>({
  acceptance: async ({ browserName }, use) => {
    void browserName;
    const pairs: AcceptancePair[] = [];
    await use({
      launch: async (policy) => {
        const launched = await launchPair(policy);
        pairs.push(launched);
        return launched;
      },
    });
    for (const launched of pairs.toReversed()) await launched.close();
  },
});
