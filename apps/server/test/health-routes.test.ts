import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { APP_VERSION, SOURCE_REPOSITORY_URL } from '@wo/protocol';

import { registerErrorHandler } from '../src/http/errors.ts';
import { registerHealthRoutes } from '../src/modules/health/health-routes.ts';

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function createHealthApp(): FastifyInstance {
  const app = Fastify();
  registerErrorHandler(app);
  registerHealthRoutes(app, { readinessCheck: async () => undefined });
  openApps.push(app);
  return app;
}

describe('health routes', () => {
  test('live and ready report the release identity', async () => {
    const app = createHealthApp();

    const live = await app.inject({ method: 'GET', url: '/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({
      status: 'ok',
      version: APP_VERSION,
      source: SOURCE_REPOSITORY_URL,
    });

    const ready = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      version: APP_VERSION,
      source: SOURCE_REPOSITORY_URL,
    });
  });

  test('buildInfo override replaces the default identity', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    registerHealthRoutes(app, {
      readinessCheck: async () => undefined,
      buildInfo: { version: '9.9.9-test', source: 'https://example.com/src' },
    });
    openApps.push(app);

    const ready = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      version: '9.9.9-test',
      source: 'https://example.com/src',
    });
  });

  test('ready fails with SERVICE_UNAVAILABLE when the probe rejects', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    registerHealthRoutes(app, {
      readinessCheck: async () => {
        throw new Error('database password must not escape');
      },
    });
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/health/ready',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service is not ready',
      },
    });
  });
});
