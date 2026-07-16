import { randomUUID } from 'node:crypto';

import {
  cloneValidDate,
  fromDatabaseTimestamp,
  toUtcTimestamp,
  type DatabaseClient,
} from './client.js';

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

export interface IdentityRepositoryDependencies {
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface IdentityRepository {
  createEmailUser(input: CreateEmailUserInput): Promise<UserRecord>;
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
