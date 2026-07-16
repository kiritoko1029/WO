import {
  PROTOCOL_VERSION,
  peerJoinedBroadcastSchema,
  roomCreateAckSchema,
  type P2pBroadcastEnvelope,
} from '@wo/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSignalingClient,
  SignalingClientError,
  type SignalingWebSocket,
} from '../src/renderer/src/media/signaling-client.js';
import type {
  DesktopApi,
  PublicAuthSession,
  RealtimeConnectionGrant,
} from '../src/preload/types.js';

const ticket = (character: string): string => character.repeat(43);

class FakeSocket implements SignalingWebSocket {
  readonly sent: string[] = [];
  readyState = 0;
  protocol = 'wo-v1';
  throwOnSend = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  fail(): void {
    this.emit('error', {});
    this.close();
  }

  receive(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  receiveText(value: string): void {
    this.emit('message', { data: value });
  }

  emitLateClose(): void {
    this.emit('close', {});
  }

  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createDesktop() {
  const refreshed: PublicAuthSession = {
    user: {
      userId: 'user-1' as PublicAuthSession['user']['userId'],
      email: 'person@example.cn',
      displayName: 'Person',
    },
    accessToken: 'refreshed-access-token',
    accessTokenExpiresAt: Date.now() + 900_000,
  };
  return {
    auth: {
      register: vi.fn<DesktopApi['auth']['register']>(),
      login: vi.fn<DesktopApi['auth']['login']>(),
      refresh: vi
        .fn<DesktopApi['auth']['refresh']>()
        .mockResolvedValue(refreshed),
      logout: vi.fn<DesktopApi['auth']['logout']>(),
    },
    realtime: {
      issueTicket: vi.fn<DesktopApi['realtime']['issueTicket']>(),
    },
  } satisfies DesktopApi;
}

function grant(value: string): RealtimeConnectionGrant {
  return {
    endpoint: 'wss://rtc.example.cn/v1/realtime',
    ticket: ticket(value),
    expiresInSeconds: 30,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('typed signaling client', () => {
  it('acquires a main-process grant and opens a query-free WSS with only offered subprotocols', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('A'));
    const sockets: FakeSocket[] = [];
    const factory = vi.fn((url: string, protocols: readonly string[]) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      expect(url).toBe('wss://rtc.example.cn/v1/realtime');
      expect(new URL(url).search).toBe('');
      expect(protocols).toEqual(['wo-v1', `ticket.${ticket('A')}`]);
      return socket;
    });
    const client = createSignalingClient({
      desktop,
      createWebSocket: factory,
      makeRequestId: () => 'request-1',
    });

    const connected = client.connect('access-token');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await connected;

    expect(desktop.realtime.issueTicket).toHaveBeenCalledWith('access-token');
    expect(factory).toHaveBeenCalledOnce();
    expect(JSON.stringify(factory.mock.calls)).not.toContain('access-token');
  });

  it('matches typed acknowledgements by request ID and dispatches validated broadcasts', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('B'));
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const client = createSignalingClient({
      desktop,
      createWebSocket: factory,
      makeRequestId: () => 'create-request',
      requestTimeoutMs: 1_000,
    });
    const connected = client.connect('access-token');
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    socket.open();
    await connected;
    const broadcasts: P2pBroadcastEnvelope[] = [];
    client.subscribe((event) => broadcasts.push(event));

    const request = client.request('room.create', {}, roomCreateAckSchema);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      version: PROTOCOL_VERSION,
      requestId: 'create-request',
      type: 'room.create',
      payload: {},
    });
    socket.receive({
      version: PROTOCOL_VERSION,
      requestId: 'different-request',
      type: 'room.create.ack',
      payload: { ok: false, error: { code: 'INVALID_REQUEST' } },
    });
    socket.receive({
      version: PROTOCOL_VERSION,
      eventId: 'event-1',
      type: 'peer.joined',
      payload: {
        roomId: 'room-1',
        peer: { userId: 'user-2', displayName: 'Peer', ready: false },
      },
    });
    expect(broadcasts).toEqual([
      peerJoinedBroadcastSchema.parse({
        version: PROTOCOL_VERSION,
        eventId: 'event-1',
        type: 'peer.joined',
        payload: {
          roomId: 'room-1',
          peer: { userId: 'user-2', displayName: 'Peer', ready: false },
        },
      }),
    ]);
    socket.receive({
      version: PROTOCOL_VERSION,
      requestId: 'create-request',
      type: 'room.create.ack',
      payload: {
        ok: true,
        data: {
          roomId: 'room-1',
          roomCode: '482731',
          role: 'creator',
          state: 'waiting',
          peer: null,
          connectionEpoch: 1,
          rtcConfiguration: {
            iceServers: [
              {
                urls: ['turn:turn.example.cn:3478?transport=udp'],
                username: 'user',
                credential: 'credential',
              },
            ],
            iceTransportPolicy: 'relay',
          },
          iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
        },
      },
    });

    await expect(request).resolves.toMatchObject({
      requestId: 'create-request',
      payload: { ok: true },
    });
  });

  it('reports malformed/version-mismatched frames and rejects pending requests on close or timeout', async () => {
    vi.useFakeTimers();
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('C'));
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const errors: SignalingClientError[] = [];
    const client = createSignalingClient({
      desktop,
      createWebSocket: factory,
      makeRequestId: () => `request-${socket.sent.length + 1}`,
      requestTimeoutMs: 50,
    });
    client.subscribeErrors((error) => errors.push(error));
    const connected = client.connect('access-token');
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    socket.open();
    await connected;

    socket.receive({ version: 2, eventId: 'bad', type: 'peer.joined' });
    expect(errors.at(-1)?.code).toBe('PROTOCOL_ERROR');

    const timedOut = client.request('room.create', {}, roomCreateAckSchema);
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      code: 'SIGNALING_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(51);
    await timeoutAssertion;

    const closed = client.request('room.create', {}, roomCreateAckSchema);
    const closeAssertion = expect(closed).rejects.toMatchObject({
      code: 'SIGNALING_CLOSED',
    });
    socket.close();
    await closeAssertion;
  });

  it('uses a fresh ticket for every bounded handshake attempt and refreshes access only through IPC', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket
      .mockRejectedValueOnce(
        Object.assign(new Error('expired'), { code: 'AUTH_REQUIRED' }),
      )
      .mockResolvedValueOnce(grant('D'))
      .mockResolvedValueOnce(grant('E'));
    const sockets: FakeSocket[] = [];
    const client = createSignalingClient({
      desktop,
      createWebSocket: (_url, protocols) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        expect(protocols[1]).toBe(
          `ticket.${ticket(sockets.length === 1 ? 'D' : 'E')}`,
        );
        return socket;
      },
      makeRequestId: () => 'request-1',
      maxConnectAttempts: 2,
    });

    const connected = client.connect('expired-access-token');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    await connected;

    expect(desktop.auth.refresh).toHaveBeenCalledOnce();
    expect(desktop.realtime.issueTicket.mock.calls).toEqual([
      ['expired-access-token'],
      ['refreshed-access-token'],
      ['refreshed-access-token'],
    ]);
    for (const socket of sockets) {
      expect(socket.sent.join('')).not.toContain('access-token');
    }
  });

  it('times out silent handshakes and validates the negotiated wo-v1 protocol on every bounded attempt', async () => {
    vi.useFakeTimers();
    const desktop = createDesktop();
    desktop.realtime.issueTicket
      .mockResolvedValueOnce(grant('F'))
      .mockResolvedValueOnce(grant('G'));
    const sockets: FakeSocket[] = [];
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      makeRequestId: () => 'request-1',
      maxConnectAttempts: 2,
      handshakeTimeoutMs: 40,
    });

    const connected = client.connect('access-token');
    const connectionAssertion = expect(connected).rejects.toMatchObject({
      code: 'SIGNALING_UNAVAILABLE',
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(41);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.protocol = 'unexpected';
    sockets[1]!.open();

    await connectionAssertion;
    expect(desktop.realtime.issueTicket).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale socket close after a replacement connection is established', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket
      .mockResolvedValueOnce(grant('H'))
      .mockResolvedValueOnce(grant('I'));
    const sockets: FakeSocket[] = [];
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      makeRequestId: () => 'replacement-request',
    });
    const first = client.connect('access-token');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await first;
    sockets[0]!.close();
    const second = client.connect('access-token');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    await second;

    sockets[0]!.emitLateClose();
    const request = client.request('room.create', {}, roomCreateAckSchema);
    sockets[1]!.receive({
      version: PROTOCOL_VERSION,
      requestId: 'replacement-request',
      type: 'room.create.ack',
      payload: {
        ok: false,
        error: { code: 'INVALID_STATE', message: 'Invalid state' },
      },
    });
    await expect(request).resolves.toMatchObject({
      requestId: 'replacement-request',
    });
  });

  it('rejects synchronous send failures without leaking pending work', async () => {
    vi.useFakeTimers();
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('J'));
    const socket = new FakeSocket();
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'send-failure',
      requestTimeoutMs: 20,
    });
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    await connected;
    socket.throwOnSend = true;

    await expect(
      client.request('room.create', {}, roomCreateAckSchema),
    ).rejects.toMatchObject({ code: 'SIGNALING_CLOSED' });
    await vi.advanceTimersByTimeAsync(100);
  });

  it('sends a prebuilt envelope unchanged and supports a bounded per-request timeout', async () => {
    vi.useFakeTimers();
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('K'));
    const socket = new FakeSocket();
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'unused',
      requestTimeoutMs: 5_000,
    });
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    await connected;
    const envelope = {
      version: PROTOCOL_VERSION,
      requestId: 'fixed-request',
      type: 'room.create' as const,
      payload: {},
    };

    const request = client.requestEnvelope(envelope, roomCreateAckSchema, {
      timeoutMs: 30,
    });
    expect(socket.sent).toEqual([JSON.stringify(envelope)]);
    const assertion = expect(request).rejects.toMatchObject({
      code: 'SIGNALING_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(31);
    await assertion;
  });

  it('bounds inbound text and isolates application listener exceptions', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('L'));
    const socket = new FakeSocket();
    const errors: SignalingClientError[] = [];
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'request-1',
      maxFrameBytes: 256,
    });
    client.subscribeErrors((error) => errors.push(error));
    client.subscribe(() => {
      throw new Error('consumer failure');
    });
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    await connected;

    socket.receive({
      version: PROTOCOL_VERSION,
      eventId: 'event-2',
      type: 'peer.joined',
      payload: {
        roomId: 'room-1',
        peer: { userId: 'user-2', displayName: 'Peer', ready: false },
      },
    });
    expect(errors).toHaveLength(0);
    socket.receiveText('x'.repeat(257));
    expect(errors.at(-1)?.code).toBe('PROTOCOL_ERROR');
  });

  it('isolates signaling error observers so one consumer cannot hide protocol failures', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('N'));
    const socket = new FakeSocket();
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'request-1',
    });
    const errors: SignalingClientError[] = [];
    client.subscribeErrors(() => {
      throw new Error('broken error observer');
    });
    client.subscribeErrors((error) => errors.push(error));
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    await connected;

    expect(() => socket.receiveText('{')).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROTOCOL_ERROR');
  });

  it('isolates connection observers during both open and close transitions', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('O'));
    const socket = new FakeSocket();
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'request-1',
      maxConnectAttempts: 1,
    });
    const events: unknown[] = [];
    client.subscribeConnection(() => {
      throw new Error('broken connection observer');
    });
    client.subscribeConnection((event) => events.push(event));
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();

    await expect(connected).resolves.toBeUndefined();
    expect(() => socket.serverClose(1012, 'service restart')).not.toThrow();
    expect(events).toEqual([
      { state: 'open' },
      { state: 'closed', code: 1012, reason: 'service restart' },
    ]);
  });

  it('publishes bounded open/close lifecycle details for room recovery without carrying media teardown', async () => {
    const desktop = createDesktop();
    desktop.realtime.issueTicket.mockResolvedValue(grant('M'));
    const socket = new FakeSocket();
    const client = createSignalingClient({
      desktop,
      createWebSocket: () => socket,
      makeRequestId: () => 'request-1',
    });
    const events: unknown[] = [];
    client.subscribeConnection((event) => events.push(event));
    const connected = client.connect('access-token');
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    await connected;
    socket.serverClose(1012, 'service restart');

    expect(events).toEqual([
      { state: 'open' },
      { state: 'closed', code: 1012, reason: 'service restart' },
    ]);
  });
});
