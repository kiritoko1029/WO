import { randomUUID } from 'node:crypto';
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
  migrateDatabase,
  type DatabaseClient,
} from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests',
  );

describe('atomic administrator bootstrap', () => {
  let client: DatabaseClient;
  const initial = {
    emailNormalized: 'admin@example.com',
    passwordHash: 'initial-password-hash',
  };
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

  test('creates one verified user with an identity-bound receipt', async () => {
    expect(
      await createAdminBootstrapRepository(client).ensure(initial),
    ).toMatchObject({ state: 'created' });
    const identity = await createIdentityRepository(client).findEmailCredential(
      initial.emailNormalized,
    );
    expect(identity?.verifiedAt).toBeInstanceOf(Date);
    expect(identity?.user.disabledAt).toBeNull();
    expect(identity?.passwordHash).toBe(initial.passwordHash);
    const receipts =
      await client.sql`SELECT user_id, identity_id, email_normalized FROM wo_meta.admin_bootstrap`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.user_id).toBe(identity?.user.id);
    expect(receipts[0]?.email_normalized).toBe(initial.emailNormalized);
  });

  test('serializes concurrent starts and preserves a changed password on restart', async () => {
    const repository = createAdminBootstrapRepository(client);
    expect(
      (
        await Promise.all([
          repository.ensure(initial),
          repository.ensure(initial),
        ])
      )
        .map((result) => result.state)
        .sort(),
    ).toEqual(['created', 'existing']);
    const identities = createIdentityRepository(client);
    const identity = await identities.findEmailCredential(
      initial.emailNormalized,
    );
    await identities.updatePasswordHash(
      identity!.user.id,
      'changed-password-hash',
    );
    expect(
      await repository.ensure({
        ...initial,
        passwordHash: 'different-startup-password',
      }),
    ).toMatchObject({ state: 'existing', userId: identity!.user.id });
    expect(
      (await identities.findEmailCredential(initial.emailNormalized))
        ?.passwordHash,
    ).toBe('changed-password-hash');
    expect(await identities.listEmailUsers()).toHaveLength(1);
  });

  test('rejects a pre-existing identity without a receipt and leaves it untouched', async () => {
    const identities = createIdentityRepository(client);
    await identities.createEmailUser({
      ...initial,
      userId: randomUUID(),
      displayName: 'Existing user',
    });
    await expect(
      createAdminBootstrapRepository(client).ensure(initial),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_CONFLICT' });
    expect(
      (await identities.findEmailCredential(initial.emailNormalized))
        ?.verifiedAt,
    ).toBeNull();
    expect(
      await client.sql`SELECT singleton FROM wo_meta.admin_bootstrap`,
    ).toHaveLength(0);
  });

  test('rejects a different email, disabled user, or changed linked identity', async () => {
    const repository = createAdminBootstrapRepository(client);
    const identities = createIdentityRepository(client);
    await repository.ensure(initial);
    await expect(
      repository.ensure({ ...initial, emailNormalized: 'other@example.com' }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_CONFLICT' });
    const identity = await identities.findEmailCredential(
      initial.emailNormalized,
    );
    await identities.disableUser(identity!.user.id);
    await expect(repository.ensure(initial)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CONFLICT',
    });
    expect(
      (await identities.findEmailCredential(initial.emailNormalized))?.user
        .disabledAt,
    ).not.toBeNull();
    await identities.enableUser(identity!.user.id);
    await identities.updateEmailIdentity(
      identity!.user.id,
      'changed@example.com',
    );
    await expect(repository.ensure(initial)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CONFLICT',
    });
    expect(
      await identities.findEmailCredential(initial.emailNormalized),
    ).toBeNull();
  });

  test('rolls back user, identity and credentials if the receipt cannot be persisted', async () => {
    await client.sql.unsafe(
      "ALTER TABLE wo_meta.admin_bootstrap ADD CONSTRAINT bootstrap_test_failure CHECK (email_normalized <> 'admin@example.com')",
    );
    try {
      await expect(
        createAdminBootstrapRepository(client).ensure(initial),
      ).rejects.toMatchObject({ code: 'BOOTSTRAP_PERSISTENCE_FAILED' });
      expect(await client.sql`SELECT id FROM users`).toHaveLength(0);
      expect(await client.sql`SELECT id FROM auth_identities`).toHaveLength(0);
      expect(
        await client.sql`SELECT user_id FROM password_credentials`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT singleton FROM wo_meta.admin_bootstrap`,
      ).toHaveLength(0);
    } finally {
      await client.sql.unsafe(
        'ALTER TABLE wo_meta.admin_bootstrap DROP CONSTRAINT bootstrap_test_failure',
      );
    }
  });
});
