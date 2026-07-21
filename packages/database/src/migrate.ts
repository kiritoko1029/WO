import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { DatabaseClient } from './client.js';

const migrationLockNamespace = 22_351;
const migrationLockKey = 1;

const migrations = Object.freeze([
  Object.freeze({
    id: '0000_identity',
    url: new URL('../drizzle/0000_identity.sql', import.meta.url),
  }),
  Object.freeze({
    id: '0001_email_verification',
    url: new URL('../drizzle/0001_email_verification.sql', import.meta.url),
  }),
]);

export class MigrationError extends Error {
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';

  constructor(message = 'Applied database migration checksum does not match this build') {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function migrateDatabase(client: DatabaseClient): Promise<void> {
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

    for (const migration of migrations) {
      const sql = await readFile(migration.url, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const appliedAt = new Date().toISOString();
      const rows = await transaction<{ checksum: string }[]>`
        SELECT checksum
        FROM wo_meta.schema_migrations
        WHERE migration_id = ${migration.id}
      `;
      const applied = rows[0];
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new MigrationError(
            `Applied database migration checksum does not match this build: ${migration.id}`,
          );
        }
        continue;
      }
      await transaction.unsafe(sql);
      await transaction`
        INSERT INTO wo_meta.schema_migrations (migration_id, checksum, applied_at)
        VALUES (${migration.id}, ${checksum}, ${appliedAt})
      `;
    }
  });
}
