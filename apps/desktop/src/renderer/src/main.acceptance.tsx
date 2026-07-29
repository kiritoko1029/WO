interface AcceptanceBridge {
  readonly iceTransportPolicy: 'all' | 'relay';
  audioWav(): Promise<ArrayBuffer>;
  report(snapshot: unknown): void;
  snapshot(): Promise<unknown>;
}

export {};

interface MutablePeerDiagnostic {
  readonly id: number;
  offers: number;
  answers: number;
  restartIceCalls: number;
  holdDisconnectedIceEvents: boolean;
  heldDisconnectedIceEvents: number;
  closed: boolean;
  connectionState: RTCPeerConnectionState;
  connectionStateHistory: RTCPeerConnectionState[];
  iceConnectionState: RTCIceConnectionState;
  iceConnectionStateHistory: RTCIceConnectionState[];
  signalingState: RTCSignalingState;
  transceivers: number;
  liveRemoteAudioTracks: number;
  liveRemoteVideoTracks: number;
  packetsSentAudio: number;
  packetsReceivedAudio: number;
  bytesSentAudio: number;
  bytesReceivedAudio: number;
  inboundAudioEnergy: number;
  localAudioEnergy: number;
  maximumAudioLevel: number;
  framesSentVideo: number;
  framesReceivedVideo: number;
  bytesSentVideo: number;
  bytesReceivedVideo: number;
  localIceType: string;
  remoteIceType: string;
  screenMaxBitrate: number;
  screenWidth: number;
  screenHeight: number;
  screenFrameRate: number;
}

interface SocketDiagnostic {
  readonly id: number;
  state: number;
  opens: number;
  closes: number;
}

declare global {
  interface Window {
    readonly woAcceptance: AcceptanceBridge;
    readonly woAcceptanceControl: Readonly<{
      denyNextMicrophoneCapture(): number;
      dropSignaling(): number;
      holdDisconnectedIceEvents(): number;
      pauseSignaling(): number;
      resetRnnoiseCallbackGap(): number;
      resumeSignaling(): number;
      stopLocalMicrophoneTrack(): number;
      stopLocalScreenTrack(): number;
      stopLocalSystemAudioTrack(): number;
    }>;
  }
}

const peerDiagnostics = new Map<RTCPeerConnection, MutablePeerDiagnostic>();
const NativePeerConnection = window.RTCPeerConnection;
const signalingSockets = new Map<WebSocket, SocketDiagnostic>();
let peerSequence = 0;
let socketSequence = 0;
let reportSequence = 0;
let signalingDrops = 0;
let signalingPaused = false;
let blockedSignalingAttempts = 0;
let microphoneDenials = 0;
const callStatusHistory: string[] = [];
const liveMicrophoneTracks = new Set<MediaStreamTrack>();
const liveSystemAudioTracks = new Set<MediaStreamTrack>();
const captureDiagnostic = {
  attempts: 0,
  successes: 0,
  lastName: '',
  tracks: 0,
  videoTracks: 0,
  audioTracks: 0,
  width: 0,
  height: 0,
  frameRate: 0,
};
const rnnoiseDiagnostic = {
  processorCreations: 0,
  processedFrames: 0,
  audioProcessCallbacks: 0,
  maxCallbackGapMs: 0,
  lastCallbackAtMs: 0,
};

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statsRecords(
  report: RTCStatsReport,
): readonly Record<string, unknown>[] {
  return [...report.values()].filter(
    (value): value is RTCStats & Record<string, unknown> =>
      typeof value === 'object' && value !== null,
  );
}

function selectedCandidateTypes(records: readonly Record<string, unknown>[]): {
  readonly local: string;
  readonly remote: string;
} {
  const transport = records.find(
    (record) =>
      record.type === 'transport' &&
      typeof record.selectedCandidatePairId === 'string',
  );
  const pair =
    records.find(
      (record) => record.id === transport?.selectedCandidatePairId,
    ) ??
    records.find(
      (record) =>
        record.type === 'candidate-pair' &&
        record.state === 'succeeded' &&
        (record.selected === true || record.nominated === true),
    );
  const local = records.find((record) => record.id === pair?.localCandidateId);
  const remote = records.find(
    (record) => record.id === pair?.remoteCandidateId,
  );
  return {
    local: textValue(local?.candidateType),
    remote: textValue(remote?.candidateType),
  };
}

function appendState<State extends string>(
  history: State[],
  state: State,
): void {
  if (history.at(-1) === state) return;
  history.push(state);
  if (history.length > 32) history.shift();
}

function recordCallStatus(): string {
  const indicator = document.querySelector('.connection-dot');
  const status =
    [
      'waiting',
      'connecting',
      'connected',
      'relay',
      'reconnecting',
      'error',
    ].find((candidate) => indicator?.classList.contains(candidate)) ?? '';
  if (status.length > 0) appendState(callStatusHistory, status);
  return status;
}

async function samplePeer(
  peer: RTCPeerConnection,
  diagnostic: MutablePeerDiagnostic,
): Promise<void> {
  diagnostic.connectionState = peer.connectionState;
  diagnostic.iceConnectionState = peer.iceConnectionState;
  diagnostic.signalingState = peer.signalingState;
  diagnostic.transceivers = peer.getTransceivers().length;
  const receivers = peer.getReceivers();
  diagnostic.liveRemoteAudioTracks = receivers.filter(
    ({ track }) =>
      track.kind === 'audio' &&
      track.readyState === 'live' &&
      track.enabled &&
      !track.muted,
  ).length;
  diagnostic.liveRemoteVideoTracks = receivers.filter(
    ({ track }) => track.kind === 'video' && track.readyState === 'live',
  ).length;

  const screenSender = peer
    .getSenders()
    .find(({ track }) => track?.kind === 'video');
  const settings = screenSender?.track?.getSettings();
  diagnostic.screenWidth = numberValue(settings?.width);
  diagnostic.screenHeight = numberValue(settings?.height);
  diagnostic.screenFrameRate = numberValue(settings?.frameRate);
  diagnostic.screenMaxBitrate = Math.max(
    0,
    ...(screenSender?.getParameters().encodings ?? []).map((encoding) =>
      numberValue(encoding.maxBitrate),
    ),
  );

  if (diagnostic.closed) return;
  let report: RTCStatsReport;
  try {
    report = await peer.getStats();
  } catch {
    return;
  }
  const records = statsRecords(report);
  diagnostic.packetsSentAudio = 0;
  diagnostic.packetsReceivedAudio = 0;
  diagnostic.bytesSentAudio = 0;
  diagnostic.bytesReceivedAudio = 0;
  diagnostic.inboundAudioEnergy = 0;
  diagnostic.localAudioEnergy = 0;
  diagnostic.maximumAudioLevel = 0;
  diagnostic.framesSentVideo = 0;
  diagnostic.framesReceivedVideo = 0;
  diagnostic.bytesSentVideo = 0;
  diagnostic.bytesReceivedVideo = 0;
  for (const record of records) {
    const kind = record.kind ?? record.mediaType;
    diagnostic.maximumAudioLevel = Math.max(
      diagnostic.maximumAudioLevel,
      kind === 'audio' ? numberValue(record.audioLevel) : 0,
    );
    if (record.type === 'outbound-rtp' && kind === 'audio') {
      diagnostic.packetsSentAudio += numberValue(record.packetsSent);
      diagnostic.bytesSentAudio += numberValue(record.bytesSent);
    } else if (record.type === 'inbound-rtp' && kind === 'audio') {
      diagnostic.packetsReceivedAudio += numberValue(record.packetsReceived);
      diagnostic.bytesReceivedAudio += numberValue(record.bytesReceived);
      diagnostic.inboundAudioEnergy += numberValue(record.totalAudioEnergy);
    } else if (record.type === 'media-source' && kind === 'audio') {
      diagnostic.localAudioEnergy += numberValue(record.totalAudioEnergy);
    } else if (record.type === 'outbound-rtp' && kind === 'video') {
      diagnostic.framesSentVideo += numberValue(
        record.framesSent ?? record.framesEncoded,
      );
      diagnostic.bytesSentVideo += numberValue(record.bytesSent);
    } else if (record.type === 'inbound-rtp' && kind === 'video') {
      diagnostic.framesReceivedVideo += numberValue(
        record.framesReceived ?? record.framesDecoded,
      );
      diagnostic.bytesReceivedVideo += numberValue(record.bytesReceived);
    }
  }
  const candidates = selectedCandidateTypes(records);
  diagnostic.localIceType = candidates.local;
  diagnostic.remoteIceType = candidates.remote;
}

function installPeerConnectionProbe(): void {
  const AcceptancePeerConnection = function (
    configuration?: RTCConfiguration,
  ): RTCPeerConnection {
    const effectiveConfiguration = {
      ...configuration,
      iceTransportPolicy: window.woAcceptance.iceTransportPolicy,
    };
    const peer = new NativePeerConnection(effectiveConfiguration);
    const diagnostic: MutablePeerDiagnostic = {
      id: ++peerSequence,
      offers: 0,
      answers: 0,
      restartIceCalls: 0,
      holdDisconnectedIceEvents: false,
      heldDisconnectedIceEvents: 0,
      closed: false,
      connectionState: peer.connectionState,
      connectionStateHistory: [peer.connectionState],
      iceConnectionState: peer.iceConnectionState,
      iceConnectionStateHistory: [peer.iceConnectionState],
      signalingState: peer.signalingState,
      transceivers: 0,
      liveRemoteAudioTracks: 0,
      liveRemoteVideoTracks: 0,
      packetsSentAudio: 0,
      packetsReceivedAudio: 0,
      bytesSentAudio: 0,
      bytesReceivedAudio: 0,
      inboundAudioEnergy: 0,
      localAudioEnergy: 0,
      maximumAudioLevel: 0,
      framesSentVideo: 0,
      framesReceivedVideo: 0,
      bytesSentVideo: 0,
      bytesReceivedVideo: 0,
      localIceType: '',
      remoteIceType: '',
      screenMaxBitrate: 0,
      screenWidth: 0,
      screenHeight: 0,
      screenFrameRate: 0,
    };
    peerDiagnostics.set(peer, diagnostic);
    const setConfiguration = peer.setConfiguration.bind(peer);
    peer.setConfiguration = (nextConfiguration: RTCConfiguration = {}) => {
      setConfiguration({
        ...nextConfiguration,
        iceTransportPolicy: window.woAcceptance.iceTransportPolicy,
      });
    };
    const createOffer = peer.createOffer.bind(peer);
    Object.defineProperty(peer, 'createOffer', {
      configurable: true,
      value: (options?: RTCOfferOptions) => {
        diagnostic.offers += 1;
        return createOffer(options);
      },
    });
    const createAnswer = peer.createAnswer.bind(peer);
    Object.defineProperty(peer, 'createAnswer', {
      configurable: true,
      value: (options?: RTCAnswerOptions) => {
        diagnostic.answers += 1;
        return createAnswer(options);
      },
    });
    const close = peer.close.bind(peer);
    peer.close = () => {
      diagnostic.closed = true;
      close();
    };
    const restartIce = peer.restartIce.bind(peer);
    peer.restartIce = () => {
      diagnostic.restartIceCalls += 1;
      restartIce();
    };
    const addEventListener = peer.addEventListener.bind(peer);
    const removeEventListener = peer.removeEventListener.bind(peer);
    const recordConnectionState = () => {
      diagnostic.connectionState = peer.connectionState;
      diagnostic.iceConnectionState = peer.iceConnectionState;
      diagnostic.signalingState = peer.signalingState;
      appendState(diagnostic.connectionStateHistory, peer.connectionState);
      appendState(
        diagnostic.iceConnectionStateHistory,
        peer.iceConnectionState,
      );
    };
    addEventListener('connectionstatechange', recordConnectionState);
    addEventListener('iceconnectionstatechange', recordConnectionState);
    const listenerWrappers = new WeakMap<
      EventListenerOrEventListenerObject,
      EventListener
    >();
    peer.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (listener === null) return;
      if (
        type !== 'connectionstatechange' &&
        type !== 'iceconnectionstatechange'
      ) {
        addEventListener(type, listener, options);
        return;
      }
      let wrapped = listenerWrappers.get(listener);
      if (wrapped === undefined) {
        wrapped = (event: Event) => {
          if (
            peer.connectionState === 'failed' ||
            peer.iceConnectionState === 'failed'
          ) {
            diagnostic.holdDisconnectedIceEvents = false;
          }
          if (
            diagnostic.holdDisconnectedIceEvents &&
            peer.iceConnectionState === 'disconnected'
          ) {
            diagnostic.heldDisconnectedIceEvents += 1;
            return;
          }
          if (typeof listener === 'function') {
            listener.call(peer, event);
          } else {
            listener.handleEvent(event);
          }
        };
        listenerWrappers.set(listener, wrapped);
      }
      addEventListener(type, wrapped, options);
    }) as typeof peer.addEventListener;
    peer.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      if (listener === null) return;
      removeEventListener(
        type,
        listenerWrappers.get(listener) ?? listener,
        options,
      );
    }) as typeof peer.removeEventListener;
    return peer;
  } as unknown as typeof RTCPeerConnection;
  AcceptancePeerConnection.prototype = NativePeerConnection.prototype;
  Object.setPrototypeOf(AcceptancePeerConnection, NativePeerConnection);
  window.RTCPeerConnection = AcceptancePeerConnection;
}

function holdDisconnectedIceEvents(): number {
  let entry: readonly [RTCPeerConnection, MutablePeerDiagnostic] | undefined;
  for (const candidate of peerDiagnostics.entries()) {
    if (!candidate[1].closed) entry = candidate;
  }
  if (entry === undefined) {
    throw new Error('No active PeerConnection is available');
  }
  const [peer, diagnostic] = entry;
  if (
    peer.connectionState !== 'connected' ||
    peer.signalingState !== 'stable'
  ) {
    throw new Error('Active PeerConnection is not stably connected');
  }
  diagnostic.holdDisconnectedIceEvents = true;
  return diagnostic.id;
}

function installWebSocketProbe(): void {
  const NativeWebSocket = window.WebSocket;
  const AcceptanceWebSocket = function (
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const signaling = new URL(String(url)).protocol === 'wss:';
    if (signaling && signalingPaused) {
      blockedSignalingAttempts += 1;
      throw new DOMException('Acceptance signaling is paused', 'NetworkError');
    }
    const socket = new NativeWebSocket(url, protocols);
    if (signaling) {
      const diagnostic: SocketDiagnostic = {
        id: ++socketSequence,
        state: socket.readyState,
        opens: 0,
        closes: 0,
      };
      signalingSockets.set(socket, diagnostic);
      socket.addEventListener('open', () => {
        diagnostic.state = socket.readyState;
        diagnostic.opens += 1;
      });
      socket.addEventListener('close', () => {
        diagnostic.state = socket.readyState;
        diagnostic.closes += 1;
      });
    }
    return socket;
  } as unknown as typeof WebSocket;
  AcceptanceWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(AcceptanceWebSocket, NativeWebSocket);
  window.WebSocket = AcceptanceWebSocket;
}

function dropOpenSignalingSockets(): number {
  let closed = 0;
  for (const socket of signalingSockets.keys()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    socket.close(4000, 'acceptance-drop');
    closed += 1;
  }
  signalingDrops += closed;
  return closed;
}

async function createAcceptanceAudioTrack(
  activeTracks: Set<MediaStreamTrack>,
): Promise<MediaStreamTrack> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const source = context.createBufferSource();
  const destination = context.createMediaStreamDestination();
  try {
    const wav = await window.woAcceptance.audioWav();
    source.buffer = await context.decodeAudioData(wav.slice(0));
    source.loop = true;
    source.connect(destination);
    source.start();
    await context.resume();
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  const track = destination.stream.getAudioTracks()[0];
  if (track === undefined) {
    source.stop();
    await context.close();
    throw new Error('Acceptance audio track is unavailable');
  }
  const stop = track.stop.bind(track);
  let stopped = false;
  activeTracks.add(track);
  track.stop = () => {
    if (stopped) return;
    stopped = true;
    activeTracks.delete(track);
    stop();
    source.stop();
    void context.close();
  };
  return track;
}

function installDisplayCaptureProbe(): void {
  const mediaDevices = navigator.mediaDevices;
  const getDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  Object.defineProperty(mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async (constraints?: DisplayMediaStreamOptions) => {
      captureDiagnostic.attempts += 1;
      captureDiagnostic.lastName = '';
      let stream: MediaStream | null = null;
      try {
        const audioRequested =
          constraints?.audio !== undefined && constraints.audio !== false;
        stream = await getDisplayMedia(
          audioRequested ? { ...constraints, audio: false } : constraints,
        );
        if (audioRequested) {
          for (const capturedAudio of stream.getAudioTracks()) {
            stream.removeTrack(capturedAudio);
            capturedAudio.stop();
          }
          stream.addTrack(
            await createAcceptanceAudioTrack(liveSystemAudioTracks),
          );
        }
        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack?.getSettings();
        captureDiagnostic.successes += 1;
        captureDiagnostic.tracks = stream.getTracks().length;
        captureDiagnostic.videoTracks = stream.getVideoTracks().length;
        captureDiagnostic.audioTracks = stream.getAudioTracks().length;
        captureDiagnostic.width = numberValue(settings?.width);
        captureDiagnostic.height = numberValue(settings?.height);
        captureDiagnostic.frameRate = numberValue(settings?.frameRate);
        window.woAcceptance.report(snapshot());
        return stream;
      } catch (error) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        captureDiagnostic.lastName =
          error instanceof DOMException ? error.name : 'Error';
        window.woAcceptance.report(snapshot());
        throw error;
      }
    },
  });
}

function installAudioFixture(): void {
  const mediaDevices = navigator.mediaDevices;
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  Object.defineProperty(mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints?: MediaStreamConstraints) => {
      const audioRequested =
        constraints?.audio !== undefined && constraints.audio !== false;
      const videoRequested =
        constraints?.video !== undefined && constraints.video !== false;
      if (!audioRequested || videoRequested) return getUserMedia(constraints);
      if (microphoneDenials > 0) {
        microphoneDenials -= 1;
        throw new DOMException(
          'Acceptance microphone permission denied',
          'NotAllowedError',
        );
      }
      const track = await createAcceptanceAudioTrack(liveMicrophoneTracks);
      return new MediaStream([track]);
    },
  });
}

function installRnnoiseProbe(): void {
  const nativeCreateScriptProcessor =
    AudioContext.prototype.createScriptProcessor;
  Object.defineProperty(AudioContext.prototype, 'createScriptProcessor', {
    configurable: true,
    writable: true,
    value: function (
      this: AudioContext,
      bufferSize?: number,
      numberOfInputChannels?: number,
      numberOfOutputChannels?: number,
    ): ScriptProcessorNode {
      const processor = nativeCreateScriptProcessor.call(
        this,
        bufferSize,
        numberOfInputChannels,
        numberOfOutputChannels,
      );
      rnnoiseDiagnostic.processorCreations += 1;
      processor.addEventListener('audioprocess', (event) => {
        const callbackAtMs = performance.now();
        if (rnnoiseDiagnostic.lastCallbackAtMs > 0) {
          rnnoiseDiagnostic.maxCallbackGapMs = Math.max(
            rnnoiseDiagnostic.maxCallbackGapMs,
            callbackAtMs - rnnoiseDiagnostic.lastCallbackAtMs,
          );
        }
        rnnoiseDiagnostic.lastCallbackAtMs = callbackAtMs;
        rnnoiseDiagnostic.audioProcessCallbacks += 1;
        rnnoiseDiagnostic.processedFrames += (
          event as AudioProcessingEvent
        ).inputBuffer.length;
      });
      return processor;
    },
  });
}

function snapshot(): unknown {
  return {
    sequence: ++reportSequence,
    icePolicy: window.woAcceptance.iceTransportPolicy,
    callStatus: recordCallStatus(),
    callStatusHistory: [...callStatusHistory],
    signalingDrops,
    signalingPaused,
    blockedSignalingAttempts,
    capture: { ...captureDiagnostic },
    rnnoise: { ...rnnoiseDiagnostic },
    rnnoiseActive:
      document
        .querySelector('.room-shell')
        ?.getAttribute('data-rnnoise-active') === 'true',
    peers: [...peerDiagnostics.values()].map((value) => ({ ...value })),
    sockets: [...signalingSockets.values()].map((value) => ({ ...value })),
  };
}

installPeerConnectionProbe();
installWebSocketProbe();
installDisplayCaptureProbe();
installRnnoiseProbe();
installAudioFixture();
const callStatusObserver = new MutationObserver(() => {
  recordCallStatus();
});
callStatusObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});
Object.defineProperty(window, 'woAcceptanceControl', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    denyNextMicrophoneCapture: () => {
      microphoneDenials += 1;
      return microphoneDenials;
    },
    dropSignaling: dropOpenSignalingSockets,
    holdDisconnectedIceEvents,
    pauseSignaling: () => {
      signalingPaused = true;
      return dropOpenSignalingSockets();
    },
    resumeSignaling: () => {
      if (!signalingPaused) return 0;
      signalingPaused = false;
      return 1;
    },
    resetRnnoiseCallbackGap: () => {
      rnnoiseDiagnostic.maxCallbackGapMs = 0;
      rnnoiseDiagnostic.lastCallbackAtMs = 0;
      return rnnoiseDiagnostic.audioProcessCallbacks;
    },
    stopLocalMicrophoneTrack: () => {
      let stopped = 0;
      for (const track of [...liveMicrophoneTracks]) {
        if (track.readyState !== 'live') continue;
        track.stop();
        track.dispatchEvent(new Event('ended'));
        stopped += 1;
      }
      return stopped;
    },
    stopLocalScreenTrack: () => {
      let stopped = 0;
      for (const peer of peerDiagnostics.keys()) {
        for (const sender of peer.getSenders()) {
          if (
            sender.track?.kind === 'video' &&
            sender.track.readyState === 'live'
          ) {
            sender.track.stop();
            sender.track.dispatchEvent(new Event('ended'));
            stopped += 1;
          }
        }
      }
      return stopped;
    },
    stopLocalSystemAudioTrack: () => {
      let stopped = 0;
      for (const track of [...liveSystemAudioTracks]) {
        if (track.readyState !== 'live') continue;
        track.stop();
        track.dispatchEvent(new Event('ended'));
        stopped += 1;
      }
      return stopped;
    },
  }),
});

let sampling = false;
window.setInterval(() => {
  if (sampling) return;
  sampling = true;
  void Promise.all(
    [...peerDiagnostics.entries()].map(([peer, diagnostic]) =>
      samplePeer(peer, diagnostic),
    ),
  ).finally(() => {
    window.woAcceptance.report(snapshot());
    sampling = false;
  });
}, 400);
window.woAcceptance.report(snapshot());

await import('./main.js');
