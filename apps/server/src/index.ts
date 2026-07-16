import { pathToFileURL } from 'node:url';

import { parseP2pServerConfig } from '@wo/config';
import {
  createDatabaseClient,
  createIdentityRepository,
  createSessionRepository,
  migrateDatabase,
  type DatabaseClient,
} from '@wo/database';
import type { FastifyInstance } from 'fastify';

import { createApp } from './app.ts';
import { createAccessTokenService } from './modules/auth/access-token.ts';
import { createAuthService } from './modules/auth/auth-service.ts';
import { hashPassword } from './modules/auth/password.ts';

const DUMMY_LOGIN_PASSWORD = 'not a real account password';

export interface RunningServer {
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

async function closeResources(
  app: FastifyInstance | undefined,
  databaseClient: DatabaseClient,
): Promise<void> {
  const results = await Promise.allSettled([
    ...(app ? [app.close()] : []),
    databaseClient.close(),
  ]);
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map(({ reason }) => reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Server shutdown failed');
  }
}

export async function startServer(
  environment: Record<string, string | undefined> = process.env,
): Promise<RunningServer> {
  const config = parseP2pServerConfig(environment);
  const databaseClient = createDatabaseClient(config.database.url);
  let app: FastifyInstance | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeResources(app, databaseClient);
    return closePromise;
  };

  try {
    await migrateDatabase(databaseClient);
    const identityRepository = createIdentityRepository(databaseClient);
    const sessionRepository = createSessionRepository(databaseClient);
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: config.auth.jwtAccessSecret,
      issuer: config.publicUrl,
    });
    const dummyPasswordHash = await hashPassword(DUMMY_LOGIN_PASSWORD);
    const authService = createAuthService({
      identityRepository,
      sessionRepository,
      accessTokenService,
      dummyPasswordHash,
    });
    app = await createApp({
      authService,
      accessTokenService,
      trustProxy: config.nodeEnv === 'production' ? 1 : false,
      readinessCheck: async () => {
        await databaseClient.sql`SELECT 1`;
      },
    });
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (startupError) {
    const [shutdownResult] = await Promise.allSettled([close()]);
    if (shutdownResult.status === 'rejected') {
      throw new AggregateError(
        [startupError, shutdownResult.reason],
        'Server startup and cleanup failed',
        { cause: startupError },
      );
    }
    throw startupError;
  }

  return { app, close };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

async function runMain(): Promise<void> {
  const server = await startServer();
  const shutdown = (): void => {
    void server.close().catch((error: unknown) => {
      process.stderr.write(
        `Server shutdown failed (${safeErrorName(error)})\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void runMain().catch((error: unknown) => {
    process.stderr.write(`Server startup failed (${safeErrorName(error)})\n`);
    process.exitCode = 1;
  });
}
