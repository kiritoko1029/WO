import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { IdentityRepository } from '@wo/database';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { registerAuthentication } from './http/authenticate.ts';
import { registerErrorHandler } from './http/errors.ts';
import type { AccessTokenService } from './modules/auth/access-token.ts';
import {
  registerAuthRoutes,
  type AuthRateLimit,
} from './modules/auth/auth-routes.ts';
import type { AuthService } from './modules/auth/auth-service.ts';
import { registerHealthRoutes } from './modules/health/health-routes.ts';
import {
  createJoinAttemptLimiter,
  type JoinAttemptLimiter,
} from './modules/rooms/join-attempt-limiter.ts';
import { safeErrorMetadata, SERVER_LOGGER_OPTIONS } from './logging.ts';
import { createRoomRegistry } from './modules/rooms/room-registry.ts';
import type {
  RoomIntent,
  RoomRegistryDependencies,
} from './modules/rooms/room-types.ts';
import { createScreenLeaseRegistry } from './modules/screen/screen-lease-registry.ts';
import {
  createSignalingDispatcher,
  type SignalingDispatcher,
} from './modules/signaling/dispatcher.ts';
import {
  registerSignalingGateway,
  type SignalingGatewayOptions,
} from './modules/signaling/gateway.ts';
import {
  createRoomRequestHandler,
  type CreateFreshIce,
} from './modules/signaling/handlers/room.ts';
import { createScreenRequestHandler } from './modules/signaling/handlers/screen.ts';
import { createWebrtcRequestHandler } from './modules/signaling/handlers/webrtc.ts';
import { registerSignalTicketRoutes } from './modules/signaling/signal-ticket-routes.ts';
import type { SignalTicketStore } from './modules/signaling/signal-ticket-store.ts';
import { createTurnCredentials } from './modules/turn/credentials.ts';
import { createIceConfiguration } from './modules/turn/ice-servers.ts';

const DEFAULT_BODY_LIMIT = 16 * 1_024;
const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = Object.freeze({
  max: 20,
  timeWindow: 60_000,
});

export interface RealtimeAppDependencies {
  readonly identityRepository: Pick<IdentityRepository, 'findEmailUserById'>;
  readonly ticketStore: SignalTicketStore;
  readonly turn: Readonly<{
    urls: readonly string[];
    sharedSecret: string;
    credentialTtlSeconds: number;
    iceTransportPolicy?: 'all' | 'relay';
  }>;
  readonly now?: () => number;
  readonly roomRegistryOptions?: Omit<
    RoomRegistryDependencies,
    'onAsyncIntent'
  >;
  readonly joinAttemptLimiter?: JoinAttemptLimiter;
  readonly gatewayOptions?: SignalingGatewayOptions;
  readonly createFreshIce?: CreateFreshIce;
}

export interface AppDependencies {
  readonly authService: AuthService;
  readonly accessTokenService: AccessTokenService;
  readonly readinessCheck: () => Promise<void>;
  readonly logger?: FastifyServerOptions['logger'];
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  readonly authRateLimit?: AuthRateLimit;
  readonly bodyLimit?: number;
  readonly realtime?: RealtimeAppDependencies;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? SERVER_LOGGER_OPTIONS,
    bodyLimit: dependencies.bodyLimit ?? DEFAULT_BODY_LIMIT,
    trustProxy: dependencies.trustProxy ?? false,
  });
  registerErrorHandler(app);
  registerAuthentication(app, dependencies.accessTokenService);
  await app.register(websocket, {
    options: {
      maxPayload: 1_048_576,
      handleProtocols: (protocols) =>
        protocols.has('wo-v1') ? 'wo-v1' : false,
    },
    errorHandler(error, socket) {
      app.log.error(safeErrorMetadata(error), 'WebSocket handler failed');
      socket.close(1011, 'SIGNALING_UNAVAILABLE');
    },
  });
  await app.register(rateLimit, { global: false });
  registerHealthRoutes(app, {
    readinessCheck: dependencies.readinessCheck,
  });
  registerAuthRoutes(app, {
    authService: dependencies.authService,
    rateLimit: dependencies.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT,
  });

  if (dependencies.realtime !== undefined) {
    const realtime = dependencies.realtime;
    const now = realtime.now ?? Date.now;
    const joinAttemptLimiter =
      realtime.joinAttemptLimiter ?? createJoinAttemptLimiter({ now });
    const ticketIssueLimiter = createJoinAttemptLimiter({
      now,
      maxAttempts: 60,
      windowMs: 60_000,
      maxKeys: 10_000,
    });
    const roomOperationLimiter = createJoinAttemptLimiter({
      now,
      maxAttempts: 10_000,
      windowMs: 60_000,
      maxKeys: 1,
    });
    let asyncIntentSink: (intent: RoomIntent) => void = () => undefined;
    const roomRegistry = createRoomRegistry({
      ...realtime.roomRegistryOptions,
      now,
      onAsyncIntent: (intent) => asyncIntentSink(intent),
    });
    const createFreshIce: CreateFreshIce =
      realtime.createFreshIce ??
      ((input) => {
        const turnCredentials = createTurnCredentials({
          ...input,
          nowSeconds: Math.floor(now() / 1_000),
          ttlSeconds: realtime.turn.credentialTtlSeconds,
          secret: realtime.turn.sharedSecret,
        });
        return createIceConfiguration({
          urls: realtime.turn.urls,
          turnCredentials,
          iceTransportPolicy: realtime.turn.iceTransportPolicy,
        });
      });
    const dispatcher: SignalingDispatcher = createSignalingDispatcher({
      roomHandler: createRoomRequestHandler({
        roomRegistry,
        joinAttemptLimiter,
        roomOperationLimiter,
        createFreshIce,
      }),
      webrtcHandler: createWebrtcRequestHandler({
        roomRegistry,
        createFreshIce,
      }),
      screenHandler: createScreenRequestHandler({
        leases: createScreenLeaseRegistry({ roomRegistry }),
      }),
      onInternalError(error, requestType) {
        app.log.error(
          { ...safeErrorMetadata(error), requestType },
          'Signaling request failed',
        );
      },
    });
    const gateway = registerSignalingGateway(app, {
      ticketStore: realtime.ticketStore,
      roomRegistry,
      dispatcher,
      options: { ...realtime.gatewayOptions, now },
      onInternalError(error, operation) {
        app.log.error(
          { ...safeErrorMetadata(error), operation },
          'Signaling gateway failed',
        );
      },
    });
    asyncIntentSink = gateway.processIntent;
    registerSignalTicketRoutes(app, {
      identityRepository: realtime.identityRepository,
      ticketStore: realtime.ticketStore,
      rateLimiter: ticketIssueLimiter,
    });
    app.addHook('onClose', async () => {
      gateway.shutdown();
      roomRegistry.clear();
      joinAttemptLimiter.clear();
      ticketIssueLimiter.clear();
      roomOperationLimiter.clear();
      realtime.ticketStore.clear();
    });
  }
  return app;
}
