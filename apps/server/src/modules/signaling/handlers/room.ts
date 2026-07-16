import {
  peerSummarySchema,
  roomResumeAckDataSchema,
  roomResumeDispositionSchema,
  roomSessionAckDataSchema,
  screenOwnerSnapshotSchema,
  type IceConfigurationData,
  type P2pRequestEnvelope,
  type PeerSummary,
  type RoomResumeAckData,
  type RoomResumeDisposition,
  type RoomSessionAckData,
  type ScreenOwnerSnapshot,
} from '@wo/protocol';

import type { JoinAttemptLimiter } from '../../rooms/join-attempt-limiter.ts';
import type {
  RoomIntent,
  RoomRegistry,
  RoomSessionData,
} from '../../rooms/room-types.ts';
import {
  SignalingHandlerError,
  type SignalingHandlerResult,
  type SignalingRequestContext,
  type SignalingRequestHandler,
} from '../dispatcher.ts';

export interface FreshIceContext {
  readonly roomId: string;
  readonly userId: string;
  readonly connectionEpoch: number;
}

export type CreateFreshIce = (context: FreshIceContext) => IceConfigurationData;

export interface RoomRequestHandlerDependencies {
  readonly roomRegistry: RoomRegistry;
  readonly joinAttemptLimiter: Pick<JoinAttemptLimiter, 'consume'>;
  readonly roomOperationLimiter?: Pick<JoinAttemptLimiter, 'consume'>;
  readonly createFreshIce: CreateFreshIce;
}

function consumeRoomOperationLimit(
  dependencies: RoomRequestHandlerDependencies,
  requestId: string,
): void {
  const limit = dependencies.roomOperationLimiter?.consume({
    userId: 'server-wide-room-operations',
    remoteIp: '0.0.0.0',
    requestId,
  });
  if (limit?.allowed === false) {
    throw new SignalingHandlerError('RATE_LIMITED', true);
  }
}

function assertUnbound(context: SignalingRequestContext): void {
  if (context.binding !== null) {
    throw new SignalingHandlerError('INVALID_STATE');
  }
}

function currentRoomInput(
  context: SignalingRequestContext,
  roomId: string,
  claimedEpoch?: number,
) {
  const binding = context.binding;
  if (
    binding === null ||
    binding.roomId !== roomId ||
    (claimedEpoch !== undefined && binding.connectionEpoch !== claimedEpoch)
  ) {
    throw new SignalingHandlerError('STALE_CONNECTION');
  }
  return {
    roomId,
    userId: context.identity.userId,
    connectionId: context.connectionId,
    connectionEpoch: binding.connectionEpoch,
  } as const;
}

function peerSummary(
  session: RoomSessionData,
  userId: string,
): PeerSummary | null {
  const peer = session.room.members.find((member) => member.userId !== userId);
  return peer === undefined
    ? null
    : peerSummarySchema.parse({
        userId: peer.userId,
        displayName: peer.displayName,
        ready: peer.ready,
      });
}

function screenOwnerSnapshot(session: RoomSessionData): ScreenOwnerSnapshot {
  const lease = session.room.screenLease;
  if (lease === null) {
    return screenOwnerSnapshotSchema.parse({
      owner: null,
      leaseId: null,
      leaseExpiresAt: null,
    });
  }
  const owner = session.room.members.find(
    (member) => member.userId === lease.ownerUserId,
  );
  if (owner === undefined) {
    throw new Error('Screen lease owner is not a room member');
  }
  return screenOwnerSnapshotSchema.parse({
    owner: peerSummarySchema.parse({
      userId: owner.userId,
      displayName: owner.displayName,
      ready: owner.ready,
    }),
    leaseId: lease.leaseId,
    leaseExpiresAt: new Date(lease.expiresAtMs).toISOString(),
  });
}

function publicRoomSession(
  session: RoomSessionData,
  userId: string,
  ice: IceConfigurationData,
): RoomSessionAckData {
  return roomSessionAckDataSchema.parse({
    roomId: session.room.id,
    role: session.role,
    state: session.room.state,
    connectionEpoch: session.connection.connectionEpoch,
    peer: peerSummary(session, userId),
    screen: screenOwnerSnapshot(session),
    ...ice,
  });
}

function sessionIce(
  dependencies: RoomRequestHandlerDependencies,
  session: RoomSessionData,
  userId: string,
): IceConfigurationData {
  return dependencies.createFreshIce({
    roomId: session.room.id,
    userId,
    connectionEpoch: session.connection.connectionEpoch,
  });
}

function compensatedPublicRoomSession(
  dependencies: RoomRequestHandlerDependencies,
  session: RoomSessionData,
  userId: string,
): RoomSessionAckData {
  try {
    return publicRoomSession(
      session,
      userId,
      sessionIce(dependencies, session, userId),
    );
  } catch (error) {
    dependencies.roomRegistry.abortSessionSetup({
      roomId: session.room.id,
      userId,
      connectionId: session.connection.connectionId,
      connectionEpoch: session.connection.connectionEpoch,
    });
    throw error;
  }
}

function resumeDisposition(session: RoomSessionData): RoomResumeDisposition {
  const reset = session.room.pendingNegotiationReset;
  if (reset !== null) {
    return roomResumeDispositionSchema.parse({
      status: 'reset_required',
      negotiationId: reset.negotiationId,
      resetGeneration: reset.generation,
      reason: reset.reason,
    });
  }
  const negotiation = session.room.activeNegotiation;
  if (negotiation === null) return Object.freeze({ status: 'none' });
  if (negotiation.status === 'completed') {
    return roomResumeDispositionSchema.parse({
      status: 'completed',
      negotiationId: negotiation.negotiationId,
      negotiationGeneration: negotiation.generation,
    });
  }
  throw new Error('Resumed room has no recoverable negotiation disposition');
}

function compensatedResumeSession(
  dependencies: RoomRequestHandlerDependencies,
  session: RoomSessionData,
  userId: string,
): RoomResumeAckData {
  const publicSession = compensatedPublicRoomSession(
    dependencies,
    session,
    userId,
  );
  return roomResumeAckDataSchema.parse({
    ...publicSession,
    resume: resumeDisposition(session),
  });
}

export function createRoomRequestHandler(
  dependencies: RoomRequestHandlerDependencies,
): SignalingRequestHandler {
  return Object.freeze({
    handle(
      context: SignalingRequestContext,
      request: P2pRequestEnvelope,
    ): SignalingHandlerResult | null {
      const identity = context.identity;
      switch (request.type) {
        case 'room.create': {
          assertUnbound(context);
          consumeRoomOperationLimit(dependencies, request.requestId);
          const result = dependencies.roomRegistry.create({
            userId: identity.userId,
            displayName: identity.displayName,
            connectionId: context.connectionId,
            requestId: request.requestId,
          });
          const data = compensatedPublicRoomSession(
            dependencies,
            result.data,
            identity.userId,
          );
          return {
            data: { ...data, roomCode: result.data.roomCode },
            effects: {
              binding: {
                roomId: result.data.room.id,
                connectionEpoch: result.data.connection.connectionEpoch,
              },
              intents: result.intents,
            },
          };
        }
        case 'room.join': {
          assertUnbound(context);
          consumeRoomOperationLimit(dependencies, request.requestId);
          const limit = dependencies.joinAttemptLimiter.consume({
            userId: identity.userId,
            remoteIp: context.remoteIp,
            requestId: request.requestId,
          });
          if (!limit.allowed) {
            throw new SignalingHandlerError('RATE_LIMITED', true);
          }
          const result = dependencies.roomRegistry.join({
            roomCode: request.payload.roomCode,
            userId: identity.userId,
            displayName: identity.displayName,
            connectionId: context.connectionId,
            requestId: request.requestId,
          });
          return {
            data: compensatedPublicRoomSession(
              dependencies,
              result.data,
              identity.userId,
            ),
            effects: {
              binding: {
                roomId: result.data.room.id,
                connectionEpoch: result.data.connection.connectionEpoch,
              },
              intents: result.intents,
            },
          };
        }
        case 'room.resume': {
          assertUnbound(context);
          const result = dependencies.roomRegistry.resume({
            roomId: request.payload.roomId,
            userId: identity.userId,
            displayName: identity.displayName,
            connectionId: context.connectionId,
            requestId: request.requestId,
          });
          const data = compensatedResumeSession(
            dependencies,
            result.data,
            identity.userId,
          );
          const current = {
            roomId: result.data.room.id,
            userId: identity.userId,
            connectionId: context.connectionId,
            connectionEpoch: result.data.connection.connectionEpoch,
          };
          const reset =
            dependencies.roomRegistry.peekPendingNegotiationReset(current);
          const intents: RoomIntent[] = [...result.intents];
          if (reset !== null) {
            intents.push({
              type: 'webrtc.negotiationReset',
              roomId: current.roomId,
              negotiationId: reset.negotiationId,
              generation: reset.generation,
              reason: reset.reason,
            });
          }
          return {
            data,
            effects: {
              binding: {
                roomId: result.data.room.id,
                connectionEpoch: result.data.connection.connectionEpoch,
              },
              intents,
              ...(reset === null
                ? {}
                : {
                    confirmations: [
                      {
                        type: 'negotiationReset.consume' as const,
                        input: { ...current, ...reset },
                      },
                    ],
                  }),
            },
          };
        }
        case 'room.leave': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.roomRegistry.leave(current);
          return {
            data: {},
            effects: { binding: null, intents: result.intents },
          };
        }
        case 'room.end': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.roomRegistry.end(current);
          return {
            data: {},
            effects: { binding: null, intents: result.intents },
          };
        }
        case 'peer.ready': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const result = dependencies.roomRegistry.bindReady({
            ...current,
            requestId: request.requestId,
          });
          return {
            data: {},
            effects: { intents: result.intents },
          };
        }
        default:
          return null;
      }
    },
  });
}
