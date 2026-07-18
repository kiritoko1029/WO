import {
  PROTOCOL_VERSION,
  iceCandidateInitSchema,
  webrtcAnswerAckSchema,
  webrtcAnswerAppliedAckSchema,
  webrtcAnswerAppliedRequestSchema,
  webrtcAnswerPayloadSchema,
  webrtcIceCandidateAckSchema,
  webrtcIceCandidatePayloadSchema,
  webrtcIceRestartAckSchema,
  webrtcIceServersRefreshAckSchema,
  webrtcOfferAckSchema,
  webrtcOfferPayloadSchema,
  webrtcRestartRequestedAckSchema,
  webrtcRecoveryResetAckSchema,
  type IceCandidateInit,
  type P2pRequestEnvelope,
  type WebrtcIceServersRefreshAck,
  type WebrtcRecoveryResetAck,
} from '@wo/protocol';

import type { PeerConnectionController } from './peer-connection-controller.js';
import type {
  RuntimeSchema,
  SignalingRequestOptions,
} from './signaling-client.js';

interface NegotiatingPeerConnection {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
}

export interface NegotiationSignaling {
  request<Response>(
    type: P2pRequestEnvelope['type'],
    payload: unknown,
    responseSchema: RuntimeSchema<Response>,
    options?: SignalingRequestOptions,
  ): Promise<Response>;
  requestEnvelope<Response>(
    envelope: P2pRequestEnvelope,
    responseSchema: RuntimeSchema<Response>,
  ): Promise<Response>;
}

export interface NegotiationControllerOptions {
  readonly peer: PeerConnectionController;
  readonly signaling: NegotiationSignaling;
  readonly roomId: string;
  readonly microphone: () => MediaStreamTrack | null;
  readonly now?: () => number;
  readonly makeNegotiationId?: () => string;
  readonly makeRequestId?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface NegotiationController {
  startCreatorOffer(negotiationId?: string): Promise<void>;
  refreshIceServers(): Promise<void>;
  restartCreatorIce(negotiationId?: string): Promise<void>;
  requestCreatorRestart(requestId: string): Promise<void>;
  requestRecoveryReset(requestId: string): Promise<RecoveryResetResult>;
  handleOffer(payload: unknown): Promise<void>;
  handleAnswer(payload: unknown): Promise<void>;
  handleRemoteCandidate(payload: unknown): Promise<void>;
  handleLocalCandidate(
    candidate: RTCIceCandidateInit | null,
    mediaGeneration: number,
  ): void;
  subscribeNegotiationReady(listener: () => void): () => void;
  reset(): void;
  dispose(): void;
}

export interface RecoveryResetResult {
  readonly negotiationId: string;
  readonly resetGeneration: number;
  readonly reason: 'peer_resumed' | 'signaling_reset';
}

interface SignalGuard {
  readonly mediaGeneration: number;
  readonly signalingGeneration: number;
  readonly connectionEpoch: number;
  readonly negotiationId: string;
  readonly controllerGeneration: number;
}

interface LocalCandidateState extends SignalGuard {
  ready: boolean;
  readonly candidates: IceCandidateInit[];
  readonly ufrags: Set<string>;
  chain: Promise<void>;
}

const ICE_REFRESH_MARGIN_MS = 120_000;
const MAX_REMOTE_CANDIDATE_CONTEXTS = 8;
const MAX_CANDIDATES_PER_CONTEXT = 256;

const defaultId = (): string => crypto.randomUUID();

function remoteKey(negotiationId: string, connectionEpoch: number): string {
  return JSON.stringify([negotiationId, connectionEpoch]);
}

function signalingErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

function assertSuccessfulAck(response: unknown): void {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('payload' in response) ||
    typeof response.payload !== 'object' ||
    response.payload === null ||
    !('ok' in response.payload)
  ) {
    throw new Error('Invalid signaling acknowledgement');
  }
  if (response.payload.ok !== true) {
    const code =
      'error' in response.payload &&
      typeof response.payload.error === 'object' &&
      response.payload.error !== null &&
      'code' in response.payload.error &&
      typeof response.payload.error.code === 'string'
        ? response.payload.error.code
        : 'SIGNALING_REJECTED';
    throw Object.assign(new Error(code), { code });
  }
}

export function createNegotiationController(
  options: NegotiationControllerOptions,
): NegotiationController {
  const now = options.now ?? Date.now;
  const makeNegotiationId = options.makeNegotiationId ?? defaultId;
  const makeRequestId = options.makeRequestId ?? defaultId;
  const pc = options.peer.pc as unknown as NegotiatingPeerConnection;
  const remoteCandidates = new Map<string, IceCandidateInit[]>();
  const remoteDescriptions = new Set<string>();
  const readyListeners = new Set<() => void>();
  let remoteCandidateChain = Promise.resolve();
  let activeRemoteKey: string | null = null;
  let localState: LocalCandidateState | null = null;
  const localStateByUfrag = new Map<string, LocalCandidateState>();
  let creatorOffer: {
    readonly contextKey: string;
    readonly promise: Promise<void>;
  } | null = null;
  let creatorRestart: {
    readonly contextKey: string;
    readonly promise: Promise<void>;
  } | null = null;
  const offerOperations = new Map<string, Promise<void>>();
  const answerOperations = new Map<string, Promise<void>>();
  let controllerGeneration = 0;
  let disposed = false;

  const current = (guard: SignalGuard): boolean =>
    !disposed &&
    guard.controllerGeneration === controllerGeneration &&
    options.peer.currentNegotiationId === guard.negotiationId &&
    options.peer.isCurrentSignalContext(
      guard.mediaGeneration,
      guard.signalingGeneration,
      guard.connectionEpoch,
    );

  const guardFor = (negotiationId: string): SignalGuard => ({
    mediaGeneration: options.peer.mediaGeneration,
    signalingGeneration: options.peer.signalingGeneration,
    connectionEpoch: options.peer.connectionEpoch,
    negotiationId,
    controllerGeneration,
  });

  const beginLocalCandidates = (guard: SignalGuard): LocalCandidateState => {
    const state: LocalCandidateState = {
      ...guard,
      ready: false,
      candidates: [],
      ufrags: new Set(),
      chain: Promise.resolve(),
    };
    localState = state;
    return state;
  };

  const bindLocalDescription = (
    state: LocalCandidateState,
    description: RTCSessionDescriptionInit,
  ): void => {
    const matches = description.sdp?.matchAll(/^a=ice-ufrag:([^\s]+)$/gmu);
    if (matches === undefined) return;
    for (const match of matches) {
      const ufrag = match[1];
      if (ufrag === undefined || ufrag.length === 0) continue;
      state.ufrags.add(ufrag);
      localStateByUfrag.set(ufrag, state);
    }
    while (localStateByUfrag.size > MAX_REMOTE_CANDIDATE_CONTEXTS * 2) {
      localStateByUfrag.delete(localStateByUfrag.keys().next().value!);
    }
  };

  const flushLocalCandidates = (state: LocalCandidateState): Promise<void> => {
    state.chain = state.chain
      .catch(() => undefined)
      .then(async () => {
        while (state.ready && state.candidates.length > 0 && current(state)) {
          const candidate = state.candidates[0]!;
          const response = await options.signaling.request(
            'webrtc.iceCandidate',
            {
              roomId: options.roomId,
              negotiationId: state.negotiationId,
              connectionEpoch: state.connectionEpoch,
              candidate,
            },
            webrtcIceCandidateAckSchema,
            { requestId: makeRequestId(), retryTimeouts: 1 },
          );
          assertSuccessfulAck(response);
          state.candidates.shift();
        }
      });
    return state.chain;
  };

  const flushRemoteCandidates = (
    negotiationId: string,
    connectionEpoch: number,
  ): Promise<void> => {
    const key = remoteKey(negotiationId, connectionEpoch);
    remoteCandidateChain = remoteCandidateChain
      .catch(() => undefined)
      .then(async () => {
        const queue = remoteCandidates.get(key);
        while (
          activeRemoteKey === key &&
          remoteDescriptions.has(key) &&
          queue !== undefined &&
          queue.length > 0
        ) {
          await pc.addIceCandidate(queue[0] ?? null);
          queue.shift();
        }
        if (queue?.length === 0) remoteCandidates.delete(key);
      });
    return remoteCandidateChain;
  };

  const activateRemoteContext = (key: string): void => {
    activeRemoteKey = key;
    remoteDescriptions.clear();
    for (const queuedKey of [...remoteCandidates.keys()]) {
      if (queuedKey !== key) remoteCandidates.delete(queuedKey);
    }
  };

  const resetRemoteContext = (): void => {
    activeRemoteKey = null;
    remoteDescriptions.clear();
    remoteCandidates.clear();
  };

  const clearNegotiationState = (): void => {
    controllerGeneration += 1;
    creatorOffer = null;
    creatorRestart = null;
    offerOperations.clear();
    answerOperations.clear();
    localState = null;
    localStateByUfrag.clear();
    resetRemoteContext();
    remoteCandidateChain = Promise.resolve();
  };

  const refreshIceServers = async (guard: SignalGuard): Promise<void> => {
    const response =
      await options.signaling.request<WebrtcIceServersRefreshAck>(
        'webrtc.iceServers.refresh',
        {
          roomId: options.roomId,
          negotiationId: guard.negotiationId,
          connectionEpoch: guard.connectionEpoch,
        },
        webrtcIceServersRefreshAckSchema,
        undefined,
      );
    assertSuccessfulAck(response);
    if (!current(guard) || response.payload.ok !== true) return;
    options.peer.setIceConfiguration(
      response.payload.data.rtcConfiguration,
      response.payload.data.iceCredentialsExpiresAt,
    );
  };

  const ensureFreshIce = async (guard: SignalGuard): Promise<void> => {
    const expiresAt = Date.parse(options.peer.iceCredentialsExpiresAt);
    if (
      Number.isFinite(expiresAt) &&
      expiresAt - now() >= ICE_REFRESH_MARGIN_MS
    ) {
      return;
    }
    await refreshIceServers(guard);
  };

  const createAndSendCreatorOffer = async (
    negotiationId: string,
    type: 'webrtc.offer' | 'webrtc.iceRestart',
  ): Promise<void> => {
    resetRemoteContext();
    if (type === 'webrtc.iceRestart') options.peer.restartIce();
    options.peer.beginNegotiation(negotiationId);
    const guard = guardFor(negotiationId);
    const candidates = beginLocalCandidates(guard);
    if (type === 'webrtc.offer') await ensureFreshIce(guard);
    if (!current(guard)) return;
    const description = await pc.createOffer();
    if (!current(guard)) return;
    bindLocalDescription(candidates, description);
    await pc.setLocalDescription(description);
    if (!current(guard)) return;
    const payload = {
      roomId: options.roomId,
      negotiationId,
      connectionEpoch: guard.connectionEpoch,
      description,
    };
    const response =
      type === 'webrtc.offer'
        ? await options.signaling.request(type, payload, webrtcOfferAckSchema, {
            requestId: makeRequestId(),
            retryTimeouts: 1,
          })
        : await options.signaling.request(
            type,
            payload,
            webrtcIceRestartAckSchema,
            { requestId: makeRequestId(), retryTimeouts: 1 },
          );
    assertSuccessfulAck(response);
    if (!current(guard)) return;
    candidates.ready = true;
    await flushLocalCandidates(candidates);
  };

  const markNegotiationReady = (): void => {
    for (const listener of readyListeners) {
      try {
        listener();
      } catch {
        // Observers cannot roll back an already completed negotiation.
      }
    }
  };

  const controller: NegotiationController = {
    startCreatorOffer: async (requestedNegotiationId) => {
      if (disposed) throw new Error('Negotiation controller is disposed');
      if (options.peer.role !== 'creator') {
        throw new Error('Only the creator may create an offer');
      }
      const contextKey = JSON.stringify([
        options.peer.mediaGeneration,
        options.peer.signalingGeneration,
        options.peer.connectionEpoch,
        requestedNegotiationId ?? null,
      ]);
      if (creatorOffer?.contextKey === contextKey) {
        return creatorOffer.promise;
      }
      const operation = createAndSendCreatorOffer(
        requestedNegotiationId ?? makeNegotiationId(),
        'webrtc.offer',
      );
      creatorOffer = { contextKey, promise: operation };
      void operation.catch(() => {
        if (creatorOffer?.promise === operation) creatorOffer = null;
      });
      return operation;
    },
    refreshIceServers: async () => {
      if (disposed) throw new Error('Negotiation controller is disposed');
      const negotiationId = options.peer.currentNegotiationId;
      if (negotiationId === null) {
        throw new Error('No active negotiation is available for ICE refresh');
      }
      await refreshIceServers(guardFor(negotiationId));
    },
    restartCreatorIce: async (requestedNegotiationId) => {
      if (disposed) throw new Error('Negotiation controller is disposed');
      if (options.peer.role !== 'creator') {
        throw new Error('Only the creator may restart ICE');
      }
      const negotiationId = requestedNegotiationId ?? makeNegotiationId();
      const contextKey = JSON.stringify([
        options.peer.mediaGeneration,
        options.peer.signalingGeneration,
        options.peer.connectionEpoch,
        negotiationId,
      ]);
      if (creatorRestart?.contextKey === contextKey) {
        return creatorRestart.promise;
      }
      const operation = createAndSendCreatorOffer(
        negotiationId,
        'webrtc.iceRestart',
      );
      creatorRestart = { contextKey, promise: operation };
      void operation.catch(() => {
        if (creatorRestart?.promise === operation) creatorRestart = null;
      });
      return operation;
    },
    requestCreatorRestart: async (requestId) => {
      if (disposed) throw new Error('Negotiation controller is disposed');
      if (options.peer.role !== 'joiner') {
        throw new Error('Only the joiner may request an ICE restart');
      }
      const negotiationId = options.peer.currentNegotiationId;
      if (negotiationId === null) {
        throw new Error('No active negotiation is available for ICE restart');
      }
      const response = await options.signaling.request(
        'webrtc.restartRequested',
        {
          roomId: options.roomId,
          negotiationId,
          connectionEpoch: options.peer.connectionEpoch,
        },
        webrtcRestartRequestedAckSchema,
        { requestId, retryTimeouts: 1 },
      );
      assertSuccessfulAck(response);
    },
    requestRecoveryReset: async (requestId) => {
      if (disposed) throw new Error('Negotiation controller is disposed');
      const negotiationId = options.peer.currentNegotiationId;
      if (negotiationId === null) {
        throw new Error('No active negotiation is available for recovery');
      }
      const response = await options.signaling.request<WebrtcRecoveryResetAck>(
        'webrtc.recoveryReset',
        {
          roomId: options.roomId,
          negotiationId,
          connectionEpoch: options.peer.connectionEpoch,
        },
        webrtcRecoveryResetAckSchema,
        { requestId, retryTimeouts: 1 },
      );
      assertSuccessfulAck(response);
      if (!response.payload.ok) {
        throw new Error('Recovery reset was rejected');
      }
      return Object.freeze({ ...response.payload.data });
    },
    handleOffer: async (input) => {
      if (disposed) return;
      if (options.peer.role !== 'joiner') return;
      const payload = webrtcOfferPayloadSchema.parse(input);
      const operationKey = remoteKey(
        payload.negotiationId,
        payload.connectionEpoch,
      );
      const existing = offerOperations.get(operationKey);
      if (existing !== undefined) return existing;
      const operation = (async () => {
        if (
          payload.roomId !== options.roomId ||
          !options.peer.acceptRemoteConnectionEpoch(payload.connectionEpoch)
        ) {
          return;
        }
        options.peer.beginNegotiation(payload.negotiationId);
        activateRemoteContext(operationKey);
        const guard = guardFor(payload.negotiationId);
        const candidates = beginLocalCandidates(guard);
        await pc.setRemoteDescription(payload.description);
        if (!current(guard)) return;
        remoteDescriptions.add(operationKey);
        await flushRemoteCandidates(
          payload.negotiationId,
          payload.connectionEpoch,
        );
        if (!current(guard)) return;
        await options.peer.configureJoinerTransceivers(options.microphone());
        if (!current(guard)) return;
        const description = await pc.createAnswer();
        if (!current(guard)) return;
        bindLocalDescription(candidates, description);
        await pc.setLocalDescription(description);
        if (!current(guard)) return;
        const response = await options.signaling.request(
          'webrtc.answer',
          {
            roomId: options.roomId,
            negotiationId: payload.negotiationId,
            connectionEpoch: guard.connectionEpoch,
            description,
          },
          webrtcAnswerAckSchema,
          undefined,
        );
        assertSuccessfulAck(response);
        if (!current(guard)) return;
        candidates.ready = true;
        await flushLocalCandidates(candidates);
        if (current(guard)) markNegotiationReady();
      })();
      offerOperations.set(operationKey, operation);
      if (offerOperations.size > MAX_REMOTE_CANDIDATE_CONTEXTS) {
        offerOperations.delete(offerOperations.keys().next().value!);
      }
      return operation;
    },
    handleAnswer: async (input) => {
      if (disposed) return;
      if (options.peer.role !== 'creator') return;
      const payload = webrtcAnswerPayloadSchema.parse(input);
      const operationKey = remoteKey(
        payload.negotiationId,
        payload.connectionEpoch,
      );
      const existing = answerOperations.get(operationKey);
      if (existing !== undefined) return existing;
      const operation = (async () => {
        if (
          payload.roomId !== options.roomId ||
          payload.negotiationId !== options.peer.currentNegotiationId ||
          !options.peer.acceptRemoteConnectionEpoch(payload.connectionEpoch)
        ) {
          return;
        }
        const guard = guardFor(payload.negotiationId);
        activateRemoteContext(operationKey);
        await pc.setRemoteDescription(payload.description);
        if (!current(guard)) return;
        remoteDescriptions.add(operationKey);
        await flushRemoteCandidates(
          payload.negotiationId,
          payload.connectionEpoch,
        );
        if (!current(guard)) return;
        const envelope = webrtcAnswerAppliedRequestSchema.parse({
          version: PROTOCOL_VERSION,
          requestId: makeRequestId(),
          type: 'webrtc.answerApplied',
          payload: {
            roomId: options.roomId,
            negotiationId: payload.negotiationId,
            connectionEpoch: guard.connectionEpoch,
          },
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!current(guard)) return;
          try {
            const response = await options.signaling.requestEnvelope(
              envelope,
              webrtcAnswerAppliedAckSchema,
            );
            if (!current(guard)) return;
            assertSuccessfulAck(response);
            markNegotiationReady();
            return;
          } catch (error) {
            if (
              attempt === 1 ||
              signalingErrorCode(error) !== 'SIGNALING_TIMEOUT' ||
              !current(guard)
            ) {
              throw error;
            }
          }
        }
      })();
      answerOperations.set(operationKey, operation);
      if (answerOperations.size > MAX_REMOTE_CANDIDATE_CONTEXTS) {
        answerOperations.delete(answerOperations.keys().next().value!);
      }
      return operation;
    },
    handleRemoteCandidate: async (input) => {
      if (disposed) return;
      const payload = webrtcIceCandidatePayloadSchema.parse(input);
      if (payload.roomId !== options.roomId) return;
      const lastRemoteEpoch = options.peer.lastAcceptedRemoteConnectionEpoch;
      if (
        lastRemoteEpoch !== null &&
        payload.connectionEpoch < lastRemoteEpoch
      ) {
        return;
      }
      const key = remoteKey(payload.negotiationId, payload.connectionEpoch);
      if (activeRemoteKey !== null && activeRemoteKey !== key) return;
      let queue = remoteCandidates.get(key);
      if (queue === undefined) {
        if (remoteCandidates.size >= MAX_REMOTE_CANDIDATE_CONTEXTS) {
          throw new Error('remote candidate context limit exceeded');
        }
        queue = [];
      }
      if (queue.length >= MAX_CANDIDATES_PER_CONTEXT) {
        throw new Error('Remote candidate queue limit exceeded');
      }
      queue.push(payload.candidate);
      remoteCandidates.set(key, queue);
      if (remoteDescriptions.has(key)) {
        await flushRemoteCandidates(
          payload.negotiationId,
          payload.connectionEpoch,
        );
      }
    },
    handleLocalCandidate: (candidateInput, mediaGeneration) => {
      const candidate = iceCandidateInitSchema.parse(candidateInput);
      const state =
        candidate?.usernameFragment === undefined ||
        candidate.usernameFragment === null
          ? localStateByUfrag.size <= 1
            ? localState
            : null
          : (localStateByUfrag.get(candidate.usernameFragment) ??
            (localState?.ufrags.size === 0 ? localState : null));
      if (
        state === null ||
        mediaGeneration !== state.mediaGeneration ||
        !current(state)
      ) {
        return;
      }
      if (state.candidates.length >= MAX_CANDIDATES_PER_CONTEXT) {
        options.onError?.(new Error('Local candidate queue limit exceeded'));
        return;
      }
      state.candidates.push(candidate);
      if (state.ready) {
        void flushLocalCandidates(state).catch(
          options.onError ?? (() => undefined),
        );
      }
    },
    subscribeNegotiationReady: (listener) => {
      if (disposed) return () => undefined;
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    reset: clearNegotiationState,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearNegotiationState();
      readyListeners.clear();
    },
  };
  return Object.freeze(controller);
}
