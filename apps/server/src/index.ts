import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { createAdminService } from './modules/admin/admin-service.ts';
import { createAccessTokenService } from './modules/auth/access-token.ts';
import { createAuthService } from './modules/auth/auth-service.ts';
import { createEmailDelivery } from './modules/auth/email-delivery.ts';
import { hashPassword } from './modules/auth/password.ts';
import { createSignalTicketStore } from './modules/signaling/signal-ticket-store.ts';

const DUMMY_LOGIN_PASSWORD = 'not a real account password';
const BUNDLED_WEB_ROOT = resolve(import.meta.dirname, '../web');

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
      emailPolicy: {
        domainAllowlist: config.email.domainAllowlist,
        verificationRequired: config.email.verificationRequired,
        codeTtlSeconds: config.email.codeTtlSeconds,
      },
      emailDelivery: createEmailDelivery(config.email.smtp),
    });
    const realtimeHandles: import('./modules/admin/admin-service.ts').AdminRealtimeHandles =
      {
        listConnections: () => [],
        roomRegistry: null,
      };
    const adminService = createAdminService({
      identityRepository,
      sessionRepository,
      superAdminEmails: config.email.superAdminEmails,
      realtime: realtimeHandles,
    });
    app = await createApp({
      authService,
      accessTokenService,
      trustProxy: config.nodeEnv === 'production' ? 1 : false,
      readinessCheck: async () => {
        await databaseClient.sql`SELECT 1`;
      },
      admin: { adminService },
      realtime: {
        identityRepository,
        ticketStore: createSignalTicketStore(),
        turn: {
          urls: config.turn.urls,
          sharedSecret: config.turn.sharedSecret,
          credentialTtlSeconds: config.turn.credentialTtlSeconds,
        },
        roomRegistryOptions: {
          roomCodeTtlMs: config.room.codeTtlSeconds * 1_000,
          reconnectGraceMs: config.room.disconnectGraceSeconds * 1_000,
          screenLeaseTtlMs: config.screen.leaseTtlSeconds * 1_000,
          screenBitrateRange: config.screen.bitrateRange,
        },
        onRealtimeReady: (handles) => {
          realtimeHandles.listConnections = handles.listConnections;
          realtimeHandles.roomRegistry = handles.roomRegistry;
        },
      },
      webRoot: existsSync(BUNDLED_WEB_ROOT) ? BUNDLED_WEB_ROOT : undefined,
      downloadsRoot: normalizeDownloadsRoot(environment.DOWNLOADS_ROOT),
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

/**
 * Resolve the downloads root directory from the environment. When unset, the
 * feature is disabled (route not registered). When set, the directory must
 * exist; otherwise the server refuses to start so operators notice a broken
 * mount instead of getting silent 404s in production.
 */
function normalizeDownloadsRoot(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const root = resolve(value.trim());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(
      `DOWNLOADS_ROOT is set to ${value} but the path is not an existing directory`,
    );
  }
  return root;
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
