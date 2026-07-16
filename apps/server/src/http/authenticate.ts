import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AccessTokenService } from '../modules/auth/access-token.ts';
import { HttpError } from './errors.ts';

export interface TrustedRequestIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authIdentity: TrustedRequestIdentity | null;
  }

  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
}

export function registerAuthentication(
  app: FastifyInstance,
  accessTokenService: AccessTokenService,
): void {
  app.decorateRequest('authIdentity', null);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string'
        ? /^Bearer ([^\s]+)$/u.exec(authorization)
        : null;
    if (!match) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    try {
      const identity = await accessTokenService.verify(match[1]!);
      request.authIdentity = {
        userId: identity.userId,
        sessionId: identity.sessionId,
      };
    } catch {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
  });
}
