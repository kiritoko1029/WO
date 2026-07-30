import {
  P2P_MEDIA_PLAN,
  p2pOutboundResponseSchema,
  signalTicketResponseSchema,
  type P2pOutboundResponse,
} from '@wo/protocol';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, test } from 'vitest';

import { createApp } from '../src/app.ts';
import type { AccessTokenService } from '../src/modules/auth/access-token.ts';
import { createSignalTicketStore } from '../src/modules/signaling/signal-ticket-store.ts';

interface RunningFixture {
  readonly app: FastifyInstance;
  readonly httpUrl: string;
  readonly wsUrl: string;
  advance(milliseconds: number): void;
}

interface FixtureOptions {
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly roomCodeTtlMs?: number;
  readonly failIceCalls?: readonly number[];
  readonly accessTokenTtlSeconds?: number;
  readonly inboundRateWindowMs?: number;
  readonly maxInboundMessagesPerWindow?: number;
  readonly maxInboundBytesPerWindow?: number;
  readonly requestCacheMaxEntries?: number;
  readonly maxAckEntriesPerConnection?: number;
}

class SocketInbox {
  readonly messages: P2pOutboundResponse[] = [];
  private readonly waiters: Array<{
    readonly predicate: (message: P2pOutboundResponse) => boolean;
    readonly resolve: (message: P2pOutboundResponse) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = p2pOutboundResponseSchema.parse(
        JSON.parse(data.toString()) as unknown,
      );
      const waiterIndex = this.waiters.findIndex(({ predicate }) =>
        predicate(message),
      );
      if (waiterIndex === -1) {
        this.messages.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
  }

  next(
    predicate: (message: P2pOutboundResponse) => boolean,
    timeoutMs = 2_000,
    label = 'unlabeled',
  ): Promise<P2pOutboundResponse> {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) {
      return Promise.resolve(this.messages.splice(index, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
          reject(
            new Error(
              `Timed out waiting for ${label}; queued=${JSON.stringify(
                this.messages,
              )}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  has(predicate: (message: P2pOutboundResponse) => boolean): boolean {
    return this.messages.some(predicate);
  }
}

const activeFixtures: RunningFixture[] = [];

async function createFixture(
  options: FixtureOptions = {},
): Promise<RunningFixture> {
  let nowMs = 1_700_000_000_000;
  const users = new Map([
    ['user-1', { displayName: 'Person One' }],
    ['user-2', { displayName: 'Person Two' }],
    ['user-3', { displayName: 'Person Three' }],
  ]);
  const accessTokenService: AccessTokenService = {
    async sign() {
      return 'unused';
    },
    async verify(token) {
      const match = /^access-(user-[123])$/u.exec(token);
      if (match === null) throw new Error('invalid token');
      return {
        userId: match[1]!,
        sessionId: `session-${match[1]!}`,
        issuedAt: Math.floor(nowMs / 1_000),
        expiresAt:
          Math.floor(nowMs / 1_000) + (options.accessTokenTtlSeconds ?? 900),
      };
    },
  };
  let connectionId = 0;
  let eventId = 0;
  let roomId = 0;
  let iceCall = 0;
  const app = await createApp({
    authService: {} as never,
    accessTokenService,
    readinessCheck: async () => undefined,
    logger: false,
    realtime: {
      identityRepository: {
        async findEmailUserById(userId: string) {
          const user = users.get(userId);
          return user === undefined
            ? null
            : {
                emailNormalized: `${userId}@example.test`,
                verifiedAt: new Date(),
                user: {
                  id: userId,
                  displayName: user.displayName,
                  createdAt: new Date(0),
                  disabledAt: null,
                },
              };
        },
      },
      ticketStore: createSignalTicketStore({ now: () => nowMs }),
      turn: {
        urls: [
          'stun:rtc.example.test:3478',
          'turn:rtc.example.test:3478?transport=udp',
        ],
        sharedSecret: 'integration-turn-secret',
        credentialTtlSeconds: 600,
      },
      now: () => nowMs,
      roomRegistryOptions: {
        randomInt: () => 12_345,
        randomUUID: () => `room-${++roomId}`,
        roomCodeTtlMs: options.roomCodeTtlMs,
        requestCacheMaxEntries: options.requestCacheMaxEntries,
      },
      gatewayOptions: {
        randomConnectionId: () => `connection-${++connectionId}`,
        randomEventId: () => `event-${++eventId}`,
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
        maxBufferedBytes: options.maxBufferedBytes,
        inboundRateWindowMs: options.inboundRateWindowMs,
        maxInboundMessagesPerWindow: options.maxInboundMessagesPerWindow,
        maxInboundBytesPerWindow: options.maxInboundBytesPerWindow,
        maxAckEntriesPerConnection: options.maxAckEntriesPerConnection,
      },
      ...(options.failIceCalls === undefined
        ? {}
        : {
            createFreshIce: () => {
              iceCall += 1;
              if (options.failIceCalls!.includes(iceCall)) {
                throw new Error(`injected ICE failure ${iceCall}`);
              }
              return {
                rtcConfiguration: {
                  iceServers: [
                    { urls: ['stun:rtc.example.test:3478'] },
                    {
                      urls: ['turn:rtc.example.test:3478?transport=udp'],
                      username: `1700000600:opaque-${iceCall}`,
                      credential: `credential-${iceCall}`,
                    },
                  ],
                  iceTransportPolicy: 'all' as const,
                },
                iceCredentialsExpiresAt: '2023-11-14T22:23:20.000Z',
              };
            },
          }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const fixture: RunningFixture = {
    app,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    advance(milliseconds) {
      nowMs += milliseconds;
    },
  };
  activeFixtures.push(fixture);
  return fixture;
}

async function issueTicket(fixture: RunningFixture, userId: string) {
  const response = await fetch(`${fixture.httpUrl}/v1/realtime/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer access-${userId}` },
  });
  expect(response.status).toBe(200);
  return signalTicketResponseSchema.parse(await response.json());
}

function openSocket(
  fixture: RunningFixture,
  ticket: string,
  path = '/v1/realtime',
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${fixture.wsUrl}${path}`, [
      'wo-v1',
      `ticket.${ticket}`,
    ]);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function openSocketWithUpgradeHeader(
  fixture: RunningFixture,
  ticket: string,
): Promise<{ socket: WebSocket; selectedProtocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    let selectedProtocol: string | undefined;
    const socket = new WebSocket(`${fixture.wsUrl}/v1/realtime`, [
      'wo-v1',
      `ticket.${ticket}`,
    ]);
    socket.once('upgrade', (response) => {
      selectedProtocol = response.headers['sec-websocket-protocol'];
    });
    socket.once('open', () => resolve({ socket, selectedProtocol }));
    socket.once('error', reject);
  });
}

async function openClient(
  fixture: RunningFixture,
  userId: string,
  options: { readonly autoPong?: boolean } = {},
): Promise<SocketInbox> {
  const issued = await issueTicket(fixture, userId);
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const next = new WebSocket(
      `${fixture.wsUrl}/v1/realtime`,
      ['wo-v1', `ticket.${issued.ticket}`],
      { autoPong: options.autoPong ?? true },
    );
    next.once('open', () => resolve(next));
    next.once('error', reject);
  });
  return new SocketInbox(socket);
}

function sendRequest(
  client: SocketInbox,
  type: string,
  requestId: string,
  payload: unknown,
): void {
  const currentPayload =
    type === 'peer.ready' &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
      ? { ...payload, mediaPlan: P2P_MEDIA_PLAN }
      : payload;
  client.socket.send(
    JSON.stringify({ version: 1, requestId, type, payload: currentPayload }),
  );
}

function serverSockets(fixture: RunningFixture): WebSocket[] {
  const app = fixture.app as FastifyInstance & {
    readonly websocketServer: { readonly clients: Set<WebSocket> };
  };
  return [...app.websocketServer.clients];
}

function failNextServerDelivery(
  socket: WebSocket,
  messageType: string,
  mode: 'throw' | 'callback' | 'drop',
): void {
  const target = socket as unknown as {
    send(...arguments_: unknown[]): void;
  };
  const originalSend = target.send;
  target.send = function (...arguments_: unknown[]): void {
    const raw = arguments_[0];
    let type: unknown;
    if (typeof raw === 'string') {
      try {
        type = (JSON.parse(raw) as { readonly type?: unknown }).type;
      } catch {
        type = undefined;
      }
    }
    if (type !== messageType) {
      Reflect.apply(originalSend, this, arguments_);
      return;
    }
    target.send = originalSend;
    if (mode === 'throw') {
      throw new Error('injected synchronous send failure');
    }
    const callback = arguments_.find(
      (argument): argument is (error?: Error) => void =>
        typeof argument === 'function',
    );
    if (mode === 'drop') {
      callback?.();
      return;
    }
    queueMicrotask(() => callback?.(new Error('injected callback failure')));
  };
}

function delayNextServerDeliveryCallback(
  socket: WebSocket,
  messageType: string,
): Readonly<{ fail(): void }> {
  const target = socket as unknown as {
    send(...arguments_: unknown[]): void;
  };
  const originalSend = target.send;
  let delayedCallback: ((error?: Error) => void) | null = null;
  target.send = function (...arguments_: unknown[]): void {
    const raw = arguments_[0];
    let type: unknown;
    if (typeof raw === 'string') {
      try {
        type = (JSON.parse(raw) as { readonly type?: unknown }).type;
      } catch {
        type = undefined;
      }
    }
    if (type !== messageType) {
      Reflect.apply(originalSend, this, arguments_);
      return;
    }
    target.send = originalSend;
    const callbackIndex = arguments_.findIndex(
      (argument) => typeof argument === 'function',
    );
    if (callbackIndex === -1) {
      throw new Error('expected a delivery callback');
    }
    delayedCallback = arguments_[callbackIndex] as (error?: Error) => void;
    const forwarded = [...arguments_];
    forwarded[callbackIndex] = () => undefined;
    Reflect.apply(originalSend, this, forwarded);
  };
  return Object.freeze({
    fail() {
      if (delayedCallback === null) {
        throw new Error('delivery callback was not captured');
      }
      const callback = delayedCallback;
      delayedCallback = null;
      callback(new Error('injected delayed callback failure'));
    },
  });
}

async function evictGatewayAckCache(
  fixture: RunningFixture,
  client: SocketInbox,
  prefix: string,
  roomId: string,
  connectionEpoch: number,
  negotiationId: string,
  count = 260,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % 90 === 0) {
      fixture.advance(1_000);
    }
    const requestId = `${prefix}-${index}`;
    sendRequest(client, 'webrtc.iceServers.refresh', requestId, {
      roomId,
      connectionEpoch,
      negotiationId,
    });
    await client.next(isAck(requestId));
  }
}

async function openReadyPair(fixture: RunningFixture) {
  const creator = await openClient(fixture, 'user-1');
  const joiner = await openClient(fixture, 'user-2');
  sendRequest(creator, 'room.create', 'create-1', {});
  const created = successData(await creator.next(isAck('create-1')));
  const roomId = String(created['roomId']);
  const creatorEpoch = Number(created['connectionEpoch']);
  sendRequest(joiner, 'room.join', 'join-1', {
    roomCode: created['roomCode'],
  });
  const joined = successData(await joiner.next(isAck('join-1')));
  const joinerEpoch = Number(joined['connectionEpoch']);
  await creator.next(isBroadcast('peer.joined'));
  sendRequest(creator, 'peer.ready', 'creator-ready', {
    roomId,
    connectionEpoch: creatorEpoch,
  });
  await creator.next(isAck('creator-ready'));
  await joiner.next(isBroadcast('peer.ready'));
  sendRequest(joiner, 'peer.ready', 'joiner-ready', {
    roomId,
    connectionEpoch: joinerEpoch,
  });
  await joiner.next(isAck('joiner-ready'));
  await creator.next(isBroadcast('peer.ready'));
  return { creator, joiner, roomId, creatorEpoch, joinerEpoch } as const;
}

const isAck = (requestId: string) => (message: P2pOutboundResponse) =>
  'requestId' in message &&
  message.requestId === requestId &&
  message.type.endsWith('.ack');

const isBroadcast = (type: string) => (message: P2pOutboundResponse) =>
  message.type === type && 'eventId' in message;

function successData(message: P2pOutboundResponse): Record<string, unknown> {
  const payload: unknown = message.payload;
  if (
    !message.type.endsWith('.ack') ||
    typeof payload !== 'object' ||
    payload === null ||
    !('ok' in payload) ||
    payload.ok !== true ||
    !('data' in payload)
  ) {
    throw new Error('Expected successful acknowledgement');
  }
  return payload.data as Record<string, unknown>;
}

function turnUsername(session: Record<string, unknown>): string {
  const configuration = session['rtcConfiguration'] as {
    iceServers: Array<{ username?: string }>;
  };
  const username = configuration.iceServers.find(
    (server) => server.username !== undefined,
  )?.username;
  if (username === undefined) throw new Error('Missing TURN username');
  return username;
}

function rejectedUpgradeStatus(
  fixture: RunningFixture,
  ticket: string,
  path = '/v1/realtime',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${fixture.wsUrl}${path}`, [
      'wo-v1',
      `ticket.${ticket}`,
    ]);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => reject(new Error('upgrade unexpectedly opened')));
    socket.once('error', () => undefined);
  });
}

function rejectedProtocolsStatus(
  fixture: RunningFixture,
  protocols: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${fixture.wsUrl}/v1/realtime`, protocols);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => reject(new Error('upgrade unexpectedly opened')));
    socket.once('error', () => undefined);
  });
}

function rawUpgradeStatus(
  fixture: RunningFixture,
  protocolHeader: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${fixture.httpUrl}/v1/realtime`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-protocol': protocolHeader,
      },
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('upgrade unexpectedly opened'));
    });
    request.once('error', reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(activeFixtures.splice(0).map(({ app }) => app.close()));
});

describe('authenticated signaling gateway', () => {
  test('returns the current screen owner in join and resume acknowledgements', async () => {
    const fixture = await createFixture();
    const creator = await openClient(fixture, 'user-1');
    sendRequest(creator, 'room.create', 'screen-snapshot-create', {});
    const createAck = await creator.next(isAck('screen-snapshot-create'));
    expect(createAck.payload).toEqual({ ok: true, data: expect.anything() });
    const created = successData(createAck);
    const roomId = String(created['roomId']);

    sendRequest(creator, 'screen.acquire', 'screen-snapshot-acquire', {
      roomId,
    });
    const acquired = successData(
      await creator.next(isAck('screen-snapshot-acquire')),
    );
    const lease = acquired['lease'] as Record<string, unknown>;
    await creator.next(isBroadcast('screen.ownerChanged'));

    const joiner = await openClient(fixture, 'user-2');
    sendRequest(joiner, 'room.join', 'screen-snapshot-join', {
      roomCode: created['roomCode'],
    });
    const joined = successData(
      await joiner.next(isAck('screen-snapshot-join')),
    );
    expect(joined['screen']).toEqual({
      owner: {
        userId: 'user-1',
        displayName: 'Person One',
        ready: false,
      },
      leaseId: lease['leaseId'],
      leaseExpiresAt: lease['expiresAt'],
    });
    await creator.next(isBroadcast('peer.joined'));

    joiner.socket.terminate();
    await creator.next(isBroadcast('peer.left'));
    const resumed = await openClient(fixture, 'user-2');
    sendRequest(resumed, 'room.resume', 'screen-snapshot-resume', { roomId });
    const resumedData = successData(
      await resumed.next(isAck('screen-snapshot-resume')),
    );
    expect(resumedData['screen']).toEqual(joined['screen']);
  });

  test('arbitrates one screen owner and broadcasts bitrate only to the peer', async () => {
    const fixture = await createFixture({ maxAckEntriesPerConnection: 1 });
    const { creator, joiner, roomId, creatorEpoch } =
      await openReadyPair(fixture);

    sendRequest(creator, 'screen.acquire', 'screen-acquire', { roomId });
    const acquired = successData(await creator.next(isAck('screen-acquire')));
    const lease = acquired['lease'] as Record<string, unknown>;
    const leaseId = String(lease['leaseId']);
    expect(lease).toMatchObject({ roomId, holderId: 'user-1' });
    await creator.next(isBroadcast('screen.ownerChanged'));
    await joiner.next(isBroadcast('screen.ownerChanged'));

    sendRequest(joiner, 'screen.acquire', 'screen-busy', { roomId });
    expect(await joiner.next(isAck('screen-busy'))).toMatchObject({
      payload: { ok: false, error: { code: 'SCREEN_SHARE_BUSY' } },
    });

    sendRequest(creator, 'screen.bitrate', 'screen-bitrate', {
      roomId,
      leaseId,
      bitrate: 8_000_000,
    });
    expect(await creator.next(isAck('screen-bitrate'))).toMatchObject({
      payload: { ok: true, data: { bitrate: 8_000_000 } },
    });
    expect(await joiner.next(isBroadcast('screen.bitrate'))).toMatchObject({
      payload: { roomId, leaseId, bitrate: 8_000_000 },
    });
    expect(creator.has(isBroadcast('screen.bitrate'))).toBe(false);

    sendRequest(creator, 'screen.release', 'screen-release', {
      roomId,
      leaseId,
    });
    expect(await creator.next(isAck('screen-release'))).toMatchObject({
      payload: { ok: true, data: {} },
    });
    await creator.next(isBroadcast('screen.ownerChanged'));
    await joiner.next(isBroadcast('screen.ownerChanged'));

    sendRequest(joiner, 'screen.acquire', 'screen-next', { roomId });
    const next = successData(await joiner.next(isAck('screen-next')));
    const nextLeaseId = String(
      (next['lease'] as Record<string, unknown>)['leaseId'],
    );
    await creator.next(isBroadcast('screen.ownerChanged'));
    await joiner.next(isBroadcast('screen.ownerChanged'));
    sendRequest(creator, 'peer.ready', 'evict-release-ack', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('evict-release-ack'));

    sendRequest(creator, 'screen.release', 'screen-release', {
      roomId,
      leaseId,
    });
    expect(await creator.next(isAck('screen-release'))).toMatchObject({
      payload: { ok: true, data: {} },
    });
    expect(creator.has(isBroadcast('screen.ownerChanged'))).toBe(false);
    expect(joiner.has(isBroadcast('screen.ownerChanged'))).toBe(false);
    sendRequest(joiner, 'screen.renew', 'screen-next-renew', {
      roomId,
      leaseId: nextLeaseId,
    });
    expect(await joiner.next(isAck('screen-next-renew'))).toMatchObject({
      payload: { ok: true },
    });
  });

  test('preserves and rebinds a screen lease across transient owner reconnect', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId } = await openReadyPair(fixture);
    sendRequest(creator, 'screen.acquire', 'screen-acquire-disconnect', {
      roomId,
    });
    const acquired = successData(
      await creator.next(isAck('screen-acquire-disconnect')),
    );
    const leaseId = String(
      (acquired['lease'] as Record<string, unknown>)['leaseId'],
    );
    await creator.next(isBroadcast('screen.ownerChanged'));
    await joiner.next(isBroadcast('screen.ownerChanged'));

    creator.socket.terminate();
    expect(await joiner.next(isBroadcast('peer.left'))).toMatchObject({
      payload: { roomId, userId: 'user-1', reason: 'disconnected' },
    });
    expect(joiner.has(isBroadcast('screen.ownerChanged'))).toBe(false);

    const resumed = await openClient(fixture, 'user-1');
    sendRequest(resumed, 'room.resume', 'screen-owner-resume', { roomId });
    const resumedData = successData(
      await resumed.next(isAck('screen-owner-resume')),
    );
    expect(resumedData['screen']).toMatchObject({
      leaseId,
      owner: { userId: 'user-1' },
    });
    sendRequest(resumed, 'screen.renew', 'screen-renew-after-resume', {
      roomId,
      leaseId,
    });
    expect(
      await resumed.next(isAck('screen-renew-after-resume')),
    ).toMatchObject({
      payload: { ok: true, data: { lease: { leaseId } } },
    });

    sendRequest(resumed, 'room.leave', 'screen-owner-leave', { roomId });
    await resumed.next(isAck('screen-owner-leave'));
    expect(await joiner.next(isBroadcast('screen.ownerChanged'))).toMatchObject(
      {
        payload: {
          roomId,
          owner: null,
          leaseId: null,
          leaseExpiresAt: null,
        },
      },
    );
  });

  test('can replay an expired gateway acquire ack but rejects it after LRU eviction', async () => {
    const fixture = await createFixture({
      requestCacheMaxEntries: 1,
      maxAckEntriesPerConnection: 1,
    });
    const { creator, joiner, roomId, creatorEpoch } =
      await openReadyPair(fixture);
    const acquirePayload = { roomId };
    sendRequest(creator, 'screen.acquire', 'expired-acquire', acquirePayload);
    const firstAck = await creator.next(isAck('expired-acquire'));
    const firstData = successData(firstAck);
    await creator.next(isBroadcast('screen.ownerChanged'));
    await joiner.next(isBroadcast('screen.ownerChanged'));
    fixture.advance(15_000);

    sendRequest(creator, 'screen.acquire', 'expired-acquire', acquirePayload);
    const staleGatewayReplay = await creator.next(isAck('expired-acquire'));
    expect(successData(staleGatewayReplay)).toEqual(firstData);

    sendRequest(joiner, 'screen.acquire', 'replacement-acquire', { roomId });
    expect(await joiner.next(isAck('replacement-acquire'))).toMatchObject({
      payload: { ok: true, data: { lease: { holderId: 'user-2' } } },
    });
    await creator.next(
      (message) =>
        isBroadcast('screen.ownerChanged')(message) &&
        (message.payload as { owner?: unknown }).owner === null,
    );
    await creator.next(
      (message) =>
        isBroadcast('screen.ownerChanged')(message) &&
        (message.payload as { owner?: unknown }).owner !== null,
    );
    await joiner.next(
      (message) =>
        isBroadcast('screen.ownerChanged')(message) &&
        (message.payload as { owner?: unknown }).owner === null,
    );
    await joiner.next(
      (message) =>
        isBroadcast('screen.ownerChanged')(message) &&
        (message.payload as { owner?: unknown }).owner !== null,
    );
    sendRequest(creator, 'peer.ready', 'evict-expired-acquire', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('evict-expired-acquire'));

    sendRequest(creator, 'screen.acquire', 'expired-acquire', acquirePayload);
    expect(await creator.next(isAck('expired-acquire'))).toMatchObject({
      payload: { ok: false, error: { code: 'LEASE_LOST' } },
    });
  });

  test('negotiates only wo-v1 and consumes a query-free ticket once', async () => {
    const fixture = await createFixture();
    const issued = await issueTicket(fixture, 'user-1');
    const { socket, selectedProtocol } = await openSocketWithUpgradeHeader(
      fixture,
      issued.ticket,
    );
    expect(socket.protocol).toBe('wo-v1');
    expect(selectedProtocol).toBe('wo-v1');
    expect(selectedProtocol).not.toContain(issued.ticket);
    socket.close();

    expect(await rejectedUpgradeStatus(fixture, issued.ticket)).toBe(401);
  });

  test('recovers a lost join ACK with the same code and request ID', async () => {
    const fixture = await createFixture();
    const creator = await openClient(fixture, 'user-1');
    sendRequest(creator, 'room.create', 'create-1', {});
    const created = successData(await creator.next(isAck('create-1')));
    const roomId = String(created['roomId']);

    const firstJoiner = await openClient(fixture, 'user-2');
    const firstJoinerServerSocket = serverSockets(fixture).at(-1);
    expect(firstJoinerServerSocket).toBeDefined();
    failNextServerDelivery(firstJoinerServerSocket!, 'room.join.ack', 'drop');
    const firstJoinerClosed = new Promise<number>((resolve) =>
      firstJoiner.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(firstJoiner, 'room.join', 'join-1', {
      roomCode: created['roomCode'],
    });
    await creator.next(isBroadcast('peer.joined'));

    const recovered = await openClient(fixture, 'user-2');
    sendRequest(recovered, 'room.join', 'join-1', {
      roomCode: created['roomCode'],
    });
    const recoveredData = successData(await recovered.next(isAck('join-1')));
    expect(recoveredData).toMatchObject({ roomId, role: 'joiner' });
    expect(await firstJoinerClosed).toBe(4409);
    expect(Number(recoveredData['connectionEpoch'])).toBeGreaterThan(
      Number((created as { connectionEpoch: number })['connectionEpoch']),
    );

    const third = await openClient(fixture, 'user-3');
    sendRequest(third, 'room.join', 'third-join', {
      roomCode: created['roomCode'],
    });
    expect(await third.next(isAck('third-join'))).toMatchObject({
      payload: { ok: false, error: { code: 'ROOM_CODE_INVALID' } },
    });
  });

  test('closes and unbinds the creator when join ICE generation fails', async () => {
    const fixture = await createFixture({ failIceCalls: [2] });
    const creator = await openClient(fixture, 'user-1');
    const joiner = await openClient(fixture, 'user-2');
    sendRequest(creator, 'room.create', 'create-before-ice-failure', {});
    const created = successData(
      await creator.next(isAck('create-before-ice-failure')),
    );
    sendRequest(joiner, 'room.join', 'join-with-ice-failure', {
      roomCode: created['roomCode'],
    });
    expect(
      await joiner.next(
        isAck('join-with-ice-failure'),
        2_000,
        'failed join ack',
      ),
    ).toMatchObject({
      payload: {
        ok: false,
        error: { code: 'SIGNALING_UNAVAILABLE', retryable: true },
      },
    });
    expect(
      await creator.next(isBroadcast('room.closed'), 2_000, 'room closed'),
    ).toMatchObject({
      payload: { roomId: created['roomId'], reason: 'signaling_error' },
    });

    sendRequest(creator, 'room.create', 'create-after-ice-failure', {});
    expect(
      await creator.next(
        isAck('create-after-ice-failure'),
        2_000,
        'create after compensation',
      ),
    ).toMatchObject({
      payload: { ok: true },
    });
  });

  test('rejects missing, duplicate, and extra subprotocols before consuming', async () => {
    const fixture = await createFixture();
    const issued = await issueTicket(fixture, 'user-1');
    expect(await rejectedProtocolsStatus(fixture, ['wo-v1'])).toBe(401);
    expect(
      await rejectedProtocolsStatus(fixture, [
        'wo-v1',
        `ticket.${issued.ticket}`,
        'wo-v2',
      ]),
    ).toBe(401);
    expect(
      await rawUpgradeStatus(fixture, `wo-v1, wo-v1, ticket.${issued.ticket}`),
    ).toBe(401);

    const valid = await openSocket(fixture, issued.ticket);
    expect(valid.protocol).toBe('wo-v1');
    valid.close();
  });

  test('bounds ticket issuance per authenticated user and IP', async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(`${fixture.httpUrl}/v1/realtime/ticket`, {
        method: 'POST',
        headers: { authorization: 'Bearer access-user-1' },
      });
      expect(response.status).toBe(200);
    }
    const limited = await fetch(`${fixture.httpUrl}/v1/realtime/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer access-user-1' },
    });
    expect(limited.status).toBe(429);
    const otherUser = await fetch(`${fixture.httpUrl}/v1/realtime/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer access-user-2' },
    });
    expect(otherUser.status).toBe(200);
  });

  test('delivers timer-driven room closure and releases the socket binding', async () => {
    const fixture = await createFixture({ roomCodeTtlMs: 20 });
    const creator = await openClient(fixture, 'user-1');
    sendRequest(creator, 'room.create', 'create-expiring', {});
    const created = successData(await creator.next(isAck('create-expiring')));
    fixture.advance(21);
    expect((await creator.next(isBroadcast('room.closed'))).payload).toEqual({
      roomId: created['roomId'],
      reason: 'expired',
    });

    sendRequest(creator, 'room.create', 'create-after-expiry', {});
    expect(
      (await creator.next(isAck('create-after-expiry'))).payload,
    ).toMatchObject({ ok: true });
  });

  test('rejects query-bearing and expired upgrades without leaking a ticket', async () => {
    const fixture = await createFixture();
    const queryTicket = await issueTicket(fixture, 'user-1');
    expect(
      await rejectedUpgradeStatus(
        fixture,
        queryTicket.ticket,
        '/v1/realtime?ticket=forbidden',
      ),
    ).toBe(400);
    const validAfterQueryRejection = await openSocket(
      fixture,
      queryTicket.ticket,
    );
    validAfterQueryRejection.close();

    const expired = await issueTicket(fixture, 'user-1');
    fixture.advance(31_000);
    expect(await rejectedUpgradeStatus(fixture, expired.ticket)).toBe(401);
  });

  test('relays an authorized two-person negotiation and caches duplicate acks', async () => {
    const fixture = await createFixture();
    const creator = await openClient(fixture, 'user-1');
    const joiner = await openClient(fixture, 'user-2');
    const third = await openClient(fixture, 'user-3');

    sendRequest(creator, 'room.create', 'create-1', {});
    const createAck = await creator.next(isAck('create-1'), 2_000, 'create-1');
    const created = successData(createAck);
    const roomId = String(created['roomId']);
    const roomCode = String(created['roomCode']);
    const creatorEpoch = Number(created['connectionEpoch']);

    sendRequest(joiner, 'room.join', 'join-1', { roomCode });
    const joinAck = await joiner.next(isAck('join-1'), 2_000, 'join-1');
    const joined = successData(joinAck);
    const joinerEpoch = Number(joined['connectionEpoch']);
    expect(creator.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      (joined['rtcConfiguration'] as { iceServers: unknown[] }).iceServers,
    ).toHaveLength(2);
    expect(
      (await creator.next(isBroadcast('peer.joined'), 2_000, 'peer.joined'))
        .payload,
    ).toMatchObject({ peer: { userId: 'user-2', displayName: 'Person Two' } });

    sendRequest(third, 'room.join', 'third-join', { roomCode });
    expect(
      (await third.next(isAck('third-join'), 2_000, 'third-join')).payload,
    ).toMatchObject({
      ok: false,
      error: { code: 'ROOM_CODE_INVALID' },
    });

    sendRequest(creator, 'peer.ready', 'creator-ready', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('creator-ready'), 2_000, 'creator-ready ack');
    await joiner.next(isBroadcast('peer.ready'), 2_000, 'creator peer.ready');
    sendRequest(joiner, 'peer.ready', 'joiner-ready', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready'), 2_000, 'joiner-ready ack');
    await creator.next(isBroadcast('peer.ready'), 2_000, 'joiner peer.ready');

    sendRequest(creator, 'webrtc.iceServers.refresh', 'wrong-room', {
      roomId: 'wrong-room',
      connectionEpoch: creatorEpoch,
      negotiationId: 'not-started',
    });
    expect((await creator.next(isAck('wrong-room'))).payload).toMatchObject({
      ok: false,
      error: { code: 'STALE_CONNECTION' },
    });

    sendRequest(joiner, 'webrtc.offer', 'forbidden-offer', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'joiner-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    expect((await joiner.next(isAck('forbidden-offer'))).payload).toMatchObject(
      {
        ok: false,
        error: { code: 'FORBIDDEN' },
      },
    );

    sendRequest(creator, 'webrtc.iceServers.refresh', 'refresh-before-offer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'not-started',
    });
    expect(
      (await creator.next(isAck('refresh-before-offer'))).payload,
    ).toMatchObject({ ok: true });

    sendRequest(creator, 'webrtc.offer', 'offer-1', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'negotiation-1',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-1'));
    expect(
      (await joiner.next(isBroadcast('webrtc.offer'))).payload,
    ).toMatchObject({ roomId, negotiationId: 'negotiation-1' });

    sendRequest(joiner, 'webrtc.answer', 'answer-1', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'negotiation-1',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isAck('answer-1'));
    await creator.next(isBroadcast('webrtc.answer'));
    sendRequest(creator, 'webrtc.answerApplied', 'answer-applied-1', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'negotiation-1',
    });
    await creator.next(isAck('answer-applied-1'));

    const candidateRequest = {
      version: 1,
      requestId: 'candidate-1',
      type: 'webrtc.iceCandidate',
      payload: {
        roomId,
        connectionEpoch: creatorEpoch,
        negotiationId: 'negotiation-1',
        candidate: null,
      },
    };
    creator.socket.send(JSON.stringify(candidateRequest));
    const firstCandidateAck = await creator.next(isAck('candidate-1'));
    await joiner.next(isBroadcast('webrtc.iceCandidate'));
    creator.socket.send(JSON.stringify(candidateRequest));
    const duplicateCandidateAck = await creator.next(isAck('candidate-1'));
    expect(duplicateCandidateAck).toEqual(firstCandidateAck);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joiner.has(isBroadcast('webrtc.iceCandidate'))).toBe(false);

    sendRequest(creator, 'webrtc.iceCandidate', 'candidate-1', {
      ...candidateRequest.payload,
      candidate: { candidate: '' },
    });
    expect(
      await creator.next(
        (message) =>
          message.type === 'protocol.error' &&
          message.requestId === 'candidate-1',
      ),
    ).toMatchObject({
      payload: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    });

    sendRequest(third, 'webrtc.iceCandidate', 'third-candidate', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'negotiation-1',
      candidate: null,
    });
    expect((await third.next(isAck('third-candidate'))).payload).toMatchObject({
      ok: false,
      error: { code: 'STALE_CONNECTION' },
    });

    sendRequest(joiner, 'webrtc.restartRequested', 'restart-requested', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'negotiation-1',
    });
    await joiner.next(isAck('restart-requested'));
    await creator.next(isBroadcast('webrtc.restartRequested'));
    sendRequest(creator, 'webrtc.iceRestart', 'restart-1', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'negotiation-2',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('restart-1'));
    await joiner.next(isBroadcast('webrtc.iceRestart'));

    sendRequest(joiner, 'webrtc.iceCandidate', 'stale-negotiation', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'negotiation-1',
      candidate: null,
    });
    expect(
      (await joiner.next(isAck('stale-negotiation'))).payload,
    ).toMatchObject({
      ok: false,
      error: { code: 'STALE_NEGOTIATION' },
    });
  });

  test('replays a queued offer after both ack caches evict it', async () => {
    const fixture = await createFixture({
      requestCacheMaxEntries: 1,
      maxAckEntriesPerConnection: 3,
    });
    const { creator, joiner, roomId, creatorEpoch } =
      await openReadyPair(fixture);
    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    failNextServerDelivery(creatorServerSocket!, 'webrtc.offer.ack', 'drop');
    const offerPayload = {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'cache-resistant-offer-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    } as const;
    sendRequest(creator, 'webrtc.offer', 'cache-resistant-offer', offerPayload);
    await joiner.next(isBroadcast('webrtc.offer'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    sendRequest(creator, 'webrtc.iceCandidate', 'evict-offer-domain', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: offerPayload.negotiationId,
      candidate: null,
    });
    await creator.next(isAck('evict-offer-domain'));
    await joiner.next(isBroadcast('webrtc.iceCandidate'));
    await evictGatewayAckCache(
      fixture,
      creator,
      'evict-offer-gateway',
      roomId,
      creatorEpoch,
      offerPayload.negotiationId,
      4,
    );

    sendRequest(creator, 'webrtc.offer', 'cache-resistant-offer', offerPayload);
    expect(await creator.next(isAck('cache-resistant-offer'))).toMatchObject({
      payload: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joiner.has(isBroadcast('webrtc.offer'))).toBe(false);

    sendRequest(creator, 'webrtc.iceCandidate', 'evict-offer-domain-again', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: offerPayload.negotiationId,
      candidate: null,
    });
    await creator.next(isAck('evict-offer-domain-again'));
    await joiner.next(isBroadcast('webrtc.iceCandidate'));
    await evictGatewayAckCache(
      fixture,
      creator,
      'evict-offer-gateway-again',
      roomId,
      creatorEpoch,
      offerPayload.negotiationId,
      4,
    );
    sendRequest(creator, 'webrtc.offer', 'cache-resistant-offer', {
      ...offerPayload,
      description: { type: 'offer', sdp: 'v=0\r\na=changed\r\n' },
    });
    expect(await creator.next(isAck('cache-resistant-offer'))).toMatchObject({
      payload: { ok: false, error: { code: 'INVALID_STATE' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joiner.has(isBroadcast('webrtc.offer'))).toBe(false);
  });

  test('closes the exact replaced socket and emits one negotiation reset', async () => {
    const fixture = await createFixture();
    const oldCreator = await openClient(fixture, 'user-1');
    const joiner = await openClient(fixture, 'user-2');
    sendRequest(oldCreator, 'room.create', 'create-1', {});
    const created = successData(await oldCreator.next(isAck('create-1')));
    const roomId = String(created['roomId']);
    const creatorEpoch = Number(created['connectionEpoch']);
    sendRequest(joiner, 'room.join', 'join-1', {
      roomCode: String(created['roomCode']),
    });
    const joined = successData(await joiner.next(isAck('join-1')));
    const joinerEpoch = Number(joined['connectionEpoch']);
    await oldCreator.next(isBroadcast('peer.joined'));
    sendRequest(oldCreator, 'peer.ready', 'creator-ready', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await oldCreator.next(isAck('creator-ready'));
    await joiner.next(isBroadcast('peer.ready'));
    sendRequest(joiner, 'peer.ready', 'joiner-ready', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready'));
    await oldCreator.next(isBroadcast('peer.ready'));
    sendRequest(oldCreator, 'webrtc.offer', 'offer-1', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'negotiation-1',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await oldCreator.next(isAck('offer-1'));
    await joiner.next(isBroadcast('webrtc.offer'));

    const oldClosed = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        oldCreator.socket.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
      },
    );
    const intermediate = await openClient(fixture, 'user-1');
    sendRequest(intermediate, 'room.resume', 'resume-1', { roomId });
    const intermediateSession = successData(
      await intermediate.next(isAck('resume-1')),
    );
    const firstResetAtIntermediate = await intermediate.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const firstResetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(firstResetAtIntermediate.payload).toEqual(
      firstResetAtJoiner.payload,
    );
    const intermediateEpoch = Number(intermediateSession['connectionEpoch']);
    expect(intermediateEpoch).toBeGreaterThan(creatorEpoch);
    expect(turnUsername(intermediateSession)).not.toBe(turnUsername(created));
    expect(await oldClosed).toEqual({ code: 4409, reason: 'SESSION_REPLACED' });

    const intermediateClosed = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        intermediate.socket.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
      },
    );
    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'resume-2', { roomId });
    const resumed = successData(await replacement.next(isAck('resume-2')));
    const resetAtReplacement = await replacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const resetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(resetAtJoiner.payload).toEqual(resetAtReplacement.payload);
    const replacementEpoch = Number(resumed['connectionEpoch']);
    expect(replacementEpoch).toBeGreaterThan(intermediateEpoch);
    expect(turnUsername(resumed)).not.toBe(turnUsername(intermediateSession));
    expect(await intermediateClosed).toEqual({
      code: 4409,
      reason: 'SESSION_REPLACED',
    });

    const staleEpochRequests = [
      {
        type: 'peer.ready',
        payload: { roomId, connectionEpoch: intermediateEpoch },
      },
      {
        type: 'webrtc.offer',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-offer',
          description: { type: 'offer', sdp: 'v=0\r\n' },
        },
      },
      {
        type: 'webrtc.answer',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-answer',
          description: { type: 'answer', sdp: 'v=0\r\n' },
        },
      },
      {
        type: 'webrtc.answerApplied',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-answer-applied',
        },
      },
      {
        type: 'webrtc.iceCandidate',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-candidate',
          candidate: null,
        },
      },
      {
        type: 'webrtc.restartRequested',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-restart-request',
        },
      },
      {
        type: 'webrtc.iceRestart',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-ice-restart',
          description: { type: 'offer', sdp: 'v=0\r\n' },
        },
      },
      {
        type: 'webrtc.iceServers.refresh',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-ice-refresh',
        },
      },
      {
        type: 'webrtc.recoveryReset',
        payload: {
          roomId,
          connectionEpoch: intermediateEpoch,
          negotiationId: 'stale-recovery-reset',
        },
      },
    ] as const;
    for (const [index, request] of staleEpochRequests.entries()) {
      const requestId = `stale-epoch-${index}`;
      sendRequest(replacement, request.type, requestId, request.payload);
      expect((await replacement.next(isAck(requestId))).payload).toMatchObject({
        ok: false,
        error: { code: 'STALE_CONNECTION' },
      });
    }

    sendRequest(replacement, 'peer.ready', 'replacement-ready', {
      roomId,
      connectionEpoch: replacementEpoch,
    });
    await replacement.next(isAck('replacement-ready'));
    sendRequest(joiner, 'peer.ready', 'joiner-ready-after-reset', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready-after-reset'));
    const resetId = String(
      (resetAtReplacement.payload as Record<string, unknown>)['negotiationId'],
    );

    sendRequest(replacement, 'peer.ready', 'replacement-ready', {
      roomId,
      connectionEpoch: replacementEpoch,
    });
    await replacement.next(isAck('replacement-ready'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacement.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);
    expect(joiner.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);

    sendRequest(replacement, 'webrtc.offer', 'offer-after-reset', {
      roomId,
      connectionEpoch: replacementEpoch,
      negotiationId: resetId,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await replacement.next(isAck('offer-after-reset'));
    expect(
      (await joiner.next(isBroadcast('webrtc.offer'))).payload,
    ).toMatchObject({ negotiationId: resetId });
  });

  test('resets once after a lost initial answer and a lost restart answer', async () => {
    const fixture = await createFixture();
    const creator = await openClient(fixture, 'user-1');
    let joiner = await openClient(fixture, 'user-2');
    sendRequest(creator, 'room.create', 'create-1', {});
    const created = successData(await creator.next(isAck('create-1')));
    const roomId = String(created['roomId']);
    const creatorEpoch = Number(created['connectionEpoch']);
    sendRequest(joiner, 'room.join', 'join-1', {
      roomCode: created['roomCode'],
    });
    let joined = successData(await joiner.next(isAck('join-1')));
    let joinerEpoch = Number(joined['connectionEpoch']);
    await creator.next(isBroadcast('peer.joined'));
    sendRequest(creator, 'peer.ready', 'creator-ready', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('creator-ready'));
    await joiner.next(isBroadcast('peer.ready'));
    sendRequest(joiner, 'peer.ready', 'joiner-ready-1', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready-1'));
    await creator.next(isBroadcast('peer.ready'));
    sendRequest(creator, 'webrtc.offer', 'initial-offer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'initial-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('initial-offer'));
    await joiner.next(isBroadcast('webrtc.offer'));

    joiner.socket.terminate();
    await creator.next(isBroadcast('peer.left'));
    joiner = await openClient(fixture, 'user-2');
    sendRequest(joiner, 'room.resume', 'joiner-resume-1', { roomId });
    joined = successData(await joiner.next(isAck('joiner-resume-1')));
    joinerEpoch = Number(joined['connectionEpoch']);
    expect(joined['resume']).toMatchObject({
      status: 'reset_required',
      reason: 'signaling_reset',
      resetGeneration: 1,
    });
    sendRequest(joiner, 'peer.ready', 'joiner-ready-2', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready-2'));
    const initialResetAtCreator = await creator.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const initialResetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(initialResetAtJoiner.payload).toEqual(initialResetAtCreator.payload);
    expect(initialResetAtCreator.payload).toMatchObject({
      negotiationId: (joined['resume'] as Record<string, unknown>)[
        'negotiationId'
      ],
      resetGeneration: (joined['resume'] as Record<string, unknown>)[
        'resetGeneration'
      ],
    });
    const initialResetId = String(
      (initialResetAtCreator.payload as Record<string, unknown>)[
        'negotiationId'
      ],
    );

    sendRequest(creator, 'peer.ready', 'creator-ready-after-initial-reset', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('creator-ready-after-initial-reset'));

    sendRequest(creator, 'webrtc.offer', 'offer-after-initial-reset', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: initialResetId,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-after-initial-reset'));
    await joiner.next(isBroadcast('webrtc.offer'));
    sendRequest(joiner, 'webrtc.answer', 'answer-after-initial-reset', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: initialResetId,
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isAck('answer-after-initial-reset'));
    await creator.next(isBroadcast('webrtc.answer'));
    sendRequest(creator, 'webrtc.answerApplied', 'initial-answer-applied', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: initialResetId,
    });
    await creator.next(isAck('initial-answer-applied'));

    sendRequest(creator, 'webrtc.iceRestart', 'restart-offer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'restart-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('restart-offer'));
    await joiner.next(isBroadcast('webrtc.iceRestart'));
    joiner.socket.terminate();
    await creator.next(isBroadcast('peer.left'));

    joiner = await openClient(fixture, 'user-2');
    sendRequest(joiner, 'room.resume', 'joiner-resume-2', { roomId });
    joined = successData(await joiner.next(isAck('joiner-resume-2')));
    joinerEpoch = Number(joined['connectionEpoch']);
    sendRequest(joiner, 'peer.ready', 'joiner-ready-3', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready-3'));
    const restartResetAtCreator = await creator.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const restartResetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(restartResetAtJoiner.payload).toEqual(restartResetAtCreator.payload);
    expect(restartResetAtCreator.payload).not.toEqual(
      initialResetAtCreator.payload,
    );

    sendRequest(joiner, 'peer.ready', 'joiner-ready-3', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready-3'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creator.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);
    expect(joiner.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);
  });

  test('unbinds terminal room state and broadcasts a real disconnect', async () => {
    const fixture = await createFixture();
    const creator = await openClient(fixture, 'user-1');
    sendRequest(creator, 'room.create', 'create-1', {});
    const first = successData(await creator.next(isAck('create-1')));
    sendRequest(creator, 'room.leave', 'leave-1', {
      roomId: first['roomId'],
    });
    const leaveAck = await creator.next(isAck('leave-1'));
    sendRequest(creator, 'room.leave', 'leave-1', {
      roomId: first['roomId'],
    });
    expect(await creator.next(isAck('leave-1'))).toEqual(leaveAck);
    sendRequest(creator, 'room.create', 'create-2', {});
    const secondAck = await creator.next(isAck('create-2'));
    expect(secondAck.payload).toMatchObject({
      ok: true,
    });

    const joiner = await openClient(fixture, 'user-2');
    const second = successData(secondAck);
    sendRequest(joiner, 'room.join', 'join-2', {
      roomCode: second['roomCode'],
    });
    await joiner.next(isAck('join-2'));
    await creator.next(isBroadcast('peer.joined'));

    sendRequest(joiner, 'room.end', 'joiner-end', {
      roomId: second['roomId'],
    });
    expect((await joiner.next(isAck('joiner-end'))).payload).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    sendRequest(creator, 'room.end', 'creator-end', {
      roomId: second['roomId'],
    });
    await creator.next(isAck('creator-end'));
    expect(
      (await joiner.next(isBroadcast('room.closed'))).payload,
    ).toMatchObject({ roomId: second['roomId'], reason: 'ended' });

    sendRequest(creator, 'room.create', 'create-3', {});
    const thirdRoom = successData(await creator.next(isAck('create-3')));
    sendRequest(joiner, 'room.join', 'join-3', {
      roomCode: thirdRoom['roomCode'],
    });
    await joiner.next(isAck('join-3'));
    await creator.next(isBroadcast('peer.joined'));
    joiner.socket.terminate();
    expect(
      (await creator.next(isBroadcast('peer.left'))).payload,
    ).toMatchObject({
      userId: 'user-2',
      reason: 'disconnected',
    });
  });

  test('maps a failed peer relay to a retryable signaling ack', async () => {
    const fixture = await createFixture({ maxBufferedBytes: 4_096 });
    const creator = await openClient(fixture, 'user-1');
    const joiner = await openClient(fixture, 'user-2');
    sendRequest(creator, 'room.create', 'create-1', {});
    const created = successData(await creator.next(isAck('create-1')));
    const roomId = String(created['roomId']);
    const creatorEpoch = Number(created['connectionEpoch']);
    sendRequest(joiner, 'room.join', 'join-1', {
      roomCode: created['roomCode'],
    });
    const joined = successData(await joiner.next(isAck('join-1')));
    const joinerEpoch = Number(joined['connectionEpoch']);
    await creator.next(isBroadcast('peer.joined'));
    sendRequest(creator, 'peer.ready', 'creator-ready', {
      roomId,
      connectionEpoch: creatorEpoch,
    });
    await creator.next(isAck('creator-ready'));
    await joiner.next(isBroadcast('peer.ready'));
    sendRequest(joiner, 'peer.ready', 'joiner-ready', {
      roomId,
      connectionEpoch: joinerEpoch,
    });
    await joiner.next(isAck('joiner-ready'));
    await creator.next(isBroadcast('peer.ready'));

    const joinerClosed = new Promise<number>((resolve) =>
      joiner.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(creator, 'webrtc.offer', 'large-offer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'large-negotiation',
      description: { type: 'offer', sdp: `v=0\r\n${'x'.repeat(5_000)}` },
    });
    const failure = await creator.next(
      (message) =>
        'requestId' in message && message.requestId === 'large-offer',
    );
    expect(failure).toMatchObject({
      type: 'webrtc.offer.ack',
      payload: {
        ok: false,
        error: { code: 'SIGNALING_UNAVAILABLE', retryable: true },
      },
    });
    expect(await joinerClosed).toBe(1013);
    sendRequest(creator, 'webrtc.offer', 'large-offer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'large-negotiation',
      description: { type: 'offer', sdp: `v=0\r\n${'x'.repeat(5_000)}` },
    });
    expect(
      await creator.next(
        (message) =>
          'requestId' in message && message.requestId === 'large-offer',
      ),
    ).toMatchObject({
      type: 'webrtc.offer.ack',
      payload: { ok: false, error: { code: 'STALE_NEGOTIATION' } },
    });
  });

  test('does not complete an answer whose relay hits synchronous backpressure', async () => {
    const fixture = await createFixture({ maxBufferedBytes: 4_096 });
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-failed-answer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'failed-answer-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-failed-answer'));
    await joiner.next(isBroadcast('webrtc.offer'));

    const creatorClosed = new Promise<number>((resolve) =>
      creator.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(joiner, 'webrtc.answer', 'backpressured-answer', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'failed-answer-negotiation',
      description: { type: 'answer', sdp: `v=0\r\n${'x'.repeat(5_000)}` },
    });
    expect(await joiner.next(isAck('backpressured-answer'))).toMatchObject({
      payload: {
        ok: false,
        error: { code: 'SIGNALING_UNAVAILABLE', retryable: true },
      },
    });
    expect(await creatorClosed).toBe(1013);
    await joiner.next(isBroadcast('peer.left'));

    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'creator-resume', { roomId });
    const resumed = successData(
      await replacement.next(isAck('creator-resume')),
    );
    const replacementEpoch = Number(resumed['connectionEpoch']);
    sendRequest(replacement, 'peer.ready', 'creator-ready-again', {
      roomId,
      connectionEpoch: replacementEpoch,
    });
    await replacement.next(isAck('creator-ready-again'));
    const resetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const resetAtReplacement = await replacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(resetAtReplacement.payload).toEqual(resetAtJoiner.payload);
    expect(resetAtReplacement.payload).not.toMatchObject({
      negotiationId: 'failed-answer-negotiation',
    });
  });

  test('abandons an answer when the indexed target socket is not open', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-non-open-answer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'non-open-answer-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-non-open-answer'));
    await joiner.next(isBroadcast('webrtc.offer'));

    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    const ownReadyState = Object.getOwnPropertyDescriptor(
      creatorServerSocket!,
      'readyState',
    );
    Object.defineProperty(creatorServerSocket!, 'readyState', {
      configurable: true,
      value: WebSocket.CLOSING,
    });
    try {
      sendRequest(joiner, 'webrtc.answer', 'answer-to-non-open-target', {
        roomId,
        connectionEpoch: joinerEpoch,
        negotiationId: 'non-open-answer-negotiation',
        description: { type: 'answer', sdp: 'v=0\r\n' },
      });
      expect(
        await joiner.next(isAck('answer-to-non-open-target')),
      ).toMatchObject({
        payload: {
          ok: false,
          error: { code: 'SIGNALING_UNAVAILABLE', retryable: true },
        },
      });
    } finally {
      if (ownReadyState === undefined) {
        Reflect.deleteProperty(creatorServerSocket!, 'readyState');
      } else {
        Object.defineProperty(
          creatorServerSocket!,
          'readyState',
          ownReadyState,
        );
      }
    }
    expect(creator.has(isBroadcast('webrtc.answer'))).toBe(false);
    sendRequest(creator, 'webrtc.answerApplied', 'applied-after-non-open', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'non-open-answer-negotiation',
    });
    expect(await creator.next(isAck('applied-after-non-open'))).toMatchObject({
      payload: { ok: false, error: { code: 'STALE_NEGOTIATION' } },
    });

    const creatorClosed = new Promise<number>((resolve) =>
      creator.socket.once('close', (code) => resolve(code)),
    );
    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'resume-after-non-open', {
      roomId,
    });
    const resumed = successData(
      await replacement.next(isAck('resume-after-non-open')),
    );
    expect(await creatorClosed).toBe(4409);
    sendRequest(replacement, 'peer.ready', 'ready-after-non-open', {
      roomId,
      connectionEpoch: Number(resumed['connectionEpoch']),
    });
    await replacement.next(isAck('ready-after-non-open'));
    const resetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const resetAtReplacement = await replacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(resetAtReplacement.payload).toEqual(resetAtJoiner.payload);
  });

  test('abandons an active answer when ws reports an asynchronous send error', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-callback-error', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'callback-error-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-callback-error'));
    await joiner.next(isBroadcast('webrtc.offer'));

    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    const delayed = delayNextServerDeliveryCallback(
      creatorServerSocket!,
      'webrtc.answer',
    );
    const creatorClosed = new Promise<number>((resolve) =>
      creator.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(joiner, 'webrtc.answer', 'callback-error-answer', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'callback-error-negotiation',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    expect(await joiner.next(isAck('callback-error-answer'))).toMatchObject({
      payload: { ok: true },
    });
    await creator.next(isBroadcast('webrtc.answer'));
    delayed.fail();
    expect(await creatorClosed).toBe(1006);
    await joiner.next(isBroadcast('peer.left'));

    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'creator-resume', { roomId });
    const resumed = successData(
      await replacement.next(isAck('creator-resume')),
    );
    const replacementEpoch = Number(resumed['connectionEpoch']);
    sendRequest(
      replacement,
      'webrtc.answerApplied',
      'applied-after-callback-error',
      {
        roomId,
        connectionEpoch: replacementEpoch,
        negotiationId: 'callback-error-negotiation',
      },
    );
    expect(
      await replacement.next(isAck('applied-after-callback-error')),
    ).toMatchObject({
      payload: { ok: false, error: { code: 'STALE_NEGOTIATION' } },
    });
    sendRequest(replacement, 'peer.ready', 'creator-ready-again', {
      roomId,
      connectionEpoch: replacementEpoch,
    });
    await replacement.next(isAck('creator-ready-again'));
    const resetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const resetAtReplacement = await replacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(resetAtReplacement.payload).toEqual(resetAtJoiner.payload);
  });

  test('keeps an applied answer completed when its send callback fails late', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-late-callback', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'late-callback-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-late-callback'));
    await joiner.next(isBroadcast('webrtc.offer'));

    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    const delayed = delayNextServerDeliveryCallback(
      creatorServerSocket!,
      'webrtc.answer',
    );
    const creatorClosed = new Promise<number>((resolve) =>
      creator.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(joiner, 'webrtc.answer', 'answer-before-late-callback', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'late-callback-negotiation',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isAck('answer-before-late-callback'));
    await creator.next(isBroadcast('webrtc.answer'));
    sendRequest(creator, 'webrtc.answerApplied', 'applied-before-callback', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'late-callback-negotiation',
    });
    expect(await creator.next(isAck('applied-before-callback'))).toMatchObject({
      payload: { ok: true },
    });

    delayed.fail();
    expect(await creatorClosed).toBe(1006);
    await joiner.next(isBroadcast('peer.left'));
    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'resume-after-late-callback', {
      roomId,
    });
    const resumed = successData(
      await replacement.next(isAck('resume-after-late-callback')),
    );
    expect(resumed['resume']).toMatchObject({
      status: 'completed',
      negotiationId: 'late-callback-negotiation',
      negotiationGeneration: 1,
    });
    const replacementEpoch = Number(resumed['connectionEpoch']);
    sendRequest(replacement, 'peer.ready', 'ready-after-late-callback', {
      roomId,
      connectionEpoch: replacementEpoch,
    });
    await replacement.next(isAck('ready-after-late-callback'));
    await joiner.next(isBroadcast('peer.ready'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joiner.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);
    expect(replacement.has(isBroadcast('webrtc.negotiationReset'))).toBe(false);
    sendRequest(
      joiner,
      'webrtc.restartRequested',
      'restart-after-late-callback',
      {
        roomId,
        connectionEpoch: joinerEpoch,
        negotiationId: 'late-callback-negotiation',
      },
    );
    await joiner.next(isAck('restart-after-late-callback'));
    await replacement.next(isBroadcast('webrtc.restartRequested'));
  });

  test('preflights an evicted conflicting answer request ID before relay', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-conflict', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'conflict-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-conflict'));
    await joiner.next(isBroadcast('webrtc.offer'));
    for (let index = 0; index < 256; index += 1) {
      if (index > 0 && index % 100 === 0) {
        fixture.advance(1_000);
      }
      const requestId = `evict-ack-${index}`;
      sendRequest(joiner, 'webrtc.iceServers.refresh', requestId, {
        roomId,
        connectionEpoch: joinerEpoch,
        negotiationId: 'conflict-negotiation',
      });
      await joiner.next(isAck(requestId));
    }

    sendRequest(joiner, 'webrtc.answer', 'joiner-ready', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'conflict-negotiation',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    expect(await joiner.next(isAck('joiner-ready'))).toMatchObject({
      type: 'webrtc.answer.ack',
      payload: { ok: false, error: { code: 'INVALID_STATE' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creator.has(isBroadcast('webrtc.answer'))).toBe(false);
  });

  test('resets an answer written to the socket but not applied by the offerer', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-unapplied-answer', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'unapplied-answer-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-unapplied-answer'));
    await joiner.next(isBroadcast('webrtc.offer'));
    sendRequest(joiner, 'webrtc.answer', 'unapplied-answer', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'unapplied-answer-negotiation',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isAck('unapplied-answer'));
    await creator.next(isBroadcast('webrtc.answer'));

    creator.socket.terminate();
    await joiner.next(isBroadcast('peer.left'));
    const replacement = await openClient(fixture, 'user-1');
    sendRequest(replacement, 'room.resume', 'creator-resume-unapplied', {
      roomId,
    });
    const resumed = successData(
      await replacement.next(isAck('creator-resume-unapplied')),
    );
    sendRequest(replacement, 'peer.ready', 'creator-ready-unapplied', {
      roomId,
      connectionEpoch: Number(resumed['connectionEpoch']),
    });
    await replacement.next(isAck('creator-ready-unapplied'));
    const resetAtJoiner = await joiner.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const resetAtReplacement = await replacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(resetAtReplacement.payload).toEqual(resetAtJoiner.payload);
    expect(resetAtReplacement.payload).not.toMatchObject({
      negotiationId: 'unapplied-answer-negotiation',
    });
  });

  test('authorizes and idempotently replays answerApplied after a lost ack', async () => {
    const fixture = await createFixture({
      requestCacheMaxEntries: 1,
      maxAckEntriesPerConnection: 3,
    });
    const { creator, joiner, roomId, creatorEpoch, joinerEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-applied', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'answer-applied-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-applied'));
    await joiner.next(isBroadcast('webrtc.offer'));
    sendRequest(joiner, 'webrtc.answer', 'answer-before-applied', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'answer-applied-negotiation',
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isAck('answer-before-applied'));
    await creator.next(isBroadcast('webrtc.answer'));

    sendRequest(joiner, 'webrtc.answerApplied', 'applied-by-answerer', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'answer-applied-negotiation',
    });
    expect(await joiner.next(isAck('applied-by-answerer'))).toMatchObject({
      payload: { ok: false, error: { code: 'FORBIDDEN' } },
    });
    sendRequest(creator, 'webrtc.answerApplied', 'applied-stale-epoch', {
      roomId,
      connectionEpoch: creatorEpoch + 1,
      negotiationId: 'answer-applied-negotiation',
    });
    expect(await creator.next(isAck('applied-stale-epoch'))).toMatchObject({
      payload: { ok: false, error: { code: 'STALE_CONNECTION' } },
    });
    sendRequest(creator, 'webrtc.answerApplied', 'applied-stale-negotiation', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'wrong-negotiation',
    });
    expect(
      await creator.next(isAck('applied-stale-negotiation')),
    ).toMatchObject({
      payload: { ok: false, error: { code: 'STALE_NEGOTIATION' } },
    });

    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    failNextServerDelivery(
      creatorServerSocket!,
      'webrtc.answerApplied.ack',
      'drop',
    );
    const appliedPayload = {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'answer-applied-negotiation',
    };
    sendRequest(
      creator,
      'webrtc.answerApplied',
      'creator-applied-answer',
      appliedPayload,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    sendRequest(creator, 'webrtc.iceCandidate', 'evict-applied-domain', {
      ...appliedPayload,
      candidate: null,
    });
    await creator.next(isAck('evict-applied-domain'));
    await joiner.next(isBroadcast('webrtc.iceCandidate'));
    await evictGatewayAckCache(
      fixture,
      creator,
      'evict-applied-gateway',
      roomId,
      creatorEpoch,
      'answer-applied-negotiation',
      4,
    );
    sendRequest(
      creator,
      'webrtc.answerApplied',
      'creator-applied-answer',
      appliedPayload,
    );
    expect(await creator.next(isAck('creator-applied-answer'))).toMatchObject({
      payload: { ok: true },
    });
    sendRequest(creator, 'webrtc.iceCandidate', 'evict-applied-domain-again', {
      ...appliedPayload,
      candidate: null,
    });
    await creator.next(isAck('evict-applied-domain-again'));
    await joiner.next(isBroadcast('webrtc.iceCandidate'));
    await evictGatewayAckCache(
      fixture,
      creator,
      'evict-applied-gateway-again',
      roomId,
      creatorEpoch,
      'answer-applied-negotiation',
      4,
    );
    sendRequest(creator, 'webrtc.answerApplied', 'creator-applied-answer', {
      ...appliedPayload,
      negotiationId: 'changed-negotiation',
    });
    expect(await creator.next(isAck('creator-applied-answer'))).toMatchObject({
      payload: { ok: false, error: { code: 'INVALID_STATE' } },
    });
    sendRequest(joiner, 'webrtc.restartRequested', 'restart-after-applied', {
      roomId,
      connectionEpoch: joinerEpoch,
      negotiationId: 'answer-applied-negotiation',
    });
    await joiner.next(isAck('restart-after-applied'));
    await creator.next(isBroadcast('webrtc.restartRequested'));
  });

  test('closes a newly bound resume socket when immediate reset delivery fails', async () => {
    const fixture = await createFixture();
    const { creator, joiner, roomId, creatorEpoch } =
      await openReadyPair(fixture);
    sendRequest(creator, 'webrtc.offer', 'offer-before-reset-delivery', {
      roomId,
      connectionEpoch: creatorEpoch,
      negotiationId: 'incomplete-negotiation',
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await creator.next(isAck('offer-before-reset-delivery'));
    await joiner.next(isBroadcast('webrtc.offer'));
    joiner.socket.terminate();
    await creator.next(isBroadcast('peer.left'));

    const [creatorServerSocket] = serverSockets(fixture);
    expect(creatorServerSocket).toBeDefined();
    failNextServerDelivery(
      creatorServerSocket!,
      'webrtc.negotiationReset',
      'throw',
    );
    const creatorClosed = new Promise<number>((resolve) =>
      creator.socket.once('close', (code) => resolve(code)),
    );
    const firstReplacement = await openClient(fixture, 'user-2');
    const firstReplacementClosed = new Promise<number>((resolve) =>
      firstReplacement.socket.once('close', (code) => resolve(code)),
    );
    sendRequest(firstReplacement, 'room.resume', 'joiner-resume-1', { roomId });
    expect(await firstReplacementClosed).toBe(1011);
    expect(await creatorClosed).toBe(1006);

    const creatorReplacement = await openClient(fixture, 'user-1');
    sendRequest(creatorReplacement, 'room.resume', 'creator-resume-2', {
      roomId,
    });
    const creatorResume = successData(
      await creatorReplacement.next(isAck('creator-resume-2')),
    );
    expect(creatorResume['resume']).toMatchObject({
      status: 'reset_required',
      resetGeneration: 1,
    });

    const secondReplacement = await openClient(fixture, 'user-2');
    sendRequest(secondReplacement, 'room.resume', 'joiner-resume-2', {
      roomId,
    });
    const secondResume = successData(
      await secondReplacement.next(isAck('joiner-resume-2')),
    );
    const retriedAtCreator = await creatorReplacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    const retriedAtReplacement = await secondReplacement.next(
      isBroadcast('webrtc.negotiationReset'),
    );
    expect(retriedAtCreator.payload).toEqual(retriedAtReplacement.payload);
    expect(retriedAtCreator.payload).toMatchObject({
      negotiationId: (creatorResume['resume'] as Record<string, unknown>)[
        'negotiationId'
      ],
      resetGeneration: 1,
    });
    expect(secondResume['resume']).toEqual(creatorResume['resume']);
  });

  test('normalizes malformed frames and enforces binary, size, heartbeat, and backpressure', async () => {
    const fixture = await createFixture();
    const malformed = await openClient(fixture, 'user-1');
    malformed.socket.send('{');
    expect(
      await malformed.next((message) => message.type === 'protocol.error'),
    ).toMatchObject({
      requestId: null,
      payload: { error: { code: 'VALIDATION_ERROR' } },
    });
    malformed.socket.send(
      JSON.stringify({
        version: 99,
        requestId: 'bad-version',
        type: 'room.create',
        payload: {},
      }),
    );
    expect(
      await malformed.next(
        (message) =>
          message.type === 'protocol.error' &&
          message.requestId === 'bad-version',
      ),
    ).toMatchObject({
      payload: { error: { code: 'UNSUPPORTED_PROTOCOL' } },
    });
    malformed.socket.send(
      JSON.stringify({
        version: 1,
        requestId: 'legacy-media-plan',
        type: 'peer.ready',
        payload: {
          roomId: 'room-1',
          connectionEpoch: 1,
        },
      }),
    );
    expect(
      await malformed.next(
        (message) =>
          message.type === 'protocol.error' &&
          message.requestId === 'legacy-media-plan',
      ),
    ).toMatchObject({
      payload: { error: { code: 'UNSUPPORTED_PROTOCOL' } },
    });
    malformed.socket.send(
      JSON.stringify({
        version: 1,
        requestId: 'unknown-type',
        type: 'unknown.message',
        payload: {},
      }),
    );
    expect(
      await malformed.next(
        (message) =>
          message.type === 'protocol.error' &&
          message.requestId === 'unknown-type',
      ),
    ).toMatchObject({
      payload: { error: { code: 'UNSUPPORTED_PROTOCOL' } },
    });
    malformed.socket.send(
      JSON.stringify({
        version: 1,
        requestId: 'invalid-payload',
        type: 'room.create',
        payload: { extra: true },
      }),
    );
    expect(
      await malformed.next(
        (message) =>
          message.type === 'protocol.error' &&
          message.requestId === 'invalid-payload',
      ),
    ).toMatchObject({
      payload: { error: { code: 'VALIDATION_ERROR' } },
    });
    malformed.socket.send(' '.repeat(1_048_576));
    expect(
      await malformed.next(
        (message) =>
          message.type === 'protocol.error' && message.requestId === null,
      ),
    ).toMatchObject({
      payload: { error: { code: 'VALIDATION_ERROR' } },
    });

    const binary = await openClient(fixture, 'user-2');
    const binaryClosed = new Promise<number>((resolve) =>
      binary.socket.once('close', (code) => resolve(code)),
    );
    binary.socket.send(Buffer.from([1, 2, 3]));
    expect(await binaryClosed).toBe(1003);

    const oversized = await openClient(fixture, 'user-3');
    const oversizedClosed = new Promise<number>((resolve) =>
      oversized.socket.once('close', (code) => resolve(code)),
    );
    oversized.socket.send('x'.repeat(1_048_577));
    expect(await oversizedClosed).toBe(1009);

    const heartbeatFixture = await createFixture({ heartbeatIntervalMs: 20 });
    const halfOpen = await openClient(heartbeatFixture, 'user-1', {
      autoPong: false,
    });
    const heartbeatClosed = new Promise<number>((resolve) =>
      halfOpen.socket.once('close', (code) => resolve(code)),
    );
    expect(await heartbeatClosed).toBe(1006);

    const pressureFixture = await createFixture({ maxBufferedBytes: 16 });
    const slow = await openClient(pressureFixture, 'user-1');
    const pressureClosed = new Promise<number>((resolve) =>
      slow.socket.once('close', (code) => resolve(code)),
    );
    slow.socket.send('{');
    expect(await pressureClosed).toBe(1013);
  });

  test('expires WSS authorization and bounds small inbound frame rates', async () => {
    const lateFixture = await createFixture({ accessTokenTtlSeconds: 1 });
    const lateTicket = await issueTicket(lateFixture, 'user-1');
    lateFixture.advance(1_000);
    const lateSocket = new WebSocket(`${lateFixture.wsUrl}/v1/realtime`, [
      'wo-v1',
      `ticket.${lateTicket.ticket}`,
    ]);
    const lateClose = new Promise<readonly [number, string]>((resolve) =>
      lateSocket.once('close', (code, reason) =>
        resolve([code, reason.toString()]),
      ),
    );
    expect(await lateClose).toEqual([4401, 'AUTH_EXPIRED']);

    const expiryFixture = await createFixture({
      accessTokenTtlSeconds: 1,
      heartbeatIntervalMs: 20,
    });
    const expiring = await openClient(expiryFixture, 'user-1');
    const expiredClose = new Promise<readonly [number, string]>((resolve) =>
      expiring.socket.once('close', (code, reason) =>
        resolve([code, reason.toString()]),
      ),
    );
    expiryFixture.advance(1_000);
    expect(await expiredClose).toEqual([4401, 'AUTH_EXPIRED']);

    const countFixture = await createFixture({
      inboundRateWindowMs: 60_000,
      maxInboundMessagesPerWindow: 2,
      maxInboundBytesPerWindow: 1_000,
    });
    const counted = await openClient(countFixture, 'user-1');
    const countClose = new Promise<number>((resolve) =>
      counted.socket.once('close', (code) => resolve(code)),
    );
    counted.socket.send('null');
    await counted.next((message) => message.type === 'protocol.error');
    counted.socket.send('null');
    await counted.next((message) => message.type === 'protocol.error');
    counted.socket.send('null');
    expect(await countClose).toBe(1008);

    const bytesFixture = await createFixture({
      inboundRateWindowMs: 60_000,
      maxInboundMessagesPerWindow: 100,
      maxInboundBytesPerWindow: 100,
    });
    const byteLimited = await openClient(bytesFixture, 'user-1');
    const bytesClose = new Promise<number>((resolve) =>
      byteLimited.socket.once('close', (code) => resolve(code)),
    );
    byteLimited.socket.send(JSON.stringify('x'.repeat(60)));
    await byteLimited.next((message) => message.type === 'protocol.error');
    byteLimited.socket.send(JSON.stringify('x'.repeat(60)));
    expect(await bytesClose).toBe(1008);
  });
});
