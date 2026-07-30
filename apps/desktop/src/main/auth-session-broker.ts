import {
  authChangePasswordBodySchema,
  authChangePasswordResponseSchema,
  authConfirmEmailChangeBodySchema,
  authEmailChangeRequestedResponseSchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  authLogoutResponseSchema,
  authRefreshResponseSchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authRequestEmailChangeBodySchema,
  authResendVerificationBodySchema,
  authResponseSchema,
  authVerifyEmailBodySchema,
  parseAuthenticatedAuthResponse,
  type AuthChangePasswordBody,
  type AuthConfirmEmailChangeBody,
  type AuthLoginBody,
  type AuthRegisterBody,
  type AuthRequestEmailChangeBody,
  type AuthResendVerificationBody,
  type AuthResponse,
  type AuthVerifyEmailBody,
} from '@wo/protocol';

import type { PublicAuthSession } from '../preload/types.js';
import { DesktopHttpError, type MainHttpClient } from './http-client.js';
import type { SecureSessionStore } from './secure-session-store.js';

export type AuthRegisterResult =
  | Readonly<{ kind: 'session'; session: PublicAuthSession }>
  | Readonly<{ kind: 'verification_required'; email: string }>;

export interface AuthSessionBroker {
  register(input: AuthRegisterBody): Promise<AuthRegisterResult>;
  login(input: AuthLoginBody): Promise<PublicAuthSession>;
  verifyEmail(input: AuthVerifyEmailBody): Promise<PublicAuthSession>;
  resendVerification(
    input: AuthResendVerificationBody,
  ): Promise<Readonly<{ email: string }>>;
  changePassword(input: AuthChangePasswordBody): Promise<void>;
  requestEmailChange(
    input: AuthRequestEmailChangeBody,
  ): Promise<Readonly<{ email: string }>>;
  confirmEmailChange(
    input: AuthConfirmEmailChangeBody,
  ): Promise<PublicAuthSession>;
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

  const rejectFailedRefresh = async (error: unknown): Promise<never> => {
    if (!(error instanceof DesktopHttpError) || error.status !== 401) {
      throw error;
    }
    let clearFailed = false;
    let clearError: unknown;
    try {
      await options.sessionStore.clear();
    } catch (caughtError) {
      clearFailed = true;
      clearError = caughtError;
    }
    if (clearFailed) {
      throw new AggregateError(
        [error, clearError],
        'Authentication refresh failed and the stored session could not be cleared',
        { cause: error },
      );
    }
    throw error;
  };

  const authorizedPost = async <Body, Response>(
    path: string,
    body: Body,
    responseSchema: {
      parse(input: unknown): Response;
    },
  ): Promise<Response> => {
    const session = await broker.refresh();
    return options.http.post({
      path,
      body,
      bearerToken: session.accessToken,
      responseSchema,
    });
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
        if (
          'status' in response &&
          response.status === 'verification_required'
        ) {
          return Object.freeze({
            kind: 'verification_required' as const,
            email: response.email,
          });
        }
        const session = await persistResponse(
          parseAuthenticatedAuthResponse(response),
        );
        return Object.freeze({ kind: 'session' as const, session });
      }),
    login: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authLoginBodySchema.parse(input);
        const response = await options.http.post({
          path: '/v1/auth/login',
          body,
          responseSchema: authLoginResponseSchema,
        });
        return persistResponse(parseAuthenticatedAuthResponse(response));
      }),
    verifyEmail: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authVerifyEmailBodySchema.parse(input);
        const response = await options.http.post({
          path: '/v1/auth/email/verify',
          body,
          responseSchema: authResponseSchema,
        });
        return persistResponse(response);
      }),
    resendVerification: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authResendVerificationBodySchema.parse(input);
        const response = await options.http.post({
          path: '/v1/auth/email/resend',
          body,
          responseSchema: authEmailChangeRequestedResponseSchema,
        });
        return Object.freeze({ email: response.email });
      }),
    changePassword: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authChangePasswordBodySchema.parse(input);
        await authorizedPost(
          '/v1/auth/password',
          body,
          authChangePasswordResponseSchema,
        );
      }),
    requestEmailChange: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authRequestEmailChangeBodySchema.parse(input);
        const response = await authorizedPost(
          '/v1/auth/email/change/request',
          body,
          authEmailChangeRequestedResponseSchema,
        );
        return Object.freeze({ email: response.email });
      }),
    confirmEmailChange: (input) =>
      exclusiveNonRefresh(async () => {
        const body = authConfirmEmailChangeBodySchema.parse(input);
        const response = await authorizedPost(
          '/v1/auth/email/change/confirm',
          body,
          authResponseSchema,
        );
        return persistResponse(response);
      }),
    refresh: () => {
      if (refreshInFlight !== null) return refreshInFlight;
      const operation = exclusive(async () => {
        const refreshToken = await options.sessionStore.read();
        if (refreshToken === null) throw new AuthSessionBrokerError();
        const response = await options.http
          .post({
            path: '/v1/auth/refresh',
            body: { refreshToken },
            responseSchema: authRefreshResponseSchema,
          })
          .catch(rejectFailedRefresh);
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
