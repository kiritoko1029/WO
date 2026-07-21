import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
  disabledAt: timestamp('disabled_at', { mode: 'date', withTimezone: true }),
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    identifierNormalized: text('identifier_normalized').notNull(),
    verifiedAt: timestamp('verified_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('auth_identities_provider_identifier_normalized_unique').on(
      table.provider,
      table.identifierNormalized,
    ),
    index('auth_identities_user_id_index').on(table.userId),
  ],
);

export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
});

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: varchar('token_hash', { length: 64 })
      .notNull()
      .unique('refresh_sessions_token_hash_unique'),
    expiresAt: timestamp('expires_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    rotatedAt: timestamp('rotated_at', { mode: 'date', withTimezone: true }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index('refresh_sessions_user_id_index').on(table.userId),
    index('refresh_sessions_family_id_index').on(table.familyId),
  ],
);

export const emailVerificationChallenges = pgTable(
  'email_verification_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailNormalized: text('email_normalized').notNull(),
    purpose: text('purpose').notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index('email_verification_challenges_user_purpose_index').on(
      table.userId,
      table.purpose,
    ),
    index('email_verification_challenges_email_index').on(
      table.emailNormalized,
    ),
  ],
);

export const databaseSchema = {
  users,
  authIdentities,
  passwordCredentials,
  refreshSessions,
  emailVerificationChallenges,
} as const;
