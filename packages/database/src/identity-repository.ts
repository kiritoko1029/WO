import { randomUUID } from 'node:crypto';

import {
  cloneValidDate,
  fromDatabaseTimestamp,
  toUtcTimestamp,
  type DatabaseClient,
} from './client.js';
import { assertCanonicalUuid } from './database-uuid.js';
import {
  SessionRepositoryError,
  parseRefreshTokenHash,
  type RefreshSessionRecord,
  type RefreshTokenHash,
} from './session-repository.js';

export type IdentityRepositoryErrorCode =
  | 'IDENTITY_CONFLICT'
  | 'IDENTITY_INVALID'
  | 'IDENTITY_PERSISTENCE_ERROR'
  | 'USER_CONFLICT'
  | 'USER_NOT_FOUND';

const identityErrorMessages: Record<IdentityRepositoryErrorCode, string> = {
  IDENTITY_CONFLICT:
    'An identity with that provider and identifier already exists',
  IDENTITY_INVALID: 'Identity identifier is invalid',
  IDENTITY_PERSISTENCE_ERROR: 'Identity persistence failed',
  USER_CONFLICT: 'A user with that identifier already exists',
  USER_NOT_FOUND: 'User not found',
};

export class IdentityRepositoryError extends Error {
  constructor(readonly code: IdentityRepositoryErrorCode) {
    super(identityErrorMessages[code]);
    this.name = 'IdentityRepositoryError';
  }
}

export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface CreateEmailUserInput {
  readonly userId: string;
  readonly emailNormalized: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

export interface CreateEmailUserWithRefreshSessionInput extends CreateEmailUserInput {
  readonly identityId: string;
  readonly session: Readonly<{
    sessionId: string;
    familyId: string;
    tokenHash: RefreshTokenHash;
    expiresAt: Date;
  }>;
}

export type EmailVerificationPurpose = 'register' | 'rebind';

export interface EmailUserRecord {
  readonly emailNormalized: string;
  readonly verifiedAt: Date | null;
  readonly user: UserRecord;
}

export interface EmailCredentialRecord extends EmailUserRecord {
  readonly passwordHash: string;
}

export interface EmailUserWithRefreshSessionRecord extends EmailUserRecord {
  readonly session: RefreshSessionRecord;
}

export interface CreateEmailVerificationChallengeInput {
  readonly challengeId: string;
  readonly userId: string;
  readonly emailNormalized: string;
  readonly purpose: EmailVerificationPurpose;
  readonly codeHash: string;
  readonly expiresAt: Date;
}

export interface EmailVerificationChallengeRecord {
  readonly id: string;
  readonly userId: string;
  readonly emailNormalized: string;
  readonly purpose: EmailVerificationPurpose;
  readonly codeHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface IdentityRepositoryDependencies {
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface IdentityRepository {
  createEmailUser(input: CreateEmailUserInput): Promise<UserRecord>;
  createEmailUserWithRefreshSession(
    input: CreateEmailUserWithRefreshSessionInput,
  ): Promise<EmailUserWithRefreshSessionRecord>;
  findEmailCredential(
    emailNormalized: string,
  ): Promise<EmailCredentialRecord | null>;
  findEmailUserById(userId: string): Promise<EmailUserRecord | null>;
  listEmailUsers(): Promise<readonly EmailUserRecord[]>;
  disableUser(userId: string, disabledAt?: Date): Promise<UserRecord>;
  enableUser(userId: string): Promise<UserRecord>;
  markEmailVerified(userId: string, verifiedAt?: Date): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  updateEmailIdentity(
    userId: string,
    emailNormalized: string,
  ): Promise<EmailUserRecord>;
  replaceEmailVerificationChallenge(
    input: CreateEmailVerificationChallengeInput,
  ): Promise<void>;
  findLatestEmailVerificationChallenge(
    userId: string,
    purpose: EmailVerificationPurpose,
  ): Promise<EmailVerificationChallengeRecord | null>;
  consumeEmailVerificationChallenge(challengeId: string): Promise<boolean>;
}

interface PostgreSqlError {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly constraint_name?: unknown;
}

function isUniqueViolation(error: unknown): error is PostgreSqlError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as PostgreSqlError).code === '23505'
  );
}

function constraintName(error: PostgreSqlError): string | undefined {
  const name = error.constraint_name ?? error.constraint;
  return typeof name === 'string' ? name : undefined;
}

const basicEmailIdentityPattern = /^[^\s@]+@[^\s@]+$/u;

function hasIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function canonicalizeEmailIdentity(value: string): string {
  const canonical = value.trim().toLowerCase();
  if (
    canonical.length === 0 ||
    canonical.length > 254 ||
    hasIdentityControlCharacter(canonical) ||
    !basicEmailIdentityPattern.test(canonical)
  ) {
    throw new IdentityRepositoryError('IDENTITY_INVALID');
  }
  return canonical;
}

export function createIdentityRepository(
  client: DatabaseClient,
  dependencies: IdentityRepositoryDependencies = {},
): IdentityRepository {
  const now = dependencies.now ?? (() => new Date());
  const createUuid = dependencies.randomUUID ?? randomUUID;

  return {
    async createEmailUser(input) {
      const emailCanonical = canonicalizeEmailIdentity(input.emailNormalized);
      const createdAt = cloneValidDate(now());
      const createdAtTimestamp = toUtcTimestamp(createdAt);
      const identityId = createUuid();
      assertCanonicalUuid(input.userId, 'User id');
      assertCanonicalUuid(identityId, 'Identity id');

      try {
        await client.sql.begin(async (transaction) => {
          await transaction`
            INSERT INTO users (id, display_name, created_at, disabled_at)
            VALUES (${input.userId}, ${input.displayName}, ${createdAtTimestamp}, NULL)
          `;
          await transaction`
            INSERT INTO auth_identities (
              id,
              user_id,
              provider,
              identifier_normalized,
              verified_at
            )
            VALUES (
              ${identityId},
              ${input.userId},
              'email',
              ${emailCanonical},
              NULL
            )
          `;
          await transaction`
            INSERT INTO password_credentials (
              user_id,
              password_hash,
              password_changed_at
            )
            VALUES (${input.userId}, ${input.passwordHash}, ${createdAtTimestamp})
          `;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (
            constraintName(error) ===
            'auth_identities_provider_identifier_normalized_unique'
          ) {
            throw new IdentityRepositoryError('IDENTITY_CONFLICT');
          }
          if (constraintName(error) === 'users_pkey') {
            throw new IdentityRepositoryError('USER_CONFLICT');
          }
          throw new IdentityRepositoryError('IDENTITY_PERSISTENCE_ERROR');
        }
        throw error;
      }

      return {
        id: input.userId,
        displayName: input.displayName,
        createdAt,
        disabledAt: null,
      };
    },

    async createEmailUserWithRefreshSession(input) {
      const emailCanonical = canonicalizeEmailIdentity(input.emailNormalized);
      parseRefreshTokenHash(input.session.tokenHash);
      assertCanonicalUuid(input.userId, 'User id');
      assertCanonicalUuid(input.identityId, 'Identity id');
      assertCanonicalUuid(input.session.sessionId, 'Session id');
      assertCanonicalUuid(input.session.familyId, 'Session family id');
      const createdAt = cloneValidDate(now());
      const expiresAt = cloneValidDate(input.session.expiresAt);
      const createdAtTimestamp = toUtcTimestamp(createdAt);
      const expiresAtTimestamp = toUtcTimestamp(expiresAt);

      try {
        await client.sql.begin(async (transaction) => {
          await transaction`
            INSERT INTO users (id, display_name, created_at, disabled_at)
            VALUES (${input.userId}, ${input.displayName}, ${createdAtTimestamp}, NULL)
          `;
          await transaction`
            INSERT INTO auth_identities (
              id,
              user_id,
              provider,
              identifier_normalized,
              verified_at
            )
            VALUES (
              ${input.identityId},
              ${input.userId},
              'email',
              ${emailCanonical},
              NULL
            )
          `;
          await transaction`
            INSERT INTO password_credentials (
              user_id,
              password_hash,
              password_changed_at
            )
            VALUES (${input.userId}, ${input.passwordHash}, ${createdAtTimestamp})
          `;
          await transaction`
            INSERT INTO refresh_sessions (
              id,
              user_id,
              family_id,
              token_hash,
              expires_at,
              rotated_at,
              revoked_at,
              created_at
            )
            VALUES (
              ${input.session.sessionId},
              ${input.userId},
              ${input.session.familyId},
              ${input.session.tokenHash},
              ${expiresAtTimestamp},
              NULL,
              NULL,
              ${createdAtTimestamp}
            )
          `;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const constraint = constraintName(error);
          if (
            constraint ===
            'auth_identities_provider_identifier_normalized_unique'
          ) {
            throw new IdentityRepositoryError('IDENTITY_CONFLICT');
          }
          if (constraint === 'users_pkey') {
            throw new IdentityRepositoryError('USER_CONFLICT');
          }
          if (
            constraint === 'refresh_sessions_pkey' ||
            constraint === 'refresh_sessions_token_hash_unique'
          ) {
            throw new SessionRepositoryError('REFRESH_SESSION_CONFLICT');
          }
          throw new IdentityRepositoryError('IDENTITY_PERSISTENCE_ERROR');
        }
        throw error;
      }

      const user: UserRecord = {
        id: input.userId,
        displayName: input.displayName,
        createdAt,
        disabledAt: null,
      };
      return {
        emailNormalized: emailCanonical,
        verifiedAt: null,
        user,
        session: {
          id: input.session.sessionId,
          userId: input.userId,
          familyId: input.session.familyId,
          expiresAt,
          rotatedAt: null,
          revokedAt: null,
          createdAt,
        },
      };
    },

    async findEmailCredential(emailNormalized) {
      const emailCanonical = canonicalizeEmailIdentity(emailNormalized);
      const rows = await client.sql<
        {
          user_id: string;
          email_normalized: string;
          verified_at: Date | string | null;
          display_name: string;
          password_hash: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        SELECT
          u.id AS user_id,
          i.identifier_normalized AS email_normalized,
          i.verified_at,
          u.display_name,
          p.password_hash,
          u.created_at,
          u.disabled_at
        FROM auth_identities i
        JOIN users u ON u.id = i.user_id
        JOIN password_credentials p ON p.user_id = u.id
        WHERE i.provider = 'email' AND i.identifier_normalized = ${emailCanonical}
      `;
      const credential = rows[0];
      if (!credential) {
        return null;
      }

      return {
        emailNormalized: credential.email_normalized,
        verifiedAt:
          credential.verified_at === null
            ? null
            : fromDatabaseTimestamp(credential.verified_at),
        passwordHash: credential.password_hash,
        user: {
          id: credential.user_id,
          displayName: credential.display_name,
          createdAt: fromDatabaseTimestamp(credential.created_at),
          disabledAt:
            credential.disabled_at === null
              ? null
              : fromDatabaseTimestamp(credential.disabled_at),
        },
      };
    },

    async findEmailUserById(userId) {
      const rows = await client.sql<
        {
          user_id: string;
          email_normalized: string;
          verified_at: Date | string | null;
          display_name: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        SELECT
          u.id AS user_id,
          i.identifier_normalized AS email_normalized,
          i.verified_at,
          u.display_name,
          u.created_at,
          u.disabled_at
        FROM users u
        JOIN auth_identities i ON i.user_id = u.id
        WHERE u.id = ${userId} AND i.provider = 'email'
      `;
      const identity = rows[0];
      if (!identity) {
        return null;
      }

      return {
        emailNormalized: identity.email_normalized,
        verifiedAt:
          identity.verified_at === null
            ? null
            : fromDatabaseTimestamp(identity.verified_at),
        user: {
          id: identity.user_id,
          displayName: identity.display_name,
          createdAt: fromDatabaseTimestamp(identity.created_at),
          disabledAt:
            identity.disabled_at === null
              ? null
              : fromDatabaseTimestamp(identity.disabled_at),
        },
      };
    },

    async listEmailUsers() {
      const rows = await client.sql<
        {
          user_id: string;
          email_normalized: string;
          verified_at: Date | string | null;
          display_name: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        SELECT
          u.id AS user_id,
          i.identifier_normalized AS email_normalized,
          i.verified_at,
          u.display_name,
          u.created_at,
          u.disabled_at
        FROM users u
        JOIN auth_identities i ON i.user_id = u.id
        WHERE i.provider = 'email'
        ORDER BY u.created_at DESC
      `;
      return rows.map((identity) =>
        Object.freeze({
          emailNormalized: identity.email_normalized,
          verifiedAt:
            identity.verified_at === null
              ? null
              : fromDatabaseTimestamp(identity.verified_at),
          user: Object.freeze({
            id: identity.user_id,
            displayName: identity.display_name,
            createdAt: fromDatabaseTimestamp(identity.created_at),
            disabledAt:
              identity.disabled_at === null
                ? null
                : fromDatabaseTimestamp(identity.disabled_at),
          }),
        }),
      );
    },

    async disableUser(userId, disabledAt = now()) {
      const disabledAtSnapshot = cloneValidDate(disabledAt);
      const disabledAtTimestamp = toUtcTimestamp(disabledAtSnapshot);
      const rows = await client.sql<
        {
          id: string;
          display_name: string;
          created_at: Date | string;
          disabled_at: Date | string;
        }[]
      >`
        UPDATE users
        SET disabled_at = ${disabledAtTimestamp}
        WHERE id = ${userId}
        RETURNING id, display_name, created_at, disabled_at
      `;
      const user = rows[0];
      if (!user) {
        throw new IdentityRepositoryError('USER_NOT_FOUND');
      }

      return {
        id: user.id,
        displayName: user.display_name,
        createdAt: fromDatabaseTimestamp(user.created_at),
        disabledAt: fromDatabaseTimestamp(user.disabled_at),
      };
    },

    async enableUser(userId) {
      assertCanonicalUuid(userId, 'User id');
      const rows = await client.sql<
        {
          id: string;
          display_name: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        UPDATE users
        SET disabled_at = NULL
        WHERE id = ${userId}
        RETURNING id, display_name, created_at, disabled_at
      `;
      const user = rows[0];
      if (!user) {
        throw new IdentityRepositoryError('USER_NOT_FOUND');
      }
      return {
        id: user.id,
        displayName: user.display_name,
        createdAt: fromDatabaseTimestamp(user.created_at),
        disabledAt: null,
      };
    },

    async markEmailVerified(userId, verifiedAt = now()) {
      assertCanonicalUuid(userId, 'User id');
      const verifiedAtTimestamp = toUtcTimestamp(cloneValidDate(verifiedAt));
      const rows = await client.sql<{ user_id: string }[]>`
        UPDATE auth_identities
        SET verified_at = ${verifiedAtTimestamp}
        WHERE user_id = ${userId} AND provider = 'email'
        RETURNING user_id
      `;
      if (rows[0] === undefined) {
        throw new IdentityRepositoryError('USER_NOT_FOUND');
      }
    },

    async updatePasswordHash(userId, passwordHash) {
      assertCanonicalUuid(userId, 'User id');
      const changedAt = toUtcTimestamp(cloneValidDate(now()));
      const rows = await client.sql<{ user_id: string }[]>`
        UPDATE password_credentials
        SET password_hash = ${passwordHash}, password_changed_at = ${changedAt}
        WHERE user_id = ${userId}
        RETURNING user_id
      `;
      if (rows[0] === undefined) {
        throw new IdentityRepositoryError('USER_NOT_FOUND');
      }
    },

    async updateEmailIdentity(userId, emailNormalized) {
      assertCanonicalUuid(userId, 'User id');
      const emailCanonical = canonicalizeEmailIdentity(emailNormalized);
      const verifiedAtTimestamp = toUtcTimestamp(cloneValidDate(now()));
      try {
        const rows = await client.sql<
          {
            user_id: string;
            email_normalized: string;
            verified_at: Date | string;
            display_name: string;
            created_at: Date | string;
            disabled_at: Date | string | null;
          }[]
        >`
          UPDATE auth_identities AS i
          SET
            identifier_normalized = ${emailCanonical},
            verified_at = ${verifiedAtTimestamp}
          FROM users AS u
          WHERE i.user_id = ${userId}
            AND i.provider = 'email'
            AND u.id = i.user_id
          RETURNING
            u.id AS user_id,
            i.identifier_normalized AS email_normalized,
            i.verified_at,
            u.display_name,
            u.created_at,
            u.disabled_at
        `;
        const identity = rows[0];
        if (identity === undefined) {
          throw new IdentityRepositoryError('USER_NOT_FOUND');
        }
        return {
          emailNormalized: identity.email_normalized,
          verifiedAt: fromDatabaseTimestamp(identity.verified_at),
          user: {
            id: identity.user_id,
            displayName: identity.display_name,
            createdAt: fromDatabaseTimestamp(identity.created_at),
            disabledAt:
              identity.disabled_at === null
                ? null
                : fromDatabaseTimestamp(identity.disabled_at),
          },
        };
      } catch (error) {
        if (
          isUniqueViolation(error) &&
          constraintName(error) ===
            'auth_identities_provider_identifier_normalized_unique'
        ) {
          throw new IdentityRepositoryError('IDENTITY_CONFLICT');
        }
        throw error;
      }
    },

    async replaceEmailVerificationChallenge(input) {
      assertCanonicalUuid(input.challengeId, 'Challenge id');
      assertCanonicalUuid(input.userId, 'User id');
      const emailCanonical = canonicalizeEmailIdentity(input.emailNormalized);
      if (input.purpose !== 'register' && input.purpose !== 'rebind') {
        throw new IdentityRepositoryError('IDENTITY_INVALID');
      }
      const createdAt = cloneValidDate(now());
      const expiresAt = cloneValidDate(input.expiresAt);
      await client.sql.begin(async (transaction) => {
        await transaction`
          UPDATE email_verification_challenges
          SET consumed_at = ${toUtcTimestamp(createdAt)}
          WHERE user_id = ${input.userId}
            AND purpose = ${input.purpose}
            AND consumed_at IS NULL
        `;
        await transaction`
          INSERT INTO email_verification_challenges (
            id,
            user_id,
            email_normalized,
            purpose,
            code_hash,
            expires_at,
            consumed_at,
            created_at
          )
          VALUES (
            ${input.challengeId},
            ${input.userId},
            ${emailCanonical},
            ${input.purpose},
            ${input.codeHash},
            ${toUtcTimestamp(expiresAt)},
            NULL,
            ${toUtcTimestamp(createdAt)}
          )
        `;
      });
    },

    async findLatestEmailVerificationChallenge(userId, purpose) {
      assertCanonicalUuid(userId, 'User id');
      const rows = await client.sql<
        {
          id: string;
          user_id: string;
          email_normalized: string;
          purpose: string;
          code_hash: string;
          expires_at: Date | string;
          consumed_at: Date | string | null;
          created_at: Date | string;
        }[]
      >`
        SELECT
          id,
          user_id,
          email_normalized,
          purpose,
          code_hash,
          expires_at,
          consumed_at,
          created_at
        FROM email_verification_challenges
        WHERE user_id = ${userId}
          AND purpose = ${purpose}
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      if (row.purpose !== 'register' && row.purpose !== 'rebind') {
        return null;
      }
      return {
        id: row.id,
        userId: row.user_id,
        emailNormalized: row.email_normalized,
        purpose: row.purpose,
        codeHash: row.code_hash,
        expiresAt: fromDatabaseTimestamp(row.expires_at),
        consumedAt:
          row.consumed_at === null
            ? null
            : fromDatabaseTimestamp(row.consumed_at),
        createdAt: fromDatabaseTimestamp(row.created_at),
      };
    },

    async consumeEmailVerificationChallenge(challengeId) {
      assertCanonicalUuid(challengeId, 'Challenge id');
      const consumedAt = toUtcTimestamp(cloneValidDate(now()));
      const rows = await client.sql<{ id: string }[]>`
        UPDATE email_verification_challenges
        SET consumed_at = ${consumedAt}
        WHERE id = ${challengeId}
          AND consumed_at IS NULL
          AND expires_at > ${consumedAt}
        RETURNING id
      `;
      return rows[0] !== undefined;
    },
  };
}
