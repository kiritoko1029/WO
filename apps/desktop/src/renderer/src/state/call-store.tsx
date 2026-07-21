import {
  p2pRoomJoinAckSchema,
  p2pRoomLeaveAckSchema,
  peerReadyAckSchema,
  roomCodeSchema,
  roomCreateAckSchema,
  roomEndAckSchema,
  roomResumeAckSchema,
  screenBitrateAckSchema,
  type P2pAckEnvelope,
  type P2pBroadcastEnvelope,
  type PublicAuthUser,
  type RtcConfiguration,
  type RoomResumeAckData,
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

import type {
  CaptureSourceSummary,
  DesktopApi,
  ScreenPermissionSnapshot,
} from '../../../preload/types.js';
import {
  createSignalingClient,
  type SignalingClient,
} from '../media/signaling-client.js';
import { createAudioOutput } from '../media/audio-output.js';
import { createIdempotentCleanup } from '../media/media-cleanup.js';
import { createNegotiationController } from '../media/negotiation-controller.js';
import {
  createReconnectController,
  type ReconnectController,
} from '../media/reconnect-controller.js';
import {
  createPeerConnectionController,
  type PeerConnectionLike,
} from '../media/peer-connection-controller.js';
import {
  createScreenController,
  type ScreenCaptureSettings,
  type ScreenController,
  type ScreenShareState,
} from '../media/screen-controller.js';
import {
  createSenderBitrateController,
  type ScreenBitrateTarget,
  type SenderBitrateController,
  DEFAULT_SCREEN_BITRATE_TARGET,
} from '../media/sender-bitrate.js';
import {
  createStatsBuffer,
  type QualityDiagnosticSample,
  type StatsExportSnapshot,
} from '../media/stats-buffer.js';
import {
  createPresentationFpsSampler,
  createStatsMonitor,
  type PresentationFpsSampler,
  type PresentationVideo,
  type StatsMonitor,
} from '../media/stats-monitor.js';
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
import {
  createCallMachine,
  type CallConnectionPath,
  type CallEvent,
  type CallMachineSnapshot,
} from './call-machine.js';

export interface RealtimeRoomGateway extends RoomGateway {
  readonly kind: 'realtime';
  readonly signaling: SignalingClient;
  readonly desktop: DesktopApi;
  readonly user: PublicAuthUser;
  markReady(roomId: string): Promise<void>;
  resumeRoom(
    roomId: string,
    shouldApply?: () => boolean,
  ): Promise<RealtimeRoomResumeResult>;
  closeLocalRoom(
    roomId: string,
    reason: Extract<RoomGatewayEvent, { type: 'closed' }>['reason'],
  ): void;
  getCallSession(roomId: string): RealtimeCallSession | null;
  dispose(): void;
}

export type RealtimeRoomResumeResult =
  | Readonly<{
      status: 'resumed';
      transport: 'healthy';
      negotiationId: string | null;
      negotiationGeneration: number | null;
    }>
  | Readonly<{
      status: 'reset_required';
      negotiationId: string;
      resetGeneration: number;
      reason: 'peer_resumed' | 'signaling_reset';
    }>
  | Readonly<{ status: 'room_closed' }>;

export interface RealtimeCallSession {
  readonly roomId: string;
  readonly role: 'creator' | 'joiner';
  readonly connectionEpoch: number;
  readonly rtcConfiguration: RtcConfiguration;
  readonly iceCredentialsExpiresAt: string;
  readonly peerReady: boolean;
  readonly screen: RoomSessionAckData['screen'];
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
    screen: session.screen,
  });
}

function resumeResult(
  session: RoomResumeAckData,
): Exclude<RealtimeRoomResumeResult, { status: 'room_closed' }> {
  switch (session.resume.status) {
    case 'completed':
      return Object.freeze({
        status: 'resumed' as const,
        transport: 'healthy' as const,
        negotiationId: session.resume.negotiationId,
        negotiationGeneration: session.resume.negotiationGeneration,
      });
    case 'reset_required':
      return Object.freeze({
        status: 'reset_required' as const,
        negotiationId: session.resume.negotiationId,
        resetGeneration: session.resume.resetGeneration,
        reason: session.resume.reason,
      });
    case 'none':
      return Object.freeze({
        status: 'resumed' as const,
        transport: 'healthy' as const,
        negotiationId: null,
        negotiationGeneration: null,
      });
  }
}

export function createRealtimeRoomGateway(
  options: RealtimeRoomGatewayOptions,
): RealtimeRoomGateway {
  const signaling =
    options.signaling ?? createSignalingClient({ desktop: options.desktop });
  const listeners = new Set<(event: RoomGatewayEvent) => void>();
  let current: RoomSnapshot | null = null;
  let callSession: RealtimeCallSession | null = null;
  let retainedAccessToken: string | null = null;
  let disposed = false;

  const emitSnapshot = (room: RoomSnapshot): void => {
    current = room;
    for (const listener of listeners) listener({ type: 'snapshot', room });
  };

  const closeLocalRoom = (
    roomId: string,
    reason: Extract<RoomGatewayEvent, { type: 'closed' }>['reason'],
  ): void => {
    if (current?.roomId !== roomId) return;
    current = null;
    callSession = null;
    retainedAccessToken = null;
    signaling.disconnect();
    for (const listener of listeners) {
      listener({ type: 'closed', roomId, reason });
    }
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
        const alreadyPresent = current.participants.some(
          (item) => item.userId === event.payload.peer.userId,
        );
        const hadRemotePeer = current.participants.some(
          (item) => !item.isSelf && item.online,
        );
        // Only reset media readiness when the first remote peer appears.
        if (callSession !== null && !hadRemotePeer) {
          callSession = Object.freeze({ ...callSession, peerReady: false });
        }
        emitSnapshot({
          ...current,
          connectionStatus: hadRemotePeer
            ? current.connectionStatus
            : 'connecting',
          participants: alreadyPresent
            ? current.participants.map((item) =>
                item.userId === event.payload.peer.userId
                  ? {
                      ...item,
                      displayName: event.payload.peer.displayName,
                      online: true,
                    }
                  : item,
              )
            : [
                ...current.participants,
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
      case 'peer.left': {
        const remainingRemotes = current.participants.filter(
          (item) =>
            !item.isSelf &&
            item.userId !== event.payload.userId &&
            item.online,
        );
        if (callSession !== null && remainingRemotes.length === 0) {
          callSession = Object.freeze({ ...callSession, peerReady: false });
        }
        emitSnapshot({
          ...current,
          connectionStatus:
            remainingRemotes.length === 0
              ? 'reconnecting'
              : current.connectionStatus,
          participants: current.participants.filter(
            (item) => item.userId !== event.payload.userId,
          ),
        });
        break;
      }
      case 'room.closed': {
        const roomId = current.roomId;
        closeLocalRoom(roomId, event.payload.reason);
        break;
      }
      case 'screen.ownerChanged':
        if (callSession !== null) {
          callSession = Object.freeze({
            ...callSession,
            screen: Object.freeze({
              owner:
                event.payload.owner === null
                  ? null
                  : Object.freeze({ ...event.payload.owner }),
              leaseId: event.payload.leaseId,
              leaseExpiresAt: event.payload.leaseExpiresAt,
            }),
          });
        }
        break;
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
    retainedAccessToken = null;
    signaling.disconnect();
  };

  return Object.freeze({
    kind: 'realtime' as const,
    signaling,
    desktop: options.desktop,
    user: options.user,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeSignaling?.();
      unsubscribeSignaling = null;
      signaling.disconnect();
      current = null;
      callSession = null;
      retainedAccessToken = null;
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
      retainedAccessToken = accessToken;
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
      retainedAccessToken = accessToken;
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
    resumeRoom: async (roomId: string, shouldApply?: () => boolean) => {
      const assertCurrent = (): void => {
        if (shouldApply?.() === false) {
          throw Object.assign(new Error('Room resume was canceled'), {
            code: 'INVALID_STATE',
          });
        }
      };
      assertCurrent();
      if (
        current?.roomId !== roomId ||
        callSession?.roomId !== roomId ||
        retainedAccessToken === null
      ) {
        throw Object.assign(new Error('Room call session is unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      await signaling.connect(retainedAccessToken);
      assertCurrent();
      const response = await signaling.request(
        'room.resume',
        { roomId },
        roomResumeAckSchema,
      );
      assertCurrent();
      if (!response.payload.ok) {
        if (response.payload.error.code === 'ROOM_CLOSED') {
          closeLocalRoom(roomId, 'server_restart');
          return Object.freeze({ status: 'room_closed' as const });
        }
        throw signalingFailure(response);
      }
      const data = response.payload.data;
      if (data.roomId !== roomId) {
        throw Object.assign(new Error('Resumed room does not match request'), {
          code: 'PROTOCOL_ERROR',
        });
      }
      const roomCode = current.roomCode;
      callSession = privateCallSession(data);
      emitSnapshot(snapshotFromSession(data, roomCode, options.user));
      return resumeResult(data);
    },
    closeLocalRoom,
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

function projectedCallStatus(phase: CallMachineSnapshot): CallConnectionStatus {
  switch (phase.phase) {
    case 'waiting':
      return 'waiting';
    case 'negotiating':
      return 'connecting';
    case 'connected':
      return phase.connectionPath === 'relay' ? 'relay' : 'connected';
    case 'recovering':
    case 'closing':
      return 'reconnecting';
    case 'failed':
    case 'closed':
      return 'error';
  }
}

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
  readonly screenState: ScreenShareState;
  readonly screenSources: readonly CaptureSourceSummary[];
  readonly screenSelectedToken: string | null;
  readonly screenCaptureSettings: ScreenCaptureSettings | null;
  readonly screenError: string | null;
  readonly screenOwner: Readonly<{
    userId: string;
    displayName: string;
  }> | null;
  readonly screenOwnerLeaseId: string | null;
  readonly localScreenTrack: MediaStreamTrack | null;
  readonly remoteScreenTrack: MediaStreamTrack | null;
  readonly screenBitrateTarget: ScreenBitrateTarget;
  readonly screenBitratePending: ScreenBitrateTarget | null;
  readonly screenBitrateError: string | null;
  readonly remoteScreenBitrateBps: number | null;
  readonly screenPermission: ScreenPermissionSnapshot | null;
  readonly quality: QualityDiagnosticSample | null;
}

export interface CallController {
  getSnapshot(): CallSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  setMuted(muted: boolean): void;
  switchMicrophone(deviceId: string): Promise<void>;
  setOutputMuted(muted: boolean): void;
  selectOutput(deviceId: string): Promise<void>;
  prepareScreenShare(): Promise<void>;
  selectScreenSource(token: string): Promise<void>;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void>;
  setScreenBitrate(target: ScreenBitrateTarget): Promise<void>;
  openScreenSettings(): Promise<void>;
  attachPresentationVideo(video: PresentationVideo | null): void;
  exportDiagnostics(): StatsExportSnapshot;
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
  readonly statsIntervalMs?: number;
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

function directionalStats(
  report: RTCStatsReport,
  direction: 'outbound' | 'inbound',
): RTCStatsReport {
  const selected = new Map<string, RTCStats>();
  const allowedRtpTypes =
    direction === 'outbound'
      ? new Set(['outbound-rtp', 'remote-inbound-rtp'])
      : new Set(['inbound-rtp', 'remote-outbound-rtp']);
  const sharedTypes = new Set([
    'candidate-pair',
    'codec',
    'local-candidate',
    'remote-candidate',
    'transport',
  ]);
  report.forEach((value, key) => {
    if (allowedRtpTypes.has(value.type) || sharedTypes.has(value.type)) {
      selected.set(key, value);
    }
  });
  return selected as unknown as RTCStatsReport;
}

export function createCallController(
  options: CallControllerOptions,
): CallController {
  const initialCallSession = options.gateway.getCallSession(
    options.room.roomId,
  );
  if (initialCallSession === null) {
    throw new Error('Room call session is unavailable');
  }
  let callSession: RealtimeCallSession = initialCallSession;
  const callMachine = createCallMachine({
    peerReady: options.room.participants.length >= 2,
  });
  const initialScreenOwner =
    callSession.screen.owner === null
      ? null
      : Object.freeze({
          userId: callSession.screen.owner.userId,
          displayName: callSession.screen.owner.displayName,
        });
  const listeners = new Set<() => void>();
  let snapshot: CallSnapshot = Object.freeze({
    status: projectedCallStatus(callMachine.getSnapshot()),
    error: null,
    muted: false,
    outputMuted: false,
    inputs: [],
    outputs: [],
    selectedInputId: '',
    selectedOutputId: '',
    supportsOutputSelection: false,
    microphoneRetryAvailable: false,
    screenState: 'idle',
    screenSources: Object.freeze([]),
    screenSelectedToken: null,
    screenCaptureSettings: null,
    screenError: null,
    screenOwner: initialScreenOwner,
    screenOwnerLeaseId: callSession.screen.leaseId,
    localScreenTrack: null,
    remoteScreenTrack: null,
    screenBitrateTarget: DEFAULT_SCREEN_BITRATE_TARGET,
    screenBitratePending: null,
    screenBitrateError: null,
    remoteScreenBitrateBps: null,
    screenPermission: null,
    quality: null,
  });
  let closed = false;
  let lifecycleGeneration = 0;
  let startPromise: Promise<void> | null = null;
  let voice: VoiceController | null = null;
  let peer: ReturnType<typeof createPeerConnectionController> | null = null;
  let negotiation: ReturnType<typeof createNegotiationController> | null = null;
  let reconnect: ReconnectController | null = null;
  let screenController: ScreenController | null = null;
  let statsMonitor: StatsMonitor | null = null;
  let presentationSampler: PresentationFpsSampler | null = null;
  let negotiationGeneration = 0;
  const negotiationReadyWaiters = new Set<
    Readonly<{
      afterGeneration: number;
      previousNegotiationId: string | null;
      requireNewNegotiation: boolean;
      requireIceConnected: boolean;
      resolve: () => void;
    }>
  >();
  let recoveryQueueGeneration = 0;
  const statsBuffer = createStatsBuffer();
  let screenSubscription: (() => void) | null = null;
  let negotiationSubscription: (() => void) | null = null;
  let pendingReset: Readonly<{
    negotiationId: string;
    resetGeneration: number;
    reason: 'peer_resumed' | 'signaling_reset';
  }> | null = null;
  let acceptedResetGeneration = 0;
  let rebuiltResetGeneration = 0;
  let transportRebuildFlight: Promise<void> | null = null;
  let resetDeliveryChain = Promise.resolve();
  let negotiationEstablished = false;
  let terminalCloseReason: 'server_restart' | 'session_replaced' =
    'server_restart';
  const bitrateController: SenderBitrateController =
    createSenderBitrateController({
      getSender: () => peer?.screenSender ?? null,
      initialTarget: DEFAULT_SCREEN_BITRATE_TARGET,
    });
  let initialized = false;
  let microphoneAcquired = false;
  let pendingMicrophoneRetryDeviceId: string | null = null;
  let microphoneRetryFlight: Promise<void> | null = null;
  let microphoneRetryFlightDeviceId: string | null = null;
  let microphoneRetryFlightGeneration = 0;
  let microphoneSwitchGeneration = 0;
  let localReady = false;
  let remoteReady = false;
  let everConnected = false;
  const subscriptions: Array<() => void> = [];
  let cleanupCall: () => Promise<void> = async () => undefined;

  const resolveNegotiationReadyWaiters = (all = false): void => {
    for (const waiter of negotiationReadyWaiters) {
      const currentNegotiationId = peer?.currentNegotiationId ?? null;
      const iceConnected =
        peer?.iceConnectionState === 'connected' ||
        peer?.iceConnectionState === 'completed';
      if (
        all ||
        (negotiationGeneration > waiter.afterGeneration &&
          currentNegotiationId !== null &&
          (!waiter.requireNewNegotiation ||
            currentNegotiationId !== waiter.previousNegotiationId) &&
          (!waiter.requireIceConnected || iceConnected))
      ) {
        negotiationReadyWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const waitForNextNegotiationReady = (
    options: Readonly<{
      requireNewNegotiation?: boolean;
      requireIceConnected?: boolean;
    }> = {},
  ): Promise<void> => {
    const afterGeneration = negotiationGeneration;
    const previousNegotiationId = peer?.currentNegotiationId ?? null;
    return new Promise((resolve) => {
      negotiationReadyWaiters.add(
        Object.freeze({
          afterGeneration,
          previousNegotiationId,
          requireNewNegotiation: options.requireNewNegotiation ?? false,
          requireIceConnected: options.requireIceConnected ?? false,
          resolve,
        }),
      );
    });
  };

  const invalidateRecoveryQueue = (): void => {
    recoveryQueueGeneration += 1;
    resolveNegotiationReadyWaiters(true);
  };

  const update = (change: Partial<Omit<CallSnapshot, 'status'>>): void => {
    if (closed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...change,
      status: projectedCallStatus(callMachine.getSnapshot()),
    });
    for (const listener of listeners) listener();
  };

  const dispatchCall = (
    event: CallEvent,
    change: Partial<Omit<CallSnapshot, 'status'>> = {},
  ): void => {
    if (closed) return;
    const previous = callMachine.getSnapshot();
    const next = callMachine.dispatch(event);
    if (next !== previous || Object.keys(change).length > 0) update(change);
  };

  const assertCurrentLifecycle = (generation: number): void => {
    if (closed || generation !== lifecycleGeneration) {
      throw Object.assign(new Error('Call lifecycle changed'), {
        code: 'INVALID_STATE',
      });
    }
  };

  const currentLifecycle = (): number => {
    assertCurrentLifecycle(lifecycleGeneration);
    return lifecycleGeneration;
  };

  const settleCallPhase = (
    connectionPath: CallConnectionPath | null = callMachine.getSnapshot()
      .connectionPath,
  ): void => {
    const recoveryState = reconnect?.getSnapshot().state;
    if (recoveryState !== undefined && recoveryState !== 'connected') return;
    dispatchCall({
      type: 'settle',
      peerReady: remoteReady,
      negotiationEstablished,
      transportConnected: peer?.connectionState === 'connected',
      connectionPath,
    });
  };

  const fail = (error: unknown): void => {
    dispatchCall(
      { type: 'fail' },
      {
        error: callErrorMessage(error),
        microphoneRetryAvailable: isMicrophoneError(error),
      },
    );
  };

  const syncScreenSnapshot = (): void => {
    if (screenController === null) return;
    const screenSnapshot = screenController.getSnapshot();
    update({
      screenState: screenSnapshot.state,
      screenSources: screenSnapshot.sources,
      screenSelectedToken: screenSnapshot.selectedToken,
      screenCaptureSettings: screenSnapshot.captureSettings,
      screenError: screenSnapshot.error,
      localScreenTrack:
        screenSnapshot.state === 'sharing'
          ? (peer?.screenSender?.track ?? null)
          : null,
    });
  };

  const syncBitrateSnapshot = (error: string | null): void => {
    const bitrateSnapshot = bitrateController.getSnapshot();
    update({
      screenBitrateTarget: bitrateSnapshot.desiredTarget,
      screenBitratePending: bitrateSnapshot.pendingTarget,
      screenBitrateError: error,
    });
  };

  const replayBitrate = async (): Promise<void> => {
    try {
      await bitrateController.replay();
      syncBitrateSnapshot(null);
    } catch {
      syncBitrateSnapshot('目标码率设置失败，请重试');
    }
  };

  const attachRemoteScreenTrack = (track: MediaStreamTrack): void => {
    if (track.kind !== 'video' || snapshot.remoteScreenTrack === track) return;
    update({ remoteScreenTrack: track });
    track.addEventListener(
      'ended',
      () => {
        if (snapshot.remoteScreenTrack === track) {
          update({ remoteScreenTrack: null });
        }
      },
      { once: true },
    );
  };

  const syncNegotiatedScreenReceiver = (): void => {
    const track = peer?.screenReceiver?.track;
    if (track !== null && track !== undefined) attachRemoteScreenTrack(track);
  };

  const ensureScreenController = (): ScreenController | null => {
    if (screenController !== null) return screenController;
    const sender = peer?.screenSender;
    if (sender === null || sender === undefined) return null;
    screenController = createScreenController({
      roomId: options.room.roomId,
      userId: options.gateway.user.userId,
      sender,
      signaling: options.gateway.signaling,
      capture: options.gateway.desktop.capture,
      ...(options.mediaDevices === undefined
        ? {}
        : { mediaDevices: options.mediaDevices }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    screenSubscription = screenController.subscribe(syncScreenSnapshot);
    syncScreenSnapshot();
    return screenController;
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
    if (negotiationEstablished && pendingReset === null) return;
    if (
      pendingReset !== null &&
      acceptedResetGeneration !== pendingReset.resetGeneration
    ) {
      return;
    }
    dispatchCall({ type: 'negotiate' });
    void negotiation.startCreatorOffer(pendingReset?.negotiationId).catch(fail);
  };

  const disposeScreenController = async (): Promise<void> => {
    const active = screenController;
    screenController = null;
    screenSubscription?.();
    screenSubscription = null;
    await active?.cleanup();
    update({
      screenState: 'idle',
      screenSources: Object.freeze([]),
      screenSelectedToken: null,
      screenCaptureSettings: null,
      screenError: null,
      localScreenTrack: null,
    });
  };

  const createTransport = (): ReturnType<
    typeof createPeerConnectionController
  > => {
    let selectedConnectionPath: CallConnectionPath | null = null;
    let candidateHandler:
      | ((candidate: RTCIceCandidateInit | null, generation: number) => void)
      | null = null;
    const createdPeer = createPeerConnectionController({
      role: callSession.role,
      rtcConfiguration: callSession.rtcConfiguration,
      iceCredentialsExpiresAt: callSession.iceCredentialsExpiresAt,
      connectionEpoch: callSession.connectionEpoch,
      createPeerConnection: options.createPeerConnection,
      onLocalCandidate: (candidate, generation) =>
        candidateHandler?.(candidate, generation),
      onRemoteTrack: (track) => {
        if (peer !== createdPeer) return;
        if (track.kind === 'audio') {
          void voice!.attachRemoteTrack(track).catch(fail);
        } else if (track.kind === 'video') {
          attachRemoteScreenTrack(track);
        }
      },
      onConnectionStateChange: ({ connectionState, iceConnectionState }) => {
        if (peer !== createdPeer) return;
        resolveNegotiationReadyWaiters();
        void reconnect
          ?.handleIceConnectionState(iceConnectionState)
          .catch(fail);
        if (connectionState === 'connected') {
          everConnected = true;
          settleCallPhase(selectedConnectionPath);
          void createdPeer
            .getStats()
            .then((stats) => {
              if (
                closed ||
                peer !== createdPeer ||
                createdPeer.connectionState !== 'connected'
              ) {
                return;
              }
              selectedConnectionPath = selectedPairUsesRelay(stats)
                ? 'relay'
                : 'direct';
              settleCallPhase(selectedConnectionPath);
              update({ error: null });
            })
            .catch(() => {
              if (!closed && peer === createdPeer) {
                settleCallPhase(selectedConnectionPath);
                update({ error: null });
              }
            });
        } else if (
          connectionState === 'failed' ||
          connectionState === 'disconnected'
        ) {
          dispatchCall({ type: 'recover', reason: 'ice' });
        }
      },
    });
    peer = createdPeer;
    ensureScreenController();
    const createdNegotiation = createNegotiationController({
      peer: createdPeer,
      signaling: options.gateway.signaling,
      roomId: options.room.roomId,
      microphone: () => voice!.microphoneTrack,
      onError: fail,
      now: options.now,
    });
    negotiation = createdNegotiation;
    candidateHandler = createdNegotiation.handleLocalCandidate;
    negotiationSubscription = createdNegotiation.subscribeNegotiationReady(
      () => {
        if (negotiation !== createdNegotiation || peer !== createdPeer) return;
        negotiationGeneration += 1;
        resolveNegotiationReadyWaiters();
        negotiationEstablished = true;
        if (
          pendingReset !== null &&
          acceptedResetGeneration === pendingReset.resetGeneration
        ) {
          pendingReset = null;
        }
        statsMonitor?.resetBaselines();
        settleCallPhase(selectedConnectionPath);
        update({ error: null });
        syncNegotiatedScreenReceiver();
        void replayBitrate();
      },
    );
    return createdPeer;
  };

  const rebuildTransportForReset = async (
    resetGeneration: number,
  ): Promise<void> => {
    const lifecycle = currentLifecycle();
    if (rebuiltResetGeneration >= resetGeneration) return;
    if (transportRebuildFlight !== null) {
      try {
        await transportRebuildFlight;
      } catch {
        // A newer authoritative reset must not inherit an older rebuild error.
      }
      assertCurrentLifecycle(lifecycle);
      if (rebuiltResetGeneration >= resetGeneration) return;
    }
    let nextPeer: ReturnType<typeof createPeerConnectionController> | null =
      null;
    const operation = (async () => {
      statsMonitor?.resetBaselines();
      await disposeScreenController();
      assertCurrentLifecycle(lifecycle);
      const oldNegotiation = negotiation;
      const oldPeer = peer;
      negotiation = null;
      peer = null;
      negotiationSubscription?.();
      negotiationSubscription = null;
      oldNegotiation?.dispose();
      await oldPeer?.disposeTransport({ stopOwnedTracks: false });
      assertCurrentLifecycle(lifecycle);
      update({
        localScreenTrack: null,
        remoteScreenTrack: null,
        remoteScreenBitrateBps: null,
      });
      negotiationEstablished = false;
      nextPeer = createTransport();
      const sender = nextPeer.audioSender;
      if (
        callSession.role === 'creator' &&
        microphoneAcquired &&
        sender !== null &&
        sender !== undefined
      ) {
        await voice!.bindSender(sender);
        assertCurrentLifecycle(lifecycle);
      }
      localReady = false;
      remoteReady = false;
      await options.gateway.markReady(options.room.roomId);
      assertCurrentLifecycle(lifecycle);
      if (peer !== nextPeer) {
        throw new Error('PeerConnection changed during transport rebuild');
      }
      localReady = true;
      rebuiltResetGeneration = resetGeneration;
      if (pendingReset?.resetGeneration === resetGeneration) {
        acceptedResetGeneration = resetGeneration;
      }
      maybeOffer();
    })().catch(async (error: unknown) => {
      if (nextPeer !== null && peer === nextPeer) {
        negotiationSubscription?.();
        negotiationSubscription = null;
        negotiation?.dispose();
        negotiation = null;
        peer = null;
        await nextPeer.disposeTransport({ stopOwnedTracks: false });
      }
      throw error;
    });
    const flight = operation.finally(() => {
      if (transportRebuildFlight === flight) {
        transportRebuildFlight = null;
      }
    });
    transportRebuildFlight = flight;
    return flight;
  };

  const waitForStableSignaling = async (): Promise<void> => {
    const active = peer;
    if (active === null || active.signalingState === 'stable') return;
    await new Promise<void>((resolve, reject) => {
      const onStateChange = (): void => {
        if (peer !== active) {
          finish(new Error('PeerConnection changed while waiting for stable'));
        } else if (active.signalingState === 'stable') {
          finish();
        }
      };
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        active.pc.removeEventListener('signalingstatechange', onStateChange);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new Error('PeerConnection did not become stable')),
        8_000,
      );
      active.pc.addEventListener('signalingstatechange', onStateChange);
    });
  };

  const syncResumedSession = (next: RealtimeCallSession): void => {
    callSession = next;
    const owner =
      next.screen.owner === null
        ? null
        : {
            userId: next.screen.owner.userId,
            displayName: next.screen.owner.displayName,
          };
    update({
      screenOwner: owner,
      screenOwnerLeaseId: next.screen.leaseId,
      ...(owner === null || owner.userId === options.gateway.user.userId
        ? { remoteScreenBitrateBps: null }
        : {}),
    });
  };

  const resumeSignaling = async () => {
    const generation = currentLifecycle();
    const result = await options.gateway.resumeRoom(
      options.room.roomId,
      () => !closed && generation === lifecycleGeneration,
    );
    assertCurrentLifecycle(generation);
    if (result.status === 'room_closed') return result;
    const resumed = options.gateway.getCallSession(options.room.roomId);
    if (resumed === null) {
      throw new Error('Resumed call session is unavailable');
    }
    syncResumedSession(resumed);
    localReady = false;
    if (result.status === 'reset_required') {
      const reset = Object.freeze({
        negotiationId: result.negotiationId,
        resetGeneration: result.resetGeneration,
        reason: result.reason,
      });
      if (
        pendingReset !== null &&
        pendingReset.resetGeneration === reset.resetGeneration &&
        pendingReset.negotiationId !== reset.negotiationId
      ) {
        throw new Error('Negotiation reset does not match resume');
      }
      pendingReset = reset;
      invalidateRecoveryQueue();
      negotiationEstablished = false;
      remoteReady = false;
      return result;
    }
    remoteReady = resumed.peerReady;
    negotiationEstablished = result.negotiationId !== null;
    pendingReset = null;
    const active = peer;
    if (active === null) throw new Error('PeerConnection is unavailable');
    active.updateLocalConnectionEpoch(resumed.connectionEpoch);
    active.setIceConfiguration(
      resumed.rtcConfiguration,
      resumed.iceCredentialsExpiresAt,
    );
    await options.gateway.markReady(options.room.roomId);
    assertCurrentLifecycle(generation);
    if (peer !== active)
      throw new Error('PeerConnection changed during resume');
    localReady = true;
    maybeOffer();
    settleCallPhase();
    update({ error: null });
    return result;
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
    createTransport();
    const presentationBridge: PresentationFpsSampler = Object.freeze({
      sample: (timestampMs: number) =>
        presentationSampler?.sample(timestampMs) ?? null,
      reset: () => presentationSampler?.reset(),
    });
    statsMonitor = createStatsMonitor({
      buffer: statsBuffer,
      getNegotiationGeneration: () => negotiationGeneration,
      getOutboundStats: async () => {
        const active = peer;
        if (active === null) return new Map() as RTCStatsReport;
        const report = await active.getStats();
        if (closed || peer !== active) {
          throw new Error('PeerConnection changed during stats collection');
        }
        return directionalStats(report, 'outbound');
      },
      getInboundStats: async () => {
        const active = peer;
        if (active === null) return new Map() as RTCStatsReport;
        const report = await active.getStats();
        if (closed || peer !== active) {
          throw new Error('PeerConnection changed during stats collection');
        }
        return directionalStats(report, 'inbound');
      },
      getCaptureSettings: () => snapshot.screenCaptureSettings,
      getTargetBitrateBps: () =>
        snapshot.screenBitrateTarget.mode === 'fixed'
          ? snapshot.screenBitrateTarget.bitrateBps
          : null,
      presentationSampler: presentationBridge,
      ...(options.statsIntervalMs === undefined
        ? {}
        : { intervalMs: options.statsIntervalMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onSample: (sample) => update({ quality: sample }),
    });
    statsMonitor.start();
    reconnect = createReconnectController({
      role: callSession.role,
      cleanupShare: async () => {
        statsMonitor?.resetBaselines();
        await screenController?.handleSignalingClosed();
        syncScreenSnapshot();
      },
      resume: resumeSignaling,
      fullCleanup: async () => {
        try {
          await cleanupCall();
        } finally {
          options.gateway.closeLocalRoom(
            options.room.roomId,
            terminalCloseReason,
          );
        }
      },
      rebuildTransport: async () => {
        for (;;) {
          const reset = pendingReset;
          if (reset === null) {
            throw new Error('Negotiation reset context is unavailable');
          }
          await rebuildTransportForReset(reset.resetGeneration);
          if (
            pendingReset?.resetGeneration === reset.resetGeneration &&
            pendingReset.negotiationId === reset.negotiationId
          ) {
            return;
          }
        }
      },
      refreshIceServers: async () => {
        if (negotiation === null) throw new Error('Negotiation is unavailable');
        await negotiation.refreshIceServers();
      },
      waitForStable: waitForStableSignaling,
      prepareRecoveryCompletion: () =>
        waitForNextNegotiationReady({
          requireNewNegotiation: true,
          requireIceConnected: true,
        }),
      restartIce: async () => {
        if (negotiation === null) throw new Error('Negotiation is unavailable');
        await negotiation.restartCreatorIce();
      },
      requestRestart: async (requestId) => {
        if (negotiation === null) throw new Error('Negotiation is unavailable');
        await negotiation.requestCreatorRestart(requestId);
      },
      recoverFailedRestart: async (requestId) => {
        if (negotiation === null) throw new Error('Negotiation is unavailable');
        const reset = await negotiation.requestRecoveryReset(requestId);
        if (
          pendingReset !== null &&
          pendingReset.resetGeneration === reset.resetGeneration &&
          pendingReset.negotiationId !== reset.negotiationId
        ) {
          throw new Error('Recovery reset acknowledgement does not match');
        }
        pendingReset = Object.freeze(reset);
        negotiationEstablished = false;
        localReady = false;
        remoteReady = false;
        await rebuildTransportForReset(reset.resetGeneration);
      },
    });
    subscriptions.push(
      reconnect.subscribe(() => {
        const recovery = reconnect?.getSnapshot();
        if (recovery === undefined) return;
        if (recovery.state === 'failed') {
          fail(recovery.error ?? new Error('Recovery failed'));
        } else if (recovery.state === 'reconnecting-signal') {
          dispatchCall({ type: 'recover', reason: 'signal' });
        } else if (
          recovery.state === 'waiting-ice' ||
          recovery.state === 'restarting-ice'
        ) {
          dispatchCall({ type: 'recover', reason: 'ice' });
        } else if (recovery.state === 'rebuilding-transport') {
          dispatchCall({ type: 'recover', reason: 'transport' });
        } else if (recovery.state === 'connected') {
          settleCallPhase();
        }
      }),
      options.gateway.signaling.subscribe((event) => {
        if (event.payload.roomId !== options.room.roomId || closed) return;
        switch (event.type) {
          case 'peer.ready':
            remoteReady = true;
            if (negotiationEstablished) settleCallPhase();
            else dispatchCall({ type: 'negotiate' });
            maybeOffer();
            break;
          case 'webrtc.offer':
            {
              const activeNegotiation = negotiation;
              const activePeer = peer;
              if (activeNegotiation === null || activePeer === null) break;
              dispatchCall({ type: 'negotiate' });
              void activeNegotiation
                .handleOffer(event.payload)
                .then(async () => {
                  if (
                    closed ||
                    negotiation !== activeNegotiation ||
                    peer !== activePeer
                  ) {
                    return;
                  }
                  ensureScreenController();
                  const sender = activePeer.audioSender;
                  if (sender !== null && voice!.microphoneTrack !== null) {
                    await voice!.bindSender(sender, true);
                  }
                })
                .catch((error: unknown) => {
                  if (
                    !closed &&
                    negotiation === activeNegotiation &&
                    peer === activePeer
                  ) {
                    fail(error);
                  }
                });
            }
            break;
          case 'webrtc.iceRestart': {
            const activeNegotiation = negotiation;
            const activePeer = peer;
            if (activeNegotiation === null || activePeer === null) break;
            void (async () => {
              await activeNegotiation.refreshIceServers();
              if (
                closed ||
                negotiation !== activeNegotiation ||
                peer !== activePeer
              ) {
                return;
              }
              await activeNegotiation.handleOffer(event.payload);
              if (
                closed ||
                negotiation !== activeNegotiation ||
                peer !== activePeer
              ) {
                return;
              }
              ensureScreenController();
              const sender = activePeer.audioSender;
              if (sender !== null) await voice!.bindSender(sender, true);
            })().catch((error: unknown) => {
              if (
                !closed &&
                negotiation === activeNegotiation &&
                peer === activePeer
              ) {
                fail(error);
              }
            });
            break;
          }
          case 'webrtc.answer': {
            const activeNegotiation = negotiation;
            const activePeer = peer;
            if (activeNegotiation === null || activePeer === null) break;
            void activeNegotiation
              .handleAnswer(event.payload)
              .catch((error: unknown) => {
                if (
                  !closed &&
                  negotiation === activeNegotiation &&
                  peer === activePeer
                ) {
                  fail(error);
                }
              });
            break;
          }
          case 'webrtc.iceCandidate': {
            const activeNegotiation = negotiation;
            const activePeer = peer;
            if (activeNegotiation === null || activePeer === null) break;
            void activeNegotiation
              .handleRemoteCandidate(event.payload)
              .catch((error: unknown) => {
                if (
                  !closed &&
                  negotiation === activeNegotiation &&
                  peer === activePeer
                ) {
                  fail(error);
                }
              });
            break;
          }
          case 'webrtc.restartRequested':
            if (callSession.role === 'creator') {
              const queuedGeneration = recoveryQueueGeneration;
              const trigger = negotiationEstablished
                ? Promise.resolve()
                : waitForNextNegotiationReady();
              void trigger
                .then(() => {
                  if (
                    closed ||
                    queuedGeneration !== recoveryQueueGeneration ||
                    !negotiationEstablished
                  ) {
                    return;
                  }
                  return reconnect!.handleIceConnectionState('failed');
                })
                .catch(fail);
            }
            break;
          case 'webrtc.negotiationReset': {
            if (event.payload.resetGeneration < acceptedResetGeneration) {
              break;
            }
            if (
              event.payload.resetGeneration === acceptedResetGeneration &&
              negotiationEstablished
            ) {
              break;
            }
            const reset = Object.freeze({
              negotiationId: event.payload.negotiationId,
              resetGeneration: event.payload.resetGeneration,
              reason: event.payload.reason,
            });
            if (
              pendingReset !== null &&
              pendingReset.resetGeneration === reset.resetGeneration &&
              pendingReset.negotiationId !== reset.negotiationId
            ) {
              fail(new Error('Negotiation reset does not match resume'));
              break;
            }
            pendingReset = reset;
            invalidateRecoveryQueue();
            negotiationEstablished = false;
            localReady = false;
            remoteReady = false;
            if (reconnect?.getSnapshot().state === 'reconnecting-signal') {
              break;
            }
            const authoritativeReset = reconnect?.handleAuthoritativeReset();
            const delivery = resetDeliveryChain
              .catch(() => undefined)
              .then(async () => {
                if (reconnect === null) {
                  await rebuildTransportForReset(reset.resetGeneration);
                } else {
                  let rebuilt = await authoritativeReset!;
                  if (
                    rebuilt &&
                    rebuiltResetGeneration < reset.resetGeneration
                  ) {
                    rebuilt = await reconnect.handleAuthoritativeReset();
                  }
                  if (
                    !rebuilt ||
                    reconnect.getSnapshot().state !== 'connected'
                  ) {
                    return;
                  }
                }
                if (
                  closed ||
                  pendingReset?.resetGeneration !== reset.resetGeneration ||
                  pendingReset.negotiationId !== reset.negotiationId
                ) {
                  return;
                }
                await options.gateway.markReady(options.room.roomId);
                if (closed) return;
                localReady = true;
                maybeOffer();
              });
            resetDeliveryChain = delivery;
            void delivery.catch(fail);
            break;
          }
          case 'peer.left':
            remoteReady = false;
            dispatchCall({ type: 'peer-left', wasConnected: everConnected });
            break;
          case 'screen.ownerChanged': {
            const previousOwner = snapshot.screenOwner;
            const owner =
              event.payload.owner === null
                ? null
                : {
                    userId: event.payload.owner.userId,
                    displayName: event.payload.owner.displayName,
                  };
            update({
              screenOwner: owner,
              screenOwnerLeaseId: event.payload.leaseId,
              ...(owner === null || owner.userId === options.gateway.user.userId
                ? { remoteScreenBitrateBps: null }
                : {}),
            });
            const localScreenState = screenController?.getSnapshot().state;
            const localScreenActive =
              localScreenState === 'acquiring' ||
              localScreenState === 'picking' ||
              localScreenState === 'capturing' ||
              localScreenState === 'sharing';
            const localUserId = options.gateway.user.userId;
            if (owner !== null && owner.userId !== localUserId) {
              syncNegotiatedScreenReceiver();
            }
            const localLeaseId = screenController?.getSnapshot().leaseId;
            if (
              localScreenActive &&
              ((owner === null && previousOwner?.userId === localUserId) ||
                (owner !== null && owner.userId !== localUserId) ||
                (owner?.userId === localUserId &&
                  localLeaseId !== null &&
                  localLeaseId !== event.payload.leaseId))
            ) {
              void screenController?.handleLeaseLost();
            }
            break;
          }
          case 'screen.bitrate':
            if (
              snapshot.screenOwner !== null &&
              snapshot.screenOwner.userId !== options.gateway.user.userId &&
              snapshot.screenOwnerLeaseId === event.payload.leaseId
            ) {
              update({ remoteScreenBitrateBps: event.payload.bitrate });
            }
            break;
          case 'room.closed':
            void cleanupCall().catch(() => undefined);
            break;
          default:
            break;
        }
      }),
      options.gateway.signaling.subscribeErrors(fail),
      options.gateway.signaling.subscribeConnection((event) => {
        if (event.state === 'closed') {
          peer?.handleSignalingClose();
          localReady = false;
          terminalCloseReason =
            event.code === 4409 && event.reason === 'SESSION_REPLACED'
              ? 'session_replaced'
              : 'server_restart';
          void reconnect?.handleSignalingClose(event).catch(fail);
        }
      }),
    );
    remoteReady =
      options.gateway.getCallSession(options.room.roomId)?.peerReady ?? false;
    maybeOffer();
  };

  cleanupCall = createIdempotentCleanup([
    () => {
      dispatchCall({ type: 'close' });
      closed = true;
      lifecycleGeneration += 1;
      invalidateRecoveryQueue();
      reconnect?.stop();
      reconnect = null;
      negotiationSubscription?.();
      negotiationSubscription = null;
      negotiation?.dispose();
      statsMonitor?.stop();
      statsMonitor = null;
      presentationSampler = null;
      statsBuffer.reset();
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      screenSubscription?.();
      screenSubscription = null;
      listeners.clear();
    },
    () => screenController?.cleanup(),
    () => voice?.cleanup(),
    () => peer?.disposeTransport({ stopOwnedTracks: false }),
    () => {
      callMachine.dispatch({ type: 'closed' });
      snapshot = Object.freeze({
        ...snapshot,
        status: projectedCallStatus(callMachine.getSnapshot()),
      });
    },
  ]);
  const cleanup = (): Promise<void> => cleanupCall();

  const retryMicrophoneSwitch = (): Promise<void> => {
    const deviceId = pendingMicrophoneRetryDeviceId;
    if (deviceId === null) return startPromise ?? Promise.resolve();
    if (
      microphoneRetryFlight !== null &&
      microphoneRetryFlightDeviceId === deviceId &&
      microphoneRetryFlightGeneration === microphoneSwitchGeneration
    ) {
      return microphoneRetryFlight;
    }
    const generation = currentLifecycle();
    const switchGeneration = ++microphoneSwitchGeneration;
    dispatchCall(
      { type: 'retry', peerReady: remoteReady },
      { error: null, microphoneRetryAvailable: false },
    );
    const operation = (async () => {
      try {
        await voice!.switchMicrophone(deviceId);
        assertCurrentLifecycle(generation);
        if (switchGeneration !== microphoneSwitchGeneration) {
          throw Object.assign(new Error('Microphone switch was superseded'), {
            code: 'INVALID_STATE',
          });
        }
        pendingMicrophoneRetryDeviceId = null;
        update({
          selectedInputId: deviceId,
          error: null,
          microphoneRetryAvailable: false,
        });
        settleCallPhase();
      } catch (error) {
        if (
          !closed &&
          generation === lifecycleGeneration &&
          switchGeneration === microphoneSwitchGeneration
        ) {
          pendingMicrophoneRetryDeviceId = deviceId;
          dispatchCall(
            { type: 'fail' },
            {
              error: callErrorMessage(error),
              microphoneRetryAvailable: true,
            },
          );
        }
        throw error;
      }
    })();
    const flight = operation.finally(() => {
      if (microphoneRetryFlight === flight) microphoneRetryFlight = null;
    });
    microphoneRetryFlight = flight;
    microphoneRetryFlightDeviceId = deviceId;
    microphoneRetryFlightGeneration = switchGeneration;
    return flight;
  };

  const controller: CallController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (pendingMicrophoneRetryDeviceId !== null) {
        return retryMicrophoneSwitch();
      }
      if (startPromise !== null) return startPromise;
      if (closed) return Promise.reject(new Error('Call has been cleaned'));
      initialize();
      dispatchCall(
        { type: 'retry', peerReady: remoteReady },
        {
          error: null,
          microphoneRetryAvailable: false,
        },
      );
      startPromise = (async () => {
        const generation = lifecycleGeneration;
        try {
          if (!localReady) {
            assertCurrentLifecycle(generation);
            await options.gateway.markReady(options.room.roomId);
            assertCurrentLifecycle(generation);
            localReady = true;
            maybeOffer();
          }
          if (!microphoneAcquired) {
            const initialSender = peer!.audioSender;
            await voice!.start(initialSender ?? undefined);
            assertCurrentLifecycle(generation);
            microphoneAcquired = true;
            const currentSender = peer!.audioSender;
            if (initialSender === null && currentSender !== null) {
              await voice!.bindSender(currentSender);
              assertCurrentLifecycle(generation);
            }
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
      const generation = currentLifecycle();
      const switchGeneration = ++microphoneSwitchGeneration;
      pendingMicrophoneRetryDeviceId = null;
      try {
        await voice!.switchMicrophone(deviceId);
        assertCurrentLifecycle(generation);
        if (switchGeneration !== microphoneSwitchGeneration) {
          throw Object.assign(new Error('Microphone switch was superseded'), {
            code: 'INVALID_STATE',
          });
        }
        pendingMicrophoneRetryDeviceId = null;
        dispatchCall(
          { type: 'retry', peerReady: remoteReady },
          {
            selectedInputId: deviceId,
            error: null,
            microphoneRetryAvailable: false,
          },
        );
        settleCallPhase();
      } catch (error) {
        if (
          !closed &&
          generation === lifecycleGeneration &&
          switchGeneration === microphoneSwitchGeneration
        ) {
          pendingMicrophoneRetryDeviceId = deviceId;
          dispatchCall(
            { type: 'fail' },
            {
              error: callErrorMessage(error),
              microphoneRetryAvailable: true,
            },
          );
        }
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
    prepareScreenShare: async () => {
      const generation = currentLifecycle();
      if (
        snapshot.screenOwner !== null &&
        snapshot.screenOwner.userId !== options.gateway.user.userId
      ) {
        throw Object.assign(new Error('Screen sharing is already owned'), {
          code: 'SCREEN_SHARE_BUSY',
        });
      }
      let permission: ScreenPermissionSnapshot;
      try {
        permission = await options.gateway.desktop.capture.permission();
      } catch (error) {
        assertCurrentLifecycle(generation);
        update({ screenError: '无法检查屏幕录制权限，请重试' });
        throw error;
      }
      assertCurrentLifecycle(generation);
      update({ screenPermission: permission });
      if (
        permission.status === 'denied' ||
        permission.status === 'restricted'
      ) {
        const error = Object.assign(
          new Error('Screen capture is not allowed'),
          {
            code: 'SCREEN_PERMISSION_DENIED',
          },
        );
        update({ screenError: '需要在系统设置中允许屏幕录制' });
        throw error;
      }
      if (
        snapshot.screenOwner !== null &&
        snapshot.screenOwner.userId !== options.gateway.user.userId
      ) {
        throw Object.assign(new Error('Screen sharing is already owned'), {
          code: 'SCREEN_SHARE_BUSY',
        });
      }
      if (!initialized) initialize();
      const screen = ensureScreenController();
      if (screen === null) {
        throw Object.assign(new Error('Screen sender is unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      await screen.prepare();
    },
    selectScreenSource: async (token) => {
      currentLifecycle();
      const screen = ensureScreenController();
      if (screen === null) {
        throw Object.assign(new Error('Screen sender is unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      await screen.selectSource(token);
    },
    startScreenShare: async () => {
      const generation = currentLifecycle();
      const screen = ensureScreenController();
      if (screen === null) {
        throw Object.assign(new Error('Screen sender is unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      await screen.startSelectedCapture();
      assertCurrentLifecycle(generation);
      await replayBitrate();
    },
    stopScreenShare: () => screenController?.stop() ?? Promise.resolve(),
    setScreenBitrate: async (target) => {
      const generation = currentLifecycle();
      update({ screenBitratePending: target, screenBitrateError: null });
      try {
        const applied = await bitrateController.setTarget(target);
        assertCurrentLifecycle(generation);
        syncBitrateSnapshot(null);
        if (applied.target.mode !== 'fixed') return;
        const leaseId = screenController?.getSnapshot().leaseId;
        if (leaseId === null || leaseId === undefined) return;
        const response = await options.gateway.signaling.request(
          'screen.bitrate',
          {
            roomId: options.room.roomId,
            leaseId,
            bitrate: applied.target.bitrateBps,
          },
          screenBitrateAckSchema,
        );
        successfulData(response);
        assertCurrentLifecycle(generation);
      } catch (error) {
        syncBitrateSnapshot('目标码率设置失败，请重试');
        throw error;
      }
    },
    openScreenSettings: async () => {
      currentLifecycle();
      if (snapshot.screenPermission?.canOpenSettings !== true) {
        throw Object.assign(new Error('Screen settings are unavailable'), {
          code: 'INVALID_STATE',
        });
      }
      await options.gateway.desktop.capture.openSettings();
    },
    attachPresentationVideo: (video) => {
      presentationSampler =
        video === null ? null : createPresentationFpsSampler(video);
      statsMonitor?.resetBaselines();
    },
    exportDiagnostics: () => statsBuffer.exportSnapshot(),
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
    screenState: 'idle',
    screenSources: Object.freeze([]),
    screenSelectedToken: null,
    screenCaptureSettings: null,
    screenError: null,
    screenOwner: null,
    screenOwnerLeaseId: null,
    localScreenTrack: null,
    remoteScreenTrack: null,
    screenBitrateTarget: DEFAULT_SCREEN_BITRATE_TARGET,
    screenBitratePending: null,
    screenBitrateError: null,
    remoteScreenBitrateBps: null,
    screenPermission: null,
    quality: null,
  });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    start: async () => undefined,
    setMuted: () => undefined,
    switchMicrophone: async () => undefined,
    setOutputMuted: () => undefined,
    selectOutput: async () => undefined,
    prepareScreenShare: async () => {
      throw Object.assign(new Error('Screen sharing is unavailable'), {
        code: 'INVALID_STATE',
      });
    },
    selectScreenSource: async () => {
      throw Object.assign(new Error('Screen sharing is unavailable'), {
        code: 'INVALID_STATE',
      });
    },
    startScreenShare: async () => {
      throw Object.assign(new Error('Screen sharing is unavailable'), {
        code: 'INVALID_STATE',
      });
    },
    stopScreenShare: async () => undefined,
    setScreenBitrate: async () => {
      throw Object.assign(new Error('Screen sharing is unavailable'), {
        code: 'INVALID_STATE',
      });
    },
    openScreenSettings: async () => {
      throw Object.assign(new Error('Screen settings are unavailable'), {
        code: 'INVALID_STATE',
      });
    },
    attachPresentationVideo: () => undefined,
    exportDiagnostics: () => Object.freeze({ version: 1, samples: [] }),
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
