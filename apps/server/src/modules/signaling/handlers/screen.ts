import type { P2pRequestEnvelope } from '@wo/protocol';

import type { ScreenLeaseSnapshot } from '../../rooms/room-types.ts';
import type { ScreenLeaseRegistry } from '../../screen/screen-lease-registry.ts';
import {
  SignalingHandlerError,
  type SignalingHandlerResult,
  type SignalingRequestContext,
  type SignalingRequestHandler,
} from '../dispatcher.ts';

export interface ScreenRequestHandlerDependencies {
  readonly leases: ScreenLeaseRegistry;
}

function currentRoomInput(context: SignalingRequestContext, roomId: string) {
  const binding = context.binding;
  if (binding === null || binding.roomId !== roomId) {
    throw new SignalingHandlerError('STALE_CONNECTION');
  }
  return {
    roomId,
    userId: context.identity.userId,
    connectionId: context.connectionId,
    connectionEpoch: binding.connectionEpoch,
  } as const;
}

function publicLease(roomId: string, lease: ScreenLeaseSnapshot) {
  return Object.freeze({
    roomId,
    leaseId: lease.leaseId,
    holderId: lease.ownerUserId,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
  });
}

function resultWithIntents(
  data: unknown,
  intents: ReturnType<ScreenLeaseRegistry['acquire']>['intents'],
): SignalingHandlerResult {
  return { data, effects: { intents } };
}

export function createScreenRequestHandler(
  dependencies: ScreenRequestHandlerDependencies,
): SignalingRequestHandler {
  return Object.freeze({
    handle(
      context: SignalingRequestContext,
      request: P2pRequestEnvelope,
    ): SignalingHandlerResult | null {
      switch (request.type) {
        case 'screen.acquire': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.leases.acquire({
            ...current,
            requestId: request.requestId,
          });
          return resultWithIntents(
            { lease: publicLease(current.roomId, result.data.lease) },
            result.intents,
          );
        }
        case 'screen.renew': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.leases.renew({
            ...current,
            requestId: request.requestId,
            leaseId: request.payload.leaseId,
          });
          return resultWithIntents(
            { lease: publicLease(current.roomId, result.data.lease) },
            result.intents,
          );
        }
        case 'screen.release': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.leases.release({
            ...current,
            requestId: request.requestId,
            leaseId: request.payload.leaseId,
          });
          return resultWithIntents({}, result.intents);
        }
        case 'screen.bitrate': {
          const current = currentRoomInput(context, request.payload.roomId);
          const result = dependencies.leases.setBitrate({
            ...current,
            requestId: request.requestId,
            leaseId: request.payload.leaseId,
            bitrateBps: request.payload.bitrate,
          });
          return resultWithIntents(
            { bitrate: result.data.bitrateBps },
            result.intents,
          );
        }
        default:
          return null;
      }
    },
  });
}
