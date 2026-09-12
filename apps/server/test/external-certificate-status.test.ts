import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { createDeploymentStatusReader } from '../src/modules/admin/deployment-status.ts';

test('external certificate publication never claims WO manages HTTPS renewal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wo-external-status-'));
  try {
    const now = Date.parse('2026-09-12T00:00:00Z');
    await writeFile(
      join(directory, 'certificate.pem'),
      await readFile(
        new URL(
          '../../../tests/fixtures/deploy-turn-cert.pem',
          import.meta.url,
        ),
      ),
    );
    await writeFile(
      join(directory, 'status.json'),
      JSON.stringify({
        version: 1,
        mode: 'external',
        state: 'error',
        lastAttemptAt: new Date(now).toISOString(),
        lastSuccessAt: new Date(now).toISOString(),
        errorCode: 'IMPORT_FAILED',
      }),
    );
    const read = createDeploymentStatusReader(
      {
        publicUrl: 'https://turn.example.com',
        turn: {
          host: 'turn.example.com',
          realm: 'turn.example.com',
          urls: ['turns:turn.example.com:5349'],
          sharedSecret: 'private-sentinel',
          credentialTtlSeconds: 600,
        },
        email: {
          domainAllowlist: [],
          verificationRequired: false,
          codeTtlSeconds: 600,
          superAdminEmails: [],
          smtp: null,
        },
        deployment: { statusDir: directory, certificateMode: 'external' },
      },
      () => now,
    );
    const status = await read();
    expect(status.certificate).toMatchObject({
      mode: 'external',
      autoRenew: false,
      state: 'error',
      errorCode: 'IMPORT_FAILED',
      alerts: ['IMPORT_FAILED'],
    });
    expect(status.certificate.details?.matchesTurnHost).toBe(true);
    expect(JSON.stringify(status)).not.toContain('private-sentinel');
    expect(JSON.stringify(status)).not.toContain(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
