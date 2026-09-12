import { randomUUID } from 'node:crypto';

import { toUtcTimestamp, type DatabaseClient } from './client.js';

export class AdminBootstrapError extends Error {
  constructor(
    readonly code: 'BOOTSTRAP_CONFLICT' | 'BOOTSTRAP_PERSISTENCE_FAILED',
  ) {
    super(
      code === 'BOOTSTRAP_CONFLICT'
        ? 'Administrator bootstrap conflicts with an existing identity or receipt'
        : 'Administrator bootstrap could not be completed',
    );
    this.name = code;
  }
}

export interface AdminBootstrapRepository {
  ensure(
    input: Readonly<{
      emailNormalized: string;
      passwordHash: string;
    }>,
  ): Promise<Readonly<{ state: 'created' | 'existing'; userId: string }>>;
}

/** The receipt and identity are committed together; a restart never updates credentials. */
export function createAdminBootstrapRepository(
  client: DatabaseClient,
): AdminBootstrapRepository {
  return {
    async ensure(input) {
      try {
        return await client.sql.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(22351, 2)`;
          const receipts = await transaction<
            {
              email_normalized: string;
              identity_email: string | null;
              identity_user: string | null;
              user_id: string;
              live_user: string | null;
              disabled_at: Date | string | null;
              verified_at: Date | string | null;
              credential_user: string | null;
            }[]
          >`
            SELECT r.email_normalized, r.user_id, i.identifier_normalized AS identity_email,
              i.user_id AS identity_user, u.id AS live_user, u.disabled_at,
              i.verified_at, p.user_id AS credential_user
            FROM wo_meta.admin_bootstrap r
            LEFT JOIN users u ON u.id = r.user_id
            LEFT JOIN auth_identities i ON i.id = r.identity_id AND i.provider = 'email'
            LEFT JOIN password_credentials p ON p.user_id = r.user_id
            WHERE r.singleton = true
          `;
          const receipt = receipts[0];
          if (receipt !== undefined) {
            if (
              receipt.email_normalized !== input.emailNormalized ||
              receipt.identity_email !== input.emailNormalized ||
              receipt.identity_user !== receipt.user_id ||
              receipt.live_user !== receipt.user_id ||
              receipt.credential_user !== receipt.user_id ||
              receipt.disabled_at !== null ||
              receipt.verified_at === null
            )
              throw new AdminBootstrapError('BOOTSTRAP_CONFLICT');
            return { state: 'existing' as const, userId: receipt.user_id };
          }
          const existing = await transaction<{ id: string }[]>`
            SELECT id FROM auth_identities
            WHERE provider = 'email' AND identifier_normalized = ${input.emailNormalized}
          `;
          if (existing.length > 0)
            throw new AdminBootstrapError('BOOTSTRAP_CONFLICT');
          const userId = randomUUID();
          const identityId = randomUUID();
          const createdAt = toUtcTimestamp(new Date());
          await transaction`
            INSERT INTO users (id, display_name, created_at, disabled_at)
            VALUES (${userId}, 'Administrator', ${createdAt}, NULL)
          `;
          await transaction`
            INSERT INTO auth_identities (id, user_id, provider, identifier_normalized, verified_at)
            VALUES (${identityId}, ${userId}, 'email', ${input.emailNormalized}, ${createdAt})
          `;
          await transaction`
            INSERT INTO password_credentials (user_id, password_hash, password_changed_at)
            VALUES (${userId}, ${input.passwordHash}, ${createdAt})
          `;
          await transaction`
            INSERT INTO wo_meta.admin_bootstrap (singleton, user_id, identity_id, email_normalized, created_at)
            VALUES (true, ${userId}, ${identityId}, ${input.emailNormalized}, ${createdAt})
          `;
          return { state: 'created' as const, userId };
        });
      } catch (error) {
        if (error instanceof AdminBootstrapError) throw error;
        // SQL errors may contain bound credential values; never expose their detail or cause.
        throw new AdminBootstrapError('BOOTSTRAP_PERSISTENCE_FAILED');
      }
    },
  };
}
