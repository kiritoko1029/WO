import { describe, expect, it, vi } from 'vitest';

import {
  AuthSessionBrokerError,
  createAuthSessionBroker,
} from '../src/main/auth-session-broker.js';
import {
  DesktopHttpError,
  type MainHttpClient,
} from '../src/main/http-client.js';
import {
  SecureSessionStoreError,
  type SecureSessionStore,
} from '../src/main/secure-session-store.js';

const authResponse = {
  user: {
    userId: 'user-1',
    email: 'person@example.cn',
    displayName: 'Person',
  },
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresInSeconds: 900,
};

function createStore(initial: string | null = null): SecureSessionStore & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (next: string) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
  };
}

function createHttp(): MainHttpClient & {
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn() as unknown as MainHttpClient['post'] &
    ReturnType<typeof vi.fn>;
  return { post };
}

describe('auth session broker', () => {
  it.each(['register', 'login'] as const)(
    '%s stores refresh ciphertext and returns only the public session',
    async (operation) => {
      const store = createStore();
      const http = createHttp();
      http.post.mockResolvedValue(
        operation === 'register'
          ? { ...authResponse, status: 'authenticated' }
          : authResponse,
      );
      const broker = createAuthSessionBroker({
        http,
        sessionStore: store,
        now: () => 1_000,
      });

      const result =
        operation === 'register'
          ? await broker.register({
              email: ' PERSON@EXAMPLE.CN ',
              password: 'long-password',
              displayName: ' Person ',
            })
          : await broker.login({
              email: ' PERSON@EXAMPLE.CN ',
              password: 'long-password',
            });

      expect(store.write).toHaveBeenCalledWith('refresh-token');
      const expectedSession = {
        user: authResponse.user,
        accessToken: 'access-token',
        accessTokenExpiresAt: 901_000,
      };
      expect(result).toEqual(
        operation === 'register'
          ? { kind: 'session', session: expectedSession }
          : expectedSession,
      );
      expect(JSON.stringify(result)).not.toContain('refresh-token');
      expect(http.post).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `/v1/auth/${operation}`,
          body: expect.objectContaining({ email: 'person@example.cn' }),
        }),
      );
    },
  );

  it('rejects invalid register and login input before any network call', async () => {
    const store = createStore();
    const http = createHttp();
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(
      broker.register({
        email: 'bad',
        password: 'short',
        displayName: '',
      }),
    ).rejects.toThrow();
    await expect(
      broker.login({ email: 'bad', password: 'short' }),
    ).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refresh calls and atomically rotates the stored token', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    let release: ((value: typeof authResponse) => void) | undefined;
    http.post.mockReturnValue(
      new Promise<typeof authResponse>((resolve) => {
        release = resolve;
      }),
    );
    const broker = createAuthSessionBroker({
      http,
      sessionStore: store,
      now: () => 5_000,
    });

    const first = broker.refresh();
    const second = broker.refresh();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    release?.({ ...authResponse, refreshToken: 'rotated-refresh' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'access-token' }),
      expect.objectContaining({ accessToken: 'access-token' }),
    ]);
    expect(http.post).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/refresh',
        body: { refreshToken: 'stored-refresh' },
      }),
    );
    expect(store.write).toHaveBeenCalledWith('rotated-refresh');
  });

  it('fails refresh without a local session and makes no network request', async () => {
    const store = createStore();
    const http = createHttp();
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(broker.refresh()).rejects.toBeInstanceOf(
      AuthSessionBrokerError,
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('clears a rejected refresh session once for coalesced callers', async () => {
    const store = createStore('expired-refresh');
    const http = createHttp();
    const rejection = new DesktopHttpError(
      401,
      'AUTH_REQUIRED',
      'Authentication is required',
    );
    http.post.mockRejectedValue(rejection);
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    const first = broker.refresh();
    const second = broker.refresh();
    expect(second).toBe(first);

    await Promise.all([
      expect(first).rejects.toBe(rejection),
      expect(second).rejects.toBe(rejection),
    ]);
    expect(store.clear).toHaveBeenCalledOnce();
    await expect(store.read()).resolves.toBeNull();
  });

  it('preserves a refresh session after a non-authentication failure', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    const rejection = new DesktopHttpError(
      null,
      'NETWORK_ERROR',
      'The server is unavailable',
    );
    http.post.mockRejectedValue(rejection);
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(broker.refresh()).rejects.toBe(rejection);

    expect(store.clear).not.toHaveBeenCalled();
    await expect(store.read()).resolves.toBe('stored-refresh');
  });

  it('preserves both failures when a rejected refresh session cannot be cleared', async () => {
    const store = createStore('expired-refresh');
    const clearError = new SecureSessionStoreError(
      'Unable to clear secure session',
    );
    store.clear.mockRejectedValue(clearError);
    const http = createHttp();
    const rejection = new DesktopHttpError(
      401,
      'AUTH_REQUIRED',
      'Authentication is required',
    );
    http.post.mockRejectedValue(rejection);
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    const failure = await broker.refresh().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([rejection, clearError]);
    expect((failure as AggregateError).cause).toBe(rejection);
  });

  it('does not send HTTP when the origin-bound local session is rejected', async () => {
    const store = createStore('token-for-another-origin');
    store.read.mockRejectedValue(
      new SecureSessionStoreError('Stored secure session cannot be decrypted'),
    );
    const http = createHttp();
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(broker.refresh()).rejects.toBeInstanceOf(
      SecureSessionStoreError,
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('clears local ciphertext even when remote logout fails', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    http.post.mockRejectedValue(new Error('network unavailable'));
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(broker.logout()).resolves.toBeUndefined();

    expect(http.post).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/logout',
        body: { refreshToken: 'stored-refresh' },
      }),
    );
    expect(store.clear).toHaveBeenCalledOnce();
    await expect(store.read()).resolves.toBeNull();
  });

  it('clears local ciphertext before a pending best-effort remote logout', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    let releaseRemote: ((value: { loggedOut: true }) => void) | undefined;
    http.post.mockReturnValue(
      new Promise<{ loggedOut: true }>((resolve) => {
        releaseRemote = resolve;
      }),
    );
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    const logout = broker.logout();
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledOnce());

    expect(store.clear).toHaveBeenCalledOnce();
    expect(store.clear.mock.invocationCallOrder[0]).toBeLessThan(
      http.post.mock.invocationCallOrder[0]!,
    );
    await expect(store.read()).resolves.toBeNull();
    releaseRemote?.({ loggedOut: true });
    await expect(logout).resolves.toBeUndefined();
  });

  it('revokes remotely but reports failure when local ciphertext cannot be cleared', async () => {
    const store = createStore('stored-refresh');
    const clearError = new SecureSessionStoreError(
      'Unable to clear secure session',
    );
    store.clear.mockRejectedValue(clearError);
    const http = createHttp();
    http.post.mockResolvedValue({ loggedOut: true });
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    await expect(broker.logout()).rejects.toBe(clearError);
    expect(http.post).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/logout',
        body: { refreshToken: 'stored-refresh' },
      }),
    );
  });

  it('orders logout after an in-flight refresh so no rotated token survives', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    let releaseRefresh: ((value: typeof authResponse) => void) | undefined;
    http.post.mockImplementation(({ path }: { path: string }) => {
      if (path === '/v1/auth/refresh') {
        return new Promise<typeof authResponse>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return Promise.resolve({ loggedOut: true });
    });
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    const refresh = broker.refresh();
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const logout = broker.logout();
    releaseRefresh?.({ ...authResponse, refreshToken: 'rotated-refresh' });
    await refresh;
    await logout;

    await expect(store.read()).resolves.toBeNull();
  });

  it('starts a new refresh generation after a queued logout', async () => {
    const store = createStore('stored-refresh');
    const http = createHttp();
    let releaseRefresh: ((value: typeof authResponse) => void) | undefined;
    http.post.mockImplementation(({ path }: { path: string }) => {
      if (path === '/v1/auth/refresh') {
        return new Promise<typeof authResponse>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return Promise.resolve({ loggedOut: true });
    });
    const broker = createAuthSessionBroker({ http, sessionStore: store });

    const refreshA = broker.refresh();
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const logout = broker.logout();
    const refreshB = broker.refresh();

    expect(refreshB).not.toBe(refreshA);
    const refreshBResult = expect(refreshB).rejects.toBeInstanceOf(
      AuthSessionBrokerError,
    );
    releaseRefresh?.({ ...authResponse, refreshToken: 'rotated-refresh' });
    await refreshA;
    await logout;
    await refreshBResult;
    expect(http.post.mock.calls.map(([request]) => request.path)).toEqual([
      '/v1/auth/refresh',
      '/v1/auth/logout',
    ]);
  });
});
