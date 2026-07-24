import {
  randomBytes as nodeRandomBytes,
  randomInt as nodeRandomInt,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import {
  networkInterfaces as nodeNetworkInterfaces,
  type NetworkInterfaceInfo,
} from 'node:os';

import websocket from '@fastify/websocket';
import {
  lanIceConfigurationDataSchema,
  signalTicketResponseSchema,
  type LanIceConfigurationData,
  type SignalTicketResponse,
} from '@wo/protocol';
import Fastify from 'fastify';
import { z } from 'zod';

import { createJoinAttemptLimiter } from '../modules/rooms/join-attempt-limiter.ts';
import { createRoomRegistry } from '../modules/rooms/room-registry.ts';
import type { RoomIntent } from '../modules/rooms/room-types.ts';
import { createScreenLeaseRegistry } from '../modules/screen/screen-lease-registry.ts';
import {
  createSignalingDispatcher,
  SignalingHandlerError,
  type SignalingRequestHandler,
} from '../modules/signaling/dispatcher.ts';
import { registerSignalingGateway } from '../modules/signaling/gateway.ts';
import { createRoomRequestHandler } from '../modules/signaling/handlers/room.ts';
import { createScreenRequestHandler } from '../modules/signaling/handlers/screen.ts';
import { createWebrtcRequestHandler } from '../modules/signaling/handlers/webrtc.ts';
import {
  createSignalTicketStore,
  SIGNAL_TICKET_EXPIRES_IN_SECONDS,
  SignalTicketStoreError,
} from '../modules/signaling/signal-ticket-store.ts';
import { createLanFrameCodec } from './authenticated-frame.ts';

const INVITE_KEY_BYTES = 32;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1_000;
const TICKET_WINDOW_MS = 60_000;
const TICKET_ATTEMPTS_PER_WINDOW = 6;
const NETWORK_WATCH_INTERVAL_MS = 5_000;
const REALTIME_PATH = '/v1/realtime';
const SESSION_PATH = '/v1/lite/session';
const VIRTUAL_INTERFACE_PATTERN =
  /^(?:br-|bridge|docker|tailscale|utun|vboxnet|veth|virbr|vmnet|zt)/iu;

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

interface PrivateIpv4Binding {
  readonly name: string;
  readonly address: string;
  readonly netmask: string;
  readonly mac: string;
  readonly cidr: string | null;
}

const displayNameSchema = z.string().trim().min(1).max(100);
const guestSessionSchema = z
  .object({
    version: z.literal(1),
    clientId: z.uuid(),
    displayName: displayNameSchema,
  })
  .strict();

export interface LiteRoomInvite {
  readonly version: 1;
  readonly endpoint: string;
  readonly sessionEndpoint: string;
  readonly roomCode: string;
  readonly inviteKey: string;
}

export interface RunningLiteRoomService {
  readonly hostClientId: string;
  readonly hostDisplayName: string;
  readonly invite: LiteRoomInvite;
  issueHostTicket(): SignalTicketResponse;
  close(): Promise<void>;
}

export interface StartLiteRoomServiceOptions {
  readonly hostDisplayName?: string;
  readonly advertiseAddress?: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomInt?: (maxExclusive: number) => number;
  readonly randomUUID?: () => string;
  readonly networkInterfaces?: () => NetworkInterfaces;
  readonly networkWatchIntervalMs?: number;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
}

function privateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function selectPrivateIpv4Binding(
  interfaces: NetworkInterfaces,
  preferredAddress?: string,
): PrivateIpv4Binding {
  const addresses = Object.entries(interfaces)
    .flatMap(([name, entries]) =>
      (entries ?? [])
        .filter(
          (entry) =>
            entry.family === 'IPv4' &&
            !entry.internal &&
            privateIpv4(entry.address),
        )
        .map((entry): PrivateIpv4Binding => ({
          name,
          address: entry.address,
          netmask: entry.netmask,
          mac: entry.mac,
          cidr: entry.cidr ?? null,
        })),
    )
    .sort((left, right) => {
      const leftVirtual = VIRTUAL_INTERFACE_PATTERN.test(left.name) ? 1 : 0;
      const rightVirtual = VIRTUAL_INTERFACE_PATTERN.test(right.name) ? 1 : 0;
      return (
        leftVirtual - rightVirtual ||
        left.name.localeCompare(right.name) ||
        left.address.localeCompare(right.address)
      );
    });
  if (preferredAddress !== undefined) {
    const preferred = addresses.find(
      ({ address }) => address === preferredAddress,
    );
    if (preferred === undefined) {
      throw new Error(
        'LAN advertise address must be an available private IPv4 address',
      );
    }
    return preferred;
  }
  const selected = addresses[0];
  if (selected === undefined) {
    throw new Error('No private IPv4 address is available for a LAN room');
  }
  return selected;
}

export function selectPrivateIpv4Address(
  interfaces: NetworkInterfaces,
  preferredAddress?: string,
): string {
  return selectPrivateIpv4Binding(interfaces, preferredAddress).address;
}

function samePrivateIpv4Binding(
  left: PrivateIpv4Binding,
  right: PrivateIpv4Binding,
): boolean {
  return (
    left.name === right.name &&
    left.address === right.address &&
    left.netmask === right.netmask &&
    left.mac === right.mac &&
    left.cidr === right.cidr
  );
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('LAN room clock must return milliseconds');
  }
  return value;
}

function canonicalInviteKey(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(INVITE_KEY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== INVITE_KEY_BYTES) {
    throw new TypeError('LAN invite random source returned invalid data');
  }
  return Buffer.from(bytes).toString('base64url');
}

function authorized(header: string | undefined, inviteKey: string): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(`Bearer ${inviteKey}`, 'ascii');
  const received = Buffer.from(header, 'ascii');
  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}

function ticketResponse(
  ticketStore: ReturnType<typeof createSignalTicketStore>,
  claims: Parameters<typeof ticketStore.issue>[0],
): SignalTicketResponse {
  const issued = ticketStore.issue(claims);
  return signalTicketResponseSchema.parse({
    ticket: issued.value,
    expiresInSeconds: SIGNAL_TICKET_EXPIRES_IN_SECONDS,
  });
}

export async function startLiteRoomService(
  options: StartLiteRoomServiceOptions = {},
): Promise<RunningLiteRoomService> {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const randomInt = options.randomInt ?? nodeRandomInt;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const networkInterfaces = options.networkInterfaces ?? nodeNetworkInterfaces;
  const setIntervalFn =
    options.setInterval ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setInterval(callback, delayMs));
  const clearIntervalFn =
    options.clearInterval ??
    ((timer: unknown) =>
      globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
  const networkWatchIntervalMs =
    options.networkWatchIntervalMs ?? NETWORK_WATCH_INTERVAL_MS;
  if (
    !Number.isSafeInteger(networkWatchIntervalMs) ||
    networkWatchIntervalMs <= 0
  ) {
    throw new RangeError(
      'LAN network watch interval must be a positive safe integer',
    );
  }
  const binding = selectPrivateIpv4Binding(
    networkInterfaces(),
    options.advertiseAddress,
  );
  const address = binding.address;
  const startedAtMs = readNow(now);
  const hostDisplayName = displayNameSchema.parse(
    options.hostDisplayName ?? 'Host',
  );
  const hostClientId = randomUUID();
  const inviteKey = canonicalInviteKey(randomBytes);
  const roomCodeNumber = randomInt(1_000_000);
  if (
    !Number.isSafeInteger(roomCodeNumber) ||
    roomCodeNumber < 0 ||
    roomCodeNumber >= 1_000_000
  ) {
    throw new TypeError('LAN room code random source returned invalid data');
  }
  const roomCode = roomCodeNumber.toString().padStart(6, '0');
  const app = Fastify({ logger: false, bodyLimit: 4_096, trustProxy: false });
  const ticketStore = createSignalTicketStore({ now, maxEntries: 8 });
  const ticketLimiter = createJoinAttemptLimiter({
    now,
    maxAttempts: TICKET_ATTEMPTS_PER_WINDOW,
    windowMs: TICKET_WINDOW_MS,
    maxKeys: 64,
  });
  const joinLimiter = createJoinAttemptLimiter({
    now,
    maxAttempts: 8,
    windowMs: TICKET_WINDOW_MS,
    maxKeys: 4,
  });
  const roomOperationLimiter = createJoinAttemptLimiter({
    now,
    maxAttempts: 64,
    windowMs: TICKET_WINDOW_MS,
    maxKeys: 1,
  });
  let asyncIntentSink: (intent: RoomIntent) => void = () => undefined;
  const roomRegistry = createRoomRegistry({
    now,
    randomInt: () => roomCodeNumber,
    randomUUID,
    onAsyncIntent: (intent) => asyncIntentSink(intent),
    roomCodeTtlMs: SESSION_TTL_MS,
    maxCodeAttempts: 1,
    maxRooms: 1,
    maxMembersPerRoom: 2,
  });
  const createLanIce = (): LanIceConfigurationData =>
    lanIceConfigurationDataSchema.parse({
      rtcConfiguration: {
        mode: 'lan',
        iceServers: [],
        iceTransportPolicy: 'all',
      },
      iceCredentialsExpiresAt: new Date(
        readNow(now) + SESSION_TTL_MS,
      ).toISOString(),
    });
  const createFreshIce = createLanIce;
  const baseRoomHandler = createRoomRequestHandler({
    roomRegistry,
    joinAttemptLimiter: joinLimiter,
    roomOperationLimiter,
    createFreshIce,
  });
  let guestClientId: string | null = null;
  const roomHandler: SignalingRequestHandler = {
    handle(context, request) {
      if (
        (request.type === 'room.create' &&
          context.identity.userId !== hostClientId) ||
        (request.type === 'room.join' &&
          context.identity.userId === hostClientId)
      ) {
        throw new SignalingHandlerError('FORBIDDEN');
      }
      // The current WebRTC topology is 1:1, so LAN rooms use the same
      // creator-plus-one-guest capacity as centralized rooms.
      const result = baseRoomHandler.handle(context, request);
      if (request.type === 'room.join') {
        guestClientId = context.identity.userId;
      } else if (
        request.type === 'room.leave' &&
        context.identity.userId === guestClientId
      ) {
        guestClientId = null;
      }
      return result;
    },
  };
  const dispatcher = createSignalingDispatcher({
    roomHandler,
    webrtcHandler: createWebrtcRequestHandler({
      roomRegistry,
      createFreshIce,
    }),
    screenHandler: createScreenRequestHandler({
      leases: createScreenLeaseRegistry({ roomRegistry }),
    }),
  });

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let networkWatchTimer: unknown | undefined;
  const clearNetworkWatch = (): void => {
    if (networkWatchTimer === undefined) return;
    const timer = networkWatchTimer;
    networkWatchTimer = undefined;
    try {
      clearIntervalFn(timer);
    } catch {
      // Timer cleanup cannot keep a stale LAN listener alive.
    }
  };
  const closeService = (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    clearNetworkWatch();
    closePromise = app.close();
    return closePromise;
  };
  const accessTokenExpiresAtSeconds =
    Math.floor(startedAtMs / 1_000) + SESSION_TTL_SECONDS;
  const issueHostTicket = (): SignalTicketResponse =>
    ticketResponse(ticketStore, {
      userId: hostClientId,
      sessionId: `lan-host:${hostClientId}`,
      displayName: hostDisplayName,
      accessTokenExpiresAtSeconds,
    });

  try {
    await app.register(websocket, {
      options: {
        maxPayload: 1_048_576,
        handleProtocols: (protocols) =>
          protocols.has('wo-v1') ? 'wo-v1' : false,
      },
    });
    app.post(SESSION_PATH, async (request, reply) => {
      const limit = ticketLimiter.consume({
        userId: 'lan-ticket-exchange',
        remoteIp: request.ip,
        requestId: request.id,
      });
      if (!limit.allowed) {
        return reply
          .status(429)
          .header('Cache-Control', 'no-store')
          .header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1_000)))
          .send({
            error: { code: 'RATE_LIMITED', message: 'Too many requests' },
          });
      }
      if (!authorized(request.headers.authorization, inviteKey)) {
        return reply
          .status(401)
          .header('Cache-Control', 'no-store')
          .send({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required',
            },
          });
      }
      const parsed = guestSessionSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.clientId === hostClientId) {
        return reply
          .status(400)
          .header('Cache-Control', 'no-store')
          .send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
            },
          });
      }
      if (guestClientId !== null && parsed.data.clientId !== guestClientId) {
        return reply
          .status(409)
          .header('Cache-Control', 'no-store')
          .send({
            error: {
              code: 'ROOM_FULL',
              message: 'Room is full',
            },
          });
      }
      try {
        return reply.header('Cache-Control', 'no-store').send(
          ticketResponse(ticketStore, {
            userId: parsed.data.clientId,
            sessionId: `lan-guest:${parsed.data.clientId}`,
            displayName: parsed.data.displayName,
            accessTokenExpiresAtSeconds,
          }),
        );
      } catch (error) {
        if (!(error instanceof SignalTicketStoreError)) throw error;
        return reply
          .status(503)
          .header('Cache-Control', 'no-store')
          .send({
            error: {
              code: 'SIGNALING_UNAVAILABLE',
              message: 'Signaling is temporarily unavailable',
            },
          });
      }
    });

    const gateway = registerSignalingGateway(app, {
      ticketStore,
      roomRegistry,
      dispatcher,
      options: {
        now,
        maxConnections: 8,
        frameCodec: createLanFrameCodec(inviteKey, 'server'),
      },
    });
    asyncIntentSink = gateway.processIntent;
    app.addHook('onClose', async () => {
      clearNetworkWatch();
      gateway.shutdown();
      roomRegistry.clear();
      ticketStore.clear();
      ticketLimiter.clear();
      joinLimiter.clear();
      roomOperationLimiter.clear();
    });
    await app.listen({ host: address, port: 0 });
    networkWatchTimer = setIntervalFn(() => {
      try {
        const currentBinding = selectPrivateIpv4Binding(
          networkInterfaces(),
          address,
        );
        if (!samePrivateIpv4Binding(binding, currentBinding)) {
          throw new Error('LAN network binding changed');
        }
      } catch {
        void closeService().catch(() => undefined);
      }
    }, networkWatchIntervalMs);
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }

  const serverAddress = app.server.address() as AddressInfo | null;
  if (serverAddress === null || typeof serverAddress === 'string') {
    await app.close();
    throw new Error('LAN room service did not bind a TCP port');
  }
  const httpOrigin = `http://${address}:${serverAddress.port}`;
  const invite = Object.freeze({
    version: 1 as const,
    endpoint: `ws://${address}:${serverAddress.port}${REALTIME_PATH}`,
    sessionEndpoint: `${httpOrigin}${SESSION_PATH}`,
    roomCode,
    inviteKey,
  });

  return Object.freeze({
    hostClientId,
    hostDisplayName,
    invite,
    issueHostTicket,
    close: closeService,
  });
}
