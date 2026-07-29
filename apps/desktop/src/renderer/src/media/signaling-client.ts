import {
  PROTOCOL_VERSION,
  centralRtcConfigurationSchema,
  lanJoinIntentSchema,
  lanRtcConfigurationSchema,
  p2pOutboundResponseSchema,
  p2pRequestEnvelopeSchema,
  type LanJoinIntent,
  type P2pBroadcastEnvelope,
  type P2pRequestEnvelope,
} from '@wo/protocol';

import type { DesktopApi } from '../../../preload/types.js';

export interface RuntimeSchema<Value> {
  parse(input: unknown): Value;
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false; readonly error: unknown };
}

export type SignalingClientErrorCode =
  | 'SIGNALING_CLOSED'
  | 'SIGNALING_TIMEOUT'
  | 'SIGNALING_UNAVAILABLE'
  | 'PROTOCOL_ERROR';

export class SignalingClientError extends Error {
  readonly code: SignalingClientErrorCode;

  constructor(code: SignalingClientErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SignalingClientError';
    this.code = code;
  }
}

export interface SignalingWebSocket {
  readonly readyState: number;
  readonly protocol: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SignalingClientOptions {
  readonly desktop: DesktopApi;
  readonly createWebSocket?: (
    endpoint: string,
    protocols: readonly string[],
  ) => SignalingWebSocket;
  readonly makeRequestId?: () => string;
  readonly requestTimeoutMs?: number;
  readonly maxConnectAttempts?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly lanIntent?: LanJoinIntent;
}

export interface SignalingRequestOptions {
  readonly requestId?: string;
  readonly retryTimeouts?: number;
  readonly timeoutMs?: number;
}

export type SignalingConnectionEvent =
  | { readonly state: 'open' }
  | {
      readonly state: 'closed';
      readonly code: number;
      readonly reason: string;
    };

export interface SignalingClient {
  connect(accessToken: string): Promise<void>;
  disconnect(): void;
  request<Response>(
    type: P2pRequestEnvelope['type'],
    payload: unknown,
    responseSchema: RuntimeSchema<Response>,
    options?: SignalingRequestOptions,
  ): Promise<Response>;
  requestEnvelope<Response>(
    envelope: unknown,
    responseSchema: RuntimeSchema<Response>,
    options?: Omit<SignalingRequestOptions, 'requestId'>,
  ): Promise<Response>;
  subscribe(listener: (event: P2pBroadcastEnvelope) => void): () => void;
  subscribeErrors(listener: (error: SignalingClientError) => void): () => void;
  subscribeConnection(
    listener: (event: SignalingConnectionEvent) => void,
  ): () => void;
  readonly connected: boolean;
}

interface PendingRequest<Response = unknown> {
  readonly responseSchema: RuntimeSchema<Response>;
  readonly serialized: string;
  readonly resolve: (value: Response) => void;
  readonly reject: (error: SignalingClientError) => void;
  retriesRemaining: number;
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultWebSocketFactory = (
  endpoint: string,
  protocols: readonly string[],
): SignalingWebSocket => new WebSocket(endpoint, [...protocols]);

const defaultRequestId = (): string => crypto.randomUUID();
const SOCKET_OPEN = 1;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONNECT_ATTEMPTS = 8;
const CONNECT_RETRY_BASE_DELAY_MS = 250;
const CONNECT_RETRY_MAX_DELAY_MS = 2_000;

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

function safeGrantEndpoint(
  endpoint: string,
  lanIntent?: LanJoinIntent,
): string {
  if (lanIntent !== undefined) {
    const parsedIntent = lanJoinIntentSchema.safeParse(lanIntent);
    if (!parsedIntent.success || endpoint !== parsedIntent.data.endpoint) {
      throw new SignalingClientError('PROTOCOL_ERROR');
    }
    return parsedIntent.data.endpoint;
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== 'wss:' ||
    url.pathname !== '/v1/realtime' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.href !== endpoint
  ) {
    throw new SignalingClientError('PROTOCOL_ERROR');
  }
  return url.href;
}

function assertRtcConfigurationMode(
  message: unknown,
  lanIntent?: LanJoinIntent,
): void {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('payload' in message) ||
    typeof message.payload !== 'object' ||
    message.payload === null ||
    !('data' in message.payload) ||
    typeof message.payload.data !== 'object' ||
    message.payload.data === null ||
    !Object.hasOwn(message.payload.data, 'rtcConfiguration')
  ) {
    return;
  }
  const schema =
    lanIntent === undefined
      ? centralRtcConfigurationSchema
      : lanRtcConfigurationSchema;
  schema.parse(
    (message.payload.data as Record<string, unknown>)['rtcConfiguration'],
  );
}

export function createSignalingClient(
  options: SignalingClientOptions,
): SignalingClient {
  const createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  const makeRequestId = options.makeRequestId ?? defaultRequestId;
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  const maxConnectAttempts =
    options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 8_000;
  const maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  const pending = new Map<string, PendingRequest>();
  const broadcastListeners = new Set<(event: P2pBroadcastEnvelope) => void>();
  const errorListeners = new Set<(error: SignalingClientError) => void>();
  const connectionListeners = new Set<
    (event: SignalingConnectionEvent) => void
  >();
  let socket: SignalingWebSocket | null = null;
  let connecting: Promise<void> | null = null;
  let accessToken = '';
  let explicitlyClosed = false;
  let cancelConnectRetry: (() => void) | null = null;

  const emitError = (error: SignalingClientError): void => {
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch {
        // Observers cannot interfere with signaling protocol handling.
      }
    }
  };

  const emitConnection = (event: SignalingConnectionEvent): void => {
    for (const listener of connectionListeners) {
      try {
        listener(event);
      } catch {
        // Connection lifecycle remains authoritative when a consumer fails.
      }
    }
  };

  const waitForConnectRetry = (attempt: number): Promise<void> => {
    const delayMs = Math.min(
      CONNECT_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 8),
      CONNECT_RETRY_MAX_DELAY_MS,
    );
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        if (cancelConnectRetry === finish) cancelConnectRetry = null;
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      cancelConnectRetry = finish;
    });
  };

  const rejectAllPending = (error: SignalingClientError): void => {
    for (const item of pending.values()) {
      if (item.timer !== null) clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  const rejectProtocolRequest = (value: unknown): void => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('requestId' in value) ||
      typeof value.requestId !== 'string'
    ) {
      return;
    }
    const request = pending.get(value.requestId);
    if (request === undefined) return;
    if (request.timer !== null) clearTimeout(request.timer);
    pending.delete(value.requestId);
    request.reject(new SignalingClientError('PROTOCOL_ERROR'));
  };

  const handleMessage = (event: unknown): void => {
    let message: ReturnType<typeof p2pOutboundResponseSchema.parse>;
    try {
      if (
        typeof event !== 'object' ||
        event === null ||
        !('data' in event) ||
        typeof event.data !== 'string'
      ) {
        throw new TypeError('Signaling frames must be text');
      }
      if (new TextEncoder().encode(event.data).byteLength > maxFrameBytes) {
        throw new TypeError('Signaling frame exceeds the size limit');
      }
      const raw: unknown = JSON.parse(event.data);
      const parsed = p2pOutboundResponseSchema.safeParse(raw);
      if (!parsed.success) {
        rejectProtocolRequest(raw);
        throw parsed.error;
      }
      try {
        assertRtcConfigurationMode(parsed.data, options.lanIntent);
      } catch (error) {
        rejectProtocolRequest(parsed.data);
        throw error;
      }
      message = parsed.data;
    } catch (error) {
      emitError(new SignalingClientError('PROTOCOL_ERROR', error));
      return;
    }
    if ('eventId' in message) {
      for (const listener of broadcastListeners) {
        try {
          listener(message);
        } catch {
          // A renderer consumer cannot turn a valid server frame into a protocol error.
        }
      }
      return;
    }
    if (message.requestId === null) {
      emitError(new SignalingClientError('PROTOCOL_ERROR'));
      return;
    }
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    const response = request.responseSchema.safeParse(message);
    if (!response.success) {
      if (request.timer !== null) clearTimeout(request.timer);
      pending.delete(message.requestId);
      request.reject(new SignalingClientError('PROTOCOL_ERROR'));
      emitError(new SignalingClientError('PROTOCOL_ERROR', response.error));
      return;
    }
    if (request.timer !== null) clearTimeout(request.timer);
    pending.delete(message.requestId);
    request.resolve(response.data);
  };

  const waitForOpen = (candidate: SignalingWebSocket): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => onFailure(new Error('Signaling handshake timed out')),
        handshakeTimeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        candidate.removeEventListener('open', onOpen);
        candidate.removeEventListener('error', onFailure);
        candidate.removeEventListener('close', onFailure);
      };
      const onOpen = () => {
        if (settled) return;
        if (candidate.protocol !== 'wo-v1') {
          onFailure(new Error('Unexpected signaling subprotocol'));
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onFailure = (event: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new SignalingClientError('SIGNALING_UNAVAILABLE', event));
      };
      candidate.addEventListener('open', onOpen);
      candidate.addEventListener('error', onFailure);
      candidate.addEventListener('close', onFailure);
    });

  const acquireGrant = async () => {
    try {
      return await options.desktop.realtime.issueTicket(accessToken);
    } catch (error) {
      if (errorCode(error) !== 'AUTH_REQUIRED') throw error;
      const session = await options.desktop.auth.refresh();
      accessToken = session.accessToken;
      return options.desktop.realtime.issueTicket(accessToken);
    }
  };

  const connect = (nextAccessToken: string): Promise<void> => {
    if (socket?.readyState === SOCKET_OPEN) return Promise.resolve();
    if (connecting !== null) return connecting;
    accessToken = nextAccessToken;
    explicitlyClosed = false;
    connecting = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < maxConnectAttempts; attempt += 1) {
        if (explicitlyClosed) {
          throw new SignalingClientError('SIGNALING_CLOSED');
        }
        let candidate: SignalingWebSocket | null = null;
        try {
          const grant = await acquireGrant();
          candidate = createWebSocket(
            safeGrantEndpoint(grant.endpoint, options.lanIntent),
            ['wo-v1', `ticket.${grant.ticket}`],
          );
          await waitForOpen(candidate);
          if (explicitlyClosed) {
            candidate.close();
            throw new SignalingClientError('SIGNALING_CLOSED');
          }
          socket = candidate;
          const established = candidate;
          const onMessage = (event: unknown) => {
            if (socket === established) handleMessage(event);
          };
          const onClose = (event: unknown) => {
            established.removeEventListener('message', onMessage);
            established.removeEventListener('close', onClose);
            if (socket !== established) return;
            socket = null;
            rejectAllPending(new SignalingClientError('SIGNALING_CLOSED'));
            const code =
              typeof event === 'object' &&
              event !== null &&
              'code' in event &&
              typeof event.code === 'number' &&
              Number.isSafeInteger(event.code)
                ? event.code
                : 1006;
            const reason =
              typeof event === 'object' &&
              event !== null &&
              'reason' in event &&
              typeof event.reason === 'string'
                ? event.reason.slice(0, 123)
                : '';
            emitConnection({ state: 'closed', code, reason });
          };
          candidate.addEventListener('message', onMessage);
          candidate.addEventListener('close', onClose);
          emitConnection({ state: 'open' });
          return;
        } catch (error) {
          lastError = error;
          candidate?.close();
          if (attempt + 1 < maxConnectAttempts) {
            await waitForConnectRetry(attempt);
          }
        }
      }
      throw new SignalingClientError('SIGNALING_UNAVAILABLE', lastError);
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const sendPending = <Response>(
    requestId: string,
    item: PendingRequest<Response>,
  ): boolean => {
    try {
      if (socket?.readyState !== SOCKET_OPEN) {
        throw new Error('Signaling socket is closed');
      }
      socket.send(item.serialized);
      return true;
    } catch (error) {
      if (item.timer !== null) clearTimeout(item.timer);
      pending.delete(requestId);
      item.reject(new SignalingClientError('SIGNALING_CLOSED', error));
      return false;
    }
  };

  const scheduleTimeout = (requestId: string): void => {
    const item = pending.get(requestId);
    if (item === undefined) return;
    item.timer = setTimeout(() => {
      const current = pending.get(requestId);
      if (current === undefined) return;
      if (current.retriesRemaining > 0 && socket?.readyState === SOCKET_OPEN) {
        current.retriesRemaining -= 1;
        if (sendPending(requestId, current)) scheduleTimeout(requestId);
        return;
      }
      pending.delete(requestId);
      current.reject(new SignalingClientError('SIGNALING_TIMEOUT'));
    }, item.timeoutMs);
  };

  const requestEnvelope = <Response>(
    envelope: unknown,
    responseSchema: RuntimeSchema<Response>,
    requestOptions: Omit<SignalingRequestOptions, 'requestId'> = {},
  ): Promise<Response> => {
    if (socket?.readyState !== SOCKET_OPEN) {
      return Promise.reject(new SignalingClientError('SIGNALING_CLOSED'));
    }
    let request: P2pRequestEnvelope;
    try {
      request = p2pRequestEnvelopeSchema.parse(envelope);
    } catch (error) {
      return Promise.reject(new SignalingClientError('PROTOCOL_ERROR', error));
    }
    const requestId = request.requestId;
    if (pending.has(requestId)) {
      return Promise.reject(new SignalingClientError('PROTOCOL_ERROR'));
    }
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      return Promise.reject(new SignalingClientError('PROTOCOL_ERROR'));
    }
    const serialized = JSON.stringify(request);
    return new Promise<Response>((resolve, reject) => {
      const item: PendingRequest<Response> = {
        responseSchema,
        serialized,
        resolve,
        reject,
        retriesRemaining: requestOptions.retryTimeouts ?? 0,
        timeoutMs,
        timer: null,
      };
      pending.set(requestId, {
        ...item,
        responseSchema: item.responseSchema as RuntimeSchema<unknown>,
        resolve: (value) => resolve(value as Response),
      });
      if (sendPending(requestId, item)) scheduleTimeout(requestId);
    });
  };

  const client: SignalingClient = {
    connect,
    disconnect: () => {
      explicitlyClosed = true;
      cancelConnectRetry?.();
      const current = socket;
      socket = null;
      current?.close();
      rejectAllPending(new SignalingClientError('SIGNALING_CLOSED'));
    },
    request: <Response>(
      type: P2pRequestEnvelope['type'],
      payload: unknown,
      responseSchema: RuntimeSchema<Response>,
      requestOptions: SignalingRequestOptions = {},
    ): Promise<Response> => {
      const requestId = requestOptions.requestId ?? makeRequestId();
      let request: P2pRequestEnvelope;
      try {
        request = p2pRequestEnvelopeSchema.parse({
          version: PROTOCOL_VERSION,
          requestId,
          type,
          payload,
        });
      } catch (error) {
        return Promise.reject(
          new SignalingClientError('PROTOCOL_ERROR', error),
        );
      }
      return requestEnvelope(request, responseSchema, requestOptions);
    },
    requestEnvelope,
    subscribe: (listener) => {
      broadcastListeners.add(listener);
      return () => broadcastListeners.delete(listener);
    },
    subscribeErrors: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    subscribeConnection: (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    get connected() {
      return socket?.readyState === SOCKET_OPEN;
    },
  };
  return Object.freeze(client);
}
