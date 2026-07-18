import {
  rtcConfigurationSchema,
  type IceCandidateInit,
  type RtcConfiguration,
} from '@wo/protocol';

import {
  configureJoinerTransceiverPlan,
  createCreatorTransceiverPlan,
  type CodecCapabilities,
  type TransceiverPlan,
} from './transceiver-plan.js';

export interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;
  addTransceiver(
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver;
  getTransceivers(): RTCRtpTransceiver[];
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  setConfiguration(configuration?: RTCConfiguration): void;
  restartIce(): void;
  getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport>;
  close(): void;
}

export interface PeerConnectionControllerOptions {
  readonly role: 'creator' | 'joiner';
  readonly rtcConfiguration: RtcConfiguration;
  readonly iceCredentialsExpiresAt: string;
  readonly connectionEpoch: number;
  readonly createPeerConnection?: (
    configuration: RTCConfiguration,
  ) => PeerConnectionLike;
  readonly onLocalCandidate: (
    candidate: IceCandidateInit,
    mediaGeneration: number,
  ) => void;
  readonly onRemoteTrack: (track: MediaStreamTrack) => void;
  readonly onConnectionStateChange?: (state: {
    readonly connectionState: RTCPeerConnectionState;
    readonly iceConnectionState: RTCIceConnectionState;
    readonly signalingState: RTCSignalingState;
  }) => void;
  readonly codecCapabilities?: CodecCapabilities;
}

export interface PeerConnectionController {
  readonly pc: PeerConnectionLike;
  readonly role: 'creator' | 'joiner';
  readonly transceivers: TransceiverPlan | null;
  readonly audioSender: RTCRtpSender | null;
  readonly screenSender: RTCRtpSender | null;
  readonly screenReceiver: RTCRtpReceiver | null;
  readonly connectionEpoch: number;
  readonly lastAcceptedRemoteConnectionEpoch: number | null;
  readonly currentNegotiationId: string | null;
  readonly mediaGeneration: number;
  readonly signalingGeneration: number;
  readonly iceCredentialsExpiresAt: string;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;
  beginNegotiation(negotiationId: string): number;
  configureJoinerTransceivers(
    microphone: MediaStreamTrack | null,
  ): Promise<TransceiverPlan>;
  setIceConfiguration(configuration: RtcConfiguration, expiresAt: string): void;
  acceptRemoteConnectionEpoch(epoch: number): boolean;
  updateLocalConnectionEpoch(epoch: number): void;
  isCurrentGeneration(generation: number): boolean;
  isCurrentSignalContext(
    mediaGeneration: number,
    signalingGeneration: number,
    connectionEpoch: number,
  ): boolean;
  handleSignalingClose(): void;
  restartIce(): void;
  getStats(): Promise<RTCStatsReport>;
  disposeTransport(options: { readonly stopOwnedTracks: false }): Promise<void>;
  cleanup(): Promise<void>;
}

const defaultPeerConnectionFactory = (
  configuration: RTCConfiguration,
): PeerConnectionLike => new RTCPeerConnection(configuration);

export function createPeerConnectionController(
  options: PeerConnectionControllerOptions,
): PeerConnectionController {
  const configuration = rtcConfigurationSchema.parse(options.rtcConfiguration);
  const pc = (options.createPeerConnection ?? defaultPeerConnectionFactory)(
    configuration,
  );
  let transceivers: TransceiverPlan | null =
    options.role === 'creator'
      ? createCreatorTransceiverPlan(
          pc as unknown as RTCPeerConnection,
          options.codecCapabilities,
        )
      : null;
  let connectionEpoch = options.connectionEpoch;
  let remoteConnectionEpoch: number | null = null;
  let currentNegotiationId: string | null = null;
  let mediaGeneration = 0;
  let signalingGeneration = 0;
  let iceCredentialsExpiresAt = options.iceCredentialsExpiresAt;
  let cleanupPromise: Promise<void> | null = null;

  const handleIceCandidate = (event: unknown): void => {
    if (
      typeof event !== 'object' ||
      event === null ||
      !('candidate' in event)
    ) {
      return;
    }
    const value = event.candidate;
    const candidate =
      value === null
        ? null
        : typeof value === 'object' &&
            value !== null &&
            'toJSON' in value &&
            typeof value.toJSON === 'function'
          ? value.toJSON()
          : null;
    options.onLocalCandidate(candidate as IceCandidateInit, mediaGeneration);
  };

  const handleTrack = (event: unknown): void => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'track' in event &&
      typeof event.track === 'object' &&
      event.track !== null
    ) {
      options.onRemoteTrack(event.track as MediaStreamTrack);
    }
  };

  const handleConnectionStateChange = (): void => {
    options.onConnectionStateChange?.({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState,
    });
  };

  pc.addEventListener('icecandidate', handleIceCandidate);
  pc.addEventListener('track', handleTrack);
  pc.addEventListener('connectionstatechange', handleConnectionStateChange);
  pc.addEventListener('iceconnectionstatechange', handleConnectionStateChange);

  const controller: PeerConnectionController = {
    pc,
    role: options.role,
    get transceivers() {
      return transceivers;
    },
    get audioSender() {
      return transceivers?.audio.sender ?? null;
    },
    get screenSender() {
      return transceivers?.screen.sender ?? null;
    },
    get screenReceiver() {
      return transceivers?.screen.receiver ?? null;
    },
    get connectionEpoch() {
      return connectionEpoch;
    },
    get lastAcceptedRemoteConnectionEpoch() {
      return remoteConnectionEpoch;
    },
    get currentNegotiationId() {
      return currentNegotiationId;
    },
    get mediaGeneration() {
      return mediaGeneration;
    },
    get signalingGeneration() {
      return signalingGeneration;
    },
    get iceCredentialsExpiresAt() {
      return iceCredentialsExpiresAt;
    },
    get connectionState() {
      return pc.connectionState;
    },
    get iceConnectionState() {
      return pc.iceConnectionState;
    },
    get signalingState() {
      return pc.signalingState;
    },
    beginNegotiation: (negotiationId) => {
      if (cleanupPromise !== null) throw new Error('PeerConnection is closed');
      currentNegotiationId = negotiationId;
      return mediaGeneration;
    },
    configureJoinerTransceivers: async (microphone) => {
      if (options.role !== 'joiner') {
        throw new Error('Only the joiner maps remote transceivers');
      }
      if (transceivers !== null) return transceivers;
      const generation = mediaGeneration;
      const result = await configureJoinerTransceiverPlan(
        pc as unknown as RTCPeerConnection,
        microphone,
        options.codecCapabilities,
      );
      if (generation !== mediaGeneration || cleanupPromise !== null) {
        await result.audio.sender.replaceTrack(null);
        throw new Error('PeerConnection generation changed');
      }
      transceivers = result;
      return result;
    },
    setIceConfiguration: (nextConfiguration, expiresAt) => {
      if (cleanupPromise !== null) throw new Error('PeerConnection is closed');
      const parsed = rtcConfigurationSchema.parse(nextConfiguration);
      pc.setConfiguration(parsed);
      iceCredentialsExpiresAt = expiresAt;
    },
    acceptRemoteConnectionEpoch: (epoch) => {
      if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
      if (remoteConnectionEpoch !== null && epoch < remoteConnectionEpoch) {
        return false;
      }
      remoteConnectionEpoch = epoch;
      return true;
    },
    updateLocalConnectionEpoch: (epoch) => {
      if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new TypeError('Invalid connection epoch');
      }
      if (epoch === connectionEpoch) return;
      connectionEpoch = epoch;
      signalingGeneration += 1;
    },
    isCurrentGeneration: (generation) =>
      cleanupPromise === null && generation === mediaGeneration,
    isCurrentSignalContext: (
      expectedMediaGeneration,
      expectedSignalingGeneration,
      expectedConnectionEpoch,
    ) =>
      cleanupPromise === null &&
      expectedMediaGeneration === mediaGeneration &&
      expectedSignalingGeneration === signalingGeneration &&
      expectedConnectionEpoch === connectionEpoch,
    handleSignalingClose: () => {
      // Signaling recovery is separate from media lifetime. Task 14 decides resume.
      signalingGeneration += 1;
    },
    restartIce: () => pc.restartIce(),
    getStats: () => pc.getStats(),
    disposeTransport: () => {
      if (cleanupPromise !== null) return cleanupPromise;
      mediaGeneration += 1;
      signalingGeneration += 1;
      currentNegotiationId = null;
      pc.removeEventListener('icecandidate', handleIceCandidate);
      pc.removeEventListener('track', handleTrack);
      pc.removeEventListener(
        'connectionstatechange',
        handleConnectionStateChange,
      );
      pc.removeEventListener(
        'iceconnectionstatechange',
        handleConnectionStateChange,
      );
      cleanupPromise = Promise.resolve().then(() => {
        pc.close();
      });
      return cleanupPromise;
    },
    cleanup: () => controller.disposeTransport({ stopOwnedTracks: false }),
  };
  return Object.freeze(controller);
}
