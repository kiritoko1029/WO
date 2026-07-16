const KNOWN_REQUEST_PATHS = new Set([
  '/v1/auth/login',
  '/v1/auth/logout',
  '/v1/auth/refresh',
  '/v1/auth/register',
  '/v1/health/live',
  '/v1/health/ready',
  '/v1/realtime',
  '/v1/realtime/ticket',
]);

const SAFE_METHOD = /^[A-Z]{3,10}$/u;
const SAFE_ERROR_NAME = /^(?:[A-Za-z][A-Za-z0-9]{0,62}Error|Error)$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

interface LogRequest {
  readonly method?: unknown;
  readonly url?: unknown;
}

interface LogResponse {
  readonly statusCode?: unknown;
}

interface LogError {
  readonly code?: unknown;
  readonly name?: unknown;
}

export function serializeRequestForLog(request: unknown): Readonly<{
  method: string;
  path: string;
}> {
  const candidate =
    typeof request === 'object' && request !== null
      ? (request as LogRequest)
      : {};
  const method =
    typeof candidate.method === 'string' && SAFE_METHOD.test(candidate.method)
      ? candidate.method
      : 'UNKNOWN';
  const rawUrl = typeof candidate.url === 'string' ? candidate.url : '';
  const queryIndex = rawUrl.search(/[?#]/u);
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return Object.freeze({
    method,
    path: KNOWN_REQUEST_PATHS.has(pathname) ? pathname : '[unmatched]',
  });
}

export function serializeResponseForLog(response: unknown): Readonly<{
  statusCode?: number;
}> {
  const candidate =
    typeof response === 'object' && response !== null
      ? (response as LogResponse)
      : {};
  const statusCode = candidate.statusCode;
  return Object.freeze(
    typeof statusCode === 'number' &&
      Number.isSafeInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
      ? { statusCode }
      : {},
  );
}

export function safeErrorMetadata(
  error: unknown,
): Readonly<{ errorName: string; errorCode?: string }> {
  const candidate =
    typeof error === 'object' && error !== null ? (error as LogError) : {};
  const errorName =
    typeof candidate.name === 'string' && SAFE_ERROR_NAME.test(candidate.name)
      ? candidate.name
      : 'UnknownError';
  const errorCode =
    typeof candidate.code === 'string' && SAFE_ERROR_CODE.test(candidate.code)
      ? candidate.code
      : null;
  return Object.freeze({
    errorName,
    ...(errorCode === null ? {} : { errorCode }),
  });
}

export const SERVER_LOGGER_OPTIONS = {
  level: 'info',
  serializers: {
    req: serializeRequestForLog,
    res: serializeResponseForLog,
  },
  redact: {
    paths: [
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
    ],
    censor: '[Redacted]',
  },
};
