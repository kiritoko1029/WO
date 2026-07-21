import {
  authLoginResponseSchema,
  authLogoutResponseSchema,
  authRefreshResponseSchema,
  authRegisterResponseSchema,
} from '@wo/protocol';
import {
  createDatabaseClient,
  createIdentityRepository,
  createSessionRepository,
  migrateDatabase,
  SessionRepositoryError,
  type DatabaseClient,
  type IdentityRepository,
  type SessionRepository,
} from '@wo/database';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import { createApp } from '../src/app.ts';
import { createAccessTokenService } from '../src/modules/auth/access-token.ts';
import {
  createAuthService,
  type AuthService,
} from '../src/modules/auth/auth-service.ts';
import { hashPassword } from '../src/modules/auth/password.ts';

const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for server integration tests');
}

const JWT_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 32),
).toString('base64url');
const PUBLIC_URL = 'https://rtc.example.test/';
const LOGIN_RACE_USER_ID = '00000000-0000-4000-8000-000000000099';
function asAuthenticated<T extends { status?: string }>(response: T): Exclude<T, { status: 'verification_required' }> {
  if ('status' in response && response.status === 'verification_required') {
    throw new Error('expected authenticated response');
  }
  return response as Exclude<T, { status: 'verification_required' }>;
}

const defaultEmailDeps = {
  emailPolicy: {
    domainAllowlist: [] as const,
    verificationRequired: false,
    codeTtlSeconds: 600,
  },
  emailDelivery: {
    async send() {
      // no-op in integration tests
    },
  },
};

describe('HTTP email/password authentication', () => {
  let client: DatabaseClient;
  let identityRepository: IdentityRepository;
  let authService: AuthService;
  let app: FastifyInstance | undefined;
  let dummyPasswordHash: string;

  beforeAll(async () => {
    client = createDatabaseClient(databaseUrl, { maxConnections: 8 });
    await migrateDatabase(client);
    dummyPasswordHash = await hashPassword('dummy password value');
  });

  beforeEach(async () => {
    await client.sql`TRUNCATE TABLE users CASCADE`;
    identityRepository = createIdentityRepository(client);
    const sessionRepository = createSessionRepository(client);
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: PUBLIC_URL,
    });
    authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService,
      dummyPasswordHash,
      ...defaultEmailDeps,
    });
    app = await createApp({
      authService,
      accessTokenService,
      readinessCheck: async () => {
        await client.sql`SELECT 1`;
      },
      logger: false,
      authRateLimit: { max: 100, timeWindow: 60_000 },
      bodyLimit: 2_048,
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await client.close();
  });

  test('reports live independently and ready only after the database probe', async () => {
    const live = await app!.inject({ method: 'GET', url: '/v1/health/live' });
    const ready = await app!.inject({ method: 'GET', url: '/v1/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });

    const unavailable = await createApp({
      authService: {} as never,
      accessTokenService: {} as never,
      readinessCheck: async () => {
        throw new Error('database password must not escape');
      },
      logger: false,
    });
    try {
      const response = await unavailable.inject({
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
      expect(response.body).not.toContain('database password');
    } finally {
      await unavailable.close();
    }
  });

  test('registers and logs in using a canonical email without storing plaintext', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: '  Person@Example.COM ',
        password: 'correct horse battery staple',
        displayName: ' Person ',
      },
    });

    expect(registration.statusCode).toBe(201);
    const registered = authRegisterResponseSchema.parse(registration.json());
    expect(asAuthenticated(registered).user).toMatchObject({
      email: 'person@example.com',
      displayName: 'Person',
    });
    const [stored] = await client.sql<
      { identifier_normalized: string; password_hash: string }[]
    >`
      SELECT i.identifier_normalized, p.password_hash
      FROM auth_identities i
      JOIN password_credentials p ON p.user_id = i.user_id
    `;
    expect(stored?.identifier_normalized).toBe('person@example.com');
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/u);
    expect(stored?.password_hash).not.toContain('correct horse');

    const login = await app!.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'PERSON@example.com',
        password: 'correct horse battery staple',
      },
    });
    expect(login.statusCode).toBe(200);
    expect(authLoginResponseSchema.parse(login.json()).user).toEqual(
      asAuthenticated(registered).user,
    );
  });

  test('returns a conflict for duplicate normalized registration', async () => {
    const payload = {
      email: 'person@example.com',
      password: 'correct horse battery staple',
      displayName: 'Person',
    };
    expect(
      (await app!.inject({ method: 'POST', url: '/v1/auth/register', payload }))
        .statusCode,
    ).toBe(201);

    const duplicate = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...payload, email: ' PERSON@EXAMPLE.COM ' },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: {
        code: 'INVALID_STATE',
        message: 'Email is already registered',
      },
    });
  });

  test('uses the same response for missing, wrong-password, and disabled accounts', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      },
    });
    const registered = authRegisterResponseSchema.parse(registration.json());
    await identityRepository.disableUser(asAuthenticated(registered).user.userId);

    const attempts = [
      { email: 'missing@example.com', password: 'wrong password value' },
      { email: 'person@example.com', password: 'wrong password value' },
      {
        email: 'person@example.com',
        password: 'correct horse battery staple',
      },
    ];
    const responses = await Promise.all(
      attempts.map((payload) =>
        app!.inject({ method: 'POST', url: '/v1/auth/login', payload }),
      ),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      401, 401, 401,
    ]);
    expect(responses.map(({ body }) => body)).toEqual([
      responses[0]!.body,
      responses[0]!.body,
      responses[0]!.body,
    ]);
    expect(responses[0]!.json()).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
    });
  });

  test.each(['USER_DISABLED', 'USER_NOT_FOUND'] as const)(
    'maps login session race %s to one generic 401 response',
    async (code) => {
      await identityRepository.createEmailUser({
        userId: LOGIN_RACE_USER_ID,
        emailNormalized: 'race@example.com',
        displayName: 'Race',
        passwordHash: await hashPassword('correct horse battery staple'),
      });
      const repositoryError = new SessionRepositoryError(code);
      const realSessionRepository = createSessionRepository(client);
      const failingSessionRepository: SessionRepository = {
        ...realSessionRepository,
        async createRefreshSession() {
          throw repositoryError;
        },
      };
      const accessTokenService = createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: PUBLIC_URL,
      });
      await app!.close();
      app = await createApp({
        authService: createAuthService({
          identityRepository,
          sessionRepository: failingSessionRepository,
          accessTokenService,
          dummyPasswordHash,
      ...defaultEmailDeps,
        }),
        accessTokenService,
        readinessCheck: async () => undefined,
        logger: false,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'race@example.com',
          password: 'correct horse battery staple',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
      expect(response.body).not.toContain(repositoryError.code);
      expect(response.body).not.toContain(repositoryError.message);
    },
  );

  test('maps a real user-disable race to 401 without persisting a refresh session', async () => {
    await identityRepository.createEmailUser({
      userId: LOGIN_RACE_USER_ID,
      emailNormalized: 'barrier@example.com',
      displayName: 'Barrier',
      passwordHash: await hashPassword('correct horse battery staple'),
    });
    const racingIdentityRepository: IdentityRepository = {
      ...identityRepository,
      async findEmailCredential(emailNormalized) {
        const credential =
          await identityRepository.findEmailCredential(emailNormalized);
        if (credential !== null) {
          await identityRepository.disableUser(credential.user.id);
        }
        return credential;
      },
    };
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: PUBLIC_URL,
    });
    await app!.close();
    app = await createApp({
      authService: createAuthService({
        identityRepository: racingIdentityRepository,
        sessionRepository: createSessionRepository(client),
        accessTokenService,
        dummyPasswordHash,
      ...defaultEmailDeps,
      }),
      accessTokenService,
      readinessCheck: async () => undefined,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'barrier@example.com',
        password: 'correct horse battery staple',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
    });
    const [{ count }] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM refresh_sessions
    `;
    expect(count).toBe(0);
  });

  test('rotates refresh tokens and reuse revokes the replacement', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      },
    });
    const registered = authRegisterResponseSchema.parse(registration.json());
    const rotation = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: asAuthenticated(registered).refreshToken },
    });
    expect(rotation.statusCode).toBe(200);
    const refreshed = authRefreshResponseSchema.parse(rotation.json());
    expect(refreshed.refreshToken).not.toBe(asAuthenticated(registered).refreshToken);

    const reuse = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: asAuthenticated(registered).refreshToken },
    });
    const replacementAfterReuse = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refreshed.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(replacementAfterReuse.statusCode).toBe(401);
    expect(reuse.body).toBe(replacementAfterReuse.body);
  });

  test('logs out idempotently and prevents future refresh', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      },
    });
    const registered = authRegisterResponseSchema.parse(registration.json());
    const payload = { refreshToken: asAuthenticated(registered).refreshToken };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const logout = await app!.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload,
      });
      expect(logout.statusCode).toBe(200);
      expect(authLogoutResponseSchema.parse(logout.json())).toEqual({
        loggedOut: true,
      });
    }
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload,
        })
      ).statusCode,
    ).toBe(401);
  });

  test('maps refresh and logout persistence failures to one safe 500 response', async () => {
    await app!.close();
    const repositoryError = new SessionRepositoryError(
      'REFRESH_SESSION_PERSISTENCE_ERROR',
    );
    const failingSessionRepository: SessionRepository = {
      async createRefreshSession() {
        throw repositoryError;
      },
      async rotateRefreshSession() {
        throw repositoryError;
      },
      async findRefreshSessionUserId() {
        throw repositoryError;
      },
      async revokeRefreshTokenFamily() {
        throw repositoryError;
      },
      async listActiveSessionSummaries() {
        throw repositoryError;
      },
      async revokeAllSessionsForUser() {
        throw repositoryError;
      },
    };
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: PUBLIC_URL,
    });
    app = await createApp({
      authService: createAuthService({
        identityRepository,
        sessionRepository: failingSessionRepository,
        accessTokenService,
        dummyPasswordHash,
      ...defaultEmailDeps,
      }),
      accessTokenService,
      readinessCheck: async () => undefined,
      logger: false,
    });
    const sensitiveToken = 'sensitive-refresh-token-that-must-not-escape';

    const responses = await Promise.all(
      ['/v1/auth/refresh', '/v1/auth/logout'].map((url) =>
        app!.inject({
          method: 'POST',
          url,
          payload: { refreshToken: sensitiveToken },
        }),
      ),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([500, 500]);
    for (const response of responses) {
      expect(response.json()).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
      expect(response.body).not.toContain(sensitiveToken);
      expect(response.body).not.toContain(repositoryError.code);
      expect(response.body).not.toContain(repositoryError.message);
    }
  });

  test.each([
    ['plain object', {}],
    ['object with forged Error toStringTag', { [Symbol.toStringTag]: 'Error' }],
  ])(
    'maps a %s with copied repository fields to one safe 500 response',
    async (_kind, extra) => {
      await app!.close();
      const forgedError = {
        ...extra,
        name: 'SessionRepositoryError',
        code: 'REFRESH_SESSION_NOT_FOUND',
      };
      const failingSessionRepository: SessionRepository = {
        async createRefreshSession() {
          throw forgedError;
        },
        async rotateRefreshSession() {
          throw forgedError;
        },
        async findRefreshSessionUserId() {
          throw forgedError;
        },
        async revokeRefreshTokenFamily() {
          throw forgedError;
        },
        async listActiveSessionSummaries() {
          throw forgedError;
        },
        async revokeAllSessionsForUser() {
          throw forgedError;
        },
      };
      const accessTokenService = createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: PUBLIC_URL,
      });
      app = await createApp({
        authService: createAuthService({
          identityRepository,
          sessionRepository: failingSessionRepository,
          accessTokenService,
          dummyPasswordHash,
      ...defaultEmailDeps,
        }),
        accessTokenService,
        readinessCheck: async () => undefined,
        logger: false,
      });

      const responses = await Promise.all(
        ['/v1/auth/refresh', '/v1/auth/logout'].map((url) =>
          app!.inject({
            method: 'POST',
            url,
            payload: { refreshToken: 'opaque-refresh-token' },
          }),
        ),
      );

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([500, 500]);
      for (const response of responses) {
        expect(response.json()).toEqual({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          },
        });
        expect(response.body).not.toContain(forgedError.name);
        expect(response.body).not.toContain(forgedError.code);
      }
    },
  );

  test('refreshes after service reconstruction and rejects a subsequently disabled user generically', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      },
    });
    const registered = authRegisterResponseSchema.parse(registration.json());

    await app!.close();
    identityRepository = createIdentityRepository(client);
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: PUBLIC_URL,
    });
    authService = createAuthService({
      identityRepository,
      sessionRepository: createSessionRepository(client),
      accessTokenService,
      dummyPasswordHash,
      ...defaultEmailDeps,
    });
    app = await createApp({
      authService,
      accessTokenService,
      readinessCheck: async () => undefined,
      logger: false,
    });

    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: asAuthenticated(registered).refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const refreshed = authRefreshResponseSchema.parse(refresh.json());
    expect(refreshed.user).toEqual(asAuthenticated(registered).user);

    await identityRepository.disableUser(asAuthenticated(registered).user.userId);
    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refreshed.refreshToken },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication is required',
      },
    });
  });

  test('derives protected identity only from a verified bearer token', async () => {
    app!.post(
      '/test/protected',
      { preHandler: app!.authenticate },
      async (request) => ({ identity: request.authIdentity }),
    );
    const registered = authRegisterResponseSchema.parse(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: 'person@example.com',
            password: 'correct horse battery staple',
            displayName: 'Person',
          },
        })
      ).json(),
    );

    const protectedResponse = await app!.inject({
      method: 'POST',
      url: '/test/protected',
      headers: { authorization: `Bearer ${asAuthenticated(registered).accessToken}` },
      payload: { userId: 'attacker', sessionId: 'attacker-session' },
    });
    expect(protectedResponse.statusCode).toBe(200);
    expect(protectedResponse.json()).toEqual({
      identity: {
        userId: asAuthenticated(registered).user.userId,
        sessionId: expect.any(String),
        accessTokenExpiresAtSeconds: expect.any(Number),
      },
    });

    const missing = await app!.inject({
      method: 'POST',
      url: '/test/protected',
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' },
    });
  });

  test('enforces strict JSON bodies, content type, syntax, and size without echoing input', async () => {
    const sensitive = 'sensitive.person@example.com';
    const cases = [
      await app!.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: sensitive,
          password: 'correct horse battery staple',
          displayName: 'Person',
          admin: true,
        },
      }),
      await app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: `{"email":"${sensitive}",`,
      }),
      await app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'text/plain' },
        payload: sensitive,
      }),
      await app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: sensitive,
          password: `valid-prefix-${'x'.repeat(4_096)}`,
        },
      }),
    ];

    expect(cases.map(({ statusCode }) => statusCode)).toEqual([
      400, 400, 415, 413,
    ]);
    for (const response of cases) {
      expect(response.json()).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
        },
      });
      expect(response.body).not.toContain(sensitive);
      expect(response.body).not.toContain('valid-prefix');
    }
  });

  test('rate limits authentication by remote IP without limiting another IP', async () => {
    await app!.close();
    app = await createApp({
      authService: createAuthService({
        identityRepository,
        sessionRepository: createSessionRepository(client),
        accessTokenService: createAccessTokenService({
          jwtAccessSecret: JWT_SECRET,
          issuer: PUBLIC_URL,
        }),
        dummyPasswordHash,
      ...defaultEmailDeps,
      }),
      accessTokenService: createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: PUBLIC_URL,
      }),
      readinessCheck: async () => undefined,
      authRateLimit: { max: 2, timeWindow: 60_000 },
      logger: false,
    });
    const request = (remoteAddress: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress,
        payload: {
          email: 'missing@example.com',
          password: 'wrong password value',
        },
      });

    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.10')).statusCode).toBe(401);
    const limited = await request('203.0.113.10');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect((await request('203.0.113.11')).statusCode).toBe(401);
  });

  test('trusts exactly one reverse-proxy hop when rate limiting authentication', async () => {
    await app!.close();
    app = await createApp({
      authService,
      accessTokenService: createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: PUBLIC_URL,
      }),
      readinessCheck: async () => undefined,
      authRateLimit: { max: 1, timeWindow: 60_000 },
      logger: false,
      trustProxy: 1,
    });
    const request = (forwardedFor: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': forwardedFor },
        payload: {
          email: 'missing@example.com',
          password: 'wrong password value',
        },
      });

    expect((await request('203.0.113.20')).statusCode).toBe(401);
    expect((await request('203.0.113.20')).statusCode).toBe(429);
    expect((await request('203.0.113.21')).statusCode).toBe(401);
  });

  test('ignores forged forwarded addresses when no reverse proxy is trusted', async () => {
    await app!.close();
    app = await createApp({
      authService,
      accessTokenService: createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: PUBLIC_URL,
      }),
      readinessCheck: async () => undefined,
      authRateLimit: { max: 1, timeWindow: 60_000 },
      logger: false,
    });
    const request = (forwardedFor: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: '203.0.113.30',
        headers: { 'x-forwarded-for': forwardedFor },
        payload: {
          email: 'missing@example.com',
          password: 'wrong password value',
        },
      });

    expect((await request('203.0.113.31')).statusCode).toBe(401);
    expect((await request('203.0.113.32')).statusCode).toBe(429);
  });
});
