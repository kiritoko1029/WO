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

export interface EmailUserRecord {
  readonly emailNormalized: string;
  readonly user: UserRecord;
}

export interface EmailCredentialRecord extends EmailUserRecord {
  readonly passwordHash: string;
}

export interface EmailUserWithRefreshSessionRecord extends EmailUserRecord {
  readonly session: RefreshSessionRecord;
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
  disableUser(userId: string, disabledAt?: Date): Promise<UserRecord>;
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
          display_name: string;
          password_hash: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        SELECT
          u.id AS user_id,
          i.identifier_normalized AS email_normalized,
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
          display_name: string;
          created_at: Date | string;
          disabled_at: Date | string | null;
        }[]
      >`
        SELECT
          u.id AS user_id,
          i.identifier_normalized AS email_normalized,
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
  };
}
