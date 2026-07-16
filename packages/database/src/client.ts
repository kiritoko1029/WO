import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { databaseSchema } from './schema.js';

export type DatabaseSql = ReturnType<typeof postgres>;

export interface DatabaseClient {
  readonly db: PostgresJsDatabase<typeof databaseSchema>;
  readonly sql: DatabaseSql;
  close(): Promise<void>;
}

export interface DatabaseClientOptions {
  readonly maxConnections?: number;
}

export function cloneValidDate(value: Date): Date {
  let milliseconds: number;
  try {
    milliseconds = Date.prototype.getTime.call(value);
  } catch {
    throw new RangeError('Database timestamp must be a valid Date');
  }
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('Database timestamp must be a valid Date');
  }
  return new Date(milliseconds);
}

export function toUtcTimestamp(value: Date): string {
  return cloneValidDate(value).toISOString();
}

export function fromDatabaseTimestamp(value: Date | string): Date {
  const parsed =
    Object.prototype.toString.call(value) === '[object Date]'
      ? new Date(Date.prototype.getTime.call(value))
      : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RangeError('Database returned an invalid timestamp');
  }
  return parsed;
}

export function createDatabaseClient(
  databaseUrl: string,
  options: DatabaseClientOptions = {},
): DatabaseClient {
  const sql = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    onnotice: () => undefined,
  });
  const db = drizzle(sql, { schema: databaseSchema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end();
    },
  };
}
