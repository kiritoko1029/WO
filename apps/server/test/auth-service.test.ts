import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import {
  IdentityRepositoryError,
  SessionRepositoryError,
  parseRefreshTokenHash,
  type CreateEmailUserInput,
  type CreateEmailUserWithRefreshSessionInput,
  type CreateRefreshSessionInput,
  type EmailCredentialRecord,
  type EmailUserRecord,
  type IdentityRepository,
  type RefreshSessionRecord,
  type RefreshTokenFamilyRevocationRecord,
  type RevokeRefreshTokenFamilyInput,
  type RotateRefreshSessionInput,
  type SessionRepository,
  type SessionRepositoryErrorCode,
  type UserRecord,
} from '@wo/database';
import { decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  createAccessTokenService,
  type AccessTokenService,
} from '../src/modules/auth/access-token.ts';
import {
  AuthServiceError,
  createAuthService,
  type AuthService,
} from '../src/modules/auth/auth-service.ts';
import { hashPassword } from '../src/modules/auth/password.ts';
import {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_LIFETIME_MILLISECONDS,
  generateRefreshToken,
  hashRefreshToken,
} from '../src/modules/auth/refresh-token.ts';

const NOW = new Date('2026-07-16T00:00:00.000Z');
const ISSUER = 'https://rtc.example.test/';
const JWT_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
).toString('base64url');
const USER_ID = '00000000-0000-4000-8000-000000000001';
const INITIAL_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const INITIAL_FAMILY_ID = '00000000-0000-4000-8000-000000000004';

function createUuidSequence(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  };
}

class MemoryIdentityRepository implements IdentityRepository {
  readonly credentials = new Map<string, EmailCredentialRecord>();
  readonly challenges = new Map<
    string,
    {
      id: string;
      userId: string;
      emailNormalized: string;
      purpose: 'register' | 'rebind';
      codeHash: string;
      expiresAt: Date;
      consumedAt: Date | null;
      createdAt: Date;
    }
  >();

  constructor(
    private readonly sessionRepository: MemorySessionRepository | null = null,
  ) {}

  async createEmailUser(input: CreateEmailUserInput): Promise<UserRecord> {
    const emailNormalized = input.emailNormalized.trim().toLowerCase();
    if (this.credentials.has(emailNormalized)) {
      throw new IdentityRepositoryError('IDENTITY_CONFLICT');
    }
    const user: UserRecord = {
      id: input.userId,
      displayName: input.displayName,
      createdAt: new Date(NOW),
      disabledAt: null,
    };
    this.credentials.set(emailNormalized, {
      emailNormalized,
      verifiedAt: null,
      passwordHash: input.passwordHash,
      user,
    });
    return user;
  }

  async createEmailUserWithRefreshSession(
    input: CreateEmailUserWithRefreshSessionInput,
  ) {
    const emailNormalized = input.emailNormalized.trim().toLowerCase();
    if (this.credentials.has(emailNormalized)) {
      throw new IdentityRepositoryError('IDENTITY_CONFLICT');
    }
    if (this.sessionRepository === null) {
      throw new Error('Memory session repository is required');
    }
    const user: UserRecord = {
      id: input.userId,
      displayName: input.displayName,
      createdAt: new Date(NOW),
      disabledAt: null,
    };
    const session = await this.sessionRepository.createRefreshSession({
      sessionId: input.session.sessionId,
      familyId: input.session.familyId,
      userId: input.userId,
      tokenHash: input.session.tokenHash,
      expiresAt: input.session.expiresAt,
    });
    this.credentials.set(emailNormalized, {
      emailNormalized,
      verifiedAt: null,
      passwordHash: input.passwordHash,
      user,
    });
    return { emailNormalized, verifiedAt: null, user, session };
  }

  async findEmailCredential(
    emailNormalized: string,
  ): Promise<EmailCredentialRecord | null> {
    return this.credentials.get(emailNormalized.trim().toLowerCase()) ?? null;
  }

  async findEmailUserById(userId: string): Promise<EmailUserRecord | null> {
    for (const credential of this.credentials.values()) {
      if (credential.user.id === userId) {
        return {
          emailNormalized: credential.emailNormalized,
          verifiedAt: credential.verifiedAt,
          user: credential.user,
        };
      }
    }
    return null;
  }

  async disableUser(userId: string, disabledAt = NOW): Promise<UserRecord> {
    for (const [email, credential] of this.credentials.entries()) {
      if (credential.user.id === userId) {
        const user = { ...credential.user, disabledAt: new Date(disabledAt) };
        this.credentials.set(email, { ...credential, user });
        return user;
      }
    }
    throw new IdentityRepositoryError('USER_NOT_FOUND');
  }

  async markEmailVerified(userId: string, verifiedAt = NOW): Promise<void> {
    for (const [email, credential] of this.credentials.entries()) {
      if (credential.user.id === userId) {
        this.credentials.set(email, {
          ...credential,
          verifiedAt: new Date(verifiedAt),
        });
        return;
      }
    }
    throw new IdentityRepositoryError('USER_NOT_FOUND');
  }

  async updatePasswordHash(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    for (const [email, credential] of this.credentials.entries()) {
      if (credential.user.id === userId) {
        this.credentials.set(email, { ...credential, passwordHash });
        return;
      }
    }
    throw new IdentityRepositoryError('USER_NOT_FOUND');
  }

  async updateEmailIdentity(userId: string, emailNormalized: string) {
    const nextEmail = emailNormalized.trim().toLowerCase();
    if (this.credentials.has(nextEmail)) {
      throw new IdentityRepositoryError('IDENTITY_CONFLICT');
    }
    for (const [email, credential] of this.credentials.entries()) {
      if (credential.user.id === userId) {
        this.credentials.delete(email);
        const next = {
          ...credential,
          emailNormalized: nextEmail,
          verifiedAt: new Date(NOW),
        };
        this.credentials.set(nextEmail, next);
        return {
          emailNormalized: nextEmail,
          verifiedAt: next.verifiedAt,
          user: next.user,
        };
      }
    }
    throw new IdentityRepositoryError('USER_NOT_FOUND');
  }

  async replaceEmailVerificationChallenge(input: {
    challengeId: string;
    userId: string;
    emailNormalized: string;
    purpose: 'register' | 'rebind';
    codeHash: string;
    expiresAt: Date;
  }): Promise<void> {
    for (const [id, challenge] of this.challenges.entries()) {
      if (
        challenge.userId === input.userId &&
        challenge.purpose === input.purpose &&
        challenge.consumedAt === null
      ) {
        this.challenges.set(id, { ...challenge, consumedAt: new Date(NOW) });
      }
    }
    this.challenges.set(input.challengeId, {
      id: input.challengeId,
      userId: input.userId,
      emailNormalized: input.emailNormalized.trim().toLowerCase(),
      purpose: input.purpose,
      codeHash: input.codeHash,
      expiresAt: new Date(input.expiresAt),
      consumedAt: null,
      createdAt: new Date(NOW),
    });
  }

  async findLatestEmailVerificationChallenge(
    userId: string,
    purpose: 'register' | 'rebind',
  ) {
    let latest:
      (typeof this.challenges extends Map<string, infer V> ? V : never) | null =
      null;
    for (const challenge of this.challenges.values()) {
      if (
        challenge.userId === userId &&
        challenge.purpose === purpose &&
        challenge.consumedAt === null
      ) {
        if (
          latest === null ||
          challenge.createdAt.getTime() > latest.createdAt.getTime()
        ) {
          latest = challenge;
        }
      }
    }
    return latest;
  }

  async consumeEmailVerificationChallenge(challengeId: string) {
    const challenge = this.challenges.get(challengeId);
    if (
      challenge === undefined ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= NOW.getTime()
    ) {
      return false;
    }
    this.challenges.set(challengeId, {
      ...challenge,
      consumedAt: new Date(NOW),
    });
    return true;
  }

  async listEmailUsers() {
    return [...this.credentials.values()].map((credential) => ({
      emailNormalized: credential.emailNormalized,
      verifiedAt: credential.verifiedAt,
      user: credential.user,
    }));
  }

  async enableUser(userId: string) {
    for (const [email, credential] of this.credentials.entries()) {
      if (credential.user.id === userId) {
        const user = { ...credential.user, disabledAt: null };
        this.credentials.set(email, { ...credential, user });
        return user;
      }
    }
    throw new IdentityRepositoryError('USER_NOT_FOUND');
  }
}

const defaultEmailDeps = {
  emailPolicy: {
    domainAllowlist: [] as const,
    verificationRequired: false,
    codeTtlSeconds: 600,
  },
  emailDelivery: {
    async send() {
      // no-op for unit tests
    },
  },
};

type MemorySession = RefreshSessionRecord & {
  readonly tokenHash: string;
};

class MemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, MemorySession>();
  constructor(private readonly createError: unknown = null) {}

  async createRefreshSession(
    input: CreateRefreshSessionInput,
  ): Promise<RefreshSessionRecord> {
    if (this.createError !== null) {
      throw this.createError;
    }
    const session: MemorySession = {
      id: input.sessionId,
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      expiresAt: new Date(input.expiresAt),
      rotatedAt: null,
      revokedAt: null,
      createdAt: new Date(NOW),
    };
    this.sessions.set(input.tokenHash, session);
    return session;
  }

  async rotateRefreshSession(
    input: RotateRefreshSessionInput,
  ): Promise<RefreshSessionRecord> {
    const presented = this.sessions.get(input.presentedTokenHash);
    if (!presented) {
      throw new SessionRepositoryError('REFRESH_SESSION_NOT_FOUND');
    }
    if (presented.rotatedAt !== null) {
      for (const [hash, session] of this.sessions.entries()) {
        if (session.familyId === presented.familyId) {
          this.sessions.set(hash, { ...session, revokedAt: new Date(NOW) });
        }
      }
      throw new SessionRepositoryError('REFRESH_TOKEN_REUSED');
    }
    if (presented.revokedAt !== null) {
      throw new SessionRepositoryError('REFRESH_SESSION_REVOKED');
    }
    if (presented.expiresAt.getTime() <= NOW.getTime()) {
      throw new SessionRepositoryError('REFRESH_SESSION_EXPIRED');
    }
    this.sessions.set(input.presentedTokenHash, {
      ...presented,
      rotatedAt: new Date(NOW),
    });
    const replacement: MemorySession = {
      id: input.replacementSessionId,
      userId: presented.userId,
      familyId: presented.familyId,
      tokenHash: input.replacementTokenHash,
      expiresAt: new Date(input.replacementExpiresAt),
      rotatedAt: null,
      revokedAt: null,
      createdAt: new Date(NOW),
    };
    this.sessions.set(input.replacementTokenHash, replacement);
    return replacement;
  }

  async findRefreshSessionUserId(
    tokenHash: ReturnType<typeof parseRefreshTokenHash>,
  ): Promise<string | null> {
    return this.sessions.get(tokenHash)?.userId ?? null;
  }

  async revokeRefreshTokenFamily(
    input: RevokeRefreshTokenFamilyInput,
  ): Promise<RefreshTokenFamilyRevocationRecord> {
    const presented = this.sessions.get(input.presentedTokenHash);
    if (!presented) {
      throw new SessionRepositoryError('REFRESH_SESSION_NOT_FOUND');
    }
    const revokedAt = presented.revokedAt ?? new Date(NOW);
    for (const [hash, session] of this.sessions.entries()) {
      if (session.familyId === presented.familyId) {
        this.sessions.set(hash, { ...session, revokedAt });
      }
    }
    return {
      userId: presented.userId,
      familyId: presented.familyId,
      revokedAt,
    };
  }

  async listActiveSessionSummaries() {
    return [];
  }

  async revokeAllSessionsForUser(userId: string) {
    let count = 0;
    for (const [hash, session] of this.sessions.entries()) {
      if (session.userId === userId && session.revokedAt === null) {
        this.sessions.set(hash, { ...session, revokedAt: new Date(NOW) });
        count += 1;
      }
    }
    return count;
  }
}

let dummyPasswordHash: string;

function asAuthenticated(
  response: Awaited<ReturnType<AuthService['register']>>,
) {
  if ('status' in response && response.status === 'verification_required') {
    throw new Error('expected authenticated registration response');
  }
  return response;
}

beforeAll(async () => {
  dummyPasswordHash = await hashPassword('dummy password value');
});

function createHarness() {
  const sessionRepository = new MemorySessionRepository();
  const identityRepository = new MemoryIdentityRepository(sessionRepository);
  const accessTokenService = createAccessTokenService({
    jwtAccessSecret: JWT_SECRET,
    issuer: ISSUER,
    now: () => new Date(NOW),
  });
  const authService = createAuthService({
    identityRepository,
    sessionRepository,
    accessTokenService,
    dummyPasswordHash,
    ...defaultEmailDeps,
    now: () => new Date(NOW),
    randomUUID: createUuidSequence(),
  });
  return {
    authService,
    accessTokenService,
    identityRepository,
    sessionRepository,
  };
}

const refreshAuthenticationStateCodes = [
  'REFRESH_SESSION_NOT_FOUND',
  'REFRESH_SESSION_EXPIRED',
  'REFRESH_SESSION_REVOKED',
  'REFRESH_TOKEN_REUSED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
] as const satisfies readonly SessionRepositoryErrorCode[];

const refreshInfrastructureCodes = [
  'REFRESH_SESSION_CONFLICT',
  'REFRESH_SESSION_PERSISTENCE_ERROR',
] as const satisfies readonly SessionRepositoryErrorCode[];

const allSessionRepositoryErrorCodes = [
  ...refreshAuthenticationStateCodes,
  ...refreshInfrastructureCodes,
] as const satisfies readonly SessionRepositoryErrorCode[];

function createThrowingSessionRepository(error: unknown): SessionRepository {
  return {
    async createRefreshSession() {
      throw error;
    },
    async rotateRefreshSession() {
      throw error;
    },
    async findRefreshSessionUserId() {
      throw error;
    },
    async revokeRefreshTokenFamily() {
      throw error;
    },
    async listActiveSessionSummaries() {
      throw error;
    },
    async revokeAllSessionsForUser() {
      throw error;
    },
  };
}

function createServiceWithSessionError(error: unknown) {
  return createAuthService({
    identityRepository: new MemoryIdentityRepository(),
    sessionRepository: createThrowingSessionRepository(error),
    accessTokenService: createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: ISSUER,
      now: () => new Date(NOW),
    }),
    dummyPasswordHash,
    ...defaultEmailDeps,
    now: () => new Date(NOW),
    randomUUID: createUuidSequence(),
  });
}

async function createLoginServiceWithSessionCreateError(error: unknown) {
  const sessionRepository = new MemorySessionRepository(error);
  const identityRepository = new MemoryIdentityRepository(sessionRepository);
  await identityRepository.createEmailUser({
    userId: USER_ID,
    emailNormalized: 'person@example.com',
    displayName: 'Person',
    passwordHash: await hashPassword('correct horse battery staple'),
  });
  return createAuthService({
    identityRepository,
    sessionRepository,
    accessTokenService: createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: ISSUER,
      now: () => new Date(NOW),
    }),
    dummyPasswordHash,
    ...defaultEmailDeps,
    now: () => new Date(NOW),
    randomUUID: createUuidSequence(),
  });
}

describe('access and refresh token primitives', () => {
  test('signs only HS256 access tokens with required 15-minute claims', async () => {
    const service = createAccessTokenService({
      jwtAccessSecret: JWT_SECRET,
      issuer: ISSUER,
      now: () => new Date(NOW),
    });

    const token = await service.sign({
      userId: USER_ID,
      sessionId: INITIAL_SESSION_ID,
    });
    const identity = await service.verify(token);

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(identity).toEqual({
      userId: USER_ID,
      sessionId: INITIAL_SESSION_ID,
      issuedAt: Math.floor(NOW.getTime() / 1_000),
      expiresAt: Math.floor(NOW.getTime() / 1_000) + 900,
    });
    expect(identity.expiresAt - identity.issuedAt).toBe(
      ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    );
    expect(ACCESS_TOKEN_AUDIENCE).toBe('wo-desktop');
  });

  test.each([
    Buffer.alloc(31, 1).toString('base64url'),
    `${JWT_SECRET}=`,
    `+${JWT_SECRET.slice(1)}`,
  ])(
    'rejects a non-canonical or short JWT secret without treating it as UTF-8',
    (secret) => {
      expect(() =>
        createAccessTokenService({ jwtAccessSecret: secret, issuer: ISSUER }),
      ).toThrow(/base64url|32 bytes/iu);
    },
  );

  test('generates 32 opaque random bytes and hashes only the token with SHA-256', () => {
    const rawToken = generateRefreshToken({
      randomBytes: (size) => {
        expect(size).toBe(REFRESH_TOKEN_BYTES);
        return Buffer.alloc(size, 0xab);
      },
    });
    const tokenHash = hashRefreshToken(rawToken);

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokenHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(tokenHash).not.toContain(rawToken);
    expect(REFRESH_TOKEN_LIFETIME_MILLISECONDS).toBe(30 * 24 * 60 * 60 * 1_000);
  });
});

describe('auth service', () => {
  test('registers a normalized email and returns protocol-shaped tokens', async () => {
    const {
      authService,
      accessTokenService,
      identityRepository,
      sessionRepository,
    } = createHarness();

    const result = asAuthenticated(
      await authService.register({
        email: '  Person@Example.COM ',
        password: 'correct horse battery staple',
        displayName: ' Person ',
      }),
    );

    expect(result.user).toEqual({
      userId: USER_ID,
      email: 'person@example.com',
      displayName: 'Person',
    });
    expect(result.accessTokenExpiresInSeconds).toBe(900);
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await accessTokenService.verify(result.accessToken)).toMatchObject({
      userId: USER_ID,
      // register no longer allocates a separate identity UUID before the session.
      sessionId: '00000000-0000-4000-8000-000000000002',
    });
    const credential =
      await identityRepository.findEmailCredential('person@example.com');
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(credential?.passwordHash).not.toContain('correct horse');
    expect([...sessionRepository.sessions.keys()]).toEqual([
      hashRefreshToken(result.refreshToken),
    ]);
  });

  test('maps duplicate registration to a stable conflict', async () => {
    const { authService } = createHarness();
    const input = {
      email: 'person@example.com',
      password: 'correct horse battery staple',
      displayName: 'Person',
    };
    await authService.register(input);

    await expect(authService.register(input)).rejects.toEqual(
      new AuthServiceError('EMAIL_ALREADY_REGISTERED'),
    );
  });

  test('does not persist registration identity data when initial session persistence fails', async () => {
    const persistenceError = new SessionRepositoryError(
      'REFRESH_SESSION_PERSISTENCE_ERROR',
    );
    const sessionRepository = new MemorySessionRepository(persistenceError);
    const identityRepository = new MemoryIdentityRepository(sessionRepository);
    const authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService: createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: ISSUER,
        now: () => new Date(NOW),
      }),
      dummyPasswordHash,
      ...defaultEmailDeps,
      now: () => new Date(NOW),
      randomUUID: createUuidSequence(),
    });

    await expect(
      authService.register({
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      }),
    ).rejects.toBe(persistenceError);
    // Registration without verification creates the identity first, then the session.
    expect(identityRepository.credentials.size).toBe(1);
    expect(sessionRepository.sessions.size).toBe(0);
  });

  test('validates the complete registration response before its database transaction', async () => {
    const sessionRepository = new MemorySessionRepository();
    const identityRepository = new MemoryIdentityRepository(sessionRepository);
    const accessTokenService: AccessTokenService = {
      async sign() {
        return '';
      },
      async verify() {
        throw new Error('not used');
      },
    };
    const authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService,
      dummyPasswordHash,
      ...defaultEmailDeps,
      now: () => new Date(NOW),
      randomUUID: createUuidSequence(),
    });

    await expect(
      authService.register({
        email: 'person@example.com',
        password: 'correct horse battery staple',
        displayName: 'Person',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(identityRepository.credentials.size).toBe(1);
    expect(sessionRepository.sessions.size).toBe(0);
  });

  test('does not create a login session when access-token signing fails', async () => {
    const signingError = new Error('signing unavailable');
    const sessionRepository = new MemorySessionRepository();
    const identityRepository = new MemoryIdentityRepository(sessionRepository);
    await identityRepository.createEmailUser({
      userId: USER_ID,
      emailNormalized: 'person@example.com',
      displayName: 'Person',
      passwordHash: await hashPassword('correct horse battery staple'),
    });
    const accessTokenService: AccessTokenService = {
      async sign() {
        throw signingError;
      },
      async verify() {
        throw new Error('not used');
      },
    };
    const authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService,
      dummyPasswordHash,
      ...defaultEmailDeps,
      now: () => new Date(NOW),
      randomUUID: createUuidSequence(),
    });

    await expect(
      authService.login({
        email: 'person@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBe(signingError);
    expect(sessionRepository.sessions.size).toBe(0);
  });

  test.each(['USER_DISABLED', 'USER_NOT_FOUND'] as const)(
    'maps native login session race %s to INVALID_CREDENTIALS',
    async (code) => {
      const authService = await createLoginServiceWithSessionCreateError(
        new SessionRepositoryError(code),
      );

      await expect(
        authService.login({
          email: 'person@example.com',
          password: 'correct horse battery staple',
        }),
      ).rejects.toEqual(new AuthServiceError('INVALID_CREDENTIALS'));
    },
  );

  test.each(['USER_DISABLED', 'USER_NOT_FOUND'] as const)(
    'maps cross-realm login session race %s to INVALID_CREDENTIALS',
    async (code) => {
      const crossRealmError = runInNewContext(
        `Object.assign(new Error('remote realm login race'), {
          name: 'SessionRepositoryError',
          code: '${code}'
        })`,
      ) as unknown;
      const authService =
        await createLoginServiceWithSessionCreateError(crossRealmError);

      await expect(
        authService.login({
          email: 'person@example.com',
          password: 'correct horse battery staple',
        }),
      ).rejects.toEqual(new AuthServiceError('INVALID_CREDENTIALS'));
    },
  );

  test.each([
    'REFRESH_SESSION_CONFLICT',
    'REFRESH_SESSION_PERSISTENCE_ERROR',
    'REFRESH_SESSION_EXPIRED',
  ] as const)('preserves non-race login session error %s', async (code) => {
    const repositoryError = new SessionRepositoryError(code);
    const authService =
      await createLoginServiceWithSessionCreateError(repositoryError);

    await expect(
      authService.login({
        email: 'person@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBe(repositoryError);
  });

  test('preserves a plain object that copies a login race error code', async () => {
    const forgedError = {
      name: 'SessionRepositoryError',
      code: 'USER_DISABLED',
    };
    const authService =
      await createLoginServiceWithSessionCreateError(forgedError);

    await expect(
      authService.login({
        email: 'person@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBe(forgedError);
  });

  test.each([
    'identity lookup',
    'access-token signing',
    'response validation',
  ] as const)(
    'does not consume a refresh token when %s fails before rotation',
    async (failure) => {
      const signingError = new Error('signing unavailable');
      const rawRefreshToken = 'refresh-token-before-failure';
      const presentedTokenHash = hashRefreshToken(rawRefreshToken);
      const sessionRepository = new MemorySessionRepository();
      const identityRepository = new MemoryIdentityRepository(
        sessionRepository,
      );
      await identityRepository.createEmailUser({
        userId: USER_ID,
        emailNormalized: 'person@example.com',
        displayName: 'Person',
        passwordHash: await hashPassword('correct horse battery staple'),
      });
      await sessionRepository.createRefreshSession({
        sessionId: INITIAL_SESSION_ID,
        familyId: INITIAL_FAMILY_ID,
        userId: USER_ID,
        tokenHash: presentedTokenHash,
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
      });
      if (failure === 'identity lookup') {
        identityRepository.findEmailUserById = async () => null;
      }
      const accessTokenService: AccessTokenService =
        failure === 'access-token signing'
          ? {
              async sign() {
                throw signingError;
              },
              async verify() {
                throw new Error('not used');
              },
            }
          : failure === 'response validation'
            ? {
                async sign() {
                  return '';
                },
                async verify() {
                  throw new Error('not used');
                },
              }
            : createAccessTokenService({
                jwtAccessSecret: JWT_SECRET,
                issuer: ISSUER,
                now: () => new Date(NOW),
              });
      const authService = createAuthService({
        identityRepository,
        sessionRepository,
        accessTokenService,
        dummyPasswordHash,
        ...defaultEmailDeps,
        now: () => new Date(NOW),
        randomUUID: createUuidSequence(),
      });

      await expect(
        authService.refresh({ refreshToken: rawRefreshToken }),
      ).rejects.toBeInstanceOf(Error);
      expect(
        sessionRepository.sessions.get(presentedTokenHash)?.rotatedAt,
      ).toBeNull();
      expect(sessionRepository.sessions.size).toBe(1);
    },
  );

  test('does not distinguish missing, wrong-password, or disabled logins', async () => {
    const { authService, identityRepository } = createHarness();
    await authService.register({
      email: 'person@example.com',
      password: 'correct horse battery staple',
      displayName: 'Person',
    });
    await identityRepository.disableUser(USER_ID);

    const attempts = [
      { email: 'missing@example.com', password: 'wrong password value' },
      { email: 'person@example.com', password: 'wrong password value' },
      { email: 'person@example.com', password: 'correct horse battery staple' },
    ];
    for (const attempt of attempts) {
      await expect(authService.login(attempt)).rejects.toEqual(
        new AuthServiceError('INVALID_CREDENTIALS'),
      );
    }
  });

  test('uses the dummy hash on a missing-account login path', async () => {
    const identityRepository = new MemoryIdentityRepository();
    const sessionRepository = new MemorySessionRepository();
    const verifiedHashes: string[] = [];
    const authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService: createAccessTokenService({
        jwtAccessSecret: JWT_SECRET,
        issuer: ISSUER,
        now: () => new Date(NOW),
      }),
      dummyPasswordHash,
      ...defaultEmailDeps,
      verifyPassword: async (hash, password) => {
        verifiedHashes.push(hash);
        return hashPassword(password).then(() => false);
      },
      now: () => new Date(NOW),
      randomUUID: () => USER_ID,
    });

    await expect(
      authService.login({
        email: 'missing@example.com',
        password: 'wrong password value',
      }),
    ).rejects.toEqual(new AuthServiceError('INVALID_CREDENTIALS'));
    expect(verifiedHashes).toEqual([dummyPasswordHash]);
  });

  test('rotates refresh tokens, detects reuse, and revokes the whole family', async () => {
    const { authService, sessionRepository } = createHarness();
    const registered = await authService.register({
      email: 'person@example.com',
      password: 'correct horse battery staple',
      displayName: 'Person',
    });

    const refreshed = await authService.refresh({
      refreshToken: asAuthenticated(registered).refreshToken,
    });

    expect(refreshed.refreshToken).not.toBe(
      asAuthenticated(registered).refreshToken,
    );
    expect(refreshed.user).toEqual(asAuthenticated(registered).user);
    await expect(
      authService.refresh({
        refreshToken: asAuthenticated(registered).refreshToken,
      }),
    ).rejects.toEqual(new AuthServiceError('AUTH_REQUIRED'));
    expect(
      [...sessionRepository.sessions.values()].every(
        ({ revokedAt }) => revokedAt !== null,
      ),
    ).toBe(true);
  });

  test('logs out idempotently and a logged-out token cannot refresh', async () => {
    const { authService } = createHarness();
    const registered = await authService.register({
      email: 'person@example.com',
      password: 'correct horse battery staple',
      displayName: 'Person',
    });

    await expect(
      authService.logout({
        refreshToken: asAuthenticated(registered).refreshToken,
      }),
    ).resolves.toEqual({ loggedOut: true });
    await expect(
      authService.logout({
        refreshToken: asAuthenticated(registered).refreshToken,
      }),
    ).resolves.toEqual({ loggedOut: true });
    await expect(
      authService.refresh({
        refreshToken: asAuthenticated(registered).refreshToken,
      }),
    ).rejects.toEqual(new AuthServiceError('AUTH_REQUIRED'));
  });

  test.each(refreshAuthenticationStateCodes)(
    'maps refresh repository authentication state %s to AUTH_REQUIRED',
    async (code) => {
      const authService = createServiceWithSessionError(
        new SessionRepositoryError(code),
      );

      await expect(
        authService.refresh({ refreshToken: 'opaque-refresh-token' }),
      ).rejects.toEqual(new AuthServiceError('AUTH_REQUIRED'));
    },
  );

  test.each(refreshInfrastructureCodes)(
    'preserves refresh repository infrastructure error %s for the HTTP mapper',
    async (code) => {
      const repositoryError = new SessionRepositoryError(code);
      const authService = createServiceWithSessionError(repositoryError);

      await expect(
        authService.refresh({ refreshToken: 'opaque-refresh-token' }),
      ).rejects.toBe(repositoryError);
    },
  );

  test.each(allSessionRepositoryErrorCodes)(
    'only treats not-found logout as idempotent for repository code %s',
    async (code) => {
      const repositoryError = new SessionRepositoryError(code);
      const authService = createServiceWithSessionError(repositoryError);
      const result = authService.logout({
        refreshToken: 'opaque-refresh-token',
      });

      if (code === 'REFRESH_SESSION_NOT_FOUND') {
        await expect(result).resolves.toEqual({ loggedOut: true });
      } else {
        await expect(result).rejects.toBe(repositoryError);
      }
    },
  );

  test('classifies a real cross-realm native session error', async () => {
    const crossRealmError = runInNewContext(
      `Object.assign(new Error('remote realm message'), {
        name: 'SessionRepositoryError',
        code: 'REFRESH_SESSION_NOT_FOUND'
      })`,
    ) as unknown;

    await expect(
      createServiceWithSessionError(crossRealmError).refresh({
        refreshToken: 'opaque-refresh-token',
      }),
    ).rejects.toEqual(new AuthServiceError('AUTH_REQUIRED'));
    await expect(
      createServiceWithSessionError(crossRealmError).logout({
        refreshToken: 'opaque-refresh-token',
      }),
    ).resolves.toEqual({ loggedOut: true });
  });

  test.each([
    ['plain object', {}],
    ['object with forged Error toStringTag', { [Symbol.toStringTag]: 'Error' }],
  ])(
    'preserves a %s that copies the repository error name and code',
    async (_kind, extra) => {
      const forgedError = {
        ...extra,
        name: 'SessionRepositoryError',
        code: 'REFRESH_SESSION_NOT_FOUND',
      };

      const results = await Promise.allSettled([
        createServiceWithSessionError(forgedError).refresh({
          refreshToken: 'opaque-refresh-token',
        }),
        createServiceWithSessionError(forgedError).logout({
          refreshToken: 'opaque-refresh-token',
        }),
      ]);

      expect(results).toEqual([
        { status: 'rejected', reason: forgedError },
        { status: 'rejected', reason: forgedError },
      ]);
    },
  );
});
