import {
  p2pRoomJoinAckSchema,
  p2pRoomLeaveAckSchema,
  peerReadyAckSchema,
  roomCodeSchema,
  roomCreateAckSchema,
  roomEndAckSchema,
  type P2pAckEnvelope,
  type P2pBroadcastEnvelope,
  type PublicAuthUser,
  type RtcConfiguration,
  type RoomSessionAckData,
} from '@wo/protocol';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { DesktopApi } from '../../../preload/types.js';
import {
  createSignalingClient,
  type SignalingClient,
} from '../media/signaling-client.js';
import { createAudioOutput } from '../media/audio-output.js';
import { createIdempotentCleanup } from '../media/media-cleanup.js';
import { createNegotiationController } from '../media/negotiation-controller.js';
import {
  createPeerConnectionController,
  type PeerConnectionLike,
} from '../media/peer-connection-controller.js';
import {
  createVoiceController,
  type VoiceController,
  type VoiceDevice,
} from '../media/voice-controller.js';
import type {
  RoomGateway,
  RoomGatewayEvent,
  RoomParticipant,
  RoomSnapshot,
} from './room-store.js';

export interface RealtimeRoomGateway extends RoomGateway {
  readonly kind: 'realtime';
  readonly signaling: SignalingClient;
  markReady(roomId: string): Promise<void>;
  getCallSession(roomId: string): RealtimeCallSession | null;
  dispose(): void;
}

export interface RealtimeCallSession {
  readonly roomId: string;
  readonly role: 'creator' | 'joiner';
  readonly connectionEpoch: number;
  readonly rtcConfiguration: RtcConfiguration;
  readonly iceCredentialsExpiresAt: string;
  readonly peerReady: boolean;
}

export interface RealtimeRoomGatewayOptions {
  readonly desktop: DesktopApi;
  readonly user: PublicAuthUser;
  readonly signaling?: SignalingClient;
}

function signalingFailure(response: P2pAckEnvelope): Error {
  if (response.payload.ok)
    return new Error('Expected a failed acknowledgement');
  return Object.assign(new Error(response.payload.error.message), {
    code: response.payload.error.code,
  });
}

function successfulData<Response extends P2pAckEnvelope>(
  response: Response,
): Extract<Response['payload'], { readonly ok: true }>['data'] {
  if (!response.payload.ok) throw signalingFailure(response);
  return response.payload.data as Extract<
    Response['payload'],
    { readonly ok: true }
  >['data'];
}

function participant(
  userId: string,
  displayName: string,
  isSelf: boolean,
  online: boolean,
): RoomParticipant {
  return { userId, displayName, isSelf, online };
}

function snapshotFromSession(
  session: RoomSessionAckData,
  roomCode: string,
  self: PublicAuthUser,
): RoomSnapshot {
  const participants: RoomParticipant[] = [
    participant(self.userId, self.displayName, true, true),
  ];
  if (session.peer !== null) {
    participants.push(
      participant(session.peer.userId, session.peer.displayName, false, true),
    );
  }
  return {
    roomId: session.roomId,
    roomCode,
    role: session.role,
    connectionStatus:
      session.peer === null
        ? 'waiting'
        : session.state === 'reconnecting'
          ? 'reconnecting'
          : 'connecting',
    participants,
  };
}

function privateCallSession(session: RoomSessionAckData): RealtimeCallSession {
  return Object.freeze({
    roomId: session.roomId,
    role: session.role,
    connectionEpoch: session.connectionEpoch,
    rtcConfiguration: session.rtcConfiguration,
    iceCredentialsExpiresAt: session.iceCredentialsExpiresAt,
    peerReady: session.peer?.ready ?? false,
  });
}

export function createRealtimeRoomGateway(
  options: RealtimeRoomGatewayOptions,
): RealtimeRoomGateway {
  const signaling =
    options.signaling ?? createSignalingClient({ desktop: options.desktop });
  const listeners = new Set<(event: RoomGatewayEvent) => void>();
  let current: RoomSnapshot | null = null;
  let callSession: RealtimeCallSession | null = null;
  let disposed = false;

  const emitSnapshot = (room: RoomSnapshot): void => {
    current = room;
    for (const listener of listeners) listener({ type: 'snapshot', room });
  };

  const updatePeer = (
    userId: string,
    change: (peer: RoomParticipant) => RoomParticipant,
  ): void => {
    if (current === null) return;
    let found = false;
    const participants = current.participants.map((item) => {
      if (item.userId !== userId || item.isSelf) return item;
      found = true;
      return change(item);
    });
    if (!found) return;
    emitSnapshot({ ...current, participants });
  };

  let unsubscribeSignaling: (() => void) | null = null;
  const handleSignalingEvent = (event: P2pBroadcastEnvelope): void => {
    if (current === null || event.payload.roomId !== current.roomId) return;
    switch (event.type) {
      case 'peer.joined': {
        if (callSession !== null) {
          callSession = Object.freeze({ ...callSession, peerReady: false });
        }
        const existing = current.participants.filter((item) => item.isSelf);
        emitSnapshot({
          ...current,
          connectionStatus: 'connecting',
          participants: [
            ...existing,
            participant(
              event.payload.peer.userId,
              event.payload.peer.displayName,
              false,
              true,
            ),
          ],
        });
        break;
      }
      case 'peer.ready':
        if (callSession !== null) {
          callSession = Object.freeze({ ...callSession, peerReady: true });
        }
        updatePeer(event.payload.peer.userId, (peer) => ({
          ...peer,
          online: true,
        }));
        break;
      case 'peer.left':
        if (callSession !== null) {
          callSession = Object.freeze({ ...callSession, peerReady: false });
        }
        updatePeer(event.payload.userId, (peer) => ({
          ...peer,
          online: false,
        }));
        if (current !== null) {
          emitSnapshot({ ...current, connectionStatus: 'reconnecting' });
        }
        break;
      case 'room.closed': {
        const roomId = current.roomId;
        current = null;
        callSession = null;
        signaling.disconnect();
        for (const listener of listeners) listener({ type: 'closed', roomId });
        break;
      }
      default:
        break;
    }
  };
  const ensureSignalingSubscription = (): void => {
    if (disposed) throw new Error('Realtime room gateway is disposed');
    unsubscribeSignaling ??= signaling.subscribe(handleSignalingEvent);
  };

  const disconnectAfter = async (
    operation: Promise<unknown>,
  ): Promise<void> => {
    await operation;
    current = null;
    callSession = null;
    signaling.disconnect();
  };

  return Object.freeze({
    kind: 'realtime' as const,
    signaling,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeSignaling?.();
      unsubscribeSignaling = null;
      signaling.disconnect();
      current = null;
      callSession = null;
      listeners.clear();
    },
    createRoom: async (accessToken: string) => {
      ensureSignalingSubscription();
      await signaling.connect(accessToken);
      const response = await signaling.request(
        'room.create',
        {},
        roomCreateAckSchema,
      );
      const data = successfulData(response);
      const snapshot = snapshotFromSession(data, data.roomCode, options.user);
      current = snapshot;
      callSession = privateCallSession(data);
      return snapshot;
    },
    joinRoom: async (accessToken: string, inputCode: string) => {
      ensureSignalingSubscription();
      const roomCode = roomCodeSchema.parse(inputCode);
      await signaling.connect(accessToken);
      const response = await signaling.request(
        'room.join',
        { roomCode },
        p2pRoomJoinAckSchema,
      );
      const data = successfulData(response);
      const snapshot = snapshotFromSession(data, roomCode, options.user);
      current = snapshot;
      callSession = privateCallSession(data);
      return snapshot;
    },
    getCallSession: (roomId: string) =>
      callSession?.roomId === roomId ? callSession : null,
    markReady: async (roomId: string) => {
      const session = callSession;
      if (session?.roomId !== roomId) {
        throw Object.assign(new Error('Room call session is unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      const response = await signaling.request(
        'peer.ready',
        { roomId, connectionEpoch: session.connectionEpoch },
        peerReadyAckSchema,
      );
      successfulData(response);
    },
    leaveRoom: (roomId: string) =>
      disconnectAfter(
        signaling
          .request('room.leave', { roomId }, p2pRoomLeaveAckSchema)
          .then(successfulData),
      ),
    endRoom: (roomId: string) =>
      disconnectAfter(
        signaling
          .request('room.end', { roomId }, roomEndAckSchema)
          .then(successfulData),
      ),
    subscribe: (listener: (event: RoomGatewayEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function isRealtimeRoomGateway(
  gateway: RoomGateway,
): gateway is RealtimeRoomGateway {
  return 'kind' in gateway && gateway.kind === 'realtime';
}

export type CallConnectionStatus =
  'waiting' | 'connecting' | 'connected' | 'relay' | 'reconnecting' | 'error';

export interface CallSnapshot {
  readonly status: CallConnectionStatus;
  readonly error: string | null;
  readonly muted: boolean;
  readonly outputMuted: boolean;
  readonly inputs: readonly VoiceDevice[];
  readonly outputs: readonly VoiceDevice[];
  readonly selectedInputId: string;
  readonly selectedOutputId: string;
  readonly supportsOutputSelection: boolean;
  readonly microphoneRetryAvailable: boolean;
}

export interface CallController {
  getSnapshot(): CallSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  setMuted(muted: boolean): void;
  switchMicrophone(deviceId: string): Promise<void>;
  setOutputMuted(muted: boolean): void;
  selectOutput(deviceId: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CallControllerOptions {
  readonly room: RoomSnapshot;
  readonly gateway: RealtimeRoomGateway;
  readonly mediaDevices?: MediaDevices;
  readonly createPeerConnection?: (
    configuration: RTCConfiguration,
  ) => PeerConnectionLike;
  readonly now?: () => number;
}

function callErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'MICROPHONE_PERMISSION_DENIED'
  ) {
    return '需要麦克风权限才能加入语音';
  }
  return '语音连接失败，请重试';
}

function isMicrophoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'MICROPHONE_PERMISSION_DENIED' ||
      error.code === 'MICROPHONE_CAPTURE_INVALID')
  );
}

function selectedPairUsesRelay(stats: RTCStatsReport): boolean {
  const reports = [...stats.values()] as unknown[];
  const records = reports.filter(
    (report): report is Record<string, unknown> =>
      typeof report === 'object' && report !== null,
  );
  const pair = records.find(
    (report) =>
      report.type === 'candidate-pair' &&
      report.state === 'succeeded' &&
      (report.selected === true || report.nominated === true),
  );
  if (pair === undefined || typeof pair.localCandidateId !== 'string') {
    return false;
  }
  const localCandidate = records.find(
    (report) => report.id === pair.localCandidateId,
  );
  return localCandidate?.candidateType === 'relay';
}

export function createCallController(
  options: CallControllerOptions,
): CallController {
  const callSession = options.gateway.getCallSession(options.room.roomId);
  if (callSession === null) {
    throw new Error('Room call session is unavailable');
  }
  const listeners = new Set<() => void>();
  let snapshot: CallSnapshot = Object.freeze({
    status: options.room.participants.length < 2 ? 'waiting' : 'connecting',
    error: null,
    muted: false,
    outputMuted: false,
    inputs: [],
    outputs: [],
    selectedInputId: '',
    selectedOutputId: '',
    supportsOutputSelection: false,
    microphoneRetryAvailable: false,
  });
  let closed = false;
  let lifecycleGeneration = 0;
  let startPromise: Promise<void> | null = null;
  let voice: VoiceController | null = null;
  let peer: ReturnType<typeof createPeerConnectionController> | null = null;
  let negotiation: ReturnType<typeof createNegotiationController> | null = null;
  let initialized = false;
  let microphoneAcquired = false;
  let localReady = false;
  let remoteReady = false;
  const subscriptions: Array<() => void> = [];

  const update = (change: Partial<CallSnapshot>): void => {
    if (closed) return;
    snapshot = Object.freeze({ ...snapshot, ...change });
    for (const listener of listeners) listener();
  };

  const assertCurrentLifecycle = (generation: number): void => {
    if (closed || generation !== lifecycleGeneration) {
      throw new Error('Call lifecycle changed');
    }
  };

  const fail = (error: unknown): void => {
    update({
      status: 'error',
      error: callErrorMessage(error),
      microphoneRetryAvailable: isMicrophoneError(error),
    });
  };

  const maybeOffer = (): void => {
    if (
      callSession.role !== 'creator' ||
      !localReady ||
      !remoteReady ||
      negotiation === null ||
      closed
    ) {
      return;
    }
    update({ status: 'connecting' });
    void negotiation.startCreatorOffer().catch(fail);
  };

  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    const audioOutput = createAudioOutput({ onPlaybackError: fail });
    voice = createVoiceController({
      mediaDevices: options.mediaDevices,
      audioOutput,
    });
    voice.setMuted(snapshot.muted);
    voice.setOutputMuted(snapshot.outputMuted);

    let candidateHandler:
      | ((candidate: RTCIceCandidateInit | null, generation: number) => void)
      | null = null;
    peer = createPeerConnectionController({
      role: callSession.role,
      rtcConfiguration: callSession.rtcConfiguration,
      iceCredentialsExpiresAt: callSession.iceCredentialsExpiresAt,
      connectionEpoch: callSession.connectionEpoch,
      createPeerConnection: options.createPeerConnection,
      onLocalCandidate: (candidate, generation) =>
        candidateHandler?.(candidate, generation),
      onRemoteTrack: (track) => {
        if (track.kind === 'audio') {
          void voice!.attachRemoteTrack(track).catch(fail);
        }
      },
      onConnectionStateChange: ({ connectionState }) => {
        if (connectionState === 'connected') {
          void peer!
            .getStats()
            .then((stats) =>
              update({
                status: selectedPairUsesRelay(stats) ? 'relay' : 'connected',
                error: null,
              }),
            )
            .catch(() => update({ status: 'connected', error: null }));
        } else if (connectionState === 'failed') {
          fail(new Error('PeerConnection failed'));
        } else if (connectionState === 'disconnected') {
          update({ status: 'reconnecting' });
        }
      },
    });
    negotiation = createNegotiationController({
      peer,
      signaling: options.gateway.signaling,
      roomId: options.room.roomId,
      microphone: () => {
        const track = voice!.microphoneTrack;
        if (track === null) throw new Error('Microphone is unavailable');
        return track;
      },
      onError: fail,
      now: options.now,
    });
    candidateHandler = negotiation.handleLocalCandidate;
    subscriptions.push(
      negotiation.subscribeNegotiationReady(() =>
        update({ status: 'connected', error: null }),
      ),
      options.gateway.signaling.subscribe((event) => {
        if (event.payload.roomId !== options.room.roomId || closed) return;
        switch (event.type) {
          case 'peer.ready':
            remoteReady = true;
            maybeOffer();
            break;
          case 'webrtc.offer':
            void negotiation!
              .handleOffer(event.payload)
              .then(async () => {
                const sender = peer!.audioSender;
                if (sender !== null) await voice!.bindSender(sender, true);
              })
              .catch(fail);
            break;
          case 'webrtc.answer':
            void negotiation!.handleAnswer(event.payload).catch(fail);
            break;
          case 'webrtc.iceCandidate':
            void negotiation!.handleRemoteCandidate(event.payload).catch(fail);
            break;
          case 'peer.left':
            remoteReady = false;
            update({ status: 'reconnecting' });
            break;
          default:
            break;
        }
      }),
      options.gateway.signaling.subscribeErrors(fail),
      options.gateway.signaling.subscribeConnection((event) => {
        if (event.state === 'closed') {
          peer!.handleSignalingClose();
          localReady = false;
          update({ status: 'reconnecting' });
        }
      }),
    );
    remoteReady =
      options.gateway.getCallSession(options.room.roomId)?.peerReady ?? false;
    maybeOffer();
  };

  const cleanup = createIdempotentCleanup([
    () => {
      closed = true;
      lifecycleGeneration += 1;
      negotiation?.dispose();
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      listeners.clear();
    },
    () => voice?.cleanup(),
    () => peer?.disposeTransport({ stopOwnedTracks: false }),
  ]);

  const controller: CallController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (startPromise !== null) return startPromise;
      if (closed) return Promise.reject(new Error('Call has been cleaned'));
      initialize();
      update({
        status: options.room.participants.length < 2 ? 'waiting' : 'connecting',
        error: null,
        microphoneRetryAvailable: false,
      });
      startPromise = (async () => {
        const generation = lifecycleGeneration;
        try {
          if (!microphoneAcquired) {
            const sender =
              callSession.role === 'creator' ? peer!.audioSender : undefined;
            await voice!.start(sender ?? undefined);
            assertCurrentLifecycle(generation);
            microphoneAcquired = true;
            update({ microphoneRetryAvailable: false });
          }
          try {
            const devices = await voice!.listDevices();
            assertCurrentLifecycle(generation);
            update({
              inputs: devices.inputs,
              outputs: devices.outputs,
              selectedInputId:
                voice!.microphoneTrack?.getSettings?.().deviceId ?? '',
              selectedOutputId: '',
              supportsOutputSelection: voice!.supportsOutputSelection,
            });
          } catch {
            assertCurrentLifecycle(generation);
            update({ supportsOutputSelection: voice!.supportsOutputSelection });
          }
          if (!localReady) {
            assertCurrentLifecycle(generation);
            await options.gateway.markReady(options.room.roomId);
            assertCurrentLifecycle(generation);
            localReady = true;
            maybeOffer();
          }
        } catch (error) {
          startPromise = null;
          assertCurrentLifecycle(generation);
          fail(error);
          throw error;
        }
      })();
      return startPromise;
    },
    setMuted: (muted) => {
      voice!.setMuted(muted);
      update({ muted });
    },
    switchMicrophone: async (deviceId) => {
      try {
        await voice!.switchMicrophone(deviceId);
        update({ selectedInputId: deviceId });
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    setOutputMuted: (muted) => {
      voice!.setOutputMuted(muted);
      update({ outputMuted: muted });
    },
    selectOutput: async (deviceId) => {
      if (await voice!.selectOutput(deviceId)) {
        update({ selectedOutputId: deviceId });
      }
    },
    cleanup,
  };
  return Object.freeze(controller);
}

function passiveCallController(room: RoomSnapshot): CallController {
  const snapshot: CallSnapshot = Object.freeze({
    status: room.connectionStatus,
    error: null,
    muted: false,
    outputMuted: false,
    inputs: [],
    outputs: [],
    selectedInputId: '',
    selectedOutputId: '',
    supportsOutputSelection: false,
    microphoneRetryAvailable: false,
  });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    start: async () => undefined,
    setMuted: () => undefined,
    switchMicrophone: async () => undefined,
    setOutputMuted: () => undefined,
    selectOutput: async () => undefined,
    cleanup: async () => undefined,
  });
}

interface CallContextValue {
  readonly controller: CallController;
  readonly snapshot: CallSnapshot;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({
  room,
  gateway,
  controller: providedController,
  children,
}: {
  readonly room: RoomSnapshot;
  readonly gateway: RoomGateway;
  readonly controller?: CallController;
  readonly children: ReactNode;
}) {
  const controller = useMemo(
    () =>
      providedController ??
      (isRealtimeRoomGateway(gateway)
        ? createCallController({ room, gateway })
        : passiveCallController(room)),
    [gateway, providedController, room.roomId],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const mountCount = useRef(0);
  useEffect(() => {
    mountCount.current += 1;
    void controller.start().catch(() => undefined);
    return () => {
      mountCount.current -= 1;
      queueMicrotask(() => {
        if (mountCount.current === 0) {
          void controller.cleanup().catch(() => undefined);
        }
      });
    };
  }, [controller]);
  return (
    <CallContext.Provider value={{ controller, snapshot }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const value = useContext(CallContext);
  if (value === null) throw new Error('CallProvider is missing');
  return value;
}
