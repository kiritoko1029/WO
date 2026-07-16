import {
  authLoginBodySchema,
  authLoginResponseSchema,
  authLogoutResponseSchema,
  authRefreshResponseSchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  type AuthLoginBody,
  type AuthRegisterBody,
  type AuthResponse,
} from '@wo/protocol';

import type { PublicAuthSession } from '../preload/types.js';
import type { MainHttpClient } from './http-client.js';
import type { SecureSessionStore } from './secure-session-store.js';

export interface AuthSessionBroker {
  register(input: AuthRegisterBody): Promise<PublicAuthSession>;
  login(input: AuthLoginBody): Promise<PublicAuthSession>;
  refresh(): Promise<PublicAuthSession>;
  logout(): Promise<void>;
}

export interface AuthSessionBrokerOptions {
  readonly http: MainHttpClient;
  readonly sessionStore: SecureSessionStore;
  readonly now?: () => number;
}

export class AuthSessionBrokerError extends Error {
  readonly code: 'AUTH_REQUIRED';

  constructor() {
    super('Authentication is required');
    this.name = 'AuthSessionBrokerError';
    this.code = 'AUTH_REQUIRED';
  }
}

function publicSession(response: AuthResponse, now: number): PublicAuthSession {
  return Object.freeze({
    user: Object.freeze({ ...response.user }),
    accessToken: response.accessToken,
    accessTokenExpiresAt: now + response.accessTokenExpiresInSeconds * 1_000,
  });
}

export function createAuthSessionBroker(
  options: AuthSessionBrokerOptions,
): Readonly<AuthSessionBroker> {
  const now = options.now ?? Date.now;
  let mutationTail = Promise.resolve();
  let refreshInFlight: Promise<PublicAuthSession> | null = null;

  const exclusive = <Result>(operation: () => Promise<Result>) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const exclusiveNonRefresh = <Result>(operation: () => Promise<Result>) => {
    refreshInFlight = null;
    return exclusive(operation);
  };

  const persistResponse = async (
    response: AuthResponse,
  ): Promise<PublicAuthSession> => {
    await options.sessionStore.write(response.refreshToken);
    return publicSession(response, now());
  };

  const broker: AuthSessionBroker = {
    register: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authRegisterBodySchema.parse(input);
        const response = await options.http.post({
          path: '/v1/auth/register',
          body,
          responseSchema: authRegisterResponseSchema,
        });
        return persistResponse(response);
      }),
    login: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authLoginBodySchema.parse(input);
        const response = await options.http.post({
          path: '/v1/auth/login',
          body,
          responseSchema: authLoginResponseSchema,
        });
        return persistResponse(response);
      }),
    refresh: () => {
      if (refreshInFlight !== null) return refreshInFlight;
      const operation = exclusive(async () => {
        const refreshToken = await options.sessionStore.read();
        if (refreshToken === null) throw new AuthSessionBrokerError();
        const response = await options.http.post({
          path: '/v1/auth/refresh',
          body: { refreshToken },
          responseSchema: authRefreshResponseSchema,
        });
        return persistResponse(response);
      });
      refreshInFlight = operation;
      void operation.then(
        () => {
          if (refreshInFlight === operation) refreshInFlight = null;
        },
        () => {
          if (refreshInFlight === operation) refreshInFlight = null;
        },
      );
      return operation;
    },
    logout: () =>
      exclusiveNonRefresh(async () => {
        let refreshToken: string | null = null;
        try {
          refreshToken = await options.sessionStore.read();
        } catch {
          // A corrupted local token is still removable during logout.
        }
        let clearError: unknown = null;
        try {
          await options.sessionStore.clear();
        } catch (error) {
          clearError = error;
        }
        try {
          if (refreshToken !== null) {
            await options.http.post({
              path: '/v1/auth/logout',
              body: { refreshToken },
              responseSchema: authLogoutResponseSchema,
            });
          }
        } catch {
          // Local logout remains authoritative while offline.
        }
        if (clearError !== null) throw clearError;
      }),
  };
  return Object.freeze(broker);
}
