import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { connect, type DetailedPeerCertificate } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import {
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
  return new Promise((resolvePeer, reject) => {
    const socket = connect({
      host: 'rtc.localhost',
      port: 443,
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
      error: 'net::ERR_CERT_DATE_INVALID',
    }),
  ).toBe(false);
});
