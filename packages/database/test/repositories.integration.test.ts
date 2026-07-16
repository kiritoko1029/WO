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
  createDatabaseClient,
  createIdentityRepository,
  createSessionRepository as createRawSessionRepository,
  migrateDatabase,
  parseRefreshTokenHash,
  type DatabaseClient,
  type CreateRefreshSessionInput,
  type IdentityRepository,
  type RotateRefreshSessionInput,
  type SessionRepository,
  type SessionRepositoryDependencies,
} from '../src/index.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests',
  );
}

const BASE_TIME = new Date('2026-07-16T00:00:00.000Z');
const USER_ONE_ID = '00000000-0000-4000-8000-000000000001';
const USER_TWO_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ONE_ID = '10000000-0000-4000-8000-000000000001';
const FAMILY_ONE_ID = '20000000-0000-4000-8000-000000000001';
const FAMILY_TWO_ID = '20000000-0000-4000-8000-000000000002';
const IDENTITY_TWO_ID = '30000000-0000-4000-8000-000000000002';

type TestCreateRefreshSessionInput = Omit<
  CreateRefreshSessionInput,
  'sessionId' | 'familyId'
> &
  Partial<Pick<CreateRefreshSessionInput, 'sessionId' | 'familyId'>>;
type TestRotateRefreshSessionInput = Omit<
  RotateRefreshSessionInput,
  'replacementSessionId'
> &
  Partial<Pick<RotateRefreshSessionInput, 'replacementSessionId'>>;
type TestSessionRepository = Omit<
  SessionRepository,
  'createRefreshSession' | 'rotateRefreshSession'
> & {
  createRefreshSession(
    input: TestCreateRefreshSessionInput,
  ): ReturnType<SessionRepository['createRefreshSession']>;
  rotateRefreshSession(
    input: TestRotateRefreshSessionInput,
  ): ReturnType<SessionRepository['rotateRefreshSession']>;
};

function createSessionRepository(
  client: DatabaseClient,
  dependencies: SessionRepositoryDependencies = {},
): TestSessionRepository {
  const repository = createRawSessionRepository(client, dependencies);
  return {
    createRefreshSession: (input) =>
      repository.createRefreshSession({
        ...input,
        sessionId: input.sessionId ?? randomUUID(),
        familyId: input.familyId ?? randomUUID(),
      }),
    rotateRefreshSession: (input) =>
      repository.rotateRefreshSession({
        ...input,
        replacementSessionId: input.replacementSessionId ?? randomUUID(),
      }),
    findRefreshSessionUserId: (tokenHash) =>
      repository.findRefreshSessionUserId(tokenHash),
    revokeRefreshTokenFamily: (input) =>
      repository.revokeRefreshTokenFamily(input),
  };
}

function tokenHash(value: string) {
  return parseRefreshTokenHash(
    createHash('sha256').update(value).digest('hex'),
  );
}

function timestampIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('PostgreSQL identity and refresh-session repositories', () => {
  let client: DatabaseClient;
  let identityRepository: IdentityRepository;
  let sessionRepository: TestSessionRepository;
  let now: Date;

  beforeAll(async () => {
    client = createDatabaseClient(databaseUrl, { maxConnections: 8 });
    await client.sql.unsafe(`
      DROP SCHEMA IF EXISTS wo_meta CASCADE;
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
    `);
    await migrateDatabase(client);
    await migrateDatabase(client);
  });

  beforeEach(async () => {
    now = new Date(BASE_TIME);
    identityRepository = createIdentityRepository(client, {
      now: () => new Date(now),
    });
    sessionRepository = createSessionRepository(client, {
      now: () => new Date(now),
    });
    await migrateDatabase(client);
    await client.sql`TRUNCATE TABLE users CASCADE`;
  });

  afterAll(async () => {
    await client.close();
  });

  async function createUser(
    userId = USER_ONE_ID,
    emailNormalized = 'person@example.com',
  ) {
    return identityRepository.createEmailUser({
      userId,
      emailNormalized,
      displayName: 'Person',
      passwordHash: '$argon2id$redacted',
    });
  }

  async function resetDatabaseSchemas(): Promise<void> {
    await client.sql.unsafe(`
      DROP SCHEMA IF EXISTS wo_meta CASCADE;
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
    `);
  }

  test('serializes four concurrent empty-database migrations across repeated starts', async () => {
    const migrationClients = Array.from({ length: 4 }, () =>
      createDatabaseClient(databaseUrl, { maxConnections: 1 }),
    );

    try {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        await resetDatabaseSchemas();
        await Promise.all(
          migrationClients.map(async (migrationClient) =>
            migrateDatabase(migrationClient),
          ),
        );
      }
    } finally {
      await Promise.all(
        migrationClients.map(async (migrationClient) =>
          migrationClient.close(),
        ),
      );
    }

    const [{ migration_count }] = await client.sql<
      { migration_count: number }[]
    >`
        SELECT count(*)::int AS migration_count
        FROM wo_meta.schema_migrations
      `;
    expect(migration_count).toBe(1);
  }, 60_000);

  test('journals the migration once and skips an identical checksum', async () => {
    await resetDatabaseSchemas();
    await migrateDatabase(client);

    const [first] = await client.sql<
      { migration_id: string; checksum: string; applied_at: Date | string }[]
    >`
      SELECT migration_id, checksum, applied_at
      FROM wo_meta.schema_migrations
    `;
    expect(first).toMatchObject({
      migration_id: '0000_identity',
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    await migrateDatabase(client);
    const rows = await client.sql<
      { migration_id: string; checksum: string; applied_at: Date | string }[]
    >`
      SELECT migration_id, checksum, applied_at
      FROM wo_meta.schema_migrations
    `;
    expect(rows).toEqual([first]);
  });

  test('rejects a journal checksum mismatch without touching the domain schema', async () => {
    await resetDatabaseSchemas();
    await migrateDatabase(client);
    try {
      await client.sql`
        UPDATE wo_meta.schema_migrations
        SET checksum = ${'0'.repeat(64)}
        WHERE migration_id = '0000_identity'
      `;

      await expect(migrateDatabase(client)).rejects.toMatchObject({
        code: 'MIGRATION_CHECKSUM_MISMATCH',
      });

      const [{ table_count }] = await client.sql<{ table_count: number }[]>`
        SELECT count(*)::int AS table_count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `;
      expect(table_count).toBe(4);
    } finally {
      await resetDatabaseSchemas();
      await migrateDatabase(client);
    }
  });

  test('migration keeps exactly the required tables in the public schema', async () => {
    const tables = await client.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    expect(tables.map(({ table_name }) => table_name)).toEqual([
      'auth_identities',
      'password_credentials',
      'refresh_sessions',
      'users',
    ]);
  });

  test('creates a stable user, email identity, and password credential atomically', async () => {
    const result = await createUser();

    expect(result).toEqual({
      id: USER_ONE_ID,
      displayName: 'Person',
      createdAt: BASE_TIME,
      disabledAt: null,
    });
    expect(result).not.toHaveProperty('passwordHash');

    const rows = await client.sql<
      {
        id: string;
        provider: string;
        identifier_normalized: string;
        password_hash: string;
      }[]
    >`
      SELECT u.id, i.provider, i.identifier_normalized, p.password_hash
      FROM users u
      JOIN auth_identities i ON i.user_id = u.id
      JOIN password_credentials p ON p.user_id = u.id
    `;

    expect(rows).toEqual([
      {
        id: USER_ONE_ID,
        provider: 'email',
        identifier_normalized: 'person@example.com',
        password_hash: '$argon2id$redacted',
      },
    ]);
  });

  test('looks up an email credential through its canonical identity', async () => {
    await createUser(USER_ONE_ID, '  Person@Example.COM  ');

    const credential = await identityRepository.findEmailCredential(
      ' PERSON@example.com ',
    );

    expect(credential).toEqual({
      emailNormalized: 'person@example.com',
      passwordHash: '$argon2id$redacted',
      user: {
        id: USER_ONE_ID,
        displayName: 'Person',
        createdAt: BASE_TIME,
        disabledAt: null,
      },
    });
    expect(
      await identityRepository.findEmailCredential('other@example.com'),
    ).toBeNull();
  });

  test('returns disabled state with an email credential without exposing session secrets', async () => {
    await createUser();
    const disabledAt = new Date('2026-07-16T04:00:00.000Z');
    await identityRepository.disableUser(USER_ONE_ID, disabledAt);

    const credential =
      await identityRepository.findEmailCredential('person@example.com');

    expect(credential?.user.disabledAt).toEqual(disabledAt);
    expect(credential).not.toHaveProperty('tokenHash');
    expect(credential).not.toHaveProperty('refreshTokenHash');
  });

  test('loads public email user data by user id without returning credentials', async () => {
    await createUser(USER_ONE_ID, 'Person@Example.COM');

    const publicUser = await identityRepository.findEmailUserById(USER_ONE_ID);

    expect(publicUser).toEqual({
      emailNormalized: 'person@example.com',
      user: {
        id: USER_ONE_ID,
        displayName: 'Person',
        createdAt: BASE_TIME,
        disabledAt: null,
      },
    });
    expect(publicUser).not.toHaveProperty('passwordHash');
    expect(await identityRepository.findEmailUserById(USER_TWO_ID)).toBeNull();
  });

  test('maps duplicate normalized email identities to a stable domain error and rolls back', async () => {
    await createUser(USER_ONE_ID, '  Person@Example.COM ');

    await expectCode(
      createUser(USER_TWO_ID, ' PERSON@example.com '),
      'IDENTITY_CONFLICT',
    );

    const [{ user_count, identity_count, credential_count }] = await client.sql<
      {
        user_count: number;
        identity_count: number;
        credential_count: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS user_count,
        (SELECT count(*)::int FROM auth_identities) AS identity_count,
        (SELECT count(*)::int FROM password_credentials) AS credential_count
    `;

    expect({ user_count, identity_count, credential_count }).toEqual({
      user_count: 1,
      identity_count: 1,
      credential_count: 1,
    });
    const [identity] = await client.sql<{ identifier_normalized: string }[]>`
      SELECT identifier_normalized FROM auth_identities
    `;
    expect(identity?.identifier_normalized).toBe('person@example.com');
  });

  test('enforces normalized identity uniqueness under concurrent registration', async () => {
    const results = await Promise.allSettled([
      createUser(USER_ONE_ID, ' Same@Example.com'),
      createUser(USER_TWO_ID, 'same@example.COM '),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'IDENTITY_CONFLICT' },
    });

    const [{ count }] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users
    `;
    expect(count).toBe(1);
  });

  test('rejects empty, overlong, and control-character email identities', async () => {
    const invalidEmails = [
      '   ',
      `${'a'.repeat(244)}@example.com`,
      'person\u0007@example.com',
    ];

    for (const [index, emailNormalized] of invalidEmails.entries()) {
      await expectCode(
        createUser(
          `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
          emailNormalized,
        ),
        'IDENTITY_INVALID',
      );
    }

    const [{ count }] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users
    `;
    expect(count).toBe(0);
  });

  test('maps an unexpected identity UUID collision to a safe persistence error', async () => {
    const collidingIdentityId = '00000000-0000-4000-8000-000000000099';
    const collidingRepository = createIdentityRepository(client, {
      now: () => new Date(now),
      randomUUID: () => collidingIdentityId,
    });
    await collidingRepository.createEmailUser({
      userId: USER_ONE_ID,
      emailNormalized: 'first@example.com',
      displayName: 'First',
      passwordHash: '$argon2id$redacted',
    });

    await expect(
      collidingRepository.createEmailUser({
        userId: USER_TWO_ID,
        emailNormalized: 'second@example.com',
        displayName: 'Second',
        passwordHash: '$argon2id$redacted',
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PERSISTENCE_ERROR',
      message: 'Identity persistence failed',
    });

    const [{ user_count, identity_count }] = await client.sql<
      { user_count: number; identity_count: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS user_count,
        (SELECT count(*)::int FROM auth_identities) AS identity_count
    `;
    expect({ user_count, identity_count }).toEqual({
      user_count: 1,
      identity_count: 1,
    });
  });

  test('snapshots the identity clock before awaiting the registration transaction', async () => {
    const clockValue = new Date('2026-07-16T01:00:00.000Z');
    const originalClock = clockValue.toISOString();
    const repository = createIdentityRepository(client, {
      now: () => clockValue,
    });

    const pending = repository.createEmailUser({
      userId: USER_ONE_ID,
      emailNormalized: 'clock@example.com',
      displayName: 'Clock',
      passwordHash: '$argon2id$redacted',
    });
    clockValue.setUTCFullYear(2030);
    const user = await pending;

    expect(user.createdAt.toISOString()).toBe(originalClock);
    expect(user.createdAt).not.toBe(clockValue);
    const [stored] = await client.sql<{ created_at: Date | string }[]>`
      SELECT created_at FROM users WHERE id = ${USER_ONE_ID}
    `;
    expect(timestampIso(stored?.created_at ?? null)).toBe(originalClock);
  });

  test('snapshots disabledAt before awaiting the update', async () => {
    await createUser();
    const disabledAt = new Date('2026-07-16T01:30:00.000Z');
    const originalDisabledAt = disabledAt.toISOString();

    const pending = identityRepository.disableUser(USER_ONE_ID, disabledAt);
    disabledAt.setUTCFullYear(2030);
    const user = await pending;

    expect(user.disabledAt?.toISOString()).toBe(originalDisabledAt);
    expect(user.disabledAt).not.toBe(disabledAt);
    const [stored] = await client.sql<{ disabled_at: Date | string | null }[]>`
      SELECT disabled_at FROM users WHERE id = ${USER_ONE_ID}
    `;
    expect(timestampIso(stored?.disabled_at ?? null)).toBe(originalDisabledAt);
  });

  test('stores only the supplied fixed-length token hash and never returns it', async () => {
    await createUser();
    const rawToken = 'raw-refresh-token-that-must-never-reach-postgresql';
    const hashedToken = tokenHash(rawToken);

    const session = await sessionRepository.createRefreshSession({
      sessionId: SESSION_ONE_ID,
      familyId: FAMILY_ONE_ID,
      userId: USER_ONE_ID,
      tokenHash: hashedToken,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    expect(session.id).toBe(SESSION_ONE_ID);
    expect(session.familyId).toBe(FAMILY_ONE_ID);
    expect(session).not.toHaveProperty('tokenHash');
    const [stored] = await client.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM refresh_sessions WHERE id = ${session.id}
    `;
    expect(stored?.token_hash).toBe(hashedToken);
    expect(stored?.token_hash).not.toContain(rawToken);
  });

  test('finds only the refresh-session user id without returning token material', async () => {
    await createUser();
    const hashedToken = tokenHash('lookup-principal');
    await sessionRepository.createRefreshSession({
      sessionId: SESSION_ONE_ID,
      familyId: FAMILY_ONE_ID,
      userId: USER_ONE_ID,
      tokenHash: hashedToken,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    expect(sessionRepository).toHaveProperty('findRefreshSessionUserId');
    await expect(
      sessionRepository.findRefreshSessionUserId(hashedToken),
    ).resolves.toBe(USER_ONE_ID);
    await expect(
      sessionRepository.findRefreshSessionUserId(tokenHash('missing')),
    ).resolves.toBeNull();
  });

  test('rejects noncanonical application-generated session UUIDs before persistence', async () => {
    await createUser();

    await expect(
      sessionRepository.createRefreshSession({
        sessionId: 'not-a-uuid',
        familyId: FAMILY_ONE_ID,
        userId: USER_ONE_ID,
        tokenHash: tokenHash('invalid-session-id'),
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/session id.*uuid/iu);

    const [{ count }] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM refresh_sessions
    `;
    expect(count).toBe(0);
  });

  test('rolls back all four authentication tables when initial session persistence conflicts', async () => {
    await createUser();
    await sessionRepository.createRefreshSession({
      sessionId: SESSION_ONE_ID,
      familyId: FAMILY_ONE_ID,
      userId: USER_ONE_ID,
      tokenHash: tokenHash('existing-session'),
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    const before = await client.sql<
      {
        users: number;
        identities: number;
        credentials: number;
        sessions: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM auth_identities) AS identities,
        (SELECT count(*)::int FROM password_credentials) AS credentials,
        (SELECT count(*)::int FROM refresh_sessions) AS sessions
    `;

    expect(identityRepository).toHaveProperty(
      'createEmailUserWithRefreshSession',
    );
    await expect(
      identityRepository.createEmailUserWithRefreshSession({
        userId: USER_TWO_ID,
        identityId: IDENTITY_TWO_ID,
        emailNormalized: 'second@example.com',
        displayName: 'Second',
        passwordHash: '$argon2id$redacted',
        session: {
          sessionId: SESSION_ONE_ID,
          familyId: FAMILY_TWO_ID,
          tokenHash: tokenHash('new-session'),
          expiresAt: new Date('2026-08-16T00:00:00.000Z'),
        },
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_SESSION_CONFLICT' });

    const after = await client.sql<
      {
        users: number;
        identities: number;
        credentials: number;
        sessions: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM auth_identities) AS identities,
        (SELECT count(*)::int FROM password_credentials) AS credentials,
        (SELECT count(*)::int FROM refresh_sessions) AS sessions
    `;
    expect(after).toEqual(before);
    await expect(
      identityRepository.findEmailCredential('second@example.com'),
    ).resolves.toBeNull();
  });

  test('snapshots create-session clock and expiry before awaiting the transaction', async () => {
    await createUser();
    const clockValue = new Date('2026-07-16T02:00:00.000Z');
    const expiresAt = new Date('2026-08-16T02:00:00.000Z');
    const originalClock = clockValue.toISOString();
    const originalExpiry = expiresAt.toISOString();
    const repository = createSessionRepository(client, {
      now: () => clockValue,
    });

    const pending = repository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: tokenHash('date-alias-create'),
      expiresAt,
    });
    clockValue.setUTCFullYear(2030);
    expiresAt.setUTCFullYear(2031);
    const session = await pending;

    expect(session.createdAt.toISOString()).toBe(originalClock);
    expect(session.expiresAt.toISOString()).toBe(originalExpiry);
    expect(session.createdAt).not.toBe(clockValue);
    expect(session.expiresAt).not.toBe(expiresAt);
    const [stored] = await client.sql<
      { created_at: Date | string; expires_at: Date | string }[]
    >`
      SELECT created_at, expires_at FROM refresh_sessions WHERE id = ${session.id}
    `;
    expect(timestampIso(stored?.created_at ?? null)).toBe(originalClock);
    expect(timestampIso(stored?.expires_at ?? null)).toBe(originalExpiry);
  });

  test('rotates a refresh session once within the same token family', async () => {
    await createUser();
    const originalHash = tokenHash('original');
    const replacementHash = tokenHash('replacement');
    const original = await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    now = new Date('2026-07-16T00:05:00.000Z');
    const replacement = await sessionRepository.rotateRefreshSession({
      presentedTokenHash: originalHash,
      replacementTokenHash: replacementHash,
      replacementExpiresAt: new Date('2026-08-16T00:05:00.000Z'),
    });

    expect(replacement.familyId).toBe(original.familyId);
    expect(replacement.userId).toBe(USER_ONE_ID);
    expect(replacement.createdAt).toEqual(now);
    expect(replacement).not.toHaveProperty('tokenHash');

    const rows = await client.sql<
      {
        token_hash: string;
        rotated_at: Date | string | null;
        revoked_at: Date | string | null;
      }[]
    >`
      SELECT token_hash, rotated_at, revoked_at
      FROM refresh_sessions
      WHERE family_id = ${original.familyId}
      ORDER BY created_at
    `;
    expect(
      rows.map((row) => ({
        ...row,
        rotated_at: timestampIso(row.rotated_at),
        revoked_at: timestampIso(row.revoked_at),
      })),
    ).toEqual([
      {
        token_hash: originalHash,
        rotated_at: now.toISOString(),
        revoked_at: null,
      },
      { token_hash: replacementHash, rotated_at: null, revoked_at: null },
    ]);
  });

  test('snapshots rotation clock and replacement expiry before awaiting the transaction', async () => {
    await createUser();
    const originalHash = tokenHash('date-alias-rotation-original');
    await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    const clockValue = new Date('2026-07-16T03:00:00.000Z');
    const replacementExpiresAt = new Date('2026-08-16T03:00:00.000Z');
    const originalClock = clockValue.toISOString();
    const originalExpiry = replacementExpiresAt.toISOString();
    const repository = createSessionRepository(client, {
      now: () => clockValue,
    });

    const pending = repository.rotateRefreshSession({
      presentedTokenHash: originalHash,
      replacementTokenHash: tokenHash('date-alias-rotation-replacement'),
      replacementExpiresAt,
    });
    clockValue.setUTCFullYear(2030);
    replacementExpiresAt.setUTCFullYear(2031);
    const replacement = await pending;

    expect(replacement.createdAt.toISOString()).toBe(originalClock);
    expect(replacement.expiresAt.toISOString()).toBe(originalExpiry);
    expect(replacement.createdAt).not.toBe(clockValue);
    expect(replacement.expiresAt).not.toBe(replacementExpiresAt);
    const [stored] = await client.sql<
      { created_at: Date | string; expires_at: Date | string }[]
    >`
      SELECT created_at, expires_at
      FROM refresh_sessions
      WHERE id = ${replacement.id}
    `;
    expect(timestampIso(stored?.created_at ?? null)).toBe(originalClock);
    expect(timestampIso(stored?.expires_at ?? null)).toBe(originalExpiry);
  });

  test('revokes one refresh-token family by a presented token and is idempotent', async () => {
    await createUser();
    const originalHash = tokenHash('logout-original');
    const replacementHash = tokenHash('logout-replacement');
    const otherFamilyHash = tokenHash('other-family');
    const original = await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    await sessionRepository.rotateRefreshSession({
      presentedTokenHash: originalHash,
      replacementTokenHash: replacementHash,
      replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: otherFamilyHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    now = new Date('2026-07-16T00:15:00.000Z');
    const first = await sessionRepository.revokeRefreshTokenFamily({
      presentedTokenHash: replacementHash,
    });
    const second = await sessionRepository.revokeRefreshTokenFamily({
      presentedTokenHash: originalHash,
    });

    expect(first).toEqual({
      userId: USER_ONE_ID,
      familyId: original.familyId,
      revokedAt: now,
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('tokenHash');

    const rows = await client.sql<
      { family_id: string; revoked_at: Date | string | null }[]
    >`
      SELECT family_id, revoked_at
      FROM refresh_sessions
      ORDER BY created_at, id
    `;
    expect(
      rows
        .filter(({ family_id }) => family_id === original.familyId)
        .every(
          ({ revoked_at }) => timestampIso(revoked_at) === now.toISOString(),
        ),
    ).toBe(true);
    expect(
      rows.find(({ family_id }) => family_id !== original.familyId)?.revoked_at,
    ).toBeNull();
  });

  test('rejects invalid repository dates before changing persistence', async () => {
    await createUser();
    const invalidDate = new Date(Number.NaN);
    const invalidIdentityClock = createIdentityRepository(client, {
      now: () => invalidDate,
    });
    const invalidSessionClock = createSessionRepository(client, {
      now: () => invalidDate,
    });

    await expect(
      invalidIdentityClock.createEmailUser({
        userId: USER_TWO_ID,
        emailNormalized: 'invalid-clock@example.com',
        displayName: 'Invalid',
        passwordHash: '$argon2id$redacted',
      }),
    ).rejects.toThrow('Database timestamp must be a valid Date');
    await expect(
      identityRepository.disableUser(USER_ONE_ID, invalidDate),
    ).rejects.toThrow('Database timestamp must be a valid Date');
    await expect(
      sessionRepository.createRefreshSession({
        userId: USER_ONE_ID,
        tokenHash: tokenHash('invalid-expiry'),
        expiresAt: invalidDate,
      }),
    ).rejects.toThrow('Database timestamp must be a valid Date');
    await expect(
      invalidSessionClock.createRefreshSession({
        userId: USER_ONE_ID,
        tokenHash: tokenHash('invalid-session-clock'),
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Database timestamp must be a valid Date');
    await expect(
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: tokenHash('missing-but-date-validates-first'),
        replacementTokenHash: tokenHash('invalid-replacement-expiry'),
        replacementExpiresAt: invalidDate,
      }),
    ).rejects.toThrow('Database timestamp must be a valid Date');

    const [{ user_count, session_count }] = await client.sql<
      { user_count: number; session_count: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS user_count,
        (SELECT count(*)::int FROM refresh_sessions) AS session_count
    `;
    expect({ user_count, session_count }).toEqual({
      user_count: 1,
      session_count: 0,
    });
  });

  test('revokes the whole family when a rotated token is reused', async () => {
    await createUser();
    const originalHash = tokenHash('reuse-original');
    const replacementHash = tokenHash('reuse-replacement');
    const original = await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    await sessionRepository.rotateRefreshSession({
      presentedTokenHash: originalHash,
      replacementTokenHash: replacementHash,
      replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    now = new Date('2026-07-16T00:10:00.000Z');
    await expectCode(
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: originalHash,
        replacementTokenHash: tokenHash('must-not-be-inserted'),
        replacementExpiresAt: new Date('2026-08-16T00:10:00.000Z'),
      }),
      'REFRESH_TOKEN_REUSED',
    );

    const family = await client.sql<{ revoked_at: Date | string | null }[]>`
      SELECT revoked_at FROM refresh_sessions WHERE family_id = ${original.familyId}
    `;
    expect(family).toHaveLength(2);
    expect(
      family.every(
        ({ revoked_at }) => timestampIso(revoked_at) === now.toISOString(),
      ),
    ).toBe(true);
    await expectCode(
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: replacementHash,
        replacementTokenHash: tokenHash('after-revocation'),
        replacementExpiresAt: new Date('2026-08-16T00:10:00.000Z'),
      }),
      'REFRESH_SESSION_REVOKED',
    );
  });

  test('rejects expired sessions without inserting a replacement', async () => {
    await createUser();
    const expiredHash = tokenHash('expired');
    await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: expiredHash,
      expiresAt: new Date('2026-07-16T00:00:01.000Z'),
    });
    now = new Date('2026-07-16T00:00:02.000Z');

    await expectCode(
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: expiredHash,
        replacementTokenHash: tokenHash('not-created'),
        replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
      'REFRESH_SESSION_EXPIRED',
    );

    const [{ count }] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM refresh_sessions
    `;
    expect(count).toBe(1);
  });

  test('rejects session creation and rotation for disabled users', async () => {
    await createUser();
    const existingHash = tokenHash('before-disable');
    await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: existingHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    await identityRepository.disableUser(USER_ONE_ID, now);

    await expectCode(
      sessionRepository.createRefreshSession({
        userId: USER_ONE_ID,
        tokenHash: tokenHash('disabled-create'),
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
      'USER_DISABLED',
    );
    await expectCode(
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: existingHash,
        replacementTokenHash: tokenHash('disabled-rotate'),
        replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
      'USER_DISABLED',
    );
  });

  test('serializes concurrent rotation and revokes the family on the losing reuse', async () => {
    await createUser();
    const originalHash = tokenHash('concurrent-original');
    const original = await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    const results = await Promise.allSettled([
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: originalHash,
        replacementTokenHash: tokenHash('concurrent-replacement-one'),
        replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
      sessionRepository.rotateRefreshSession({
        presentedTokenHash: originalHash,
        replacementTokenHash: tokenHash('concurrent-replacement-two'),
        replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'REFRESH_TOKEN_REUSED' },
    });

    const family = await client.sql<{ revoked_at: Date | string | null }[]>`
      SELECT revoked_at FROM refresh_sessions WHERE family_id = ${original.familyId}
    `;
    expect(family).toHaveLength(2);
    expect(family.every(({ revoked_at }) => revoked_at !== null)).toBe(true);
  });

  test('serializes ancestor reuse against a legal current-token rotation without deadlock', async () => {
    const firstClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const secondClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const firstRepository = createSessionRepository(firstClient, {
      now: () => new Date(now),
    });
    const secondRepository = createSessionRepository(secondClient, {
      now: () => new Date(now),
    });

    try {
      await createUser();
      for (let iteration = 0; iteration < 20; iteration += 1) {
        await client.sql`TRUNCATE TABLE refresh_sessions`;
        const ancestorHash = tokenHash(`ancestor-${iteration}`);
        const currentHash = tokenHash(`current-${iteration}`);
        const ancestor = await sessionRepository.createRefreshSession({
          userId: USER_ONE_ID,
          tokenHash: ancestorHash,
          expiresAt: new Date('2026-08-16T00:00:00.000Z'),
        });
        await sessionRepository.rotateRefreshSession({
          presentedTokenHash: ancestorHash,
          replacementTokenHash: currentHash,
          replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
        });

        const [reuseResult, rotationResult] = await Promise.allSettled([
          firstRepository.rotateRefreshSession({
            presentedTokenHash: ancestorHash,
            replacementTokenHash: tokenHash(`unused-${iteration}`),
            replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
          }),
          secondRepository.rotateRefreshSession({
            presentedTokenHash: currentHash,
            replacementTokenHash: tokenHash(`next-${iteration}`),
            replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
          }),
        ]);

        expect(reuseResult).toMatchObject({
          status: 'rejected',
          reason: { code: 'REFRESH_TOKEN_REUSED' },
        });
        if (rotationResult.status === 'rejected') {
          expect(rotationResult.reason).toMatchObject({
            code: 'REFRESH_SESSION_REVOKED',
          });
        }

        const family = await client.sql<{ revoked_at: Date | string | null }[]>`
            SELECT revoked_at
            FROM refresh_sessions
            WHERE family_id = ${ancestor.familyId}
          `;
        expect(family.length === 2 || family.length === 3).toBe(true);
        expect(family.every(({ revoked_at }) => revoked_at !== null)).toBe(
          true,
        );
      }
    } finally {
      await Promise.all([firstClient.close(), secondClient.close()]);
    }
  }, 60_000);

  test('serializes two simultaneous ancestor-token reuse attempts without deadlock', async () => {
    const firstClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const secondClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const firstRepository = createSessionRepository(firstClient, {
      now: () => new Date(now),
    });
    const secondRepository = createSessionRepository(secondClient, {
      now: () => new Date(now),
    });

    try {
      await createUser();
      for (let iteration = 0; iteration < 20; iteration += 1) {
        await client.sql`TRUNCATE TABLE refresh_sessions`;
        const oldestHash = tokenHash(`oldest-${iteration}`);
        const middleHash = tokenHash(`middle-${iteration}`);
        const currentHash = tokenHash(`latest-${iteration}`);
        const oldest = await sessionRepository.createRefreshSession({
          userId: USER_ONE_ID,
          tokenHash: oldestHash,
          expiresAt: new Date('2026-08-16T00:00:00.000Z'),
        });
        await sessionRepository.rotateRefreshSession({
          presentedTokenHash: oldestHash,
          replacementTokenHash: middleHash,
          replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
        });
        await sessionRepository.rotateRefreshSession({
          presentedTokenHash: middleHash,
          replacementTokenHash: currentHash,
          replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
        });

        const results = await Promise.allSettled([
          firstRepository.rotateRefreshSession({
            presentedTokenHash: oldestHash,
            replacementTokenHash: tokenHash(`unused-oldest-${iteration}`),
            replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
          }),
          secondRepository.rotateRefreshSession({
            presentedTokenHash: middleHash,
            replacementTokenHash: tokenHash(`unused-middle-${iteration}`),
            replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
          }),
        ]);

        expect(results).toEqual([
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ code: 'REFRESH_TOKEN_REUSED' }),
          }),
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ code: 'REFRESH_TOKEN_REUSED' }),
          }),
        ]);

        const family = await client.sql<{ revoked_at: Date | string | null }[]>`
            SELECT revoked_at
            FROM refresh_sessions
            WHERE family_id = ${oldest.familyId}
          `;
        expect(family).toHaveLength(3);
        expect(family.every(({ revoked_at }) => revoked_at !== null)).toBe(
          true,
        );
      }
    } finally {
      await Promise.all([firstClient.close(), secondClient.close()]);
    }
  }, 60_000);

  test('returns session-not-found when the user is deleted between lookup and lock', async () => {
    await createUser();
    const originalHash = tokenHash('deleted-during-lock-original');
    await sessionRepository.createRefreshSession({
      userId: USER_ONE_ID,
      tokenHash: originalHash,
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    const blockerClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const deleterClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const rotationClient = createDatabaseClient(databaseUrl, {
      maxConnections: 1,
    });
    const rotationRepository = createSessionRepository(rotationClient, {
      now: () => new Date(now),
    });
    let releaseUserLock: () => void = () => undefined;
    let blocker: Promise<unknown> | undefined;
    let deletion: Promise<unknown> | undefined;

    try {
      let signalUserLocked!: () => void;
      const userLocked = new Promise<void>((resolve) => {
        signalUserLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseUserLock = resolve;
      });
      blocker = blockerClient.sql.begin(async (transaction) => {
        await transaction`
          SELECT id FROM users WHERE id = ${USER_ONE_ID} FOR UPDATE
        `;
        signalUserLocked();
        await release;
      });
      await userLocked;

      let signalDeletionPid!: (pid: number) => void;
      const deletionPid = new Promise<number>((resolve) => {
        signalDeletionPid = resolve;
      });
      deletion = deleterClient.sql.begin(async (transaction) => {
        const [{ pid }] = await transaction<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `;
        signalDeletionPid(pid);
        await transaction`DELETE FROM users WHERE id = ${USER_ONE_ID}`;
      });
      const pid = await deletionPid;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [activity] = await client.sql<
          { wait_event_type: string | null }[]
        >`
          SELECT wait_event_type
          FROM pg_stat_activity
          WHERE pid = ${pid}
        `;
        if (activity?.wait_event_type === 'Lock') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const rotationExpectation = expect(
        rotationRepository.rotateRefreshSession({
          presentedTokenHash: originalHash,
          replacementTokenHash: tokenHash('deleted-during-lock-replacement'),
          replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'REFRESH_SESSION_NOT_FOUND' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseUserLock();
      await Promise.all([blocker, deletion, rotationExpectation]);
    } finally {
      releaseUserLock();
      await Promise.allSettled([blocker, deletion].filter(Boolean));
      await Promise.all([
        blockerClient.close(),
        deleterClient.close(),
        rotationClient.close(),
      ]);
    }
  });
});
