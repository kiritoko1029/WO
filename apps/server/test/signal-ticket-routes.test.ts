import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HttpError, registerErrorHandler } from '../src/http/errors.ts';
import { registerSignalTicketRoutes } from '../src/modules/signaling/signal-ticket-routes.ts';
import { createSignalTicketStore } from '../src/modules/signaling/signal-ticket-store.ts';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const CREATED_AT = new Date('2026-07-16T00:00:00.000Z');
const ACCESS_TOKEN_EXPIRES_AT_SECONDS = 1_784_246_400;

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

interface RouteHarnessOptions {
  readonly user: null | Readonly<{
    id: string;
    displayName: string;
    disabledAt: Date | null;
  }>;
  readonly ticketCapacity?: number;
  readonly maxCollisionAttempts?: number;
  readonly prefillTicket?: boolean;
  readonly rateLimited?: boolean;
}

async function createHarness(options: RouteHarnessOptions) {
  const app = Fastify({ logger: false });
  openApps.push(app);
  registerErrorHandler(app);
  app.decorateRequest('authIdentity', null);
  let authenticateCalls = 0;
  app.decorate('authenticate', async (request) => {
    authenticateCalls += 1;
    if (request.headers.authorization !== 'Bearer valid-access-token') {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    request.authIdentity = {
      userId: USER_ID,
      sessionId: SESSION_ID,
      accessTokenExpiresAtSeconds: ACCESS_TOKEN_EXPIRES_AT_SECONDS,
    };
  });

  const ticketStore = createSignalTicketStore({
    now: () => CREATED_AT.getTime(),
    randomBytes: () => new Uint8Array(32).fill(7),
    maxEntries: options.ticketCapacity,
    maxCollisionAttempts: options.maxCollisionAttempts,
  });
  if (options.prefillTicket === true) {
    ticketStore.issue({
      userId: USER_ID,
      sessionId: SESSION_ID,
      displayName: 'Existing ticket',
      accessTokenExpiresAtSeconds: ACCESS_TOKEN_EXPIRES_AT_SECONDS,
    });
  }
  const lookedUpUserIds: string[] = [];
  const consumeTicketAttempt = vi.fn(() =>
    options.rateLimited === true
      ? { allowed: false, remaining: 0, retryAfterMs: 1_000 }
      : { allowed: true, remaining: 59, retryAfterMs: 0 },
  );
  registerSignalTicketRoutes(app, {
    identityRepository: {
      async findEmailUserById(userId) {
        lookedUpUserIds.push(userId);
        return options.user === null
          ? null
          : {
              emailNormalized: 'person@example.com',
              user: {
                id: options.user.id,
                displayName: options.user.displayName,
                createdAt: CREATED_AT,
                disabledAt: options.user.disabledAt,
              },
            };
      },
    },
    ticketStore,
    rateLimiter: { consume: consumeTicketAttempt },
  });
  await app.ready();
  return {
    app,
    ticketStore,
    lookedUpUserIds,
    authenticateCalls: () => authenticateCalls,
    consumeTicketAttempt,
  };
}

describe('POST /v1/realtime/ticket', () => {
  test('authenticates, reloads the trusted display name, and returns only the ticket', async () => {
    const harness = await createHarness({
      user: {
        id: USER_ID,
        displayName: 'Trusted database name',
        disabledAt: null,
      },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { authorization: 'Bearer valid-access-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresInSeconds: 30,
    });
    expect(Object.keys(response.json())).toEqual([
      'ticket',
      'expiresInSeconds',
    ]);
    expect(harness.authenticateCalls()).toBe(1);
    expect(harness.lookedUpUserIds).toEqual([USER_ID]);
    expect(harness.ticketStore.consume(response.json().ticket)).toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      displayName: 'Trusted database name',
      accessTokenExpiresAtSeconds: ACCESS_TOKEN_EXPIRES_AT_SECONDS,
    });
  });

  test('requires bearer authentication before doing an identity lookup', async () => {
    const harness = await createHarness({
      user: { id: USER_ID, displayName: 'Person', disabledAt: null },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication is required',
      },
    });
    expect(harness.lookedUpUserIds).toEqual([]);
  });

  test('rate limits an authenticated user and IP before identity lookup', async () => {
    const harness = await createHarness({
      user: { id: USER_ID, displayName: 'Person', disabledAt: null },
      rateLimited: true,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      remoteAddress: '203.0.113.10',
      headers: { authorization: 'Bearer valid-access-token' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect(harness.consumeTicketAttempt).toHaveBeenCalledWith({
      userId: USER_ID,
      remoteIp: '203.0.113.10',
      requestId: 'signal-ticket',
    });
    expect(harness.lookedUpUserIds).toEqual([]);
    expect(harness.ticketStore.stats().size).toBe(0);
  });

  test.each([
    ['capacity', { ticketCapacity: 1 }],
    ['collision', { ticketCapacity: 2, maxCollisionAttempts: 1 }],
  ] as const)(
    'maps ticket %s failures to a generic service-unavailable response',
    async (_name, storeOptions) => {
      const harness = await createHarness({
        user: { id: USER_ID, displayName: 'Person', disabledAt: null },
        ...storeOptions,
        prefillTicket: true,
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/realtime/ticket',
        headers: { authorization: 'Bearer valid-access-token' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Signaling is temporarily unavailable',
        },
      });
      expect(response.body).not.toMatch(/capacity|collision|random/iu);
    },
  );

  test('rejects a nonempty request body before doing an identity lookup', async () => {
    const harness = await createHarness({
      user: { id: USER_ID, displayName: 'Person', disabledAt: null },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { authorization: 'Bearer valid-access-token' },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
      },
    });
    expect(harness.lookedUpUserIds).toEqual([]);
    expect(harness.ticketStore.stats().size).toBe(0);
  });

  test.each([
    ['missing', null],
    [
      'disabled',
      { id: USER_ID, displayName: 'Person', disabledAt: CREATED_AT },
    ],
    [
      'mismatched',
      {
        id: '00000000-0000-4000-8000-000000000099',
        displayName: 'Person',
        disabledAt: null,
      },
    ],
  ] as const)(
    'maps a %s identity to the same AUTH_REQUIRED response',
    async (_name, user) => {
      const harness = await createHarness({ user });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/realtime/ticket',
        headers: { authorization: 'Bearer valid-access-token' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication is required',
        },
      });
      expect(harness.ticketStore.stats().size).toBe(0);
    },
  );
});
