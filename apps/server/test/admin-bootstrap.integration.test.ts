import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import {
  createAdminBootstrapRepository,
  createDatabaseClient,
  createIdentityRepository,
  createSessionRepository,
  migrateDatabase,
  type DatabaseClient,
} from '@wo/database';
import { createApp } from '../src/app.ts';
import { bootstrapAdmin } from '../src/modules/admin/bootstrap-admin.ts';
import { createAccessTokenService } from '../src/modules/auth/access-token.ts';
import { createAuthService } from '../src/modules/auth/auth-service.ts';
import { hashPassword } from '../src/modules/auth/password.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('TEST_DATABASE_URL is required for server integration tests');
const initialPassword = 'initial-admin-password';
const changedPassword = 'changed-admin-password';

describe('bootstrap account lifecycle', () => {
  let client: DatabaseClient;
  beforeAll(async () => {
    client = createDatabaseClient(databaseUrl);
    await migrateDatabase(client);
  });
  beforeEach(async () => {
    await client.sql`TRUNCATE TABLE users CASCADE`;
  });
  afterAll(async () => {
    await client.close();
  });

  async function setup() {
    const identities = createIdentityRepository(client);
    const bootstrap = await bootstrapAdmin(
      { email: 'admin@example.com', password: initialPassword },
      createAdminBootstrapRepository(client),
    );
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: Buffer.alloc(32, 9).toString('base64url'),
      issuer: 'https://wo.example.com',
    });
    const delivered: string[] = [];
    const authService = createAuthService({
      identityRepository: identities,
      sessionRepository: createSessionRepository(client),
      accessTokenService,
      dummyPasswordHash: await hashPassword('dummy-password-value'),
      protectedEmailUserIds: [bootstrap.userId],
      emailPolicy: {
        domainAllowlist: [],
        verificationRequired: true,
        codeTtlSeconds: 600,
      },
      emailDelivery: {
        send: async (message) => {
          delivered.push(message.text);
        },
      },
    });
    const app = await createApp({
      authService,
      accessTokenService,
      readinessCheck: async () => undefined,
      logger: false,
    });
    return { identities, bootstrap, authService, app, delivered };
  }

  test('logs in verified administrator, permits password changes, and blocks both email-change stages', async () => {
    const { identities, bootstrap, authService, app, delivered } =
      await setup();
    try {
      const login = await authService.login({
        email: 'admin@example.com',
        password: initialPassword,
      });
      await authService.changePassword(bootstrap.userId, {
        currentPassword: initialPassword,
        newPassword: changedPassword,
      });
      await bootstrapAdmin(
        { email: 'admin@example.com', password: initialPassword },
        createAdminBootstrapRepository(client),
      );
      await expect(
        authService.login({
          email: 'admin@example.com',
          password: initialPassword,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(
        (
          await authService.login({
            email: 'admin@example.com',
            password: changedPassword,
          })
        ).user.userId,
      ).toBe(bootstrap.userId);
      await identities.replaceEmailVerificationChallenge({
        challengeId: randomUUID(),
        userId: bootstrap.userId,
        emailNormalized: 'new@example.com',
        purpose: 'rebind',
        codeHash: createHash('sha256').update('123456').digest('hex'),
        expiresAt: new Date(Date.now() + 600_000),
      });
      for (const [path, payload] of [
        ['request', { newEmail: 'new@example.com', password: changedPassword }],
        ['confirm', { newEmail: 'new@example.com', code: '123456' }],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/auth/email/change/${path}`,
          headers: { authorization: `Bearer ${login.accessToken}` },
          payload,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error).toMatchObject({
          code: 'INVALID_STATE',
          message: expect.stringContaining('administrator email is fixed'),
        });
      }
      expect(
        (await identities.findEmailUserById(bootstrap.userId))?.emailNormalized,
      ).toBe('admin@example.com');
      expect(
        await identities.findLatestEmailVerificationChallenge(
          bootstrap.userId,
          'rebind',
        ),
      ).not.toBeNull();
      expect(delivered).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test('ordinary members can still request and confirm email changes', async () => {
    const { identities, authService, app, delivered } = await setup();
    try {
      const userId = randomUUID();
      await identities.createEmailUser({
        userId,
        emailNormalized: 'member@example.com',
        displayName: 'Member',
        passwordHash: await hashPassword(initialPassword),
      });
      await identities.markEmailVerified(userId);
      await authService.requestEmailChange(userId, {
        newEmail: 'changed@example.com',
        password: initialPassword,
      });
      const code = delivered[0]?.match(/\b\d{6}\b/u)?.[0];
      expect(code).toBeDefined();
      const result = await authService.confirmEmailChange(userId, {
        newEmail: 'changed@example.com',
        code: code!,
      });
      expect(result.user.email).toBe('changed@example.com');
      expect(
        await identities.findEmailCredential('member@example.com'),
      ).toBeNull();
      expect(
        (await identities.findEmailCredential('changed@example.com'))?.user.id,
      ).toBe(userId);
    } finally {
      await app.close();
    }
  });
});
