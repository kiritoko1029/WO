import { describe, expect, test, vi } from 'vitest';

import { createBrowserDesktopApi } from '../src/browser-desktop-api.js';
import type { DesktopApi } from '../../desktop/src/preload/types.js';

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

const AUTH_RESPONSE = {
  user: USER,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresInSeconds: 900,
};

const accountOperations = [
  {
    name: 'changePassword',
    path: '/v1/auth/password',
    invoke: (api: DesktopApi) =>
      api.auth.changePassword({
        currentPassword: 'long-password',
        newPassword: 'new-long-password',
      }),
    response: { changed: true },
    expectedResult: undefined,
    expectedStoredToken: 'refresh-b',
  },
  {
    name: 'requestEmailChange',
    path: '/v1/auth/email/change/request',
    invoke: (api: DesktopApi) =>
      api.auth.requestEmailChange({
        password: 'long-password',
        newEmail: 'next@example.cn',
      }),
    response: { status: 'verification_required', email: 'next@example.cn' },
    expectedResult: { email: 'next@example.cn' },
    expectedStoredToken: 'refresh-b',
  },
  {
    name: 'confirmEmailChange',
    path: '/v1/auth/email/change/confirm',
    invoke: (api: DesktopApi) =>
      api.auth.confirmEmailChange({
        newEmail: 'next@example.cn',
        code: '123456',
      }),
    response: { ...AUTH_RESPONSE, refreshToken: 'refresh-confirmed' },
    expectedResult: {
      user: USER,
      accessToken: AUTH_RESPONSE.accessToken,
      accessTokenExpiresAt: 901_000,
    },
    expectedStoredToken: 'refresh-confirmed',
  },
];

describe('serialized browser account mutations', () => {
  test.each(accountOperations)(
    '$name refreshes inside its queue turn and preserves refresh/logout token order',
    async ({ invoke, path, response, expectedResult, expectedStoredToken }) => {
      const storage = memoryStorage('stored-refresh');
      let releaseRefresh!: (response: Response) => void;
      const fetch = vi
        .fn()
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            releaseRefresh = resolve;
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              ...AUTH_RESPONSE,
              accessToken: 'access-b',
              refreshToken: 'refresh-b',
            },
            '/v1/auth/refresh',
          ),
        )
        .mockResolvedValueOnce(jsonResponse(response, path))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              ...AUTH_RESPONSE,
              accessToken: 'access-c',
              refreshToken: 'refresh-c',
            },
            '/v1/auth/refresh',
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({ loggedOut: true }, '/v1/auth/logout'),
        );
      const api = createBrowserDesktopApi({
        origin: ORIGIN,
        storage,
        fetch,
        now: () => 1_000,
      });

      const before = api.auth.refresh();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const account = invoke(api);
      const after = api.auth.refresh();
      expect(api.auth.refresh()).toBe(after);
      expect(after).not.toBe(before);
      const logout = api.auth.logout();
      const afterLogout = expect(api.auth.refresh()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
      releaseRefresh(
        jsonResponse(
          { ...AUTH_RESPONSE, refreshToken: 'refresh-a' },
          '/v1/auth/refresh',
        ),
      );

      await expect(account).resolves.toEqual(expectedResult);
      await Promise.all([before, after, logout, afterLogout]);
      expect(
        fetch.mock.calls.map(([url, init]) => ({
          url: String(url),
          body: JSON.parse(init.body),
          authorization: init.headers.authorization,
        })),
      ).toEqual([
        {
          url: `${ORIGIN}/v1/auth/refresh`,
          body: { refreshToken: 'stored-refresh' },
          authorization: undefined,
        },
        {
          url: `${ORIGIN}/v1/auth/refresh`,
          body: { refreshToken: 'refresh-a' },
          authorization: undefined,
        },
        {
          url: `${ORIGIN}${path}`,
          body: expect.any(Object),
          authorization: 'Bearer access-b',
        },
        {
          url: `${ORIGIN}/v1/auth/refresh`,
          body: { refreshToken: expectedStoredToken },
          authorization: undefined,
        },
        {
          url: `${ORIGIN}/v1/auth/logout`,
          body: { refreshToken: 'refresh-c' },
          authorization: undefined,
        },
      ]);
      expect(storage.getItem('wo.web.refresh-token.v1')).toBeNull();
    },
    2_000,
  );

  test.each(accountOperations)(
    '$name rejects an expired refresh without stalling the queue and recovers after login',
    async ({ invoke, path, response, expectedResult }) => {
      const storage = memoryStorage('expired-refresh');
      const remove = vi.spyOn(storage, 'removeItem');
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
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
        )
        .mockResolvedValueOnce(
          jsonResponse(
            { ...AUTH_RESPONSE, refreshToken: 'refresh-login' },
            '/v1/auth/login',
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              ...AUTH_RESPONSE,
              accessToken: 'access-b',
              refreshToken: 'refresh-b',
            },
            '/v1/auth/refresh',
          ),
        )
        .mockResolvedValueOnce(jsonResponse(response, path));
      const api = createBrowserDesktopApi({
        origin: ORIGIN,
        storage,
        fetch,
        now: () => 1_000,
      });

      const failure = expect(invoke(api)).rejects.toMatchObject({
        status: 401,
        code: 'AUTH_REQUIRED',
      });
      const queuedRefresh = expect(api.auth.refresh()).rejects.toMatchObject({
        status: null,
        code: 'AUTH_REQUIRED',
      });
      await Promise.all([failure, queuedRefresh]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(storage.getItem('wo.web.refresh-token.v1')).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);

      await api.auth.login({ email: USER.email, password: 'long-password' });
      await expect(invoke(api)).resolves.toEqual(expectedResult);
      expect(
        fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
      ).toEqual([
        '/v1/auth/refresh',
        '/v1/auth/login',
        '/v1/auth/refresh',
        path,
      ]);
      expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({
        refreshToken: 'refresh-login',
      });
    },
    2_000,
  );

  test.each(accountOperations)(
    '$name allows an explicit retry after an account 401 and uses the rotated refresh token',
    async ({ invoke, path, response, expectedResult, expectedStoredToken }) => {
      const storage = memoryStorage('stored-refresh');
      const remove = vi.spyOn(storage, 'removeItem');
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              ...AUTH_RESPONSE,
              accessToken: 'access-a',
              refreshToken: 'refresh-a',
            },
            '/v1/auth/refresh',
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: 'AUTH_REQUIRED',
                message: 'Authentication is required',
              },
            },
            path,
            401,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              ...AUTH_RESPONSE,
              accessToken: 'access-b',
              refreshToken: 'refresh-b',
            },
            '/v1/auth/refresh',
          ),
        )
        .mockResolvedValueOnce(jsonResponse(response, path));
      const api = createBrowserDesktopApi({
        origin: ORIGIN,
        storage,
        fetch,
        now: () => 1_000,
      });

      await expect(invoke(api)).rejects.toMatchObject({
        status: 401,
        code: 'AUTH_REQUIRED',
      });
      expect(remove).not.toHaveBeenCalled();
      expect(storage.getItem('wo.web.refresh-token.v1')).toBe('refresh-a');
      await expect(invoke(api)).resolves.toEqual(expectedResult);
      expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({
        refreshToken: 'refresh-a',
      });
      expect(fetch.mock.calls[3]?.[1].headers.authorization).toBe(
        'Bearer access-b',
      );
      expect(storage.getItem('wo.web.refresh-token.v1')).toBe(
        expectedStoredToken,
      );
    },
    2_000,
  );
});

describe('browser DesktopApi', () => {
  test('accepts the authenticated registration discriminator and stores the session', async () => {
    const storage = memoryStorage();
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          user: USER,
          accessToken: 'access-register',
          refreshToken: 'refresh-register',
          accessTokenExpiresInSeconds: 900,
          status: 'authenticated',
        },
        '/v1/auth/register',
        201,
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
      api.auth.register({
        email: 'alice@example.test',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice',
      }),
    ).resolves.toEqual({
      kind: 'session',
      session: {
        user: USER,
        accessToken: 'access-register',
        accessTokenExpiresAt: 901_000,
      },
    });
    expect(storage.getItem('wo.web.refresh-token.v1')).toBe('refresh-register');
  });

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
      systemAudioMode: 'native-picker',
      captureProcessElevated: false,
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
      systemAudioMode: 'unsupported',
      captureProcessElevated: false,
    });
  });
});
