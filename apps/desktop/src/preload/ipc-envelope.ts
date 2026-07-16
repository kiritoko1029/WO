export const DESKTOP_IPC_ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Authentication is required',
  INVALID_CREDENTIALS: 'Authentication failed',
  INVALID_STATE: 'The operation is not available',
  RATE_LIMITED: 'Too many requests',
  VALIDATION_ERROR: 'The request was rejected',
  SERVICE_UNAVAILABLE: 'The service is unavailable',
  NETWORK_ERROR: 'The server is unavailable',
  REQUEST_TIMEOUT: 'The server request timed out',
  RESPONSE_TOO_LARGE: 'The server response was rejected',
  UNTRUSTED_RESPONSE_ORIGIN: 'The server response was rejected',
  INVALID_RESPONSE: 'The server response was rejected',
  HTTP_ERROR: 'The server rejected the request',
  IPC_FORBIDDEN: 'IPC request was rejected',
  INVALID_ARGUMENTS: 'IPC arguments were rejected',
  INVALID_IPC_RESPONSE: 'IPC response was rejected',
  IPC_UNAVAILABLE: 'Desktop service is unavailable',
  INTERNAL_ERROR: 'The operation failed',
} as const);

export type DesktopIpcErrorCode = keyof typeof DESKTOP_IPC_ERROR_MESSAGES;

export interface DesktopIpcSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
}

export interface DesktopIpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: DesktopIpcErrorCode;
    readonly message: string;
  };
}

export type DesktopIpcEnvelope<Value> =
  DesktopIpcSuccess<Value> | DesktopIpcFailure;

export class DesktopIpcError extends Error {
  readonly code: DesktopIpcErrorCode;

  constructor(code: DesktopIpcErrorCode) {
    super(DESKTOP_IPC_ERROR_MESSAGES[code]);
    this.name = 'DesktopIpcError';
    this.code = code;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(input);
  return actual.length === keys.length && keys.every((key) => key in input);
}

function safeCode(error: unknown): DesktopIpcErrorCode {
  if (
    isRecord(error) &&
    typeof error.code === 'string' &&
    Object.hasOwn(DESKTOP_IPC_ERROR_MESSAGES, error.code)
  ) {
    return error.code as DesktopIpcErrorCode;
  }
  return 'INTERNAL_ERROR';
}

export function createDesktopIpcSuccess<Value>(
  value: Value,
): DesktopIpcSuccess<Value> {
  return Object.freeze({ ok: true, value });
}

export function createDesktopIpcFailure(error: unknown): DesktopIpcFailure {
  const code = safeCode(error);
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message: DESKTOP_IPC_ERROR_MESSAGES[code],
    }),
  });
}

export function parseDesktopIpcEnvelope<Value>(
  input: unknown,
  parseValue: (input: unknown) => Value,
): DesktopIpcEnvelope<Value> {
  const invalid = () =>
    createDesktopIpcFailure({ code: 'INVALID_IPC_RESPONSE' });
  if (!isRecord(input)) return invalid();
  if (input.ok === true) {
    if (!hasExactKeys(input, ['ok', 'value'])) return invalid();
    try {
      return createDesktopIpcSuccess(parseValue(input.value));
    } catch {
      return invalid();
    }
  }
  if (input.ok !== false || !hasExactKeys(input, ['ok', 'error'])) {
    return invalid();
  }
  if (
    !isRecord(input.error) ||
    !hasExactKeys(input.error, ['code', 'message'])
  ) {
    return invalid();
  }
  const { code, message } = input.error;
  if (
    typeof code !== 'string' ||
    !Object.hasOwn(DESKTOP_IPC_ERROR_MESSAGES, code) ||
    message !== DESKTOP_IPC_ERROR_MESSAGES[code as DesktopIpcErrorCode]
  ) {
    return invalid();
  }
  return createDesktopIpcFailure({ code });
}

export function unwrapDesktopIpcEnvelope<Value>(
  input: unknown,
  parseValue: (input: unknown) => Value,
): Value {
  const envelope = parseDesktopIpcEnvelope(input, parseValue);
  if (!envelope.ok) throw new DesktopIpcError(envelope.error.code);
  return envelope.value;
}
