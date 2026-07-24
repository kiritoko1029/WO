import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect, type DetailedPeerCertificate } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { _electron as electron, expect, test } from '@playwright/test';
import electronPath from 'electron';

import {
  acceptanceCertificateVerificationResult,
  acceptsPinnedAcceptanceCertificate,
  type AcceptanceCertificate,
} from '../src/main/acceptance-certificate.js';

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const acceptanceOutput = join(desktopDirectory, 'out-acceptance');
const productionOutput = join(desktopDirectory, 'out');
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';

const acceptanceMarkers = [
  'cn.wo.desktop.acceptance',
  'acceptance:audio:wav',
  'certificate-error',
  'acceptance:diagnostics:snapshot',
  'acceptanceCertificateVerificationResult',
] as const;

async function textFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(await textFiles(path));
      continue;
    }
    contents.push(await readFile(path, 'utf8'));
  }
  return contents.join('\n');
}

async function expectClipboardBridge(preload: string): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'wo-clipboard-bridge-test-'),
  );
  const mainEntry = join(temporaryRoot, 'main.cjs');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;

  await writeFile(
    mainEntry,
    `
const { app, BrowserWindow } = require('electron');
const { ipcMain } = require('electron');

const clipboardWrites = [];
global.__woClipboardWrites = clipboardWrites;
ipcMain.handle('desktop:clipboard:write-text', (_event, ...arguments_) => {
  clipboardWrites.push(arguments_);
  return { ok: true, value: null };
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: ${JSON.stringify(preload)},
      sandbox: true,
    },
  });
  void window.loadURL('data:text/html,<title>WO clipboard bridge</title>');
});
`,
    { mode: 0o600 },
  );

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      cwd: temporaryRoot,
      env: environment,
      timeout: 30_000,
    });
    const page = await application.firstWindow();
    await expect(page).toHaveTitle('WO clipboard bridge');
    const probeValue = 'https://wo.example.cn/join/482731';
    const bridge = await page.evaluate(async (value) => {
      const candidate = (
        globalThis as unknown as {
          woClipboard?: {
            writeText?: (clipboardValue: string) => Promise<void>;
          };
        }
      ).woClipboard;
      const shape = {
        bridgeType: typeof candidate,
        keys: candidate === undefined ? [] : Object.keys(candidate),
        writerType: typeof candidate?.writeText,
      };
      if (typeof candidate?.writeText !== 'function') return shape;
      await candidate.writeText(value);
      return shape;
    }, probeValue);
    expect(bridge).toEqual({
      bridgeType: 'object',
      keys: ['writeText'],
      writerType: 'function',
    });
    const writes = await application.evaluate(
      () =>
        (
          globalThis as unknown as {
            __woClipboardWrites?: readonly (readonly unknown[])[];
          }
        ).__woClipboardWrites,
    );
    expect(writes).toEqual([[probeValue]]);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function pem(raw: Buffer): string {
  const body =
    raw
      .toString('base64')
      .match(/.{1,64}/gu)
      ?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function acceptanceChain(peer: DetailedPeerCertificate): AcceptanceCertificate {
  const chain: DetailedPeerCertificate[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = peer;
  while (current !== undefined && current.raw.length > 0) {
    const identity = current.raw.toString('hex');
    if (seen.has(identity)) break;
    seen.add(identity);
    chain.push(current);
    current = current.issuerCertificate;
  }
  let output: AcceptanceCertificate | undefined;
  for (const certificate of chain.toReversed()) {
    output = { data: pem(certificate.raw), issuerCert: output };
  }
  if (output === undefined) throw new Error('TLS peer did not return a chain');
  return output;
}

function withoutReportedRoot(
  certificate: AcceptanceCertificate,
): AcceptanceCertificate {
  if (
    certificate.issuerCert === undefined ||
    certificate.issuerCert.issuerCert === undefined
  ) {
    return { data: certificate.data };
  }
  return {
    data: certificate.data,
    issuerCert: withoutReportedRoot(certificate.issuerCert),
  };
}

async function caddyPeer(ca: string): Promise<DetailedPeerCertificate> {
  const endpoint = new URL(
    process.env.WO_E2E_BASE_URL ?? 'https://rtc.localhost',
  );
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== 'rtc.localhost' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new Error(
      'WO_E2E_BASE_URL must use trusted https://rtc.localhost[:port]',
    );
  }
  return new Promise((resolvePeer, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port: endpoint.port === '' ? 443 : Number(endpoint.port),
      servername: 'rtc.localhost',
      ca,
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate(true);
      socket.end();
      resolvePeer(certificate);
    });
    socket.once('error', reject);
  });
}

test('keeps acceptance hooks in a separately pinned build', async () => {
  await rm(acceptanceOutput, { recursive: true, force: true });
  await execFileAsync(
    pnpm,
    [
      'exec',
      'electron-vite',
      'build',
      '--config',
      'electron.vite.acceptance.config.ts',
    ],
    { cwd: desktopDirectory, windowsHide: true },
  );
  await execFileAsync(pnpm, ['run', 'build'], {
    cwd: desktopDirectory,
    windowsHide: true,
  });
  await expectClipboardBridge(join(acceptanceOutput, 'preload', 'index.js'));
  await expectClipboardBridge(join(productionOutput, 'preload', 'index.js'));

  const acceptance = await textFiles(acceptanceOutput);
  const production = await textFiles(productionOutput);
  const caPem = await readFile(
    join(
      repositoryDirectory,
      'deploy',
      '.certs',
      'caddy-authority',
      'root.crt',
    ),
    'utf8',
  );
  const certificate = new X509Certificate(caPem);
  const spki = createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');

  for (const marker of acceptanceMarkers) expect(acceptance).toContain(marker);
  expect(acceptance).toContain(spki);
  for (const marker of acceptanceMarkers)
    expect(production).not.toContain(marker);
  expect(production).not.toContain(spki);
  for (const marker of [
    'WO_EXTRA_CA_CERTS',
    'fixed extra CA hostname',
    'ERR_CERT_AUTHORITY_INVALID',
    'checkIssued',
    'setCertificateVerifyProc',
  ])
    expect(production).toContain(marker);
});

test('accepts only the current rtc.localhost chain and pinned root SPKI', async () => {
  const caPem = await readFile(
    join(
      repositoryDirectory,
      'deploy',
      '.certs',
      'caddy-authority',
      'root.crt',
    ),
    'utf8',
  );
  const root = new X509Certificate(caPem);
  const spki = createHash('sha256')
    .update(root.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const certificate = acceptanceChain(await caddyPeer(caPem));
  const request = {
    url: 'https://rtc.localhost/v1/realtime',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate,
    pinnedRootSpki: spki,
  };

  expect(acceptsPinnedAcceptanceCertificate(request)).toBe(true);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      url: 'https://rtc.localhost:18443/v1/realtime',
    }),
  ).toBe(true);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      certificate: withoutReportedRoot(certificate),
      trustedRoot: caPem,
    }),
  ).toBe(true);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      pinnedRootSpki: Buffer.alloc(32, 0xa5).toString('base64'),
    }),
  ).toBe(false);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      url: 'https://localhost/',
    }),
  ).toBe(false);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      url: 'https://127.0.0.1:18443/',
    }),
  ).toBe(false);
  expect(
    acceptsPinnedAcceptanceCertificate({
      ...request,
      error: 'net::ERR_CERT_DATE_INVALID',
    }),
  ).toBe(false);
  for (const verificationResult of [
    'OK',
    'net::OK',
    'CERT_AUTHORITY_INVALID',
    'ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_AUTHORITY_INVALID',
  ]) {
    expect(
      acceptanceCertificateVerificationResult({
        hostname: 'rtc.localhost',
        verificationResult,
        certificate,
        pinnedRootSpki: spki,
        trustedRoot: caPem,
      }),
    ).toBe(0);
  }
  expect(
    acceptanceCertificateVerificationResult({
      hostname: 'rtc.localhost',
      verificationResult: 'OK',
      certificate,
      pinnedRootSpki: Buffer.alloc(32, 0xa5).toString('base64'),
      trustedRoot: caPem,
    }),
  ).toBe(-2);
  expect(
    acceptanceCertificateVerificationResult({
      hostname: 'rtc.localhost',
      verificationResult: 'CERT_DATE_INVALID',
      certificate,
      pinnedRootSpki: spki,
      trustedRoot: caPem,
    }),
  ).toBe(-2);
  expect(
    acceptanceCertificateVerificationResult({
      hostname: 'example.test',
      verificationResult: 'OK',
      certificate,
      pinnedRootSpki: spki,
      trustedRoot: caPem,
    }),
  ).toBe(-3);
});
