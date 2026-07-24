import {
  authChangePasswordBodySchema,
  authChangePasswordResponseSchema,
  authConfirmEmailChangeBodySchema,
  authEmailChangeRequestedResponseSchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  authLogoutBodySchema,
  authLogoutResponseSchema,
  authRefreshBodySchema,
  authRefreshResponseSchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authRequestEmailChangeBodySchema,
  authResendVerificationBodySchema,
  authResponseSchema,
  authVerifyEmailBodySchema,
  opaqueTokenSchema,
  parseAuthenticatedAuthResponse,
  signalTicketResponseSchema,
  type AuthResponse,
} from '@wo/protocol';

import type {
  AuthRegisterResult,
  CaptureSourceSummary,
  DesktopApi,
  PublicAuthSession,
} from '../../desktop/src/preload/types.js';

const REFRESH_TOKEN_KEY = 'wo.web.refresh-token.v1';
const MAX_RESPONSE_BYTES = 256 * 1_024;
const CAPTURE_TOKEN = '00000000-0000-4000-8000-000000000001';
const CAPTURE_THUMBNAIL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface RuntimeSchema<Value> {
  parse(input: unknown): Value;
}

type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface BrowserDesktopApiOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: TokenStorage;
  readonly origin?: string;
  readonly now?: () => number;
  readonly displayCaptureSupported?: boolean;
}

export class BrowserApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BrowserApiError';
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function canonicalOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== input ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Web origin must be canonical');
  }
  return url.origin;
}

function serverError(input: unknown): { code: string; message: string } | null {
  if (!isRecord(input) || !isRecord(input.error)) return null;
  const { code, message } = input.error;
  if (
    typeof code !== 'string' ||
    !/^[A-Z0-9_]{1,128}$/u.test(code) ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > 256
  ) {
    return null;
  }
  return { code, message };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new BrowserApiError(
      response.status,
      'RESPONSE_TOO_LARGE',
      'The server response was too large',
    );
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new BrowserApiError(
            response.status,
            'RESPONSE_TOO_LARGE',
            'The server response was too large',
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BrowserApiError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned an invalid response',
      { cause: error },
    );
  }
}

function publicSession(response: AuthResponse, now: number): PublicAuthSession {
  return Object.freeze({
    user: Object.freeze({ ...response.user }),
    accessToken: response.accessToken,
    accessTokenExpiresAt: now + response.accessTokenExpiresInSeconds * 1_000,
  });
}

export function browserSupportsDisplayCapture(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

export function createBrowserDesktopApi(
  options: BrowserDesktopApiOptions = {},
): Readonly<DesktopApi> {
  const origin = canonicalOrigin(options.origin ?? window.location.origin);
  const fetchImplementation = options.fetch ?? window.fetch.bind(window);
  const storage = options.storage ?? window.sessionStorage;
  const now = options.now ?? Date.now;
  const displayCaptureSupported =
    options.displayCaptureSupported ?? browserSupportsDisplayCapture();

  const post = async <Value>(
    path: string,
    schema: RuntimeSchema<Value>,
    body?: unknown,
    bearerToken?: string,
  ): Promise<Value> => {
    const url = new URL(path, `${origin}/`);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith('/v1/') ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new TypeError('Web API path must remain same-origin');
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearerToken !== undefined) {
      headers.authorization = `Bearer ${opaqueTokenSchema.parse(bearerToken)}`;
    }

    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const timedOut =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'TimeoutError';
      throw new BrowserApiError(
        null,
        timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? 'The server request timed out' : 'The server is unavailable',
        { cause: error },
      );
    }

    let responseOrigin: string;
    try {
      responseOrigin = new URL(response.url).origin;
    } catch {
      responseOrigin = '';
    }
    if (responseOrigin !== origin) {
      throw new BrowserApiError(
        null,
        'UNTRUSTED_RESPONSE_ORIGIN',
        'The server response origin was rejected',
      );
    }
    const decoded = await readJson(response);
    if (!response.ok) {
      const parsed = serverError(decoded);
      throw new BrowserApiError(
        response.status,
        parsed?.code ?? 'HTTP_ERROR',
        parsed?.message ?? 'The server rejected the request',
      );
    }
    try {
      return schema.parse(decoded);
    } catch (error) {
      throw new BrowserApiError(
        response.status,
        'INVALID_RESPONSE',
        'The server returned an invalid response',
        { cause: error },
      );
    }
  };

  let mutationTail = Promise.resolve();
  let refreshInFlight: Promise<PublicAuthSession> | null = null;
  const exclusive = <Value>(operation: () => Promise<Value>) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const exclusiveNonRefresh = <Value>(operation: () => Promise<Value>) => {
    refreshInFlight = null;
    return exclusive(operation);
  };
  const persistResponse = (response: AuthResponse): PublicAuthSession => {
    storage.setItem(REFRESH_TOKEN_KEY, response.refreshToken);
    return publicSession(response, now());
  };

  const refresh = (): Promise<PublicAuthSession> => {
    if (refreshInFlight !== null) return refreshInFlight;
    const operation = exclusive(async () => {
      const refreshToken = storage.getItem(REFRESH_TOKEN_KEY);
      if (refreshToken === null) {
        throw new BrowserApiError(
          null,
          'AUTH_REQUIRED',
          'Authentication is required',
        );
      }
      let body: unknown;
      try {
        body = authRefreshBodySchema.parse({ refreshToken });
      } catch (error) {
        storage.removeItem(REFRESH_TOKEN_KEY);
        throw new BrowserApiError(
          null,
          'AUTH_REQUIRED',
          'Authentication is required',
          { cause: error },
        );
      }
      try {
        return persistResponse(
          await post('/v1/auth/refresh', authRefreshResponseSchema, body),
        );
      } catch (error) {
        if (error instanceof BrowserApiError && error.status === 401) {
          storage.removeItem(REFRESH_TOKEN_KEY);
        }
        throw error;
      }
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
  };

  const authorizedPost = async <Value>(
    path: string,
    schema: RuntimeSchema<Value>,
    body: unknown,
  ): Promise<Value> => {
    const session = await refresh();
    return post(path, schema, body, session.accessToken);
  };

  const auth: DesktopApi['auth'] = Object.freeze({
    register: (input) =>
      exclusiveNonRefresh(async (): Promise<AuthRegisterResult> => {
        const response = await post(
          '/v1/auth/register',
          authRegisterResponseSchema,
          authRegisterBodySchema.parse(input),
        );
        if (
          'status' in response &&
          response.status === 'verification_required'
        ) {
          return Object.freeze({
            kind: 'verification_required' as const,
            email: response.email,
          });
        }
        const session = persistResponse(
          parseAuthenticatedAuthResponse(response),
        );
        return Object.freeze({ kind: 'session' as const, session });
      }),
    login: (input) =>
      exclusiveNonRefresh(async () =>
        persistResponse(
          await post(
            '/v1/auth/login',
            authLoginResponseSchema,
            authLoginBodySchema.parse(input),
          ),
        ),
      ),
    verifyEmail: (input) =>
      exclusiveNonRefresh(async () =>
        persistResponse(
          await post(
            '/v1/auth/email/verify',
            authResponseSchema,
            authVerifyEmailBodySchema.parse(input),
          ),
        ),
      ),
    resendVerification: (input) =>
      exclusiveNonRefresh(async () => {
        const response = await post(
          '/v1/auth/email/resend',
          authEmailChangeRequestedResponseSchema,
          authResendVerificationBodySchema.parse(input),
        );
        return Object.freeze({ email: response.email });
      }),
    changePassword: (input) =>
      exclusiveNonRefresh(async () => {
        await authorizedPost(
          '/v1/auth/password',
          authChangePasswordResponseSchema,
          authChangePasswordBodySchema.parse(input),
        );
      }),
    requestEmailChange: (input) =>
      exclusiveNonRefresh(async () => {
        const response = await authorizedPost(
          '/v1/auth/email/change/request',
          authEmailChangeRequestedResponseSchema,
          authRequestEmailChangeBodySchema.parse(input),
        );
        return Object.freeze({ email: response.email });
      }),
    confirmEmailChange: (input) =>
      exclusiveNonRefresh(async () =>
        persistResponse(
          await authorizedPost(
            '/v1/auth/email/change/confirm',
            authResponseSchema,
            authConfirmEmailChangeBodySchema.parse(input),
          ),
        ),
      ),
    refresh,
    logout: () =>
      exclusiveNonRefresh(async () => {
        const refreshToken = storage.getItem(REFRESH_TOKEN_KEY);
        storage.removeItem(REFRESH_TOKEN_KEY);
        if (refreshToken === null) return;
        try {
          await post(
            '/v1/auth/logout',
            authLogoutResponseSchema,
            authLogoutBodySchema.parse({ refreshToken }),
          );
        } catch {
          // Closing the tab-local session remains authoritative while offline.
        }
      }),
  });

  const endpoint = new URL('/v1/realtime', origin);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const realtime: DesktopApi['realtime'] = Object.freeze({
    issueTicket: async (accessToken) =>
      Object.freeze({
        endpoint: endpoint.href,
        ...(await post(
          '/v1/realtime/ticket',
          signalTicketResponseSchema,
          undefined,
          accessToken,
        )),
      }),
  });

  const virtualSource: CaptureSourceSummary = Object.freeze({
    token: CAPTURE_TOKEN,
    name: '使用浏览器选择共享内容',
    kind: 'screen',
    thumbnailDataUrl: CAPTURE_THUMBNAIL,
  });
  const capture: DesktopApi['capture'] = Object.freeze({
    list: async () =>
      displayCaptureSupported
        ? Object.freeze([virtualSource])
        : Object.freeze([]),
    select: async (token) => {
      if (!displayCaptureSupported || token !== CAPTURE_TOKEN) {
        throw new BrowserApiError(
          null,
          'SCREEN_CAPTURE_UNAVAILABLE',
          'Screen capture is unavailable',
        );
      }
    },
    permission: async () =>
      Object.freeze({
        status: displayCaptureSupported ? 'not-determined' : 'restricted',
        canOpenSettings: false,
        systemAudioMode: displayCaptureSupported
          ? ('native-picker' as const)
          : ('unsupported' as const),
      }),
    openSettings: async () => undefined,
  });

  return Object.freeze({ auth, realtime, capture });
}
