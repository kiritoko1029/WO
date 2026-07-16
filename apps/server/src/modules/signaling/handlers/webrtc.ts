import type { P2pRequestEnvelope } from '@wo/protocol';

import type { RoomRegistry, RoomSnapshot } from '../../rooms/room-types.ts';
import {
  SignalingHandlerError,
  type SignalingHandlerResult,
  type SignalingRelay,
  type SignalingRequestContext,
  type SignalingRequestHandler,
} from '../dispatcher.ts';
import type { CreateFreshIce } from './room.ts';

export interface WebrtcRequestHandlerDependencies {
  readonly roomRegistry: RoomRegistry;
  readonly createFreshIce: CreateFreshIce;
}

function currentRoomInput(
  context: SignalingRequestContext,
  roomId: string,
  claimedEpoch: number,
) {
  const binding = context.binding;
  if (
    binding === null ||
    binding.roomId !== roomId ||
    binding.connectionEpoch !== claimedEpoch
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

function memberRole(room: RoomSnapshot, userId: string) {
  const member = room.members.find((candidate) => candidate.userId === userId);
  if (member === undefined) {
    throw new SignalingHandlerError('FORBIDDEN');
  }
  return member.role;
}

function peerUserId(room: RoomSnapshot, userId: string): string {
  const peer = room.members.find((candidate) => candidate.userId !== userId);
  if (peer === undefined || !peer.online) {
    throw new SignalingHandlerError('INVALID_STATE');
  }
  return peer.userId;
}

function relay(
  room: RoomSnapshot,
  userId: string,
  type: SignalingRelay['type'],
  payload: unknown,
  options: Readonly<{
    deliveryFailure?: SignalingRelay['deliveryFailure'];
    confirmations?: SignalingHandlerResult['effects'] extends infer Effects
      ? Effects extends { readonly confirmations?: infer Confirmations }
        ? Confirmations
        : never
      : never;
  }> = {},
): SignalingHandlerResult {
  return {
    data: {},
    effects: {
      relays: [
        {
          targetUserId: peerUserId(room, userId),
          type,
          payload,
          ...(options.deliveryFailure === undefined
            ? {}
            : { deliveryFailure: options.deliveryFailure }),
        },
      ],
      ...(options.confirmations === undefined
        ? {}
        : { confirmations: options.confirmations }),
    },
  };
}

function signalBase(payload: {
  readonly roomId: string;
  readonly negotiationId: string;
  readonly connectionEpoch: number;
}) {
  return {
    roomId: payload.roomId,
    negotiationId: payload.negotiationId,
    connectionEpoch: payload.connectionEpoch,
  };
}

function relayRequestInput(
  context: SignalingRequestContext,
  current: ReturnType<typeof currentRoomInput>,
  requestId: string,
  operation: 'webrtc.iceCandidate' | 'webrtc.restartRequested',
) {
  return {
    ...current,
    requestId,
    operation,
    requestDigest: context.requestDigest,
  } as const;
}

function reconstructedCandidate(
  candidate: Extract<
    P2pRequestEnvelope,
    { type: 'webrtc.iceCandidate' }
  >['payload']['candidate'],
) {
  if (candidate === null) {
    return null;
  }
  return {
    candidate: candidate.candidate,
    ...(candidate.sdpMid === undefined ? {} : { sdpMid: candidate.sdpMid }),
    ...(candidate.sdpMLineIndex === undefined
      ? {}
      : { sdpMLineIndex: candidate.sdpMLineIndex }),
    ...(candidate.usernameFragment === undefined
      ? {}
      : { usernameFragment: candidate.usernameFragment }),
  };
}

export function createWebrtcRequestHandler(
  dependencies: WebrtcRequestHandlerDependencies,
): SignalingRequestHandler {
  return Object.freeze({
    handle(
      context: SignalingRequestContext,
      request: P2pRequestEnvelope,
    ): SignalingHandlerResult | null {
      switch (request.type) {
        case 'webrtc.offer': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const room =
            dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          if (memberRole(room, current.userId) !== 'creator') {
            throw new SignalingHandlerError('FORBIDDEN');
          }
          const begun = dependencies.roomRegistry.beginNegotiation({
            ...current,
            negotiationId: request.payload.negotiationId,
            requestId: request.requestId,
          });
          const offerRelay = {
            ...current,
            negotiationId: request.payload.negotiationId,
            negotiationGeneration: begun.data.negotiation.generation,
            requestId: request.requestId,
            requestDigest: context.requestDigest,
            operation: 'webrtc.offer',
          } as const;
          if (
            dependencies.roomRegistry.prepareOfferRelay(offerRelay).replayed
          ) {
            return { data: {} };
          }
          return relay(
            room,
            current.userId,
            'webrtc.offer',
            {
              ...signalBase(request.payload),
              description: {
                type: 'offer',
                sdp: request.payload.description.sdp,
              },
            },
            {
              deliveryFailure: {
                roomId: current.roomId,
                negotiationId: request.payload.negotiationId,
                negotiationGeneration: begun.data.negotiation.generation,
              },
              confirmations: [
                { type: 'offer.confirmQueued', input: offerRelay },
              ],
            },
          );
        }
        case 'webrtc.answer': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const answerRelay = {
            ...current,
            negotiationId: request.payload.negotiationId,
            requestId: request.requestId,
            requestDigest: context.requestDigest,
          } as const;
          const prepared =
            dependencies.roomRegistry.prepareAnswerRelay(answerRelay);
          if (prepared.replayed) {
            return { data: {} };
          }
          const room =
            dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          return relay(
            room,
            current.userId,
            'webrtc.answer',
            {
              ...signalBase(request.payload),
              description: {
                type: 'answer',
                sdp: request.payload.description.sdp,
              },
            },
            {
              deliveryFailure: {
                roomId: current.roomId,
                negotiationId: request.payload.negotiationId,
                negotiationGeneration: prepared.negotiationGeneration,
              },
              confirmations: [
                {
                  type: 'answer.confirmQueued',
                  input: {
                    ...answerRelay,
                    negotiationGeneration: prepared.negotiationGeneration,
                  },
                },
              ],
            },
          );
        }
        case 'webrtc.answerApplied': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const completed = dependencies.roomRegistry.completeNegotiation({
            ...current,
            negotiationId: request.payload.negotiationId,
            requestId: request.requestId,
          });
          return {
            data: {},
            effects: { intents: completed.intents },
          };
        }
        case 'webrtc.iceCandidate': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const relayInput = relayRequestInput(
            context,
            current,
            request.requestId,
            'webrtc.iceCandidate',
          );
          if (dependencies.roomRegistry.prepareRelay(relayInput).replayed) {
            return { data: {} };
          }
          const negotiation = dependencies.roomRegistry.validateNegotiation({
            ...current,
            negotiationId: request.payload.negotiationId,
          });
          if (negotiation.offerState !== 'queued') {
            throw new SignalingHandlerError('INVALID_STATE');
          }
          const room =
            dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          return relay(
            room,
            current.userId,
            'webrtc.iceCandidate',
            {
              ...signalBase(request.payload),
              candidate: reconstructedCandidate(request.payload.candidate),
            },
            {
              confirmations: [{ type: 'relay.confirm', input: relayInput }],
            },
          );
        }
        case 'webrtc.restartRequested': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const relayInput = relayRequestInput(
            context,
            current,
            request.requestId,
            'webrtc.restartRequested',
          );
          if (dependencies.roomRegistry.prepareRelay(relayInput).replayed) {
            return { data: {} };
          }
          dependencies.roomRegistry.validateNegotiation({
            ...current,
            negotiationId: request.payload.negotiationId,
          });
          const room =
            dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          if (memberRole(room, current.userId) !== 'joiner') {
            throw new SignalingHandlerError('INVALID_STATE');
          }
          return relay(
            room,
            current.userId,
            'webrtc.restartRequested',
            signalBase(request.payload),
            {
              confirmations: [{ type: 'relay.confirm', input: relayInput }],
            },
          );
        }
        case 'webrtc.iceRestart': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          const restarted = dependencies.roomRegistry.beginIceRestart({
            ...current,
            negotiationId: request.payload.negotiationId,
            requestId: request.requestId,
          });
          const offerRelay = {
            ...current,
            negotiationId: request.payload.negotiationId,
            negotiationGeneration: restarted.data.negotiation.generation,
            requestId: request.requestId,
            requestDigest: context.requestDigest,
            operation: 'webrtc.iceRestart',
          } as const;
          if (
            dependencies.roomRegistry.prepareOfferRelay(offerRelay).replayed
          ) {
            return { data: {} };
          }
          const room =
            dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          return relay(
            room,
            current.userId,
            'webrtc.iceRestart',
            {
              ...signalBase(request.payload),
              description: {
                type: 'offer',
                sdp: request.payload.description.sdp,
              },
            },
            {
              deliveryFailure: {
                roomId: current.roomId,
                negotiationId: request.payload.negotiationId,
                negotiationGeneration: restarted.data.negotiation.generation,
              },
              confirmations: [
                {
                  type: 'offer.confirmQueued',
                  input: offerRelay,
                },
              ],
            },
          );
        }
        case 'webrtc.iceServers.refresh': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          dependencies.roomRegistry.getCurrentConnectionSnapshot(current);
          return {
            data: dependencies.createFreshIce({
              roomId: current.roomId,
              userId: current.userId,
              connectionEpoch: current.connectionEpoch,
            }),
          };
        }
        case 'webrtc.recoveryReset': {
          const current = currentRoomInput(
            context,
            request.payload.roomId,
            request.payload.connectionEpoch,
          );
          dependencies.roomRegistry.validateNegotiation({
            ...current,
            negotiationId: request.payload.negotiationId,
          });
          const reset = dependencies.roomRegistry.resetNegotiation({
            ...current,
            reason: 'signaling_reset',
            requestId: request.requestId,
          }).data.reset;
          return {
            data: {
              negotiationId: reset.negotiationId,
              resetGeneration: reset.generation,
              reason: reset.reason,
            },
            effects: {
              intents: [
                {
                  type: 'webrtc.negotiationReset',
                  roomId: current.roomId,
                  negotiationId: reset.negotiationId,
                  generation: reset.generation,
                  reason: reset.reason,
                },
              ],
              confirmations: [
                {
                  type: 'negotiationReset.consume',
                  input: { ...current, ...reset },
                },
              ],
            },
          };
        }
        default:
          return null;
      }
    },
  });
}
