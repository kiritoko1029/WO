import {
  p2pAckEnvelopeSchema,
  type P2pAckEnvelope,
  type P2pErrorCode,
  type P2pRequestEnvelope,
} from '@wo/protocol';

import {
  RoomDomainError,
  type ConfirmAnswerRelayInput,
  type ConfirmPendingNegotiationResetInput,
  type OfferRelayInput,
  type RelayRequestInput,
  type RoomIntent,
} from '../rooms/room-types.ts';
import type { ConnectionRoomBinding } from './connection-registry.ts';
import type { SignalTicketClaims } from './signal-ticket-store.ts';

export interface SignalingRequestContext {
  readonly identity: SignalTicketClaims;
  readonly connectionId: string;
  readonly binding: ConnectionRoomBinding | null;
  readonly remoteIp: string;
  readonly requestDigest: string;
}

export interface SignalingRelay {
  readonly targetUserId: string;
  readonly type:
    | 'webrtc.offer'
    | 'webrtc.answer'
    | 'webrtc.iceCandidate'
    | 'webrtc.iceRestart'
    | 'webrtc.restartRequested';
  readonly payload: unknown;
  readonly deliveryFailure?: Readonly<{
    roomId: string;
    negotiationId: string;
    negotiationGeneration: number;
  }>;
}

export type SignalingConfirmation =
  | Readonly<{
      type: 'relay.confirm';
      input: RelayRequestInput;
    }>
  | Readonly<{
      type: 'answer.confirmQueued';
      input: ConfirmAnswerRelayInput;
    }>
  | Readonly<{
      type: 'offer.confirmQueued';
      input: OfferRelayInput;
    }>
  | Readonly<{
      type: 'negotiationReset.consume';
      input: ConfirmPendingNegotiationResetInput;
    }>;

export interface SignalingEffects {
  readonly binding?: ConnectionRoomBinding | null;
  readonly intents: readonly RoomIntent[];
  readonly relays: readonly SignalingRelay[];
  readonly confirmations: readonly SignalingConfirmation[];
}

export interface SignalingHandlerResult {
  readonly data: unknown;
  readonly effects?: Partial<SignalingEffects>;
}

export interface SignalingRequestHandler {
  handle(
    context: SignalingRequestContext,
    request: P2pRequestEnvelope,
  ): SignalingHandlerResult | null;
}

export interface SignalingDispatchResult {
  readonly response: P2pAckEnvelope;
  readonly effects: SignalingEffects;
}

export class SignalingHandlerError extends Error {
  constructor(
    readonly code: P2pErrorCode,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'SignalingHandlerError';
  }
}

export interface SignalingDispatcherDependencies {
  readonly roomHandler: SignalingRequestHandler;
  readonly webrtcHandler: SignalingRequestHandler;
  readonly onInternalError?: (error: unknown, requestType: string) => void;
}

export interface SignalingDispatcher {
  dispatch(
    context: SignalingRequestContext,
    request: P2pRequestEnvelope,
  ): SignalingDispatchResult;
}

const EMPTY_EFFECTS: SignalingEffects = Object.freeze({
  intents: Object.freeze([]),
  relays: Object.freeze([]),
  confirmations: Object.freeze([]),
});

const publicErrorMessages: Record<P2pErrorCode, string> = {
  ROOM_FULL: 'Room is full',
  FORBIDDEN: 'Operation is not permitted',
  SCREEN_SHARE_BUSY: 'Screen sharing is already owned',
  LEASE_LOST: 'Screen sharing lease was lost',
  INVALID_STATE: 'Operation is not valid in the current state',
  UNSUPPORTED_PROTOCOL: 'Protocol message is not supported',
  VALIDATION_ERROR: 'Request validation failed',
  INVALID_CREDENTIALS: 'Credentials are invalid',
  AUTH_REQUIRED: 'Authentication is required',
  ROOM_CODE_INVALID: 'Room code is invalid',
  ROOM_CODE_EXPIRED: 'Room code is invalid',
  ROOM_CLOSED: 'Room is closed',
  STALE_CONNECTION: 'Connection is no longer current',
  STALE_NEGOTIATION: 'Negotiation is no longer current',
  RATE_LIMITED: 'Too many requests',
  SIGNALING_UNAVAILABLE: 'Signaling is temporarily unavailable',
};

function normalizeError(error: unknown): SignalingHandlerError {
  if (error instanceof SignalingHandlerError) {
    return error;
  }
  if (error instanceof RoomDomainError) {
    switch (error.code) {
      case 'CAPACITY_EXCEEDED':
      case 'NOT_ROOM_MEMBER':
        return error.code === 'NOT_ROOM_MEMBER'
          ? new SignalingHandlerError('FORBIDDEN')
          : new SignalingHandlerError('SIGNALING_UNAVAILABLE', true);
      case 'ROOM_CODE_EXHAUSTED':
        return new SignalingHandlerError('SIGNALING_UNAVAILABLE', true);
      default:
        return new SignalingHandlerError(error.code);
    }
  }
  return new SignalingHandlerError('SIGNALING_UNAVAILABLE', true);
}

function effectsOf(
  effects: Partial<SignalingEffects> | undefined,
): SignalingEffects {
  if (effects === undefined) {
    return EMPTY_EFFECTS;
  }
  return Object.freeze({
    ...(Object.hasOwn(effects, 'binding') ? { binding: effects.binding } : {}),
    intents: Object.freeze([...(effects.intents ?? [])]),
    relays: Object.freeze([...(effects.relays ?? [])]),
    confirmations: Object.freeze([...(effects.confirmations ?? [])]),
  });
}

function createAck(
  request: P2pRequestEnvelope,
  payload: unknown,
): P2pAckEnvelope {
  return p2pAckEnvelopeSchema.parse({
    version: 1,
    requestId: request.requestId,
    type: `${request.type}.ack`,
    payload,
  });
}

export function createSignalingDispatcher(
  dependencies: SignalingDispatcherDependencies,
): SignalingDispatcher {
  return Object.freeze({
    dispatch(context: SignalingRequestContext, request: P2pRequestEnvelope) {
      try {
        const result =
          dependencies.roomHandler.handle(context, request) ??
          dependencies.webrtcHandler.handle(context, request);
        if (result === null) {
          throw new SignalingHandlerError('UNSUPPORTED_PROTOCOL');
        }
        return Object.freeze({
          response: createAck(request, { ok: true, data: result.data }),
          effects: effectsOf(result.effects),
        });
      } catch (error) {
        const normalized = normalizeError(error);
        if (
          normalized.code === 'SIGNALING_UNAVAILABLE' &&
          !(error instanceof SignalingHandlerError) &&
          !(error instanceof RoomDomainError)
        ) {
          try {
            dependencies.onInternalError?.(error, request.type);
          } catch {
            // Observability cannot replace the public normalized response.
          }
        }
        return Object.freeze({
          response: createAck(request, {
            ok: false,
            error: {
              code: normalized.code,
              message: publicErrorMessages[normalized.code],
              ...(normalized.retryable ? { retryable: true } : {}),
            },
          }),
          effects: EMPTY_EFFECTS,
        });
      }
    },
  });
}
