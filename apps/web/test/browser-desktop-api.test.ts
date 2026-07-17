import { describe, expect, test, vi } from 'vitest';

import { createBrowserDesktopApi } from '../src/browser-desktop-api.js';

const ORIGIN = 'https://wo.example.test';
const USER = Object.freeze({
  userId: 'user-1',
  email: 'alice@example.test',
  displayName: 'Alice',
});

function jsonResponse(body: unknown, path: string, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'url', {
    value: `${ORIGIN}${path}`,
  });
  return response;
}

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('wo.web.refresh-token.v1', initial);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe('browser DesktopApi', () => {
  test('stores and rotates refresh tokens only through tab storage', async () => {
    const storage = memoryStorage();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            user: USER,
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            accessTokenExpiresInSeconds: 900,
          },
          '/v1/auth/login',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            user: USER,
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresInSeconds: 900,
          },
          '/v1/auth/refresh',
        ),
      );
    const api = createBrowserDesktopApi({
      origin: ORIGIN,
      storage,
      fetch: fetch as typeof globalThis.fetch,
      now: () => 1_000,
      displayCaptureSupported: true,
    });

    await expect(
      api.auth.login({
        email: 'alice@example.test',
        password: 'correct-horse-battery-staple',
      }),
    ).resolves.toEqual({
      user: USER,
      accessToken: 'access-1',
      accessTokenExpiresAt: 901_000,
    });
    expect(storage.getItem('wo.web.refresh-token.v1')).toBe('refresh-1');

    const [first, second] = await Promise.all([
      api.auth.refresh(),
      api.auth.refresh(),
    ]);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe('access-2');
    expect(storage.getItem('wo.web.refresh-token.v1')).toBe('refresh-2');
    expect(fetch).toHaveBeenCalledTimes(2);

    const refreshCall = fetch.mock.calls[1]!;
    expect(String(refreshCall[0])).toBe(`${ORIGIN}/v1/auth/refresh`);
    expect(JSON.parse(String(refreshCall[1]?.body))).toEqual({
      refreshToken: 'refresh-1',
    });
    expect(JSON.stringify(refreshCall)).not.toContain('refresh-2');
  });

  test('clears a rejected refresh token without placing it in the URL', async () => {
    const storage = memoryStorage('stale-refresh');
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'AUTH_REQUIRED',
            message: 'Authentication is required',
          },
        },
        '/v1/auth/refresh',
        401,
      ),
    );
    const api = createBrowserDesktopApi({
      origin: ORIGIN,
      storage,
      fetch: fetch as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });

    await expect(api.auth.refresh()).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
    });
    expect(storage.getItem('wo.web.refresh-token.v1')).toBeNull();
    expect(String(fetch.mock.calls[0]![0])).toBe(`${ORIGIN}/v1/auth/refresh`);
  });

  test('rejects responses attributed to another origin', async () => {
    const response = new Response(
      JSON.stringify({
        ticket: 'A'.repeat(43),
        expiresInSeconds: 30,
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
    Object.defineProperty(response, 'url', {
      value: 'https://attacker.example/v1/realtime/ticket',
    });
    const api = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: vi.fn().mockResolvedValue(response) as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });

    await expect(
      api.realtime.issueTicket('access-token'),
    ).rejects.toMatchObject({
      status: null,
      code: 'UNTRUSTED_RESPONSE_ORIGIN',
    });
  });

  test('validates realtime grants and derives the same-origin WSS endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ticket: 'A'.repeat(43),
          expiresInSeconds: 30,
        },
        '/v1/realtime/ticket',
      ),
    );
    const api = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: fetch as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });

    await expect(api.realtime.issueTicket('access-token')).resolves.toEqual({
      endpoint: 'wss://wo.example.test/v1/realtime',
      ticket: 'A'.repeat(43),
      expiresInSeconds: 30,
    });
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: 'Bearer access-token',
    });
  });

  test('rejects invalid and oversized chunked server responses', async () => {
    const invalidFetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ticket: 'not-a-ticket',
          expiresInSeconds: 30,
        },
        '/v1/realtime/ticket',
      ),
    );
    const invalidApi = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: invalidFetch as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });
    await expect(
      invalidApi.realtime.issueTicket('access-token'),
    ).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    });

    const oversized = new Response('x'.repeat(256 * 1_024 + 1));
    Object.defineProperty(oversized, 'url', {
      value: `${ORIGIN}/v1/realtime/ticket`,
    });
    const oversizedApi = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: vi.fn().mockResolvedValue(oversized) as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });
    await expect(
      oversizedApi.realtime.issueTicket('access-token'),
    ).rejects.toMatchObject({
      status: 200,
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  test('exposes one virtual source and degrades unsupported capture', async () => {
    const supported = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      displayCaptureSupported: true,
    });
    const [source] = await supported.capture.list();
    expect(source?.name).toBe('使用浏览器选择共享内容');
    await expect(
      supported.capture.select(source!.token),
    ).resolves.toBeUndefined();
    await expect(supported.capture.permission()).resolves.toEqual({
      status: 'not-determined',
      canOpenSettings: false,
    });

    const unsupported = createBrowserDesktopApi({
      origin: ORIGIN,
      storage: memoryStorage(),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      displayCaptureSupported: false,
    });
    await expect(unsupported.capture.list()).resolves.toEqual([]);
    await expect(unsupported.capture.permission()).resolves.toEqual({
      status: 'restricted',
      canOpenSettings: false,
    });
  });
});
