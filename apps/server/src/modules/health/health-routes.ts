import type { FastifyInstance } from 'fastify';

import { APP_VERSION, SOURCE_REPOSITORY_URL } from '@wo/protocol';

import { HttpError } from '../../http/errors.ts';

export interface HealthBuildInfo {
  readonly version: string;
  readonly source: string;
}

export interface HealthRouteDependencies {
  readonly readinessCheck: () => Promise<void>;
  readonly buildInfo?: HealthBuildInfo;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthRouteDependencies,
): void {
  const buildInfo = dependencies.buildInfo ?? {
    version: APP_VERSION,
    source: SOURCE_REPOSITORY_URL,
  };

  app.get('/v1/health/live', async () => ({
    status: 'ok' as const,
    version: buildInfo.version,
    source: buildInfo.source,
  }));

  app.get('/v1/health/ready', async () => {
    try {
      await dependencies.readinessCheck();
    } catch {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Service is not ready');
    }
    return {
      status: 'ready' as const,
      version: buildInfo.version,
      source: buildInfo.source,
    };
  });
}
