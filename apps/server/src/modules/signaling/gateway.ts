import { createHash, randomUUID } from 'node:crypto';

import {
  p2pAckEnvelopeSchema,
  p2pBroadcastEnvelopeSchema,
  p2pOutboundResponseSchema,
  p2pRequestEnvelopeSchema,
  protocolErrorResponseSchema,
  requestIdSchema,
  type P2pErrorCode,
  type P2pRequestEnvelope,
} from '@wo/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import { HttpError } from '../../http/errors.ts';
import {
  RoomDomainError,
  type RoomIntent,
  type RoomRegistry,
  type RoomSnapshot,
} from '../rooms/room-types.ts';
import {
  createConnectionRegistry,
  type ConnectionRegistry,
  type ConnectionRegistryOptions,
  type SignalingConnection,
} from './connection-registry.ts';
import type {
  SignalingDispatcher,
  SignalingEffects,
  SignalingRelay,
  SignalingRequestContext,
} from './dispatcher.ts';
import type {
  SignalTicketClaims,
  SignalTicketStore,
} from './signal-ticket-store.ts';

const REALTIME_PATH = '/v1/realtime';
const MAX_PROTOCOL_HEADER_BYTES = 256;
const MAX_TEXT_PAYLOAD_BYTES = 1_048_576;
const KNOWN_REQUEST_TYPES = new Set<string>(
  p2pRequestEnvelopeSchema.options.map((schema) => schema.shape.type.value),
);

export interface SignalingGatewayOptions extends Omit<
  ConnectionRegistryOptions,
  'onTransportDead'
> {
  readonly randomConnectionId?: () => string;
  readonly randomEventId?: () => string;
}

export interface SignalingGatewayDependencies {
  readonly ticketStore: SignalTicketStore;
  readonly roomRegistry: RoomRegistry;
  readonly dispatcher: SignalingDispatcher;
  readonly options?: SignalingGatewayOptions;
  readonly onInternalError?: (error: unknown, operation: string) => void;
}

export interface SignalingGateway {
  processIntent(intent: RoomIntent): void;
  shutdown(): void;
}

type ParsedMessage =
  | Readonly<{ ok: true; request: P2pRequestEnvelope }>
  | Readonly<{
      ok: false;
      requestId: string | null;
      code: 'UNSUPPORTED_PROTOCOL' | 'VALIDATION_ERROR';
    }>;

function randomId(): string {
  return randomUUID();
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const result = requestIdSchema.safeParse(
    (value as Record<string, unknown>)['requestId'],
  );
  return result.success ? result.data : null;
}

function parseMessage(text: string): ParsedMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, requestId: null, code: 'VALIDATION_ERROR' };
  }
  const requestId = safeRequestId(decoded);
  if (typeof decoded !== 'object' || decoded === null) {
    return { ok: false, requestId, code: 'VALIDATION_ERROR' };
  }
  const candidate = decoded as Record<string, unknown>;
  if (candidate['version'] !== 1) {
    return { ok: false, requestId, code: 'UNSUPPORTED_PROTOCOL' };
  }
  const parsed = p2pRequestEnvelopeSchema.safeParse(decoded);
  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }
  return {
    ok: false,
    requestId,
    code:
      typeof candidate['type'] === 'string' &&
      KNOWN_REQUEST_TYPES.has(candidate['type'])
        ? 'VALIDATION_ERROR'
        : 'UNSUPPORTED_PROTOCOL',
  };
}

const protocolErrorMessages: Record<
  'UNSUPPORTED_PROTOCOL' | 'VALIDATION_ERROR',
  string
> = {
  UNSUPPORTED_PROTOCOL: 'Protocol message is not supported',
  VALIDATION_ERROR: 'Request validation failed',
};

function serializedProtocolError(
  requestId: string | null,
  code: 'UNSUPPORTED_PROTOCOL' | 'VALIDATION_ERROR',
): string {
  return JSON.stringify(
    protocolErrorResponseSchema.parse({
      version: 1,
      requestId,
      type: 'protocol.error',
      payload: {
        ok: false,
        error: { code, message: protocolErrorMessages[code] },
      },
    }),
  );
}

function serializedRequestFailure(
  request: P2pRequestEnvelope,
  code: P2pErrorCode,
  message: string,
  retryable = false,
): string {
  return JSON.stringify(
    p2pOutboundResponseSchema.parse(
      p2pAckEnvelopeSchema.parse({
        version: 1,
        requestId: request.requestId,
        type: `${request.type}.ack`,
        payload: {
          ok: false,
          error: {
            code,
            message,
            ...(retryable ? { retryable: true } : {}),
          },
        },
      }),
    ),
  );
}

function requestDigest(request: P2pRequestEnvelope): string {
  return createHash('sha256')
    .update(JSON.stringify(request), 'utf8')
    .digest('base64url');
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function peerSummary(room: RoomSnapshot, userId: string) {
  const member = room.members.find((candidate) => candidate.userId === userId);
  if (member === undefined) {
    throw new RoomDomainError('NOT_ROOM_MEMBER');
  }
  return {
    userId: member.userId,
    displayName: member.displayName,
    ready: member.ready,
  };
}

export function registerSignalingGateway(
  app: FastifyInstance,
  dependencies: SignalingGatewayDependencies,
): SignalingGateway {
  const options = dependencies.options ?? {};
  const randomConnectionId = options.randomConnectionId ?? randomId;
  const randomEventId = options.randomEventId ?? randomId;
  const now = options.now ?? Date.now;
  const upgradeClaims = new WeakMap<FastifyRequest, SignalTicketClaims>();
  let shuttingDown = false;

  const reportInternal = (error: unknown, operation: string): void => {
    try {
      dependencies.onInternalError?.(error, operation);
    } catch {
      // Observability cannot change signaling cleanup.
    }
  };

  const disconnectRemoved = (connection: SignalingConnection): void => {
    const binding = connection.binding;
    if (binding === null) {
      return;
    }
    try {
      const result = dependencies.roomRegistry.disconnect({
        roomId: binding.roomId,
        userId: connection.identity.userId,
        connectionId: connection.connectionId,
        connectionEpoch: binding.connectionEpoch,
      });
      for (const intent of result.intents) {
        processIntent(intent);
      }
    } catch (error) {
      if (
        error instanceof RoomDomainError &&
        (error.code === 'STALE_CONNECTION' || error.code === 'ROOM_CLOSED')
      ) {
        return;
      }
      reportInternal(error, 'connection.disconnect');
    }
  };

  const cleanupConnection = (connectionId: string): void => {
    const removed = connectionRegistry.remove(connectionId);
    if (removed !== null && !shuttingDown) {
      disconnectRemoved(removed);
    }
  };

  const connectionRegistry: ConnectionRegistry = createConnectionRegistry({
    ...options,
    onTransportDead: cleanupConnection,
  });

  const sendSerialized = (
    connectionId: string,
    serialized: string,
    onDeliveryFailure?: (error: Error) => void,
  ): boolean =>
    onDeliveryFailure === undefined
      ? connectionRegistry.send(connectionId, serialized)
      : connectionRegistry.send(connectionId, serialized, onDeliveryFailure);

  interface BroadcastOutcome {
    readonly targetCount: number;
    readonly queuedCount: number;
  }

  const broadcast = (
    roomId: string,
    excludedUserId: string | null,
    type: string,
    payload: unknown,
    options: Readonly<{
      eventId?: string;
      stopOnFailure?: boolean;
    }> = {},
  ): BroadcastOutcome => {
    const envelope = p2pBroadcastEnvelopeSchema.parse({
      version: 1,
      eventId: options.eventId ?? randomEventId(),
      type,
      payload,
    });
    const serialized = JSON.stringify(
      p2pOutboundResponseSchema.parse(envelope),
    );
    const targets = connectionRegistry
      .listCurrentInRoom(roomId)
      .filter((target) => target.identity.userId !== excludedUserId);
    let queuedCount = 0;
    for (const target of targets) {
      if (target.identity.userId !== excludedUserId) {
        if (sendSerialized(target.connectionId, serialized)) {
          queuedCount += 1;
        } else if (options.stopOnFailure === true) {
          break;
        }
      }
    }
    return Object.freeze({ targetCount: targets.length, queuedCount });
  };

  const snapshotForIntent = (intent: {
    readonly roomId: string;
    readonly userId: string;
  }): RoomSnapshot =>
    dependencies.roomRegistry.getMemberSnapshotForBroadcast({
      roomId: intent.roomId,
      userId: intent.userId,
    });

  function processIntent(intent: RoomIntent): boolean {
    try {
      switch (intent.type) {
        case 'connection.replaced':
          connectionRegistry.supersede(intent);
          return true;
        case 'peer.joined': {
          const room = snapshotForIntent(intent);
          broadcast(intent.roomId, intent.userId, 'peer.joined', {
            roomId: intent.roomId,
            peer: peerSummary(room, intent.userId),
          });
          return true;
        }
        case 'peer.ready': {
          const room = snapshotForIntent(intent);
          broadcast(intent.roomId, intent.userId, 'peer.ready', {
            roomId: intent.roomId,
            peer: peerSummary(room, intent.userId),
          });
          return true;
        }
        case 'peer.left':
          broadcast(intent.roomId, intent.userId, 'peer.left', {
            roomId: intent.roomId,
            userId: intent.userId,
            reason: intent.reason,
          });
          return true;
        case 'room.closed': {
          broadcast(intent.roomId, null, 'room.closed', {
            roomId: intent.roomId,
            reason: intent.reason,
          });
          for (const connection of connectionRegistry.listCurrentInRoom(
            intent.roomId,
          )) {
            connectionRegistry.unbind(connection.connectionId);
          }
          return true;
        }
        case 'webrtc.negotiationReset': {
          const outcome = broadcast(
            intent.roomId,
            null,
            'webrtc.negotiationReset',
            {
              roomId: intent.roomId,
              negotiationId: intent.negotiationId,
              resetGeneration: intent.generation,
              reason: intent.reason,
            },
            {
              eventId: intent.negotiationId,
              stopOnFailure: true,
            },
          );
          return outcome.targetCount === 2 && outcome.queuedCount === 2;
        }
        case 'screen.ownerChanged': {
          if (intent.ownerUserId === null) {
            broadcast(intent.roomId, null, 'screen.ownerChanged', {
              roomId: intent.roomId,
              owner: null,
              leaseId: null,
              leaseExpiresAt: null,
            });
            return true;
          }
          const room = snapshotForIntent({
            roomId: intent.roomId,
            userId: intent.ownerUserId,
          });
          const lease = room.screenLease;
          if (lease === null || lease.leaseId !== intent.leaseId) {
            return true;
          }
          broadcast(intent.roomId, null, 'screen.ownerChanged', {
            roomId: intent.roomId,
            owner: peerSummary(room, intent.ownerUserId),
            leaseId: lease.leaseId,
            leaseExpiresAt: new Date(lease.expiresAtMs).toISOString(),
          });
          return true;
        }
        case 'screen.bitrateChanged':
          broadcast(intent.roomId, intent.ownerUserId, 'screen.bitrate', {
            roomId: intent.roomId,
            leaseId: intent.leaseId,
            bitrate: intent.bitrateBps,
          });
          return true;
      }
    } catch (error) {
      if (error instanceof RoomDomainError && error.code === 'ROOM_CLOSED') {
        return false;
      }
      reportInternal(error, `intent.${intent.type}`);
      return false;
    }
  }

  const sendRelay = (
    source: SignalingConnection,
    relay: SignalingRelay,
  ): void => {
    const binding = source.binding;
    if (binding === null) {
      throw new RoomDomainError('STALE_CONNECTION');
    }
    const target = connectionRegistry.findCurrent(
      binding.roomId,
      relay.targetUserId,
    );
    if (target === null) {
      throw new RoomDomainError('INVALID_STATE');
    }
    const envelope = p2pBroadcastEnvelopeSchema.parse({
      version: 1,
      eventId: randomEventId(),
      type: relay.type,
      payload: relay.payload,
    });
    let deliveryFailureHandled = false;
    const onDeliveryFailure =
      relay.deliveryFailure === undefined
        ? undefined
        : () => {
            if (deliveryFailureHandled) {
              return;
            }
            deliveryFailureHandled = true;
            try {
              dependencies.roomRegistry.markNegotiationDeliveryFailed(
                relay.deliveryFailure!,
              );
            } catch (error) {
              if (
                !(error instanceof RoomDomainError) ||
                error.code !== 'ROOM_CLOSED'
              ) {
                reportInternal(error, 'relay.deliveryFailure');
              }
            }
          };
    const queued = sendSerialized(
      target.connectionId,
      JSON.stringify(envelope),
      onDeliveryFailure,
    );
    if (!queued) {
      onDeliveryFailure?.();
      throw new Error('Signaling relay transport is unavailable');
    }
  };

  const applyEffects = (
    connectionId: string,
    effects: SignalingEffects,
  ): void => {
    if (Object.hasOwn(effects, 'binding')) {
      if (effects.binding === null) {
        connectionRegistry.unbind(connectionId);
      } else if (effects.binding !== undefined) {
        connectionRegistry.bind({ connectionId, ...effects.binding });
      }
    }
    for (const intent of effects.intents) {
      if (intent.type === 'connection.replaced') {
        processIntent(intent);
      }
    }
    for (const intent of effects.intents) {
      if (intent.type !== 'connection.replaced') {
        const delivered = processIntent(intent);
        if (intent.type === 'webrtc.negotiationReset' && !delivered) {
          throw new Error('Negotiation reset delivery is unavailable');
        }
      }
    }
    const source = connectionRegistry.get(connectionId);
    if (source === null) {
      return;
    }
    for (const relay of effects.relays) {
      sendRelay(source, relay);
    }
    for (const confirmation of effects.confirmations) {
      switch (confirmation.type) {
        case 'relay.confirm':
          if (!dependencies.roomRegistry.confirmRelay(confirmation.input)) {
            throw new Error('Relay confirmation was already applied');
          }
          break;
        case 'answer.confirmQueued':
          if (
            !dependencies.roomRegistry.confirmAnswerRelay(confirmation.input)
          ) {
            throw new Error('Answer relay confirmation was already applied');
          }
          break;
        case 'offer.confirmQueued':
          if (
            !dependencies.roomRegistry.confirmOfferRelay(confirmation.input)
          ) {
            throw new Error('Offer relay confirmation was already applied');
          }
          break;
        case 'negotiationReset.consume':
          if (
            !dependencies.roomRegistry.confirmPendingNegotiationReset(
              confirmation.input,
            )
          ) {
            throw new Error('Negotiation reset confirmation is stale');
          }
          break;
      }
    }
  };

  const processTextMessage = (
    connectionId: string,
    text: string,
    remoteIp: string,
  ): void => {
    const parsed = parseMessage(text);
    if (!parsed.ok) {
      sendSerialized(
        connectionId,
        serializedProtocolError(parsed.requestId, parsed.code),
      );
      return;
    }
    const digest = requestDigest(parsed.request);
    const cached = connectionRegistry.lookupAck(
      connectionId,
      parsed.request.requestId,
      digest,
    );
    if (cached.kind === 'replay') {
      sendSerialized(connectionId, cached.serializedAck);
      return;
    }
    if (cached.kind === 'conflict') {
      sendSerialized(
        connectionId,
        serializedProtocolError(parsed.request.requestId, 'VALIDATION_ERROR'),
      );
      return;
    }

    const connection = connectionRegistry.get(connectionId);
    if (connection === null || connection.state !== 'active') {
      return;
    }
    const context: SignalingRequestContext = {
      identity: connection.identity,
      connectionId,
      binding: connection.binding,
      remoteIp,
      requestDigest: digest,
    };
    const dispatched = dependencies.dispatcher.dispatch(
      context,
      parsed.request,
    );
    try {
      const serialized = JSON.stringify(
        p2pOutboundResponseSchema.parse(dispatched.response),
      );
      applyEffects(connectionId, dispatched.effects);
      connectionRegistry.storeAck(
        connectionId,
        parsed.request.requestId,
        digest,
        serialized,
      );
      sendSerialized(connectionId, serialized);
    } catch (error) {
      reportInternal(error, `request.${parsed.request.type}`);
      const fallback = serializedRequestFailure(
        parsed.request,
        'SIGNALING_UNAVAILABLE',
        'Signaling is temporarily unavailable',
        true,
      );
      const needsFreshSocket =
        Object.hasOwn(dispatched.effects, 'binding') &&
        dispatched.effects.binding !== null;
      if (needsFreshSocket) {
        closeAndCleanup(connectionId, 1011, 'SIGNALING_RECOVERY_FAILED');
      } else {
        sendSerialized(connectionId, fallback);
      }
    }
  };

  function closeAndCleanup(
    connectionId: string,
    code: number,
    reason: string,
  ): void {
    const connection = connectionRegistry.get(connectionId);
    if (connection === null) {
      return;
    }
    try {
      connection.socket.close(code, reason);
    } catch {
      try {
        connection.socket.terminate();
      } catch {
        // Registry cleanup below is authoritative.
      }
    }
    cleanupConnection(connectionId);
  }

  const preValidateUpgrade = async (request: FastifyRequest): Promise<void> => {
    if (!request.ws) {
      return;
    }
    if (request.raw.url !== REALTIME_PATH) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed');
    }
    const header = request.headers['sec-websocket-protocol'];
    if (
      typeof header !== 'string' ||
      Buffer.byteLength(header, 'ascii') > MAX_PROTOCOL_HEADER_BYTES
    ) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    const offered = header.split(',').map((value) => value.trim());
    const ticketProtocols = offered.filter((value) =>
      value.startsWith('ticket.'),
    );
    if (
      offered.length !== 2 ||
      new Set(offered).size !== 2 ||
      !offered.includes('wo-v1') ||
      ticketProtocols.length !== 1
    ) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    const claims = dependencies.ticketStore.consume(
      ticketProtocols[0]!.slice('ticket.'.length),
    );
    if (claims === null) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    upgradeClaims.set(request, claims);
  };

  app.route({
    method: 'GET',
    url: REALTIME_PATH,
    preValidation: preValidateUpgrade,
    handler: async (_request, reply) => reply.status(404).send(),
    wsHandler(socket: WebSocket, request) {
      const connectionId = randomConnectionId();
      const onMessage = (data: RawData, isBinary: boolean): void => {
        try {
          if (isBinary) {
            closeAndCleanup(connectionId, 1003, 'TEXT_REQUIRED');
            return;
          }
          const message = rawDataBuffer(data);
          const bytes = message.byteLength;
          if (bytes > MAX_TEXT_PAYLOAD_BYTES) {
            closeAndCleanup(connectionId, 1009, 'MESSAGE_TOO_BIG');
            return;
          }
          const inbound = connectionRegistry.consumeInbound(
            connectionId,
            bytes,
          );
          if (inbound === 'expired' || inbound === 'inactive') {
            return;
          }
          if (inbound === 'rate_limited') {
            closeAndCleanup(connectionId, 1008, 'RATE_LIMITED');
            return;
          }
          processTextMessage(
            connectionId,
            message.toString('utf8'),
            request.ip,
          );
        } catch (error) {
          reportInternal(error, 'socket.message');
          closeAndCleanup(connectionId, 1011, 'SIGNALING_UNAVAILABLE');
        }
      };
      const onClose = (): void => {
        try {
          cleanupConnection(connectionId);
        } catch (error) {
          reportInternal(error, 'socket.close');
        }
      };
      const onError = (): void => {
        try {
          cleanupConnection(connectionId);
        } catch (error) {
          reportInternal(error, 'socket.error');
        }
      };
      const onPong = (): void => {
        try {
          connectionRegistry.markPong(connectionId);
        } catch (error) {
          reportInternal(error, 'socket.pong');
          closeAndCleanup(connectionId, 1011, 'SIGNALING_UNAVAILABLE');
        }
      };

      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.on('pong', onPong);

      const claims = upgradeClaims.get(request);
      upgradeClaims.delete(request);
      if (claims === undefined) {
        socket.close(1008, 'AUTH_REQUIRED');
        return;
      }
      if (Math.floor(now() / 1_000) >= claims.accessTokenExpiresAtSeconds) {
        socket.close(4401, 'AUTH_EXPIRED');
        return;
      }
      try {
        connectionRegistry.register({
          connectionId,
          identity: claims,
          socket,
        });
      } catch (error) {
        reportInternal(error, 'connection.register');
        socket.close(1013, 'SIGNALING_UNAVAILABLE');
      }
    },
  });

  return Object.freeze({
    processIntent,
    shutdown() {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      connectionRegistry.shutdown();
    },
  });
}
