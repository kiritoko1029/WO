import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { DatabaseClient } from './client.js';

const migrationId = '0000_identity';
const migrationLockNamespace = 22_351;
const migrationLockKey = 1;
const identityMigrationUrl = new URL(
  '../drizzle/0000_identity.sql',
  import.meta.url,
);

export class MigrationError extends Error {
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';

  constructor() {
    super('Applied database migration checksum does not match this build');
    this.name = 'MigrationError';
  }
}

export async function migrateDatabase(client: DatabaseClient): Promise<void> {
  const migration = await readFile(identityMigrationUrl, 'utf8');
  const checksum = createHash('sha256').update(migration).digest('hex');
  const appliedAt = new Date().toISOString();

  await client.sql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(
        ${migrationLockNamespace}::integer,
        ${migrationLockKey}::integer
      )
    `;
    await transaction.unsafe(`
      CREATE SCHEMA IF NOT EXISTS wo_meta;
      CREATE TABLE IF NOT EXISTS wo_meta.schema_migrations (
        migration_id text PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamp with time zone NOT NULL
      );
    `);

    const rows = await transaction<{ checksum: string }[]>`
      SELECT checksum
      FROM wo_meta.schema_migrations
      WHERE migration_id = ${migrationId}
    `;
    const applied = rows[0];
    if (applied) {
      if (applied.checksum !== checksum) {
        throw new MigrationError();
      }
      return;
    }

    await transaction.unsafe(migration);
    await transaction`
      INSERT INTO wo_meta.schema_migrations (migration_id, checksum, applied_at)
      VALUES (${migrationId}, ${checksum}, ${appliedAt})
    `;
  });
}
