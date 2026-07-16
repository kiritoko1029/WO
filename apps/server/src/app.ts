import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { registerAuthentication } from './http/authenticate.ts';
import { registerErrorHandler } from './http/errors.ts';
import type { AccessTokenService } from './modules/auth/access-token.ts';
import {
  registerAuthRoutes,
  type AuthRateLimit,
} from './modules/auth/auth-routes.ts';
import type { AuthService } from './modules/auth/auth-service.ts';
import { registerHealthRoutes } from './modules/health/health-routes.ts';

const DEFAULT_BODY_LIMIT = 16 * 1_024;
const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = Object.freeze({
  max: 20,
  timeWindow: 60_000,
});

const DEFAULT_LOGGER = {
  level: 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'request.headers.authorization',
      'req.body',
      'request.body',
      'email',
      'password',
      'accessToken',
      'refreshToken',
      'tokenHash',
    ],
    censor: '[Redacted]',
  },
};

export interface AppDependencies {
  readonly authService: AuthService;
  readonly accessTokenService: AccessTokenService;
  readonly readinessCheck: () => Promise<void>;
  readonly logger?: FastifyServerOptions['logger'];
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  readonly authRateLimit?: AuthRateLimit;
  readonly bodyLimit?: number;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? DEFAULT_LOGGER,
    bodyLimit: dependencies.bodyLimit ?? DEFAULT_BODY_LIMIT,
    trustProxy: dependencies.trustProxy ?? false,
  });
  registerErrorHandler(app);
  registerAuthentication(app, dependencies.accessTokenService);
  await app.register(rateLimit, { global: false });
  registerHealthRoutes(app, {
    readinessCheck: dependencies.readinessCheck,
  });
  registerAuthRoutes(app, {
    authService: dependencies.authService,
    rateLimit: dependencies.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT,
  });
  return app;
}
