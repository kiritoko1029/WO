import type { FastifyInstance } from 'fastify';
import {
  authLoginBodySchema,
  authLogoutBodySchema,
  authRefreshBodySchema,
  authRegisterBodySchema,
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

  app.post('/v1/auth/register', routeOptions, async (request, reply) => {
    const body = authRegisterBodySchema.parse(request.body);
    const response = await dependencies.authService.register(body);
    return reply.status(201).send(response);
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
}
