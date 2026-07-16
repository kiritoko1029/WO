import type { SignalTicketClaims } from './signal-ticket-store.ts';

const SOCKET_OPEN = 1;
const DEFAULT_MAX_ACK_ENTRIES = 256;
const DEFAULT_MAX_SERIALIZED_ACK_BYTES = 64 * 1_024;
const DEFAULT_MAX_ACK_CACHE_BYTES = 1_048_576;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1_048_576;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_INBOUND_RATE_WINDOW_MS = 1_000;
const DEFAULT_MAX_INBOUND_MESSAGES = 200;
const DEFAULT_MAX_INBOUND_BYTES = 4 * 1_048_576;

export interface SignalingSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  ping(): void;
  terminate(): void;
}

export interface ConnectionRoomBinding {
  readonly roomId: string;
  readonly connectionEpoch: number;
}

export type SignalingConnectionState =
  'active' | 'closing' | 'superseded' | 'closed';

export interface SignalingConnection {
  readonly connectionId: string;
  readonly identity: SignalTicketClaims;
  readonly socket: SignalingSocket;
  readonly binding: ConnectionRoomBinding | null;
  readonly state: SignalingConnectionState;
}

interface AckCacheEntry {
  readonly requestDigest: string;
  readonly serializedAck: string;
  readonly serializedBytes: number;
}

interface MutableSignalingConnection {
  readonly connectionId: string;
  readonly identity: SignalTicketClaims;
  readonly socket: SignalingSocket;
  binding: ConnectionRoomBinding | null;
  state: SignalingConnectionState;
  heartbeatTimer: unknown | null;
  awaitingPong: boolean;
  missedPongs: number;
  transportDeadNotified: boolean;
  readonly ackCache: Map<string, AckCacheEntry>;
  ackCacheBytes: number;
  inboundWindowStartedAtMs: number;
  inboundMessages: number;
  inboundBytes: number;
}

export type AckLookupResult =
  | Readonly<{ kind: 'miss' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'replay'; serializedAck: string }>;

export interface RegisterConnectionInput {
  readonly connectionId: string;
  readonly identity: SignalTicketClaims;
  readonly socket: SignalingSocket;
}

export interface BindConnectionInput extends ConnectionRoomBinding {
  readonly connectionId: string;
}

export interface SupersedeConnectionInput {
  readonly roomId: string;
  readonly userId: string;
  readonly replacedConnectionId: string;
  readonly replacedConnectionEpoch: number;
  readonly closeCode: 4409;
  readonly reason: 'SESSION_REPLACED';
}

export interface ConnectionRegistryOptions {
  readonly maxAckEntriesPerConnection?: number;
  readonly maxSerializedAckBytes?: number;
  readonly maxAckCacheBytesPerConnection?: number;
  readonly maxBufferedBytes?: number;
  readonly maxConnections?: number;
  readonly heartbeatIntervalMs?: number;
  readonly inboundRateWindowMs?: number;
  readonly maxInboundMessagesPerWindow?: number;
  readonly maxInboundBytesPerWindow?: number;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
  readonly onTransportDead?: (connectionId: string) => void;
}

export interface ConnectionRegistry {
  register(input: RegisterConnectionInput): SignalingConnection;
  get(connectionId: string): SignalingConnection | null;
  bind(input: BindConnectionInput): SignalingConnection;
  unbind(connectionId: string): SignalingConnection;
  findCurrent(roomId: string, userId: string): SignalingConnection | null;
  listCurrentInRoom(roomId: string): readonly SignalingConnection[];
  listConnections(): readonly SignalingConnection[];
  supersede(input: SupersedeConnectionInput): boolean;
  remove(connectionId: string): SignalingConnection | null;
  lookupAck(
    connectionId: string,
    requestId: string,
    requestDigest: string,
  ): AckLookupResult;
  storeAck(
    connectionId: string,
    requestId: string,
    requestDigest: string,
    serializedAck: string,
  ): void;
  consumeInbound(
    connectionId: string,
    serializedBytes: number,
  ): 'accepted' | 'expired' | 'inactive' | 'rate_limited';
  send(connectionId: string, serializedEnvelope: string): boolean;
  send(
    connectionId: string,
    serializedEnvelope: string,
    onDeliveryFailure: (error: Error) => void,
  ): boolean;
  markPong(connectionId: string): void;
  shutdown(): void;
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireIdentifier(value: string, name: string): string {
  if (value.trim() !== value || value.length === 0 || value.length > 128) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Signaling clock must return milliseconds');
  }
  return value;
}

function requireRequestDigest(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError('Request digest is invalid');
  }
  return value;
}

function bindingKey(roomId: string, userId: string): string {
  return JSON.stringify([roomId, userId]);
}

function publicConnection(
  connection: MutableSignalingConnection,
): SignalingConnection {
  return Object.freeze({
    connectionId: connection.connectionId,
    identity: connection.identity,
    socket: connection.socket,
    binding: connection.binding,
    state: connection.state,
  });
}

export function createConnectionRegistry(
  options: ConnectionRegistryOptions = {},
): ConnectionRegistry {
  const maxAckEntries = requirePositiveSafeInteger(
    options.maxAckEntriesPerConnection ?? DEFAULT_MAX_ACK_ENTRIES,
    'Maximum acknowledgement entries',
  );
  const maxSerializedAckBytes = requirePositiveSafeInteger(
    options.maxSerializedAckBytes ?? DEFAULT_MAX_SERIALIZED_ACK_BYTES,
    'Maximum serialized acknowledgement bytes',
  );
  const maxAckCacheBytes = requirePositiveSafeInteger(
    options.maxAckCacheBytesPerConnection ?? DEFAULT_MAX_ACK_CACHE_BYTES,
    'Maximum acknowledgement cache bytes',
  );
  if (maxAckCacheBytes < maxSerializedAckBytes) {
    throw new RangeError(
      'Maximum acknowledgement cache bytes must cover one acknowledgement',
    );
  }
  const maxBufferedBytes = requirePositiveSafeInteger(
    options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    'Maximum buffered bytes',
  );
  const heartbeatIntervalMs = requirePositiveSafeInteger(
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    'Heartbeat interval',
  );
  const maxConnections = requirePositiveSafeInteger(
    options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    'Maximum signaling connections',
  );
  const inboundRateWindowMs = requirePositiveSafeInteger(
    options.inboundRateWindowMs ?? DEFAULT_INBOUND_RATE_WINDOW_MS,
    'Inbound rate window',
  );
  const maxInboundMessages = requirePositiveSafeInteger(
    options.maxInboundMessagesPerWindow ?? DEFAULT_MAX_INBOUND_MESSAGES,
    'Maximum inbound messages per window',
  );
  const maxInboundBytes = requirePositiveSafeInteger(
    options.maxInboundBytesPerWindow ?? DEFAULT_MAX_INBOUND_BYTES,
    'Maximum inbound bytes per window',
  );
  const now = options.now ?? Date.now;
  const setIntervalFn =
    options.setInterval ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setInterval(callback, delayMs));
  const clearIntervalFn =
    options.clearInterval ??
    ((timer: unknown) =>
      globalThis.clearInterval(timer as ReturnType<typeof setInterval>));

  const connections = new Map<string, MutableSignalingConnection>();
  const currentByRoomUser = new Map<string, string>();

  const clearHeartbeat = (connection: MutableSignalingConnection): void => {
    if (connection.heartbeatTimer === null) {
      return;
    }
    const timer = connection.heartbeatTimer;
    connection.heartbeatTimer = null;
    try {
      clearIntervalFn(timer);
    } catch {
      // A timer adapter failure cannot leave the connection deliverable.
    }
  };

  const removeCurrentIndex = (connection: MutableSignalingConnection): void => {
    const binding = connection.binding;
    if (binding === null) {
      return;
    }
    const key = bindingKey(binding.roomId, connection.identity.userId);
    if (currentByRoomUser.get(key) === connection.connectionId) {
      currentByRoomUser.delete(key);
    }
  };

  const stopDelivery = (
    connection: MutableSignalingConnection,
    state: Exclude<SignalingConnectionState, 'active'>,
  ): void => {
    if (connection.state !== 'active') {
      return;
    }
    connection.state = state;
    removeCurrentIndex(connection);
    clearHeartbeat(connection);
    connection.ackCache.clear();
    connection.ackCacheBytes = 0;
  };

  const notifyTransportDead = (
    connection: MutableSignalingConnection,
  ): void => {
    if (connection.transportDeadNotified) {
      return;
    }
    connection.transportDeadNotified = true;
    try {
      options.onTransportDead?.(connection.connectionId);
    } catch {
      // Cleanup notification failures cannot restore a dead transport.
    }
  };

  const terminate = (connection: MutableSignalingConnection): void => {
    stopDelivery(connection, 'closing');
    try {
      connection.socket.terminate();
    } catch {
      // Transport cleanup is best effort and registry state is already closed.
    }
    notifyTransportDead(connection);
  };

  const accessExpired = (connection: MutableSignalingConnection): boolean =>
    Math.floor(readNow(now) / 1_000) >=
    connection.identity.accessTokenExpiresAtSeconds;

  const expireAuthorization = (
    connection: MutableSignalingConnection,
  ): void => {
    stopDelivery(connection, 'closing');
    try {
      connection.socket.close(4401, 'AUTH_EXPIRED');
    } catch {
      try {
        connection.socket.terminate();
      } catch {
        // Registry state already prevents further delivery.
      }
    }
    notifyTransportDead(connection);
  };

  const heartbeat = (connection: MutableSignalingConnection): void => {
    if (connection.state !== 'active') {
      clearHeartbeat(connection);
      return;
    }
    if (accessExpired(connection)) {
      expireAuthorization(connection);
      return;
    }
    if (connection.awaitingPong) {
      connection.missedPongs += 1;
      if (connection.missedPongs >= 2) {
        terminate(connection);
        return;
      }
    }
    connection.awaitingPong = true;
    try {
      connection.socket.ping();
    } catch {
      terminate(connection);
    }
  };

  const registry: ConnectionRegistry = {
    register(input) {
      const connectionId = requireIdentifier(
        input.connectionId,
        'Connection ID',
      );
      if (connections.has(connectionId)) {
        throw new TypeError('Connection ID is already registered');
      }
      if (connections.size >= maxConnections) {
        throw new RangeError('Signaling connection capacity exceeded');
      }
      const connection: MutableSignalingConnection = {
        connectionId,
        identity: Object.freeze({ ...input.identity }),
        socket: input.socket,
        binding: null,
        state: 'active',
        heartbeatTimer: null,
        awaitingPong: false,
        missedPongs: 0,
        transportDeadNotified: false,
        ackCache: new Map(),
        ackCacheBytes: 0,
        inboundWindowStartedAtMs: readNow(now),
        inboundMessages: 0,
        inboundBytes: 0,
      };
      connections.set(connectionId, connection);
      try {
        connection.heartbeatTimer = setIntervalFn(
          () => heartbeat(connection),
          heartbeatIntervalMs,
        );
        const timer = connection.heartbeatTimer as { unref?: () => void };
        timer?.unref?.();
      } catch (error) {
        clearHeartbeat(connection);
        connections.delete(connectionId);
        throw error;
      }
      return publicConnection(connection);
    },

    get(connectionId) {
      const connection = connections.get(connectionId);
      return connection === undefined ? null : publicConnection(connection);
    },

    bind(input) {
      const connection = connections.get(input.connectionId);
      if (connection === undefined || connection.state !== 'active') {
        throw new TypeError('Connection is not active');
      }
      if (connection.binding !== null) {
        throw new TypeError('Connection is already bound to a room');
      }
      requireIdentifier(input.roomId, 'Room ID');
      if (
        !Number.isSafeInteger(input.connectionEpoch) ||
        input.connectionEpoch < 0
      ) {
        throw new TypeError('Connection epoch is invalid');
      }
      connection.binding = Object.freeze({
        roomId: input.roomId,
        connectionEpoch: input.connectionEpoch,
      });
      currentByRoomUser.set(
        bindingKey(input.roomId, connection.identity.userId),
        connection.connectionId,
      );
      return publicConnection(connection);
    },

    unbind(connectionId) {
      const connection = connections.get(connectionId);
      if (connection === undefined || connection.state !== 'active') {
        throw new TypeError('Connection is not active');
      }
      removeCurrentIndex(connection);
      connection.binding = null;
      return publicConnection(connection);
    },

    findCurrent(roomId, userId) {
      const connectionId = currentByRoomUser.get(bindingKey(roomId, userId));
      if (connectionId === undefined) {
        return null;
      }
      const connection = connections.get(connectionId);
      return connection?.state === 'active'
        ? publicConnection(connection)
        : null;
    },

    listCurrentInRoom(roomId) {
      const result = [...connections.values()]
        .filter((connection) => {
          if (
            connection.state !== 'active' ||
            connection.binding?.roomId !== roomId
          ) {
            return false;
          }
          return (
            currentByRoomUser.get(
              bindingKey(roomId, connection.identity.userId),
            ) === connection.connectionId
          );
        })
        .map(publicConnection);
      return Object.freeze(result);
    },

    listConnections() {
      return Object.freeze([...connections.values()].map(publicConnection));
    },

    supersede(input) {
      const connection = connections.get(input.replacedConnectionId);
      if (
        connection === undefined ||
        connection.state !== 'active' ||
        connection.identity.userId !== input.userId ||
        connection.binding?.roomId !== input.roomId ||
        connection.binding.connectionEpoch !== input.replacedConnectionEpoch
      ) {
        return false;
      }
      stopDelivery(connection, 'superseded');
      try {
        connection.socket.close(input.closeCode, input.reason);
      } catch {
        try {
          connection.socket.terminate();
        } catch {
          // Registry state already prevents any further delivery.
        }
      }
      notifyTransportDead(connection);
      return true;
    },

    remove(connectionId) {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return null;
      }
      connections.delete(connectionId);
      removeCurrentIndex(connection);
      clearHeartbeat(connection);
      connection.ackCache.clear();
      connection.ackCacheBytes = 0;
      connection.state = 'closed';
      return publicConnection(connection);
    },

    lookupAck(connectionId, requestId, requestDigest) {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return Object.freeze({ kind: 'miss' });
      }
      const entry = connection.ackCache.get(requestId);
      if (entry === undefined) {
        return Object.freeze({ kind: 'miss' });
      }
      connection.ackCache.delete(requestId);
      connection.ackCache.set(requestId, entry);
      return entry.requestDigest === requestDigest
        ? Object.freeze({
            kind: 'replay',
            serializedAck: entry.serializedAck,
          })
        : Object.freeze({ kind: 'conflict' });
    },

    storeAck(connectionId, requestId, requestDigest, serializedAck) {
      const connection = connections.get(connectionId);
      if (connection === undefined || connection.state !== 'active') {
        return;
      }
      requireIdentifier(requestId, 'Request ID');
      requireRequestDigest(requestDigest);
      const serializedBytes = Buffer.byteLength(serializedAck, 'utf8');
      if (serializedBytes > maxSerializedAckBytes) {
        throw new RangeError('Serialized acknowledgement exceeds byte limit');
      }
      if (serializedBytes > maxAckCacheBytes) {
        throw new RangeError('Serialized acknowledgement exceeds cache budget');
      }
      const replaced = connection.ackCache.get(requestId);
      if (replaced !== undefined) {
        connection.ackCache.delete(requestId);
        connection.ackCacheBytes -= replaced.serializedBytes;
      }
      while (
        connection.ackCache.size >= maxAckEntries ||
        connection.ackCacheBytes > maxAckCacheBytes - serializedBytes
      ) {
        const oldest = connection.ackCache.keys().next().value as
          string | undefined;
        if (oldest === undefined) {
          break;
        }
        const removed = connection.ackCache.get(oldest);
        connection.ackCache.delete(oldest);
        if (removed !== undefined) {
          connection.ackCacheBytes -= removed.serializedBytes;
        }
      }
      connection.ackCache.set(requestId, {
        requestDigest,
        serializedAck,
        serializedBytes,
      });
      connection.ackCacheBytes += serializedBytes;
    },

    consumeInbound(connectionId, serializedBytes) {
      if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 0) {
        throw new RangeError('Inbound message bytes must be a safe integer');
      }
      const connection = connections.get(connectionId);
      if (connection === undefined || connection.state !== 'active') {
        return 'inactive';
      }
      if (accessExpired(connection)) {
        expireAuthorization(connection);
        return 'expired';
      }
      const operationTime = readNow(now);
      if (
        operationTime < connection.inboundWindowStartedAtMs ||
        operationTime - connection.inboundWindowStartedAtMs >=
          inboundRateWindowMs
      ) {
        connection.inboundWindowStartedAtMs = operationTime;
        connection.inboundMessages = 0;
        connection.inboundBytes = 0;
      }
      if (
        connection.inboundMessages >= maxInboundMessages ||
        serializedBytes > maxInboundBytes - connection.inboundBytes
      ) {
        return 'rate_limited';
      }
      connection.inboundMessages += 1;
      connection.inboundBytes += serializedBytes;
      return 'accepted';
    },

    send(
      connectionId: string,
      serializedEnvelope: string,
      onDeliveryFailure?: (error: Error) => void,
    ) {
      const connection = connections.get(connectionId);
      if (
        connection === undefined ||
        connection.state !== 'active' ||
        connection.socket.readyState !== SOCKET_OPEN
      ) {
        return false;
      }
      const encodedBytes = Buffer.byteLength(serializedEnvelope, 'utf8');
      if (
        encodedBytes > maxBufferedBytes ||
        connection.socket.bufferedAmount > maxBufferedBytes - encodedBytes
      ) {
        stopDelivery(connection, 'closing');
        try {
          connection.socket.close(1013, 'BACKPRESSURE');
        } catch {
          try {
            connection.socket.terminate();
          } catch {
            // Delivery was already disabled before transport cleanup.
          }
        }
        notifyTransportDead(connection);
        return false;
      }
      let sendReturned = false;
      let failedBeforeReturn = false;
      try {
        connection.socket.send(serializedEnvelope, (error) => {
          if (error != null) {
            if (!sendReturned) {
              failedBeforeReturn = true;
            }
            try {
              onDeliveryFailure?.(error);
            } catch {
              // A delivery observer cannot prevent transport cleanup.
            } finally {
              terminate(connection);
            }
          }
        });
        sendReturned = true;
        return !failedBeforeReturn;
      } catch {
        terminate(connection);
        return false;
      }
    },

    markPong(connectionId) {
      const connection = connections.get(connectionId);
      if (connection === undefined || connection.state !== 'active') {
        return;
      }
      connection.awaitingPong = false;
      connection.missedPongs = 0;
    },

    shutdown() {
      for (const connection of connections.values()) {
        removeCurrentIndex(connection);
        clearHeartbeat(connection);
        connection.ackCache.clear();
        connection.ackCacheBytes = 0;
        connection.state = 'closed';
        try {
          connection.socket.terminate();
        } catch {
          // Every connection is removed even if a transport adapter fails.
        }
      }
      connections.clear();
      currentByRoomUser.clear();
    },
  };

  return Object.freeze(registry);
}
