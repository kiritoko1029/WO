import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  SERVER_LOGGER_OPTIONS,
  safeErrorMetadata,
  serializeRequestForLog,
} from '../../apps/server/src/logging.ts';
import { createApp } from '../../apps/server/src/app.ts';
import { createStatsBuffer } from '../../apps/desktop/src/renderer/src/media/stats-buffer.ts';

const root = resolve(import.meta.dirname, '..', '..');

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

describe('production redaction gates', () => {
  test('serializes requests without headers, bodies, query strings, or peer addresses', () => {
    const serialized = serializeRequestForLog({
      method: 'POST',
      url: '/v1/auth/login?ticket=SIGNAL_TICKET&email=person@example.cn',
      headers: {
        authorization: 'Bearer ACCESS_TOKEN',
        'sec-websocket-protocol': 'wo-v1,SIGNAL_TICKET',
      },
      body: { email: 'person@example.cn', password: 'PASSWORD_SECRET' },
      remoteAddress: '192.0.2.10',
    });

    expect(serialized).toEqual({ method: 'POST', path: '/v1/auth/login' });
    expect(JSON.stringify(serialized)).not.toMatch(
      /SIGNAL_TICKET|ACCESS_TOKEN|person@example\.cn|PASSWORD_SECRET|192\.0\.2\.10/u,
    );
  });

  test('redacts every structured secret class and emits only safe error metadata', () => {
    const redact = SERVER_LOGGER_OPTIONS.redact;
    expect(redact.censor).toBe('[Redacted]');
    expect(new Set(redact.paths)).toEqual(
      new Set([
        'req.headers.authorization',
        'request.headers.authorization',
        'req.headers.sec-websocket-protocol',
        'request.headers.sec-websocket-protocol',
        'req.body',
        'request.body',
        'authorization',
        'email',
        'password',
        'roomCode',
        'accessToken',
        'refreshToken',
        'tokenHash',
        'ticket',
        'sdp',
        'candidate',
        'username',
        'credential',
        'sourceName',
        'windowTitle',
      ]),
    );

    const error = Object.assign(new Error('token=RAW_TOKEN'), {
      code: 'INTERNAL_FAILURE',
      cause: new Error('password=PASSWORD_SECRET'),
      email: 'person@example.cn',
    });
    expect(safeErrorMetadata(error)).toEqual({
      errorName: 'Error',
      errorCode: 'INTERNAL_FAILURE',
    });
    expect(JSON.stringify(safeErrorMetadata(error))).not.toMatch(
      /RAW_TOKEN|PASSWORD_SECRET|person@example\.cn|stack|cause/u,
    );
  });

  test('keeps secrets out of real Fastify request and failure logs', async () => {
    let logs = '';
    const app = await createApp({
      authService: new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error('RAW_TOKEN PASSWORD_SECRET person@example.cn');
          },
        },
      ) as never,
      accessTokenService: {
        sign: async () => 'unused',
        verify: async () => {
          throw new Error('ACCESS_TOKEN');
        },
      },
      readinessCheck: async () => undefined,
      logger: {
        ...SERVER_LOGGER_OPTIONS,
        stream: {
          write: (chunk: string) => {
            logs += chunk;
          },
        },
      } as never,
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login?ticket=SIGNAL_TICKET',
        headers: {
          authorization: 'Bearer ACCESS_TOKEN',
          'content-type': 'application/json',
          'sec-websocket-protocol': 'wo-v1,SIGNAL_TICKET',
        },
        payload: {
          email: 'person@example.cn',
          password: 'PASSWORD_SECRET',
        },
      });
    } finally {
      await app.close();
    }

    expect(logs).toContain('"path":"/v1/auth/login"');
    expect(logs).not.toMatch(
      /RAW_TOKEN|PASSWORD_SECRET|person@example\.cn|SIGNAL_TICKET|ACCESS_TOKEN/u,
    );
  });

  test('exports diagnostics through an exact public schema', () => {
    const buffer = createStatsBuffer();
    buffer.append({
      timestampMs: 1_700_000_000_000,
      negotiationGeneration: 3,
      path: {
        candidateType: 'relay',
        protocol: 'udp',
        address: '192.0.2.10',
      },
      capture: { width: 1920, height: 1080, frameRate: 60 },
      targetBitrateBps: 8_000_000,
      outbound: null,
      inbound: null,
      presentationFps: 60,
      email: 'person@example.cn',
      roomCode: '123456',
      sourceName: 'Confidential window',
      sdp: 'v=0',
    } as never);

    const serialized = JSON.stringify(buffer.exportSnapshot());
    expect(serialized).toContain('"candidateType":"relay"');
    expect(serialized).not.toMatch(
      /192\.0\.2\.10|person@example\.cn|123456|Confidential window|v=0|address|sourceName/u,
    );
  });

  test('keeps renderer and main-process source free of browser secret persistence and crash extras', async () => {
    const desktopSource = resolve(root, 'apps', 'desktop', 'src');
    const files = await sourceFiles(desktopSource);
    const combined = (
      await Promise.all(
        files.map(async (path) => `${path}\n${await readFile(path, 'utf8')}`),
      )
    ).join('\n');

    expect(combined).not.toMatch(
      /\b(?:localStorage|sessionStorage|indexedDB|crashReporter)\b/u,
    );
    expect(combined).not.toMatch(
      /(?:setExtraParameter|addExtraParameter)\s*\(/u,
    );
  });

  test('does not enable Caddy access logging that could retain failed handshake headers', async () => {
    for (const name of ['Caddyfile', 'Caddyfile.integration']) {
      const source = await readFile(
        resolve(root, 'deploy', 'caddy', name),
        'utf8',
      );
      expect(source).not.toMatch(/^\s*log(?:_append)?\b/mu);
    }
  });
});
