import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { createDeploymentStatusReader } from '../src/modules/admin/deployment-status.ts';

const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const directories: string[] = [];
const config = {
  publicUrl: 'https://turn.example.com/',
  turn: {
    host: 'turn.example.com',
    realm: 'turn.example.com',
    urls: ['turns:turn.example.com:5349?transport=tcp'],
    sharedSecret: 'turn-secret-sentinel',
    credentialTtlSeconds: 600,
  },
  email: {
    domainAllowlist: [],
    verificationRequired: false,
    codeTtlSeconds: 600,
    superAdminEmails: [],
    smtp: null,
  },
};
const ready = {
  version: 1,
  mode: 'acme',
  state: 'ready',
  lastAttemptAt: new Date(NOW).toISOString(),
  lastSuccessAt: new Date(NOW).toISOString(),
  errorCode: null,
};
async function setup(status: unknown = ready, pem = true) {
  const directory = await mkdtemp(join(tmpdir(), 'wo-deployment-status-'));
  directories.push(directory);
  if (status !== null)
    await writeFile(join(directory, 'status.json'), JSON.stringify(status));
  if (pem)
    await writeFile(
      join(directory, 'certificate.pem'),
      await readFile(
        new URL(
          '../../../tests/fixtures/deploy-turn-cert.pem',
          import.meta.url,
        ),
      ),
    );
  return {
    directory,
    read: createDeploymentStatusReader(
      {
        ...config,
        deployment: { statusDir: directory, certificateMode: 'acme' },
      },
      () => NOW,
    ),
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('read-only public deployment status', () => {
  test('manual deployments stay supported without reading certificate files', async () => {
    const status = await createDeploymentStatusReader(config, () => NOW)();
    expect(status.enabled).toBe(false);
    expect(status.certificate.state).toBe('unmanaged');
    expect(JSON.stringify(status)).not.toContain('turn-secret-sentinel');
  });
  test('parses only public leaf fields and reports hostname matching', async () => {
    const { directory, read } = await setup();
    await writeFile(
      join(directory, 'private-key.pem'),
      'DO_NOT_READ_PRIVATE_KEY',
    );
    const status = await read();
    expect(status.certificate.state).toBe('ready');
    expect(status.certificate.details).toMatchObject({
      subject: 'CN=turn.example.com',
      matchesPublicHost: true,
      matchesTurnHost: true,
    });
    const encoded = JSON.stringify(status);
    expect(encoded).not.toContain('DO_NOT_READ_PRIVATE_KEY');
    expect(encoded).not.toContain('BEGIN CERTIFICATE');
    expect(encoded).not.toContain(directory);
    expect(encoded).not.toContain('turn-secret-sentinel');
    expect(status.adminUrl).toBe('https://turn.example.com/admin');
  });
  test('missing first-start files remain pending and do not fail the API', async () => {
    const { read } = await setup(null, false);
    expect((await read()).certificate).toMatchObject({
      state: 'pending',
      details: null,
      alerts: ['CERTIFICATE_PENDING'],
    });
  });
  test.each([
    { ...ready, privateKey: 'SECRET_SENTINEL' },
    { ...ready, mode: 'local' },
    { ...ready, state: 'arbitrary-state' },
    { ...ready, lastAttemptAt: 'malformed-date' },
    { ...ready, lastAttemptAt: '2036-01-01T00:00:00.000Z' },
  ])(
    'malformed or inconsistent metadata becomes unavailable: %j',
    async (metadata) => {
      const { read } = await setup(metadata);
      const result = await read();
      expect(result.certificate.state).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
    },
  );
  test('rejects invalid JSON and oversized files without returning contents', async () => {
    const { directory, read } = await setup();
    for (const content of ['{', 'x'.repeat(16_385)]) {
      await writeFile(join(directory, 'status.json'), content);
      expect((await read()).certificate.state).toBe('unavailable');
    }
  });
  test('rejects a private key accidentally mixed into the public certificate', async () => {
    const { directory, read } = await setup();
    await writeFile(
      join(directory, 'certificate.pem'),
      '-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL',
    );
    const result = await read();
    expect(result.certificate.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });
  test('exposes stale renewal failures while keeping existing certificate information', async () => {
    const { read } = await setup({
      ...ready,
      state: 'error',
      errorCode: 'RENEWAL_FAILED',
      lastAttemptAt: '2026-09-08T00:00:00.000Z',
    });
    const cert = (await read()).certificate;
    expect(cert.state).toBe('error');
    expect(cert.details).not.toBeNull();
    expect(cert.alerts).toEqual(['STATUS_STALE', 'RENEWAL_FAILED']);
  });
  test('reports hostname mismatches, expiry, and local trust honestly', async () => {
    const { directory } = await setup({ ...ready, mode: 'local' });
    const read = createDeploymentStatusReader(
      {
        ...config,
        publicUrl: 'https://wrong.example.com',
        deployment: { statusDir: directory, certificateMode: 'local' },
      },
      () => Date.parse('2037-01-01T00:00:00.000Z'),
    );
    const cert = (await read()).certificate;
    expect(cert.details?.matchesPublicHost).toBe(false);
    expect(cert.alerts).toEqual(
      expect.arrayContaining([
        'LOCAL_CERTIFICATE',
        'CERTIFICATE_EXPIRED',
        'HOST_MISMATCH',
      ]),
    );
  });
});
