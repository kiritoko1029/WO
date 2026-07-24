import { readFile } from 'node:fs/promises';

import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';

import {
  authIdentities,
  databaseSchema,
  passwordCredentials,
  refreshSessions,
  users,
} from '../src/schema.js';
import type { DatabaseClient } from '../src/client.js';
import {
  createSessionRepository,
  parseRefreshTokenHash,
} from '../src/session-repository.js';

const migrationUrl = new URL('../drizzle/0000_identity.sql', import.meta.url);

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

describe('identity schema', () => {
  test('contains exactly the identity, refresh, and verification tables', () => {
    expect(Object.values(databaseSchema).map(getTableName).sort()).toEqual([
      'auth_identities',
      'email_verification_challenges',
      'password_credentials',
      'refresh_sessions',
      'users',
    ]);
  });

  test('uses the required stable user columns without database-generated ids', () => {
    expect(columnNames(users)).toEqual([
      'id',
      'display_name',
      'created_at',
      'disabled_at',
    ]);
    expect(users.id.getSQLType()).toBe('uuid');
    expect(users.id.hasDefault).toBe(false);
    expect(users.id.primary).toBe(true);
    expect(users.createdAt.getSQLType()).toBe('timestamp with time zone');
    expect(users.createdAt.hasDefault).toBe(false);
  });

  test('models provider-neutral identities with a provider-scoped unique identifier', () => {
    const config = getTableConfig(authIdentities);

    expect(columnNames(authIdentities)).toEqual([
      'id',
      'user_id',
      'provider',
      'identifier_normalized',
      'verified_at',
    ]);
    expect(authIdentities.id.hasDefault).toBe(false);
    expect(authIdentities.provider.getSQLType()).toBe('text');
    expect(
      config.uniqueConstraints.map((constraint) => ({
        name: constraint.getName(),
        columns: constraint.columns.map((column) => column.name),
      })),
    ).toContainEqual({
      name: 'auth_identities_provider_identifier_normalized_unique',
      columns: ['provider', 'identifier_normalized'],
    });
  });

  test('allows only one password credential per user', () => {
    expect(columnNames(passwordCredentials)).toEqual([
      'user_id',
      'password_hash',
      'password_changed_at',
    ]);
    expect(passwordCredentials.userId.primary).toBe(true);
  });

  test('stores only a fixed-length unique refresh-token hash', () => {
    expect(columnNames(refreshSessions)).toEqual([
      'id',
      'user_id',
      'family_id',
      'token_hash',
      'expires_at',
      'rotated_at',
      'revoked_at',
      'created_at',
    ]);
    expect(refreshSessions.tokenHash.getSQLType()).toBe('varchar(64)');
    expect(refreshSessions.tokenHash.isUnique).toBe(true);
  });

  test('rejects values that are not opaque SHA-256 token hashes', () => {
    expect(() => parseRefreshTokenHash('raw-refresh-token')).toThrowError(
      'Refresh token hash must be 64 lowercase hexadecimal characters',
    );
    expect(() => parseRefreshTokenHash('A'.repeat(64))).toThrowError(
      'Refresh token hash must be 64 lowercase hexadecimal characters',
    );
    expect(parseRefreshTokenHash('a'.repeat(64))).toBe('a'.repeat(64));
  });

  test('retries deadlocks a bounded number of times before returning a safe error', async () => {
    let attempts = 0;
    const client = {
      sql: {
        begin: async () => {
          attempts += 1;
          throw Object.assign(new Error('raw database deadlock details'), {
            code: '40P01',
          });
        },
      },
    } as unknown as DatabaseClient;
    const repository = createSessionRepository(client, {
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    await expect(
      repository.rotateRefreshSession({
        replacementSessionId: '00000000-0000-4000-8000-000000000001',
        presentedTokenHash: parseRefreshTokenHash('a'.repeat(64)),
        replacementTokenHash: parseRefreshTokenHash('b'.repeat(64)),
        replacementExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'REFRESH_SESSION_PERSISTENCE_ERROR',
      message: 'Refresh session persistence failed',
    });
    expect(attempts).toBe(3);
  });

  test('migration does not introduce unrelated product persistence', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).not.toMatch(
      /\b(?:rooms?|sdp|ice|turn_credentials?|device_names?|media_stats?)\b/iu,
    );
    expect(migration.match(/CREATE TABLE/gu)).toHaveLength(4);
  });
});
