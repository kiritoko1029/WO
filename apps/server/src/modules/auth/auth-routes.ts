import type { FastifyInstance } from 'fastify';
import {
  authChangePasswordBodySchema,
  authConfirmEmailChangeBodySchema,
  authLoginBodySchema,
  authLogoutBodySchema,
  authRefreshBodySchema,
  authRegisterBodySchema,
  authRequestEmailChangeBodySchema,
  authResendVerificationBodySchema,
  authVerifyEmailBodySchema,
} from '@wo/protocol';

import type { AuthService } from './auth-service.ts';
import { HttpError } from '../../http/errors.ts';

export interface AuthRateLimit {
  readonly max: number;
  readonly timeWindow: number;
}

export interface AuthRouteDependencies {
  readonly authService: AuthService;
  readonly rateLimit: AuthRateLimit;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const routeConfig = {
    rateLimit: {
      max: dependencies.rateLimit.max,
      timeWindow: dependencies.rateLimit.timeWindow,
    },
  };
  const requireJson = async (request: {
    headers: Record<string, unknown>;
  }): Promise<void> => {
    const contentType = request.headers['content-type'];
    const mediaType =
      typeof contentType === 'string'
        ? contentType.split(';', 1)[0]!.trim().toLowerCase()
        : '';
    if (mediaType !== 'application/json') {
      throw new HttpError(415, 'VALIDATION_ERROR', 'Request validation failed');
    }
  };
  const routeOptions = { config: routeConfig, onRequest: requireJson };
  const authenticatedRouteOptions = {
    ...routeOptions,
    preHandler: app.authenticate,
  };

  app.post('/v1/auth/register', routeOptions, async (request, reply) => {
    const body = authRegisterBodySchema.parse(request.body);
    const response = await dependencies.authService.register(body);
    const status =
      'status' in response && response.status === 'verification_required'
        ? 202
        : 201;
    return reply.status(status).send(response);
  });

  app.post('/v1/auth/login', routeOptions, async (request) => {
    const body = authLoginBodySchema.parse(request.body);
    return dependencies.authService.login(body);
  });

  app.post('/v1/auth/refresh', routeOptions, async (request) => {
    const body = authRefreshBodySchema.parse(request.body);
    return dependencies.authService.refresh(body);
  });

  app.post('/v1/auth/logout', routeOptions, async (request) => {
    const body = authLogoutBodySchema.parse(request.body);
    return dependencies.authService.logout(body);
  });

  app.post('/v1/auth/email/verify', routeOptions, async (request) => {
    const body = authVerifyEmailBodySchema.parse(request.body);
    return dependencies.authService.verifyEmail(body);
  });

  app.post('/v1/auth/email/resend', routeOptions, async (request) => {
    const body = authResendVerificationBodySchema.parse(request.body);
    return dependencies.authService.resendVerification(body);
  });

  app.post(
    '/v1/auth/password',
    authenticatedRouteOptions,
    async (request) => {
      const identity = request.authIdentity;
      if (identity === null) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }
      const body = authChangePasswordBodySchema.parse(request.body);
      return dependencies.authService.changePassword(identity.userId, body);
    },
  );

  app.post(
    '/v1/auth/email/change/request',
    authenticatedRouteOptions,
    async (request) => {
      const identity = request.authIdentity;
      if (identity === null) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }
      const body = authRequestEmailChangeBodySchema.parse(request.body);
      return dependencies.authService.requestEmailChange(identity.userId, body);
    },
  );

  app.post(
    '/v1/auth/email/change/confirm',
    authenticatedRouteOptions,
    async (request) => {
      const identity = request.authIdentity;
      if (identity === null) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }
      const body = authConfirmEmailChangeBodySchema.parse(request.body);
      return dependencies.authService.confirmEmailChange(identity.userId, body);
    },
  );
}
