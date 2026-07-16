import type { FastifyInstance } from 'fastify';

import { HttpError } from '../../http/errors.ts';

export interface HealthRouteDependencies {
  readonly readinessCheck: () => Promise<void>;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthRouteDependencies,
): void {
  app.get('/v1/health/live', async () => ({ status: 'ok' as const }));

  app.get('/v1/health/ready', async () => {
    try {
      await dependencies.readinessCheck();
    } catch {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Service is not ready');
    }
    return { status: 'ready' as const };
  });
}
