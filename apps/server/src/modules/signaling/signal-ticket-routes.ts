import type { FastifyInstance } from 'fastify';
import type { IdentityRepository } from '@wo/database';
import { signalTicketResponseSchema } from '@wo/protocol';

import { HttpError } from '../../http/errors.ts';
import type { JoinAttemptLimiter } from '../rooms/join-attempt-limiter.ts';
import {
  SIGNAL_TICKET_EXPIRES_IN_SECONDS,
  SignalTicketStoreError,
  type SignalTicketStore,
} from './signal-ticket-store.ts';

export interface SignalTicketRouteDependencies {
  readonly identityRepository: Pick<IdentityRepository, 'findEmailUserById'>;
  readonly ticketStore: SignalTicketStore;
  readonly rateLimiter?: Pick<JoinAttemptLimiter, 'consume'>;
}

const authenticationRequired = (): HttpError =>
  new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');

const rejectNonemptyBody = async (request: {
  readonly body: unknown;
}): Promise<void> => {
  if (request.body !== undefined) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
};

export function registerSignalTicketRoutes(
  app: FastifyInstance,
  dependencies: SignalTicketRouteDependencies,
): void {
  app.post(
    '/v1/realtime/ticket',
    { preHandler: [app.authenticate, rejectNonemptyBody] },
    async (request, reply) => {
      const authIdentity = request.authIdentity;
      if (authIdentity === null) {
        throw authenticationRequired();
      }
      const rateLimit = dependencies.rateLimiter?.consume({
        userId: authIdentity.userId,
        remoteIp: request.ip,
        requestId: 'signal-ticket',
      });
      if (rateLimit?.allowed === false) {
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests');
      }

      const identity = await dependencies.identityRepository.findEmailUserById(
        authIdentity.userId,
      );
      if (
        identity === null ||
        identity.user.id !== authIdentity.userId ||
        identity.user.disabledAt !== null
      ) {
        throw authenticationRequired();
      }

      let issued;
      try {
        issued = dependencies.ticketStore.issue({
          userId: authIdentity.userId,
          sessionId: authIdentity.sessionId,
          displayName: identity.user.displayName,
          accessTokenExpiresAtSeconds: authIdentity.accessTokenExpiresAtSeconds,
        });
      } catch (error) {
        if (error instanceof SignalTicketStoreError) {
          throw new HttpError(
            503,
            'SERVICE_UNAVAILABLE',
            'Signaling is temporarily unavailable',
          );
        }
        throw error;
      }
      return reply.header('Cache-Control', 'no-store').send(
        signalTicketResponseSchema.parse({
          ticket: issued.value,
          expiresInSeconds: SIGNAL_TICKET_EXPIRES_IN_SECONDS,
        }),
      );
    },
  );
}
