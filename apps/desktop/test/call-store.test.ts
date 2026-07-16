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

function signaling() {
  const listeners = new Set<(event: P2pBroadcastEnvelope) => void>();
  const connectionListeners = new Set<
    (
      event:
        { state: 'open' } | { state: 'closed'; code: number; reason: string },
    ) => void
  >();
  const request = vi.fn(async (type: string) => {
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

function mediaStream(track: MediaStreamTrack) {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

function peerConnectionFactory() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const transceivers = [
    {
      mid: '0',
      direction: 'sendrecv',
      sender: {
        track: null,
        replaceTrack: vi.fn().mockResolvedValue(undefined),
      },
      receiver: { track: { kind: 'audio' } },
      setCodecPreferences: vi.fn(),
    },
    {
      mid: '1',
      direction: 'sendrecv',
      sender: {
        track: null,
        replaceTrack: vi.fn().mockResolvedValue(undefined),
      },
      receiver: { track: { kind: 'video' } },
      setCodecPreferences: vi.fn(),
    },
  ];
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
    await expect(call.start()).resolves.toBeUndefined();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(peer.factory).toHaveBeenCalledOnce();
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

  it('routes a joiner offer onto existing transceivers and binds the captured microphone once', async () => {
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
    expect(peer.transceivers[0]!.sender.replaceTrack).toHaveBeenCalledOnce();
    expect(peer.transceivers[0]!.sender.replaceTrack).toHaveBeenCalledWith(
      microphone,
    );
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

  it('keeps voice/PC alive on signaling close, then stops voice and closes transport once on cleanup', async () => {
    const client = signaling();
    const gateway = createRealtimeRoomGateway({
      desktop,
      user,
      signaling: client,
    });
    const room = await gateway.createRoom('access-token');
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

    client.emitConnection({ state: 'closed', code: 1012, reason: 'restart' });
    expect(call.getSnapshot().status).toBe('reconnecting');
    expect(microphone.stop).not.toHaveBeenCalled();
    expect(peer.pc.close).not.toHaveBeenCalled();

    const first = call.cleanup();
    const second = call.cleanup();
    expect(second).toBe(first);
    await first;
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(peer.pc.close).toHaveBeenCalledOnce();
  });

  it('reports a selected relay candidate without uploading stats', async () => {
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
    peer.pc.connectionState = 'connected';
    peer.pc.emit('connectionstatechange', {});

    await vi.waitFor(() => expect(call.getSnapshot().status).toBe('relay'));
  });

  it('never marks ready when cleanup wins while device enumeration is pending', async () => {
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
    ).toHaveLength(0);
  });
});
// @vitest-environment jsdom
