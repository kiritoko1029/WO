import {
  PROTOCOL_VERSION,
  type P2pBroadcastEnvelope,
  type P2pRequestEnvelope,
} from '@wo/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimeRoomGateway,
  createCallController,
  isRealtimeRoomGateway,
} from '../src/renderer/src/state/call-store.js';
import type { PeerConnectionLike } from '../src/renderer/src/media/peer-connection-controller.js';
import type { SignalingClient } from '../src/renderer/src/media/signaling-client.js';
import type { SignalingConnectionEvent } from '../src/renderer/src/media/signaling-client.js';
import type { RoomGatewayEvent } from '../src/renderer/src/state/room-store.js';
import type { DesktopApi, PublicAuthSession } from '../src/preload/types.js';

const user: PublicAuthSession['user'] = {
  userId: 'user-1' as PublicAuthSession['user']['userId'],
  email: 'person@example.cn',
  displayName: '陈晨',
};

const peerUser: PublicAuthSession['user'] = {
  userId: 'user-2' as PublicAuthSession['user']['userId'],
  email: 'peer@example.cn',
  displayName: '林远',
};

const rtcConfiguration = {
  iceServers: [
    {
      urls: ['turn:turn.example.cn:3478?transport=udp'],
      username: 'user',
      credential: 'credential',
    },
  ],
  iceTransportPolicy: 'relay' as const,
};

const fixedNegotiationNow = Date.parse('2026-07-16T16:00:00.000Z');

const idleScreenSession = {
  owner: null,
  leaseId: null,
  leaseExpiresAt: null,
} as const;

function signaling(screenSession: unknown = idleScreenSession) {
  const listeners = new Set<(event: P2pBroadcastEnvelope) => void>();
  const connectionListeners = new Set<
    (
      event:
        { state: 'open' } | { state: 'closed'; code: number; reason: string },
    ) => void
  >();
  const request = vi.fn(async (type: string, payload?: unknown) => {
    if (type === 'room.create') {
      return {
        version: PROTOCOL_VERSION,
        requestId: 'request-1',
        type: 'room.create.ack',
        payload: {
          ok: true,
          data: {
            roomId: 'room-1',
            roomCode: '482731',
            role: 'creator',
            state: 'waiting',
            peer: null,
            connectionEpoch: 3,
            rtcConfiguration,
            iceCredentialsExpiresAt: '2026-07-16T16:10:00.000Z',
            screen: screenSession,
          },
        },
      };
    }
    if (type === 'room.join') {
      return {
        version: PROTOCOL_VERSION,
        requestId: 'request-2',
        type: 'room.join.ack',
        payload: {
          ok: true,
          data: {
            roomId: 'room-2',
            role: 'joiner',
            state: 'negotiating',
            peer: { userId: 'user-2', displayName: '林远', ready: true },
            connectionEpoch: 4,
            rtcConfiguration,
            iceCredentialsExpiresAt: '2026-07-16T16:10:00.000Z',
            screen: screenSession,
          },
        },
      };
    }
    if (type === 'screen.acquire' || type === 'screen.renew') {
      return {
        version: PROTOCOL_VERSION,
        requestId: 'screen-request',
        type: `${type}.ack`,
        payload: {
          ok: true,
          data: {
            lease: {
              roomId: 'room-1',
              leaseId: 'lease-1',
              holderId: 'user-1',
              expiresAt: new Date(Date.now() + 15_000).toISOString(),
            },
          },
        },
      };
    }
    if (type === 'room.resume') {
      const roomId = (payload as { roomId?: string } | undefined)?.roomId;
      const creator = roomId === 'room-1';
      return {
        version: PROTOCOL_VERSION,
        requestId: 'resume-request',
        type: 'room.resume.ack',
        payload: {
          ok: true,
          data: {
            roomId,
            role: creator ? 'creator' : 'joiner',
            state: creator ? 'waiting' : 'connected',
            peer: creator
              ? null
              : { userId: 'user-2', displayName: '林远', ready: true },
            connectionEpoch: creator ? 5 : 6,
            rtcConfiguration,
            iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
            screen: idleScreenSession,
            resume: { status: 'none' },
          },
        },
      };
    }
    if (type === 'webrtc.iceServers.refresh') {
      return {
        version: PROTOCOL_VERSION,
        requestId: 'ice-refresh-request',
        type: 'webrtc.iceServers.refresh.ack',
        payload: {
          ok: true,
          data: {
            rtcConfiguration,
            iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
          },
        },
      };
    }
    return {
      version: PROTOCOL_VERSION,
      requestId: 'request-other',
      type: `${type}.ack`,
      payload: { ok: true, data: {} },
    };
  });
  const value = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    request,
    requestEnvelope: vi.fn(),
    subscribe(listener: (event: P2pBroadcastEnvelope) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeErrors: vi.fn(() => () => undefined),
    subscribeConnection(listener: (event: SignalingConnectionEvent) => void) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    get connected() {
      return true;
    },
    emit(event: P2pBroadcastEnvelope) {
      for (const listener of listeners) listener(event);
    },
    emitConnection(
      event:
        { state: 'open' } | { state: 'closed'; code: number; reason: string },
    ) {
      for (const listener of connectionListeners) listener(event);
    },
  };
  return value as unknown as SignalingClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    emit(event: P2pBroadcastEnvelope): void;
    emitConnection(
      event:
        { state: 'open' } | { state: 'closed'; code: number; reason: string },
    ): void;
  };
}

function pairedSignaling() {
  type Side = 'creator' | 'joiner';
  type RequestRecord = {
    readonly side: Side;
    readonly type: P2pRequestEnvelope['type'];
    readonly payload: unknown;
  };
  const roomId = 'room-pair';
  const listeners: Record<Side, Set<(event: P2pBroadcastEnvelope) => void>> = {
    creator: new Set(),
    joiner: new Set(),
  };
  const records: RequestRecord[] = [];
  let sequence = 0;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  const remoteSide = (side: Side): Side =>
    side === 'creator' ? 'joiner' : 'creator';
  const sideUser = (side: Side) => (side === 'creator' ? user : peerUser);
  const emit = (
    side: Side,
    type: P2pBroadcastEnvelope['type'],
    payload: unknown,
  ): void => {
    const event = {
      version: PROTOCOL_VERSION,
      eventId: `pair-event-${++sequence}`,
      type,
      payload,
    } as P2pBroadcastEnvelope;
    for (const listener of listeners[side]) listener(event);
  };
  const relay = (
    source: Side,
    type: P2pBroadcastEnvelope['type'],
    payload: unknown,
  ): void => {
    setTimeout(() => emit(remoteSide(source), type, payload), 0);
  };
  const respond = async (
    side: Side,
    type: P2pRequestEnvelope['type'],
    payload: unknown,
    requestId = `pair-request-${++sequence}`,
  ): Promise<unknown> => {
    records.push({ side, type, payload });
    let data: unknown = {};
    if (type === 'room.create') {
      data = {
        roomId,
        roomCode: '482731',
        role: 'creator',
        state: 'waiting',
        peer: null,
        connectionEpoch: 10,
        rtcConfiguration,
        iceCredentialsExpiresAt: expiresAt,
        screen: idleScreenSession,
      };
    } else if (type === 'room.join') {
      data = {
        roomId,
        role: 'joiner',
        state: 'negotiating',
        peer: {
          userId: user.userId,
          displayName: user.displayName,
          ready: false,
        },
        connectionEpoch: 20,
        rtcConfiguration,
        iceCredentialsExpiresAt: expiresAt,
        screen: idleScreenSession,
      };
    } else if (type === 'peer.ready') {
      relay(side, 'peer.ready', {
        roomId,
        peer: {
          userId: sideUser(side).userId,
          displayName: sideUser(side).displayName,
          ready: true,
        },
      });
    } else if (
      type === 'webrtc.offer' ||
      type === 'webrtc.answer' ||
      type === 'webrtc.iceCandidate'
    ) {
      relay(side, type, payload);
    }
    return {
      version: PROTOCOL_VERSION,
      requestId,
      type: `${type}.ack`,
      payload: { ok: true, data },
    };
  };

  const createEndpoint = (side: Side): SignalingClient => {
    let connected = false;
    return {
      connect: vi.fn(async () => {
        connected = true;
      }),
      disconnect: vi.fn(() => {
        connected = false;
      }),
      request: vi.fn((type, payload, _schema, options) =>
        respond(side, type, payload, options?.requestId),
      ),
      requestEnvelope: vi.fn((envelope) =>
        respond(side, envelope.type, envelope.payload, envelope.requestId),
      ),
      subscribe: (listener) => {
        listeners[side].add(listener);
        return () => listeners[side].delete(listener);
      },
      subscribeErrors: () => () => undefined,
      subscribeConnection: () => () => undefined,
      get connected() {
        return connected;
      },
    } as SignalingClient;
  };

  return {
    creator: createEndpoint('creator'),
    joiner: createEndpoint('joiner'),
    records,
  };
}

const desktop = {
  auth: {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
  realtime: { issueTicket: vi.fn() },
  capture: {
    list: vi.fn().mockResolvedValue([
      {
        token: '00000000-0000-4000-8000-000000000001',
        name: 'Editor',
        kind: 'window',
        thumbnailDataUrl: 'data:image/png;base64,AAAA',
      },
    ]),
    select: vi.fn().mockResolvedValue(undefined),
    permission: vi.fn().mockResolvedValue({
      status: 'granted',
      canOpenSettings: false,
    }),
    openSettings: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as DesktopApi;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function audioTrack() {
  return {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function videoTrack() {
  const listeners = new Set<() => void>();
  return {
    kind: 'video',
    stop: vi.fn(),
    getSettings: vi.fn(() => ({ width: 1_920, height: 1_080, frameRate: 60 })),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    emitEnded() {
      for (const listener of listeners) listener();
    },
  } as unknown as MediaStreamTrack & { emitEnded(): void };
}

function mediaStream(track: MediaStreamTrack) {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

function peerConnectionFactory(
  options: { readonly screenReceiverTrack?: MediaStreamTrack | null } = {},
) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const negotiatedScreenTrack =
    options.screenReceiverTrack === undefined
      ? videoTrack()
      : options.screenReceiverTrack;
  const transceivers = [
    {
      mid: '0',
      direction: 'sendrecv',
      sender: {
        track: null as MediaStreamTrack | null,
        replaceTrack: vi.fn().mockResolvedValue(undefined),
        getParameters: vi.fn(() => ({
          transactionId: 'audio-transaction',
          encodings: [{ rid: 'a' }],
          codecs: [],
          headerExtensions: [],
          rtcp: {},
        })),
        setParameters: vi.fn().mockResolvedValue(undefined),
      },
      receiver: { track: { kind: 'audio' } },
      setCodecPreferences: vi.fn(),
    },
    {
      mid: '1',
      direction: 'sendrecv',
      sender: {
        track: null as MediaStreamTrack | null,
        replaceTrack: vi.fn().mockResolvedValue(undefined),
        getParameters: vi.fn(() => ({
          transactionId: 'screen-transaction',
          encodings: [{ rid: 'f', scaleResolutionDownBy: 1 }],
          codecs: [],
          headerExtensions: [],
          rtcp: {},
        })),
        setParameters: vi.fn().mockResolvedValue(undefined),
      },
      receiver: { track: negotiatedScreenTrack },
      setCodecPreferences: vi.fn(),
    },
  ];
  for (const transceiver of transceivers) {
    transceiver.sender.replaceTrack.mockImplementation(
      async (track: MediaStreamTrack | null) => {
        transceiver.sender.track = track;
      },
    );
  }
  const pc = {
    connectionState: 'new' as RTCPeerConnectionState,
    iceConnectionState: 'new' as RTCIceConnectionState,
    signalingState: 'stable' as RTCSignalingState,
    addTransceiver: vi
      .fn()
      .mockReturnValueOnce(transceivers[0])
      .mockReturnValueOnce(transceivers[1]),
    getTransceivers: vi.fn(() => transceivers),
    addEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        const values = listeners.get(type) ?? new Set();
        values.add(listener);
        listeners.set(type, values);
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) =>
        listeners.get(type)?.delete(listener),
    ),
    setConfiguration: vi.fn(),
    createOffer: vi.fn().mockResolvedValue({
      type: 'offer',
      sdp: 'v=0\r\na=ice-ufrag:creator\r\na=sendrecv',
    }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    createAnswer: vi.fn().mockResolvedValue({
      type: 'answer',
      sdp: 'v=0\r\na=ice-ufrag:joiner\r\na=sendrecv',
    }),
    addIceCandidate: vi.fn(),
    restartIce: vi.fn(),
    getStats: vi.fn().mockResolvedValue(new Map()),
    close: vi.fn(),
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  const factory = vi.fn(() => pc as unknown as PeerConnectionLike);
  return { factory, pc, transceivers };
}

describe('realtime room gateway', () => {
  it('connects once, creates a room and retains the sanitized media session', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });

    const room = await gateway.createRoom('access-token');

    expect(isRealtimeRoomGateway(gateway)).toBe(true);
    expect(client.connect).toHaveBeenCalledWith('access-token');
    expect(client.request).toHaveBeenCalledWith(
      'room.create',
      {},
      expect.anything(),
    );
    expect(room).toMatchObject({
      roomId: 'room-1',
      roomCode: '482731',
      role: 'creator',
      connectionStatus: 'waiting',
    });
    expect(room).not.toHaveProperty('mediaSession');
    expect(JSON.stringify(room)).not.toContain('credential');
    expect(gateway.getCallSession(room.roomId)).toMatchObject({
      connectionEpoch: 3,
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T16:10:00.000Z',
      role: 'creator',
    });
  });

  it('resumes with the retained access token and atomically refreshes the private session', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    client.request.mockImplementationOnce(async (type: string) => ({
      version: PROTOCOL_VERSION,
      requestId: 'resume-request',
      type: `${type}.ack`,
      payload: {
        ok: true,
        data: {
          roomId: room.roomId,
          role: 'creator',
          state: 'connected',
          peer: { userId: 'user-2', displayName: '林远', ready: true },
          connectionEpoch: 7,
          rtcConfiguration,
          iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
          screen: idleScreenSession,
          resume: {
            status: 'completed',
            negotiationId: 'negotiation-completed',
            negotiationGeneration: 4,
          },
        },
      },
    }));

    const result = await gateway.resumeRoom(room.roomId);

    expect(client.connect).toHaveBeenLastCalledWith('access-token');
    expect(client.request).toHaveBeenLastCalledWith(
      'room.resume',
      { roomId: room.roomId },
      expect.anything(),
    );
    expect(result).toMatchObject({
      status: 'resumed',
      transport: 'healthy',
      negotiationId: 'negotiation-completed',
      negotiationGeneration: 4,
    });
    expect(gateway.getCallSession(room.roomId)).toMatchObject({
      connectionEpoch: 7,
      peerReady: true,
      iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
    });
  });

  it('returns the authoritative reset generation after an incomplete resume', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    client.request.mockImplementationOnce(async (type: string) => ({
      version: PROTOCOL_VERSION,
      requestId: 'resume-reset-request',
      type: `${type}.ack`,
      payload: {
        ok: true,
        data: {
          roomId: room.roomId,
          role: 'joiner',
          state: 'reconnecting',
          peer: { userId: 'user-2', displayName: '林远', ready: false },
          connectionEpoch: 11,
          rtcConfiguration,
          iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
          screen: idleScreenSession,
          resume: {
            status: 'reset_required',
            negotiationId: 'negotiation-reset',
            resetGeneration: 6,
            reason: 'peer_resumed',
          },
        },
      },
    }));

    await expect(gateway.resumeRoom(room.roomId)).resolves.toMatchObject({
      status: 'reset_required',
      negotiationId: 'negotiation-reset',
      resetGeneration: 6,
      reason: 'peer_resumed',
    });
    expect(gateway.getCallSession(room.roomId)?.connectionEpoch).toBe(11);
  });

  it('turns a missing resumed room into one explicit local close event', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const events: RoomGatewayEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    client.request.mockImplementationOnce(async (type: string) => ({
      version: PROTOCOL_VERSION,
      requestId: 'resume-closed-request',
      type: `${type}.ack`,
      payload: {
        ok: false,
        error: { code: 'ROOM_CLOSED', message: 'Room is closed' },
      },
    }));

    await expect(gateway.resumeRoom(room.roomId)).resolves.toEqual({
      status: 'room_closed',
    });
    expect(events.filter((event) => event.type === 'closed')).toEqual([
      {
        type: 'closed',
        roomId: room.roomId,
        reason: 'server_restart',
      },
    ]);
    expect(gateway.getCallSession(room.roomId)).toBeNull();
  });

  it('joins with a six-digit code and updates snapshots from validated peer broadcasts', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const snapshots: unknown[] = [];
    gateway.subscribe((event: RoomGatewayEvent) => {
      if (event.type === 'snapshot') snapshots.push(event.room);
    });
    await gateway.joinRoom('access-token', '123456');

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'event-1' as never,
      type: 'peer.left',
      payload: {
        roomId: 'room-2' as never,
        userId: 'user-2' as never,
        reason: 'disconnected',
      },
    });

    expect(client.request).toHaveBeenCalledWith(
      'room.join',
      { roomCode: '123456' },
      expect.anything(),
    );
    expect(snapshots.at(-1)).toMatchObject({
      roomId: 'room-2',
      connectionStatus: 'reconnecting',
      participants: [
        expect.objectContaining({ isSelf: true, online: true }),
        expect.objectContaining({ userId: 'user-2', online: false }),
      ],
    });
  });

  it('initializes remote screen ownership from the authoritative join snapshot', async () => {
    const client = signaling({
      owner: { userId: 'user-2', displayName: '林远', ready: true },
      leaseId: 'lease-before-join',
      leaseExpiresAt: '2026-07-16T16:01:00.000Z',
    });
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'owner-after-join-ack' as never,
      type: 'screen.ownerChanged',
      payload: {
        roomId: 'room-2' as never,
        owner: { userId: 'user-2' as never, displayName: '林远', ready: true },
        leaseId: 'lease-after-join-ack' as never,
        leaseExpiresAt: '2026-07-16T16:02:00.000Z',
      },
    });
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });

    expect(call.getSnapshot()).toMatchObject({
      screenOwner: { userId: 'user-2', displayName: '林远' },
      screenOwnerLeaseId: 'lease-after-join-ack',
    });
    await expect(call.prepareScreenShare()).rejects.toMatchObject({
      code: 'SCREEN_SHARE_BUSY',
    });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.acquire'),
    ).toHaveLength(0);
  });

  it('marks the local peer ready and leaves through typed signaling before disconnecting', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');

    await gateway.markReady(room.roomId);
    await gateway.leaveRoom(room.roomId);

    expect(client.request.mock.calls.map(([type]) => type)).toEqual([
      'room.join',
      'peer.ready',
      'room.leave',
    ]);
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a failed leave retryable and disconnects when the server closes the room', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    client.request.mockRejectedValueOnce(new Error('leave failed'));

    await expect(gateway.leaveRoom(room.roomId)).rejects.toThrow(
      'leave failed',
    );
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(gateway.getCallSession(room.roomId)).not.toBeNull();

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'event-closed' as never,
      type: 'room.closed',
      payload: { roomId: 'room-2' as never, reason: 'ended' },
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(gateway.getCallSession(room.roomId)).toBeNull();
  });

  it('constructs lazily and waits for both readiness signals using an injected negotiation clock', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const captured = deferred<MediaStream>();
    const mediaDevices = {
      getUserMedia: vi.fn(() => captured.promise),
      enumerateDevices: vi.fn().mockRejectedValue(new Error('enumeration')),
    } as unknown as MediaDevices;
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peer.factory,
      now: () => fixedNegotiationNow,
    });
    expect(peer.factory).not.toHaveBeenCalled();

    const starting = call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'peer-ready' as never,
      type: 'peer.ready',
      payload: {
        roomId: 'room-1' as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
    ).toHaveLength(0);
    captured.resolve(mediaStream(audioTrack()));
    await starting;
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
      ).toHaveLength(1),
    );

    expect(peer.factory).toHaveBeenCalledOnce();
    expect(
      client.request.mock.calls.filter(([type]) => type === 'peer.ready'),
    ).toHaveLength(1);
  });

  it('allows microphone permission retry without recreating the peer connection', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const microphone = audioTrack();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
        )
        .mockResolvedValueOnce(mediaStream(microphone)),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peer.factory,
    });

    await expect(call.start()).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });
    expect(call.getSnapshot().status).toBe('error');
    await expect(call.start()).resolves.toBeUndefined();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(peer.factory).toHaveBeenCalledOnce();
    expect(call.getSnapshot().status).toBe('waiting');
  });

  it('keeps a failed call failed when a stale peer-left event arrives', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
          ),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await expect(call.start()).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'late-peer-left-after-failure' as never,
      type: 'peer.left',
      payload: {
        roomId: room.roomId as never,
        userId: 'user-2' as never,
        reason: 'disconnected',
      },
    });

    expect(call.getSnapshot().status).toBe('error');
    await call.cleanup();
  });

  it('retries a failed microphone switch through start while preserving the old track', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const originalMicrophone = audioTrack();
    const replacementMicrophone = audioTrack();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValueOnce(mediaStream(originalMicrophone))
        .mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
        )
        .mockResolvedValueOnce(mediaStream(replacementMicrophone)),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();

    await expect(call.switchMicrophone('mic-2')).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });
    expect(originalMicrophone.stop).not.toHaveBeenCalled();
    expect(call.getSnapshot()).toMatchObject({
      status: 'error',
      microphoneRetryAvailable: true,
    });

    await expect(call.start()).resolves.toBeUndefined();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(call.getSnapshot()).toMatchObject({
      status: 'waiting',
      selectedInputId: 'mic-2',
      microphoneRetryAvailable: false,
      error: null,
    });
    expect(originalMicrophone.stop).toHaveBeenCalledOnce();
    expect(replacementMicrophone.stop).not.toHaveBeenCalled();
    expect(peer.factory).toHaveBeenCalledOnce();
    await call.cleanup();
  });

  it('keeps the newest microphone switch result when an older request fails late', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const initial = audioTrack();
    const older = audioTrack();
    const newer = audioTrack();
    const olderCapture = deferred<MediaStream>();
    const newerCapture = deferred<MediaStream>();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValueOnce(mediaStream(initial))
        .mockReturnValueOnce(olderCapture.promise)
        .mockReturnValueOnce(newerCapture.promise),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();

    const olderSwitch = call.switchMicrophone('mic-old');
    const newerSwitch = call.switchMicrophone('mic-new');
    newerCapture.resolve(mediaStream(newer));
    await expect(newerSwitch).resolves.toBeUndefined();
    olderCapture.resolve(mediaStream(older));
    await expect(olderSwitch).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });

    expect(call.getSnapshot()).toMatchObject({
      status: 'waiting',
      selectedInputId: 'mic-new',
      microphoneRetryAvailable: false,
      error: null,
    });
    expect(older.stop).toHaveBeenCalledOnce();
    expect(newer.stop).not.toHaveBeenCalled();
    await call.cleanup();
  });

  it('does not let a stale retry overwrite a newer direct microphone switch', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const initial = audioTrack();
    const retryTrack = audioTrack();
    const directTrack = audioTrack();
    const retryCapture = deferred<MediaStream>();
    const directCapture = deferred<MediaStream>();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValueOnce(mediaStream(initial))
        .mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
        )
        .mockReturnValueOnce(retryCapture.promise)
        .mockReturnValueOnce(directCapture.promise),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();
    await expect(call.switchMicrophone('mic-retry')).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });

    const retry = call.start();
    const direct = call.switchMicrophone('mic-direct');
    directCapture.resolve(mediaStream(directTrack));
    await expect(direct).resolves.toBeUndefined();
    retryCapture.resolve(mediaStream(retryTrack));
    await expect(retry).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });

    expect(call.getSnapshot()).toMatchObject({
      status: 'waiting',
      selectedInputId: 'mic-direct',
      microphoneRetryAvailable: false,
      error: null,
    });
    expect(retryTrack.stop).toHaveBeenCalledOnce();
    await call.cleanup();
  });

  it('offers retry when replacing the sender microphone track fails', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const initial = audioTrack();
    const failedReplacement = audioTrack();
    const replacement = audioTrack();
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValueOnce(mediaStream(initial))
        .mockResolvedValueOnce(mediaStream(failedReplacement))
        .mockResolvedValueOnce(mediaStream(replacement)),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const peer = peerConnectionFactory();
    peer.transceivers[0]!.sender.replaceTrack.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('replace failed'))
      .mockResolvedValueOnce(undefined);
    const call = createCallController({
      room,
      gateway,
      mediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();

    await expect(call.switchMicrophone('mic-2')).rejects.toThrow(
      'replace failed',
    );
    expect(call.getSnapshot()).toMatchObject({
      status: 'error',
      microphoneRetryAvailable: true,
    });
    expect(initial.stop).not.toHaveBeenCalled();
    expect(failedReplacement.stop).toHaveBeenCalledOnce();

    await expect(call.start()).resolves.toBeUndefined();
    expect(call.getSnapshot()).toMatchObject({
      status: 'waiting',
      selectedInputId: 'mic-2',
      microphoneRetryAvailable: false,
      error: null,
    });
    expect(initial.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).not.toHaveBeenCalled();
    await call.cleanup();
  });

  it('returns an initial negotiation to waiting when the peer leaves before the call connects', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-before-initial-leave' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(call.getSnapshot().status).toBe('connecting'),
    );

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'left-before-initial-connect' as never,
      type: 'peer.left',
      payload: {
        roomId: room.roomId as never,
        userId: 'user-2' as never,
        reason: 'disconnected',
      },
    });

    expect(call.getSnapshot().status).toBe('waiting');
    await call.cleanup();
  });

  it('projects a terminal snapshot after cleanup completes', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();

    await call.cleanup();

    expect(call.getSnapshot().status).toBe('error');
    expect(call.getSnapshot().status).not.toBe('reconnecting');
  });

  it('replays early peer readiness using an injected negotiation clock', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'early-ready' as never,
      type: 'peer.ready',
      payload: {
        roomId: 'room-1' as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
      now: () => fixedNegotiationNow,
    });

    await call.start();
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
      ).toHaveLength(1),
    );
  });

  it('disposes its WSS subscription and private call session idempotently', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const listener = vi.fn();
    gateway.subscribe(listener);

    gateway.dispose();
    gateway.dispose();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'after-dispose' as never,
      type: 'room.closed',
      payload: { roomId: 'room-1' as never, reason: 'ended' },
    });

    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(gateway.getCallSession(room.roomId)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('routes a joiner offer and revalidates the attached microphone after answering', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const microphone = audioTrack();
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'offer-event' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: 'room-2' as never,
        negotiationId: 'negotiation-1' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\nm=audio\r\nm=video' },
      },
    });
    await vi.waitFor(() => expect(peer.pc.createAnswer).toHaveBeenCalledOnce());

    expect(peer.pc.addTransceiver).not.toHaveBeenCalled();
    expect(peer.transceivers[0]!.sender.replaceTrack).toHaveBeenCalledTimes(2);
    expect(peer.transceivers[0]!.sender.replaceTrack).toHaveBeenLastCalledWith(
      microphone,
    );
    await vi.waitFor(() =>
      expect(call.getSnapshot().remoteScreenTrack).toBe(
        peer.transceivers[1]!.receiver.track,
      ),
    );
  });

  it('resynchronizes the negotiated screen receiver when remote ownership starts', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const initialTrack = videoTrack();
    const peer = peerConnectionFactory({ screenReceiverTrack: initialTrack });
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'offer-before-screen-track' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: 'room-2' as never,
        negotiationId: 'negotiation-before-screen-track' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\nm=audio\r\nm=video' },
      },
    });
    await vi.waitFor(() => expect(peer.pc.createAnswer).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(call.getSnapshot().remoteScreenTrack).toBe(initialTrack),
    );
    initialTrack.emitEnded();
    expect(call.getSnapshot().remoteScreenTrack).toBeNull();

    const remoteTrack = videoTrack();
    peer.transceivers[1]!.receiver.track = remoteTrack;
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'remote-screen-owner-after-negotiation' as never,
      type: 'screen.ownerChanged',
      payload: {
        roomId: 'room-2' as never,
        owner: {
          userId: peerUser.userId,
          displayName: peerUser.displayName,
          ready: true,
        },
        leaseId: 'remote-screen-lease' as never,
        leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
      },
    });

    expect(call.getSnapshot()).toMatchObject({
      screenOwner: {
        userId: peerUser.userId,
        displayName: peerUser.displayName,
      },
      remoteScreenTrack: remoteTrack,
    });
  });

  it('keeps an established connection connected when peer.ready is repeated', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'established-offer' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'established-negotiation' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\nm=audio\r\nm=video' },
      },
    });
    await vi.waitFor(() => expect(peer.pc.createAnswer).toHaveBeenCalledOnce());
    peer.pc.connectionState = 'connected';
    peer.pc.iceConnectionState = 'connected';
    peer.pc.emit('connectionstatechange', {});
    await vi.waitFor(() => expect(call.getSnapshot().status).toBe('connected'));

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'duplicate-ready-after-established' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });

    expect(call.getSnapshot().status).toBe('connected');
    await call.cleanup();
  });

  it('completes a paired offer, answer and answer-applied flow with both microphones attached', async () => {
    const bus = pairedSignaling();
    const creatorGateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: bus.creator,
    });
    const joinerGateway = createRealtimeRoomGateway({
      desktop,
      user: peerUser,
      signaling: bus.joiner,
    });
    const creatorRoom = await creatorGateway.createRoom('creator-token');
    const joinerRoom = await joinerGateway.joinRoom('joiner-token', '482731');
    const creatorMicrophone = audioTrack();
    const joinerMicrophone = audioTrack();
    const creatorPeer = peerConnectionFactory();
    const joinerPeer = peerConnectionFactory();
    const creatorCall = createCallController({
      room: creatorRoom,
      gateway: creatorGateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(creatorMicrophone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: creatorPeer.factory,
    });
    const joinerCall = createCallController({
      room: joinerRoom,
      gateway: joinerGateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(joinerMicrophone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: joinerPeer.factory,
    });

    await Promise.all([creatorCall.start(), joinerCall.start()]);
    await vi.waitFor(() =>
      expect(
        bus.records.filter(({ type }) => type === 'webrtc.answerApplied'),
      ).toHaveLength(1),
    );

    expect(
      bus.records
        .filter(({ type }) => type.startsWith('webrtc.'))
        .map(({ side, type }) => `${side}:${type}`),
    ).toEqual([
      'creator:webrtc.offer',
      'joiner:webrtc.answer',
      'creator:webrtc.answerApplied',
    ]);
    expect(creatorPeer.pc.createOffer).toHaveBeenCalledOnce();
    expect(joinerPeer.pc.createAnswer).toHaveBeenCalledOnce();
    expect(creatorPeer.pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer' }),
    );
    expect(
      creatorPeer.transceivers[0]!.sender.replaceTrack,
    ).toHaveBeenCalledWith(creatorMicrophone);
    expect(
      joinerPeer.transceivers[0]!.sender.replaceTrack,
    ).toHaveBeenCalledWith(joinerMicrophone);
    expect(creatorCall.getSnapshot().status).toBe('connecting');
    expect(joinerCall.getSnapshot().status).toBe('connecting');

    creatorPeer.pc.connectionState = 'connected';
    creatorPeer.pc.iceConnectionState = 'connected';
    joinerPeer.pc.connectionState = 'connected';
    joinerPeer.pc.iceConnectionState = 'connected';
    creatorPeer.pc.emit('connectionstatechange', {});
    joinerPeer.pc.emit('connectionstatechange', {});
    await vi.waitFor(() =>
      expect(creatorCall.getSnapshot().status).toBe('connected'),
    );
    await vi.waitFor(() =>
      expect(joinerCall.getSnapshot().status).toBe('connected'),
    );

    const creatorCleanup = creatorCall.cleanup();
    const joinerCleanup = joinerCall.cleanup();
    expect(creatorCall.cleanup()).toBe(creatorCleanup);
    expect(joinerCall.cleanup()).toBe(joinerCleanup);
    await Promise.all([creatorCleanup, joinerCleanup]);
    expect(creatorMicrophone.stop).toHaveBeenCalledOnce();
    expect(joinerMicrophone.stop).toHaveBeenCalledOnce();
    expect(creatorPeer.pc.close).toHaveBeenCalledOnce();
    expect(joinerPeer.pc.close).toHaveBeenCalledOnce();
  });

  it('negotiates the screen receiver when the joiner microphone is unavailable', async () => {
    const bus = pairedSignaling();
    const creatorGateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: bus.creator,
    });
    const joinerGateway = createRealtimeRoomGateway({
      desktop,
      user: peerUser,
      signaling: bus.joiner,
    });
    const creatorRoom = await creatorGateway.createRoom('creator-token');
    const joinerRoom = await joinerGateway.joinRoom(
      'joiner-token',
      creatorRoom.roomCode,
    );
    const creatorPeer = peerConnectionFactory();
    const joinerPeer = peerConnectionFactory();
    const creatorCall = createCallController({
      room: creatorRoom,
      gateway: creatorGateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: creatorPeer.factory,
    });
    const joinerCall = createCallController({
      room: joinerRoom,
      gateway: joinerGateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
        ),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: joinerPeer.factory,
    });

    const results = await Promise.allSettled([
      creatorCall.start(),
      joinerCall.start(),
    ]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'MICROPHONE_PERMISSION_DENIED' },
    });
    await vi.waitFor(() =>
      expect(
        bus.records.filter(({ type }) => type === 'webrtc.answerApplied'),
      ).toHaveLength(1),
    );
    expect(creatorCall.getSnapshot().remoteScreenTrack).toBe(
      creatorPeer.transceivers[1]!.receiver.track,
    );
    expect(
      joinerPeer.transceivers[0]!.sender.replaceTrack,
    ).not.toHaveBeenCalled();

    await Promise.all([creatorCall.cleanup(), joinerCall.cleanup()]);
  });

  it('resumes signaling with a fresh epoch while keeping healthy voice and transport alive', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const microphone = audioTrack();
    const screenTrack = videoTrack();
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getDisplayMedia: vi.fn().mockResolvedValue({
          getTracks: () => [screenTrack],
          getVideoTracks: () => [screenTrack],
          getAudioTracks: () => [],
        }),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    await call.prepareScreenShare();
    await call.selectScreenSource('00000000-0000-4000-8000-000000000001');
    await call.startScreenShare();

    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    expect(call.getSnapshot().status).toBe('reconnecting');
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'room.resume'),
      ).toHaveLength(1),
    );
    await vi.waitFor(() => expect(call.getSnapshot().status).toBe('waiting'));

    expect(client.connect).toHaveBeenLastCalledWith('access-token');
    expect(peer.pc.setConfiguration).toHaveBeenCalledWith(rtcConfiguration);
    expect(screenTrack.stop).toHaveBeenCalledOnce();
    expect(peer.transceivers[1]!.sender.replaceTrack).toHaveBeenLastCalledWith(
      null,
    );
    expect(microphone.stop).not.toHaveBeenCalled();
    expect(peer.pc.close).not.toHaveBeenCalled();

    const first = call.cleanup();
    const second = call.cleanup();
    expect(second).toBe(first);
    await first;
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(peer.pc.close).toHaveBeenCalledOnce();
  });

  it('cancels late resume session updates when cleanup wins', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const roomEvents: RoomGatewayEvent[] = [];
    gateway.subscribe((event) => roomEvents.push(event));
    const resumeAck = deferred<unknown>();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    client.request.mockImplementation((type: string, payload?: unknown) =>
      type === 'room.resume' ? resumeAck.promise : baseRequest(type, payload),
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();
    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'room.resume'),
      ).toHaveLength(1),
    );

    await call.cleanup();
    resumeAck.resolve({
      version: PROTOCOL_VERSION,
      requestId: 'late-resume-after-cleanup',
      type: 'room.resume.ack',
      payload: {
        ok: true,
        data: {
          roomId: room.roomId,
          role: 'creator',
          state: 'waiting',
          peer: null,
          connectionEpoch: 99,
          rtcConfiguration,
          iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
          screen: idleScreenSession,
          resume: { status: 'none' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.getCallSession(room.roomId)?.connectionEpoch).toBe(3);
    expect(roomEvents).toEqual([]);
  });

  it('does not create a second offer after an authoritative completed resume', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-before-completed-resume' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
      ).toHaveLength(1),
    );
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    client.request.mockImplementation(
      async (type: string, payload?: unknown) => {
        if (type !== 'room.resume') return baseRequest(type, payload);
        return {
          version: PROTOCOL_VERSION,
          requestId: 'completed-resume',
          type: 'room.resume.ack',
          payload: {
            ok: true,
            data: {
              roomId: room.roomId,
              role: 'creator',
              state: 'connected',
              peer: { userId: 'user-2', displayName: 'Peer', ready: true },
              connectionEpoch: 9,
              rtcConfiguration,
              iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
              screen: idleScreenSession,
              resume: {
                status: 'completed',
                negotiationId: 'completed-negotiation',
                negotiationGeneration: 2,
              },
            },
          },
        };
      },
    );

    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'room.resume'),
      ).toHaveLength(1),
    );
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-after-completed-resume' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
    ).toHaveLength(1);
    expect(peer.factory).toHaveBeenCalledOnce();
    await call.cleanup();
  });

  it('starts the missing initial offer after a none resume crosses a fresh ready barrier', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'room.resume'),
      ).toHaveLength(1),
    );
    expect(
      client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
    ).toHaveLength(0);

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-after-none-resume' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
      ).toHaveLength(1),
    );
    await call.cleanup();
  });

  it('rebuilds one transport for an incomplete resume and offers only the server reset ID', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const microphone = audioTrack();
    const firstPeer = peerConnectionFactory();
    const secondPeer = peerConnectionFactory();
    const factory = vi
      .fn()
      .mockReturnValueOnce(firstPeer.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(secondPeer.pc as unknown as PeerConnectionLike);
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
    });
    await call.start();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    client.request.mockImplementation(
      async (type: string, payload?: unknown) => {
        if (type !== 'room.resume') return baseRequest(type, payload);
        client.emit({
          version: PROTOCOL_VERSION,
          eventId: 'server-reset-negotiation' as never,
          type: 'webrtc.negotiationReset',
          payload: {
            roomId: room.roomId as never,
            negotiationId: 'server-reset-negotiation' as never,
            resetGeneration: 8,
            reason: 'peer_resumed',
          },
        });
        return {
          version: PROTOCOL_VERSION,
          requestId: 'resume-reset-request',
          type: 'room.resume.ack',
          payload: {
            ok: true,
            data: {
              roomId: room.roomId,
              role: 'creator',
              state: 'reconnecting',
              peer: { userId: 'user-2', displayName: '林远', ready: false },
              connectionEpoch: 9,
              rtcConfiguration,
              iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
              screen: idleScreenSession,
              resume: {
                status: 'reset_required',
                negotiationId: 'server-reset-negotiation',
                resetGeneration: 8,
                reason: 'peer_resumed',
              },
            },
          },
        };
      },
    );

    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(firstPeer.pc.close).toHaveBeenCalledOnce();
    expect(secondPeer.pc.createOffer).not.toHaveBeenCalled();
    expect(microphone.stop).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'peer.ready'),
      ).toHaveLength(2),
    );

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'peer-ready-after-reset' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: '林远', ready: true },
      },
    });

    await vi.waitFor(() =>
      expect(secondPeer.pc.createOffer).toHaveBeenCalledOnce(),
    );
    expect(
      client.request.mock.calls.find(
        ([type, payload]) =>
          type === 'webrtc.offer' &&
          (payload as { negotiationId?: string }).negotiationId ===
            'server-reset-negotiation',
      ),
    ).toBeDefined();
    await call.cleanup();
  });

  it('continues with a newer reset when an older rebuild ready request fails', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const microphone = audioTrack();
    const peers = [
      peerConnectionFactory(),
      peerConnectionFactory(),
      peerConnectionFactory(),
    ];
    const factory = vi
      .fn()
      .mockReturnValueOnce(peers[0]!.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(peers[1]!.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(peers[2]!.pc as unknown as PeerConnectionLike);
    const oldReady = deferred<unknown>();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    let readyCount = 0;
    client.request.mockImplementation(
      async (type: string, payload?: unknown) => {
        if (type === 'peer.ready') {
          readyCount += 1;
          if (readyCount === 2) return oldReady.promise;
        }
        if (type === 'room.resume') {
          return {
            version: PROTOCOL_VERSION,
            requestId: 'newer-reset-resume',
            type: 'room.resume.ack',
            payload: {
              ok: true,
              data: {
                roomId: room.roomId,
                role: 'creator',
                state: 'reconnecting',
                peer: { userId: 'user-2', displayName: 'Peer', ready: false },
                connectionEpoch: 10,
                rtcConfiguration,
                iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
                screen: idleScreenSession,
                resume: {
                  status: 'reset_required',
                  negotiationId: 'newer-reset',
                  resetGeneration: 2,
                  reason: 'peer_resumed',
                },
              },
            },
          };
        }
        return baseRequest(type, payload);
      },
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'older-reset' as never,
      type: 'webrtc.negotiationReset',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'older-reset' as never,
        resetGeneration: 1,
        reason: 'signaling_reset',
      },
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readyCount).toBe(2));

    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'room.resume'),
    ).toHaveLength(0);
    oldReady.reject(new Error('old ready failed'));
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'room.resume'),
      ).toHaveLength(1),
    );

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
    expect(peers[1]!.pc.close).toHaveBeenCalledOnce();
    expect(microphone.stop).not.toHaveBeenCalled();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-for-newer-reset' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([type, payload]) =>
            type === 'webrtc.offer' &&
            (payload as { negotiationId?: string }).negotiationId ===
              'newer-reset',
        ),
      ).toHaveLength(1),
    );
    await call.cleanup();
  });

  it('catches up to a newer reset that arrives during an authoritative rebuild', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peers = [
      peerConnectionFactory(),
      peerConnectionFactory(),
      peerConnectionFactory(),
    ];
    const factory = vi
      .fn()
      .mockReturnValueOnce(peers[0]!.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(peers[1]!.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(peers[2]!.pc as unknown as PeerConnectionLike);
    const firstResetReady = deferred<unknown>();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    let readyCount = 0;
    client.request.mockImplementation((type: string, payload?: unknown) => {
      if (type === 'peer.ready' && ++readyCount === 2) {
        return firstResetReady.promise;
      }
      return baseRequest(type, payload);
    });
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
    });
    await call.start();
    const emitReset = (generation: number, negotiationId: string) =>
      client.emit({
        version: PROTOCOL_VERSION,
        eventId: negotiationId as never,
        type: 'webrtc.negotiationReset',
        payload: {
          roomId: room.roomId as never,
          negotiationId: negotiationId as never,
          resetGeneration: generation,
          reason: 'signaling_reset',
        },
      });
    emitReset(1, 'reset-generation-1');
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readyCount).toBe(2));

    emitReset(2, 'reset-generation-2');
    firstResetReady.resolve({
      version: PROTOCOL_VERSION,
      requestId: 'first-reset-ready',
      type: 'peer.ready.ack',
      payload: { ok: true, data: {} },
    });

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
    expect(peers[1]!.pc.close).toHaveBeenCalledOnce();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'peer-ready-for-reset-generation-2' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: 'Peer', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([type, payload]) =>
            type === 'webrtc.offer' &&
            (payload as { negotiationId?: string }).negotiationId ===
              'reset-generation-2',
        ),
      ).toHaveLength(1),
    );
    await call.cleanup();
  });

  it('does not create or retain transport after cleanup wins a reset rebuild', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peers = [peerConnectionFactory(), peerConnectionFactory()];
    const factory = vi
      .fn()
      .mockReturnValueOnce(peers[0]!.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(peers[1]!.pc as unknown as PeerConnectionLike);
    const rebuildReady = deferred<unknown>();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    let readyCount = 0;
    client.request.mockImplementation(
      async (type: string, payload?: unknown) => {
        if (type === 'peer.ready' && ++readyCount === 2) {
          return rebuildReady.promise;
        }
        return baseRequest(type, payload);
      },
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'reset-before-cleanup' as never,
      type: 'webrtc.negotiationReset',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'reset-before-cleanup' as never,
        resetGeneration: 1,
        reason: 'signaling_reset',
      },
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readyCount).toBe(2));

    await call.cleanup();
    rebuildReady.resolve({
      version: PROTOCOL_VERSION,
      requestId: 'late-ready',
      type: 'peer.ready.ack',
      payload: { ok: true, data: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(peers[1]!.pc.close).toHaveBeenCalledOnce();
    expect(
      client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
    ).toHaveLength(0);
  });

  it('treats 4409 SESSION_REPLACED as terminal without auto-resume', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const events: RoomGatewayEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    const microphone = audioTrack();
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();

    client.emitConnection({
      state: 'closed',
      code: 4409,
      reason: 'SESSION_REPLACED',
    });

    await vi.waitFor(() => expect(microphone.stop).toHaveBeenCalledOnce());
    expect(peer.pc.close).toHaveBeenCalledOnce();
    expect(
      client.request.mock.calls.filter(([type]) => type === 'room.resume'),
    ).toHaveLength(0);
    expect(events.filter((event) => event.type === 'closed')).toContainEqual({
      type: 'closed',
      roomId: room.roomId,
      reason: 'session_replaced',
    });
  });

  it('turns one creator restart request into fresh ICE and one restart offer', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'ready-before-restart' as never,
      type: 'peer.ready',
      payload: {
        roomId: room.roomId as never,
        peer: { userId: 'user-2' as never, displayName: '林远', ready: true },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([type]) => type === 'webrtc.offer'),
      ).toHaveLength(1),
    );
    const originalOffer = client.request.mock.calls.find(
      ([type]) => type === 'webrtc.offer',
    )![1] as { negotiationId: string };

    (
      client.requestEnvelope as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      version: PROTOCOL_VERSION,
      requestId: 'answer-applied-before-restart',
      type: 'webrtc.answerApplied.ack',
      payload: { ok: true, data: {} },
    });
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'restart-requested-event' as never,
      type: 'webrtc.restartRequested',
      payload: {
        roomId: room.roomId as never,
        negotiationId: originalOffer.negotiationId as never,
        connectionEpoch: 20,
      },
    });
    expect(
      client.request.mock.calls.filter(
        ([type]) => type === 'webrtc.iceRestart',
      ),
    ).toHaveLength(0);
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'answer-before-queued-restart' as never,
      type: 'webrtc.answer',
      payload: {
        roomId: room.roomId as never,
        negotiationId: originalOffer.negotiationId as never,
        connectionEpoch: 20,
        description: { type: 'answer', sdp: 'v=0\r\n' },
      },
    });

    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([type]) => type === 'webrtc.iceRestart',
        ),
      ).toHaveLength(1),
    );
    const requestTypes = client.request.mock.calls.map(([type]) => type);
    expect(requestTypes.indexOf('webrtc.iceServers.refresh')).toBeLessThan(
      requestTypes.indexOf('webrtc.iceRestart'),
    );
    expect(peer.pc.setConfiguration).toHaveBeenCalledWith(rtcConfiguration);
    expect(peer.pc.restartIce).toHaveBeenCalledOnce();
    await call.cleanup();
  });

  it('requests one creator restart when joiner ICE fails', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'offer-before-ice-failure' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'negotiation-before-failure' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\nm=audio\r\nm=video' },
      },
    });
    await vi.waitFor(() => expect(peer.pc.createAnswer).toHaveBeenCalledOnce());

    peer.pc.iceConnectionState = 'failed';
    peer.pc.connectionState = 'failed';
    peer.pc.emit('iceconnectionstatechange', {});

    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([type]) => type === 'webrtc.restartRequested',
        ),
      ).toHaveLength(1),
    );
    expect(peer.pc.restartIce).not.toHaveBeenCalled();
    await call.cleanup();
  });

  it('does not apply a stale ICE restart to transport rebuilt by a reset', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const firstPeer = peerConnectionFactory();
    const secondPeer = peerConnectionFactory();
    const factory = vi
      .fn()
      .mockReturnValueOnce(firstPeer.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(secondPeer.pc as unknown as PeerConnectionLike);
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'offer-before-stale-restart' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'initial-before-stale-restart' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\n' },
      },
    });
    await vi.waitFor(() =>
      expect(firstPeer.pc.createAnswer).toHaveBeenCalledOnce(),
    );

    const refresh = deferred<unknown>();
    const baseRequest = client.request.getMockImplementation() as (
      type: string,
      payload?: unknown,
    ) => Promise<unknown>;
    client.request.mockImplementation((type: string, payload?: unknown) =>
      type === 'webrtc.iceServers.refresh'
        ? refresh.promise
        : baseRequest(type, payload),
    );
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'stale-ice-restart' as never,
      type: 'webrtc.iceRestart',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'stale-restart-negotiation' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\n' },
      },
    });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([type]) => type === 'webrtc.iceServers.refresh',
        ),
      ).toHaveLength(1),
    );
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'reset-wins-stale-restart' as never,
      type: 'webrtc.negotiationReset',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'reset-wins-negotiation' as never,
        resetGeneration: 1,
        reason: 'signaling_reset',
      },
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    refresh.resolve({
      version: PROTOCOL_VERSION,
      requestId: 'late-refresh',
      type: 'webrtc.iceServers.refresh.ack',
      payload: {
        ok: true,
        data: {
          rtcConfiguration,
          iceCredentialsExpiresAt: '2026-07-16T16:20:00.000Z',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondPeer.pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(
      client.request.mock.calls.filter(
        ([type, payload]) =>
          type === 'webrtc.answer' &&
          (payload as { negotiationId?: string }).negotiationId ===
            'stale-restart-negotiation',
      ),
    ).toHaveLength(0);
    await call.cleanup();
  });

  it('publishes bounded privacy-safe quality samples from the live transport', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    peer.pc.getStats.mockResolvedValue(
      new Map([
        [
          'pair-secret',
          {
            id: 'pair-secret',
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: 'local-secret',
          },
        ],
        [
          'local-secret',
          {
            id: 'local-secret',
            type: 'local-candidate',
            candidateType: 'relay',
            protocol: 'udp',
            address: '192.168.1.24',
          },
        ],
        [
          'screen-send',
          {
            id: 'screen-send',
            type: 'outbound-rtp',
            kind: 'video',
            frameWidth: 1_920,
            frameHeight: 1_080,
            framesPerSecond: 50,
            bytesSent: 10_000,
          },
        ],
        [
          'screen-receive',
          {
            id: 'screen-receive',
            type: 'inbound-rtp',
            kind: 'video',
            frameWidth: 1_280,
            frameHeight: 720,
            framesPerSecond: 24,
            bytesReceived: 8_000,
          },
        ],
      ]) as RTCStatsReport,
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
      statsIntervalMs: 250,
    });
    await call.start();

    await vi.waitFor(
      () =>
        expect(call.getSnapshot().quality?.path).toEqual({
          candidateType: 'relay',
          protocol: 'udp',
        }),
      { timeout: 1_500 },
    );
    expect(call.getSnapshot().quality).toMatchObject({
      outbound: { fps: 50, width: 1_920 },
      inbound: { fps: 24, width: 1_280 },
    });
    const exported = JSON.stringify(call.exportDiagnostics());
    expect(exported).not.toMatch(/192\.168|pair-secret|local-secret/);
    await call.cleanup();
  });

  it('drops an old peer stats poll as soon as an authoritative rebuild starts', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const oldPeer = peerConnectionFactory();
    const nextPeer = peerConnectionFactory();
    const oldStats = deferred<RTCStatsReport>();
    oldPeer.pc.getStats.mockReturnValue(oldStats.promise);
    const factory = vi
      .fn()
      .mockReturnValueOnce(oldPeer.pc as unknown as PeerConnectionLike)
      .mockReturnValueOnce(nextPeer.pc as unknown as PeerConnectionLike);
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: factory,
      statsIntervalMs: 250,
    });
    await call.start();
    await vi.waitFor(() =>
      expect(oldPeer.pc.getStats.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'reset-during-old-stats' as never,
      type: 'webrtc.negotiationReset',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'reset-during-old-stats' as never,
        resetGeneration: 1,
        reason: 'signaling_reset',
      },
    });
    oldStats.resolve(new Map() as RTCStatsReport);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(call.exportDiagnostics().samples).toEqual([]);
    expect(call.getSnapshot().quality).toBeNull();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await call.cleanup();
  });

  it('starts and stops one screen sender without renegotiating or stopping voice', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const microphone = audioTrack();
    const screenTrack = videoTrack();
    const peer = peerConnectionFactory();
    const getDisplayMedia = vi.fn(() =>
      Promise.resolve({
        getTracks: () => [screenTrack],
        getVideoTracks: () => [screenTrack],
        getAudioTracks: () => [],
      } as unknown as MediaStream),
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(microphone)),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getDisplayMedia,
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    const offerCount = peer.pc.createOffer.mock.calls.length;
    const transceiverCount = peer.pc.addTransceiver.mock.calls.length;

    await call.prepareScreenShare();
    expect(call.getSnapshot()).toMatchObject({
      screenState: 'picking',
      screenSources: [expect.objectContaining({ name: 'Editor' })],
    });
    await call.selectScreenSource('00000000-0000-4000-8000-000000000001');
    await call.startScreenShare();

    expect(peer.transceivers[1]!.sender.replaceTrack).toHaveBeenCalledWith(
      screenTrack,
    );
    expect(peer.pc.createOffer).toHaveBeenCalledTimes(offerCount);
    expect(peer.pc.addTransceiver).toHaveBeenCalledTimes(transceiverCount);
    expect(call.getSnapshot()).toMatchObject({
      screenState: 'sharing',
      screenCaptureSettings: { width: 1_920, height: 1_080, frameRate: 60 },
      localScreenTrack: screenTrack,
    });
    await call.setScreenBitrate({ mode: 'fixed', bitrateBps: 4_000_000 });
    expect(peer.transceivers[1]!.sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'screen-transaction',
        encodings: [
          expect.objectContaining({ rid: 'f', maxBitrate: 4_000_000 }),
        ],
      }),
    );
    expect(call.getSnapshot()).toMatchObject({
      screenBitrateTarget: { mode: 'fixed', bitrateBps: 4_000_000 },
    });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.bitrate'),
    ).toHaveLength(1);
    expect(peer.pc.createOffer).toHaveBeenCalledTimes(offerCount);
    expect(peer.pc.addTransceiver).toHaveBeenCalledTimes(transceiverCount);

    await call.stopScreenShare();

    expect(peer.transceivers[1]!.sender.replaceTrack.mock.calls.at(-1)).toEqual(
      [null],
    );
    expect(call.getSnapshot()).toMatchObject({
      screenState: 'idle',
      localScreenTrack: null,
    });
    expect(microphone.stop).not.toHaveBeenCalled();
    expect(peer.pc.close).not.toHaveBeenCalled();
  });

  it('rejects stale screen callbacks after cleanup without acquiring a lease', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    await call.cleanup();

    await expect(call.prepareScreenShare()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(
      call.setScreenBitrate({ mode: 'fixed', bitrateBps: 4_000_000 }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.acquire'),
    ).toHaveLength(0);
  });

  it('checks capture permission before acquire and exposes only the approved settings action', async () => {
    const client = signaling();
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const deniedDesktop = {
      ...desktop,
      capture: {
        ...desktop.capture,
        permission: vi.fn().mockResolvedValue({
          status: 'denied',
          canOpenSettings: true,
        }),
        openSettings,
      },
    } as DesktopApi;
    const gateway = createRealtimeRoomGateway({
      desktop: deniedDesktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    await call.start();

    await expect(call.prepareScreenShare()).rejects.toMatchObject({
      code: 'SCREEN_PERMISSION_DENIED',
    });
    expect(call.getSnapshot()).toMatchObject({
      screenPermission: { status: 'denied', canOpenSettings: true },
      screenError: '需要在系统设置中允许屏幕录制',
    });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.acquire'),
    ).toHaveLength(0);

    await call.openScreenSettings();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('does not send an in-flight bitrate update after cleanup wins', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const parametersApplied = deferred<void>();
    peer.transceivers[1]!.sender.setParameters.mockImplementationOnce(
      () => parametersApplied.promise,
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    await call.prepareScreenShare();

    const changing = call.setScreenBitrate({
      mode: 'fixed',
      bitrateBps: 6_000_000,
    });
    await vi.waitFor(() =>
      expect(peer.transceivers[1]!.sender.setParameters).toHaveBeenCalledOnce(),
    );
    const cleaning = call.cleanup();
    parametersApplied.resolve();

    await expect(changing).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await cleaning;
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.bitrate'),
    ).toHaveLength(0);
  });

  it('loses an active local share when the same user is assigned a new lease id', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    await call.prepareScreenShare();

    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'replacement-screen-owner' as never,
      type: 'screen.ownerChanged',
      payload: {
        roomId: 'room-1' as never,
        owner: {
          userId: user.userId,
          displayName: user.displayName,
          ready: true,
        },
        leaseId: 'lease-2' as never,
        leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
      },
    });

    await vi.waitFor(() =>
      expect(call.getSnapshot()).toMatchObject({
        screenState: 'error',
        screenOwnerLeaseId: 'lease-2',
      }),
    );
    expect(peer.transceivers[1]!.sender.replaceTrack.mock.calls.at(-1)).toEqual(
      [null],
    );
  });

  it('reuses the negotiated screen receiver and keeps remote ownership until an event changes it', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const peer = peerConnectionFactory();
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    const remoteTrack = peer.transceivers[1]!.receiver
      .track as MediaStreamTrack;
    peer.pc.emit('track', { track: remoteTrack });
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'screen-owner' as never,
      type: 'screen.ownerChanged',
      payload: {
        roomId: 'room-1' as never,
        owner: {
          userId: 'user-2' as never,
          displayName: 'Peer',
          ready: true,
        },
        leaseId: 'lease-remote' as never,
        leaseExpiresAt: '2000-01-01T00:00:00.000Z',
      },
    });

    expect(call.getSnapshot()).toMatchObject({
      remoteScreenTrack: remoteTrack,
      screenOwner: { userId: 'user-2', displayName: 'Peer' },
    });
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'stale-screen-bitrate' as never,
      type: 'screen.bitrate',
      payload: {
        roomId: 'room-1' as never,
        leaseId: 'old-lease' as never,
        bitrate: 8_000_000,
      },
    });
    expect(call.getSnapshot().remoteScreenBitrateBps).toBeNull();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'current-screen-bitrate' as never,
      type: 'screen.bitrate',
      payload: {
        roomId: 'room-1' as never,
        leaseId: 'lease-remote' as never,
        bitrate: 6_000_000,
      },
    });
    expect(call.getSnapshot().remoteScreenBitrateBps).toBe(6_000_000);
    await expect(call.prepareScreenShare()).rejects.toMatchObject({
      code: 'SCREEN_SHARE_BUSY',
    });
    expect(
      client.request.mock.calls.filter(([type]) => type === 'screen.acquire'),
    ).toHaveLength(0);
  });

  it('reports a selected relay candidate without uploading stats', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.joinRoom('access-token', '123456');
    const peer = peerConnectionFactory();
    peer.pc.getStats.mockResolvedValue(
      new Map([
        [
          'pair',
          {
            id: 'pair',
            type: 'candidate-pair',
            state: 'succeeded',
            selected: true,
            localCandidateId: 'local',
          },
        ],
        [
          'local',
          { id: 'local', type: 'local-candidate', candidateType: 'relay' },
        ],
      ]),
    );
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      createPeerConnection: peer.factory,
    });
    await call.start();
    client.emit({
      version: PROTOCOL_VERSION,
      eventId: 'relay-offer' as never,
      type: 'webrtc.offer',
      payload: {
        roomId: room.roomId as never,
        negotiationId: 'relay-negotiation' as never,
        connectionEpoch: 10,
        description: { type: 'offer', sdp: 'v=0\r\nm=audio\r\nm=video' },
      },
    });
    await vi.waitFor(() => expect(peer.pc.createAnswer).toHaveBeenCalledOnce());
    peer.pc.connectionState = 'connected';
    peer.pc.iceConnectionState = 'connected';
    peer.pc.emit('connectionstatechange', {});

    await vi.waitFor(() => expect(call.getSnapshot().status).toBe('relay'));
  });

  it('keeps early readiness single-shot when cleanup wins during device enumeration', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
    const enumeration = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = vi.fn(() => enumeration.promise);
    const call = createCallController({
      room,
      gateway,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream(audioTrack())),
        enumerateDevices,
      } as unknown as MediaDevices,
      createPeerConnection: peerConnectionFactory().factory,
    });
    const starting = call.start();
    await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
    const cleaning = call.cleanup();
    enumeration.resolve([]);
    await cleaning;

    await expect(starting).rejects.toThrow('Call lifecycle changed');
    expect(
      client.request.mock.calls.filter(([type]) => type === 'peer.ready'),
    ).toHaveLength(1);
  });
});
// @vitest-environment jsdom
