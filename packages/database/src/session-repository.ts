import type postgres from 'postgres';

import {
  cloneValidDate,
  fromDatabaseTimestamp,
  toUtcTimestamp,
  type DatabaseClient,
} from './client.js';
import { assertCanonicalUuid } from './database-uuid.js';

declare const refreshTokenHashBrand: unique symbol;

export type RefreshTokenHash = string & {
  readonly [refreshTokenHashBrand]: true;
};

const refreshTokenHashPattern = /^[0-9a-f]{64}$/u;

export function parseRefreshTokenHash(value: string): RefreshTokenHash {
  if (!refreshTokenHashPattern.test(value)) {
    throw new TypeError(
      'Refresh token hash must be 64 lowercase hexadecimal characters',
    );
  }
  return value as RefreshTokenHash;
}

export type SessionRepositoryErrorCode =
  | 'REFRESH_SESSION_CONFLICT'
  | 'REFRESH_SESSION_EXPIRED'
  | 'REFRESH_SESSION_NOT_FOUND'
  | 'REFRESH_SESSION_PERSISTENCE_ERROR'
  | 'REFRESH_SESSION_REVOKED'
  | 'REFRESH_TOKEN_REUSED'
  | 'USER_DISABLED'
  | 'USER_NOT_FOUND';

const sessionErrorMessages: Record<SessionRepositoryErrorCode, string> = {
  REFRESH_SESSION_CONFLICT: 'Refresh session could not be created',
  REFRESH_SESSION_EXPIRED: 'Refresh session has expired',
  REFRESH_SESSION_NOT_FOUND: 'Refresh session not found',
  REFRESH_SESSION_PERSISTENCE_ERROR: 'Refresh session persistence failed',
  REFRESH_SESSION_REVOKED: 'Refresh session has been revoked',
  REFRESH_TOKEN_REUSED: 'Refresh token reuse detected',
  USER_DISABLED: 'User is disabled',
  USER_NOT_FOUND: 'User not found',
};

export class SessionRepositoryError extends Error {
  constructor(readonly code: SessionRepositoryErrorCode) {
    super(sessionErrorMessages[code]);
    this.name = 'SessionRepositoryError';
  }
}

export interface RefreshSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateRefreshSessionInput {
  readonly sessionId: string;
  readonly familyId: string;
  readonly userId: string;
  readonly tokenHash: RefreshTokenHash;
  readonly expiresAt: Date;
}

export interface RotateRefreshSessionInput {
  readonly replacementSessionId: string;
  readonly presentedTokenHash: RefreshTokenHash;
  readonly replacementTokenHash: RefreshTokenHash;
  readonly replacementExpiresAt: Date;
}

export interface RevokeRefreshTokenFamilyInput {
  readonly presentedTokenHash: RefreshTokenHash;
}

export interface RefreshTokenFamilyRevocationRecord {
  readonly userId: string;
  readonly familyId: string;
  readonly revokedAt: Date;
}

export interface SessionRepositoryDependencies {
  readonly now?: () => Date;
}

export interface SessionRepository {
  createRefreshSession(
    input: CreateRefreshSessionInput,
  ): Promise<RefreshSessionRecord>;
  rotateRefreshSession(
    input: RotateRefreshSessionInput,
  ): Promise<RefreshSessionRecord>;
  findRefreshSessionUserId(tokenHash: RefreshTokenHash): Promise<string | null>;
  revokeRefreshTokenFamily(
    input: RevokeRefreshTokenFamilyInput,
  ): Promise<RefreshTokenFamilyRevocationRecord>;
}

interface PostgreSqlError {
  readonly code?: unknown;
}

interface LockedSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly expires_at: Date | string;
  readonly rotated_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

type SessionOutcome =
  | { readonly ok: true; readonly session: RefreshSessionRecord }
  | { readonly ok: false; readonly code: SessionRepositoryErrorCode };

type RevocationOutcome =
  | {
      readonly ok: true;
      readonly revocation: RefreshTokenFamilyRevocationRecord;
    }
  | { readonly ok: false; readonly code: SessionRepositoryErrorCode };

function isUniqueViolation(error: unknown): error is PostgreSqlError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as PostgreSqlError).code === '23505'
  );
}

function hasPostgreSqlCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as PostgreSqlError).code === code
  );
}

const deadlockRetryAttempts = 3;

async function withDeadlockRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= deadlockRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!hasPostgreSqlCode(error, '40P01')) {
        throw error;
      }
      if (attempt === deadlockRetryAttempts) {
        throw new SessionRepositoryError('REFRESH_SESSION_PERSISTENCE_ERROR');
      }
    }
  }
  throw new SessionRepositoryError('REFRESH_SESSION_PERSISTENCE_ERROR');
}

function assertTokenHash(value: RefreshTokenHash): void {
  parseRefreshTokenHash(value);
}

function throwIfFailed(outcome: SessionOutcome): RefreshSessionRecord {
  if (!outcome.ok) {
    throw new SessionRepositoryError(outcome.code);
  }
  return outcome.session;
}

function throwIfRevocationFailed(
  outcome: RevocationOutcome,
): RefreshTokenFamilyRevocationRecord {
  if (!outcome.ok) {
    throw new SessionRepositoryError(outcome.code);
  }
  return outcome.revocation;
}

type TransactionSql = postgres.TransactionSql;

async function lockUser(
  transaction: TransactionSql,
  userId: string,
): Promise<{ readonly disabled_at: Date | string | null } | undefined> {
  const rows = await transaction<{ disabled_at: Date | string | null }[]>`
    SELECT disabled_at
    FROM users
    WHERE id = ${userId}
    FOR UPDATE
  `;
  return rows[0];
}

export function createSessionRepository(
  client: DatabaseClient,
  dependencies: SessionRepositoryDependencies = {},
): SessionRepository {
  const now = dependencies.now ?? (() => new Date());

  return {
    async createRefreshSession(input) {
      assertTokenHash(input.tokenHash);
      assertCanonicalUuid(input.sessionId, 'Session id');
      assertCanonicalUuid(input.familyId, 'Session family id');
      assertCanonicalUuid(input.userId, 'User id');
      const createdAt = cloneValidDate(now());
      const expiresAt = cloneValidDate(input.expiresAt);
      const createdAtTimestamp = toUtcTimestamp(createdAt);
      const expiresAtTimestamp = toUtcTimestamp(expiresAt);
      const id = input.sessionId;
      const familyId = input.familyId;

      try {
        const outcome = await withDeadlockRetry(async () =>
          client.sql.begin<SessionOutcome>(async (transaction) => {
            const user = await lockUser(transaction, input.userId);
            if (!user) {
              return { ok: false, code: 'USER_NOT_FOUND' };
            }
            if (user.disabled_at !== null) {
              return { ok: false, code: 'USER_DISABLED' };
            }

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
              ${id},
              ${input.userId},
              ${familyId},
              ${input.tokenHash},
              ${expiresAtTimestamp},
              NULL,
              NULL,
              ${createdAtTimestamp}
            )
          `;

            return {
              ok: true,
              session: {
                id,
                userId: input.userId,
                familyId,
                expiresAt,
                rotatedAt: null,
                revokedAt: null,
                createdAt,
              },
            };
          }),
        );
        return throwIfFailed(outcome);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SessionRepositoryError('REFRESH_SESSION_CONFLICT');
        }
        throw error;
      }
    },

    async rotateRefreshSession(input) {
      assertTokenHash(input.presentedTokenHash);
      assertTokenHash(input.replacementTokenHash);
      assertCanonicalUuid(input.replacementSessionId, 'Replacement session id');
      const rotatedAt = cloneValidDate(now());
      const replacementExpiresAt = cloneValidDate(input.replacementExpiresAt);
      const rotatedAtTimestamp = toUtcTimestamp(rotatedAt);
      const replacementExpiresAtTimestamp =
        toUtcTimestamp(replacementExpiresAt);

      try {
        const outcome = await withDeadlockRetry(async () =>
          client.sql.begin<SessionOutcome>(async (transaction) => {
            const identities = await transaction<{ user_id: string }[]>`
              SELECT user_id
              FROM refresh_sessions
              WHERE token_hash = ${input.presentedTokenHash}
            `;
            const identity = identities[0];
            if (!identity) {
              return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
            }

            const user = await lockUser(transaction, identity.user_id);
            if (!user) {
              return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
            }
            if (user.disabled_at !== null) {
              return { ok: false, code: 'USER_DISABLED' };
            }

            const rows = await transaction<LockedSessionRow[]>`
            SELECT
              id,
              user_id,
              family_id,
              expires_at,
              rotated_at,
              revoked_at
            FROM refresh_sessions
            WHERE
              token_hash = ${input.presentedTokenHash}
              AND user_id = ${identity.user_id}
            FOR UPDATE
          `;
            const presented = rows[0];
            if (!presented) {
              return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
            }
            if (presented.rotated_at !== null) {
              await transaction`
              UPDATE refresh_sessions
              SET revoked_at = COALESCE(revoked_at, ${rotatedAtTimestamp})
              WHERE family_id = ${presented.family_id}
            `;
              return { ok: false, code: 'REFRESH_TOKEN_REUSED' };
            }
            if (presented.revoked_at !== null) {
              return { ok: false, code: 'REFRESH_SESSION_REVOKED' };
            }
            if (
              fromDatabaseTimestamp(presented.expires_at).getTime() <=
              rotatedAt.getTime()
            ) {
              return { ok: false, code: 'REFRESH_SESSION_EXPIRED' };
            }

            const replacementId = input.replacementSessionId;
            await transaction`
            UPDATE refresh_sessions
            SET rotated_at = ${rotatedAtTimestamp}
            WHERE id = ${presented.id}
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
              ${replacementId},
              ${presented.user_id},
              ${presented.family_id},
              ${input.replacementTokenHash},
              ${replacementExpiresAtTimestamp},
              NULL,
              NULL,
              ${rotatedAtTimestamp}
            )
          `;

            return {
              ok: true,
              session: {
                id: replacementId,
                userId: presented.user_id,
                familyId: presented.family_id,
                expiresAt: replacementExpiresAt,
                rotatedAt: null,
                revokedAt: null,
                createdAt: rotatedAt,
              },
            };
          }),
        );
        return throwIfFailed(outcome);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SessionRepositoryError('REFRESH_SESSION_CONFLICT');
        }
        throw error;
      }
    },

    async findRefreshSessionUserId(tokenHash) {
      assertTokenHash(tokenHash);
      const rows = await client.sql<{ user_id: string }[]>`
        SELECT user_id
        FROM refresh_sessions
        WHERE token_hash = ${tokenHash}
      `;
      return rows[0]?.user_id ?? null;
    },

    async revokeRefreshTokenFamily(input) {
      assertTokenHash(input.presentedTokenHash);
      const revokedAt = cloneValidDate(now());
      const revokedAtTimestamp = toUtcTimestamp(revokedAt);

      const outcome = await withDeadlockRetry(async () =>
        client.sql.begin<RevocationOutcome>(async (transaction) => {
          const identities = await transaction<{ user_id: string }[]>`
            SELECT user_id
            FROM refresh_sessions
            WHERE token_hash = ${input.presentedTokenHash}
          `;
          const identity = identities[0];
          if (!identity) {
            return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
          }

          const user = await lockUser(transaction, identity.user_id);
          if (!user) {
            return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
          }

          const rows = await transaction<LockedSessionRow[]>`
            SELECT
              id,
              user_id,
              family_id,
              expires_at,
              rotated_at,
              revoked_at
            FROM refresh_sessions
            WHERE
              token_hash = ${input.presentedTokenHash}
              AND user_id = ${identity.user_id}
            FOR UPDATE
          `;
          const presented = rows[0];
          if (!presented) {
            return { ok: false, code: 'REFRESH_SESSION_NOT_FOUND' };
          }

          await transaction`
            UPDATE refresh_sessions
            SET revoked_at = COALESCE(revoked_at, ${revokedAtTimestamp})
            WHERE family_id = ${presented.family_id}
          `;

          return {
            ok: true,
            revocation: {
              userId: presented.user_id,
              familyId: presented.family_id,
              revokedAt:
                presented.revoked_at === null
                  ? revokedAt
                  : fromDatabaseTimestamp(presented.revoked_at),
            },
          };
        }),
      );
      return throwIfRevocationFailed(outcome);
    },
  };
}
