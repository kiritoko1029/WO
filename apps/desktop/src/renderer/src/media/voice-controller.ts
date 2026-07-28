import { createIdempotentCleanup } from './media-cleanup.js';
import {
  type NoiseIntensity,
  type RnnoiseLoader,
  DEFAULT_NOISE_INTENSITY,
  createNoiseSuppressor,
  noiseSuppressionEnabledFor,
} from './noise-suppressor.js';

import { clampRemoteVolume, type AudioOutput } from './audio-output.js';

export type VoiceControllerErrorCode =
  | 'MICROPHONE_PERMISSION_DENIED'
  | 'MICROPHONE_CAPTURE_INVALID'
  | 'MICROPHONE_CAPTURE_ENDED';

export class VoiceControllerError extends Error {
  readonly code: VoiceControllerErrorCode;

  constructor(code: VoiceControllerErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'VoiceControllerError';
    this.code = code;
  }
}

export interface VoiceDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface VoiceDevices {
  readonly inputs: readonly VoiceDevice[];
  readonly outputs: readonly VoiceDevice[];
}

export interface VoiceControllerOptions {
  readonly mediaDevices?: MediaDevices;
  readonly audioOutput: AudioOutput;
  readonly initialNoiseIntensity?: NoiseIntensity;
  readonly initialMicrophoneVolume?: number;
  readonly onMicrophoneEnded?: (error: VoiceControllerError) => void;
  /** Injectable for tests; defaults to `new AudioContext()`. */
  readonly createAudioContext?: () => AudioContext;
  /** Injectable RNNoise loader for tests. */
  readonly loadRnnoise?: RnnoiseLoader;
}

export interface VoiceController {
  readonly microphoneTrack: MediaStreamTrack | null;
  readonly muted: boolean;
  readonly outputMuted: boolean;
  readonly remoteVolume: number;
  readonly microphoneVolume: number;
  readonly supportsOutputSelection: boolean;
  readonly noiseIntensity: NoiseIntensity;
  /** True when the live outbound path is running RNNoise (not native fallback). */
  readonly rnnoiseActive: boolean;
  start(sender?: RTCRtpSender): Promise<MediaStreamTrack>;
  bindSender(
    sender: RTCRtpSender,
    trackAlreadyAttached?: boolean,
  ): Promise<void>;
  setMuted(muted: boolean): void;
  switchMicrophone(deviceId: string): Promise<MediaStreamTrack>;
  setNoiseIntensity(intensity: NoiseIntensity): Promise<void>;
  attachRemoteTrack(track: MediaStreamTrack): Promise<void>;
  clearRemoteTracks(): void;
  setOutputMuted(muted: boolean): void;
  setRemoteVolume(volume: number): void;
  setMicrophoneVolume(volume: number): void;
  selectOutput(deviceId: string): Promise<boolean>;
  listDevices(): Promise<VoiceDevices>;
  cleanup(): Promise<void>;
}

const MIC_VOLUME_STORAGE_KEY = 'wo-microphone-volume';
export const DEFAULT_MICROPHONE_VOLUME = 1;
export const MIN_MICROPHONE_VOLUME = 0;
export const MAX_MICROPHONE_VOLUME = 2;

export function clampMicrophoneVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MICROPHONE_VOLUME;
  return Math.min(
    MAX_MICROPHONE_VOLUME,
    Math.max(MIN_MICROPHONE_VOLUME, value),
  );
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readMicrophoneVolume(
  storage: Pick<Storage, 'getItem'> | null = safeLocalStorage(),
): number {
  if (storage === null) return DEFAULT_MICROPHONE_VOLUME;
  try {
    const raw = storage.getItem(MIC_VOLUME_STORAGE_KEY);
    if (raw === null) return DEFAULT_MICROPHONE_VOLUME;
    return clampMicrophoneVolume(Number(raw));
  } catch {
    return DEFAULT_MICROPHONE_VOLUME;
  }
}

export function writeMicrophoneVolume(
  volume: number,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      MIC_VOLUME_STORAGE_KEY,
      String(clampMicrophoneVolume(volume)),
    );
  } catch {
    // Ignore quota / private-mode failures.
  }
}

const voiceConstraints = (
  deviceId: string | undefined,
  noiseIntensity: NoiseIntensity,
  rnnoiseActive: boolean,
): MediaStreamConstraints => ({
  audio: {
    echoCancellation: true,
    // When RNNoise is live, disable Chromium NS to avoid double processing.
    // When RNNoise failed and intensity is non-off, enable native NS fallback.
    noiseSuppression: noiseSuppressionEnabledFor(noiseIntensity, rnnoiseActive),
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48_000,
    ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
  },
  video: false,
});

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function captureError(error: unknown): VoiceControllerError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  ) {
    return new VoiceControllerError('MICROPHONE_PERMISSION_DENIED', error);
  }
  return new VoiceControllerError('MICROPHONE_CAPTURE_INVALID', error);
}

interface OutboundPipeline {
  readonly setVolume: (volume: number) => void;
  readonly setIntensity: (intensity: NoiseIntensity) => void;
  readonly dispose: () => void;
  readonly rnnoiseActive: boolean;
}

export function createVoiceController(
  options: VoiceControllerOptions,
): VoiceController {
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  const createAudioContext =
    options.createAudioContext ??
    (() => new AudioContext({ sampleRate: 48_000 }));
  let localStream: MediaStream | null = null;
  let rawMicrophoneTrack: MediaStreamTrack | null = null;
  let microphoneTrack: MediaStreamTrack | null = null;
  let outboundPipeline: OutboundPipeline | null = null;
  /** Whether the last successful outbound path used RNNoise. */
  let rnnoiseActive = false;
  let audioSender: RTCRtpSender | null = null;
  let muted = false;
  let outputMuted = false;
  let remoteVolume = 1;
  let microphoneVolume = clampMicrophoneVolume(
    options.initialMicrophoneVolume ?? DEFAULT_MICROPHONE_VOLUME,
  );
  let noiseIntensity: NoiseIntensity =
    options.initialNoiseIntensity ?? DEFAULT_NOISE_INTENSITY;
  let operationSequence = 0;
  let senderBindingSequence = 0;
  let cleaned = false;
  let senderMutationChain = Promise.resolve();
  const uncommittedStreams = new Set<MediaStream>();
  let removeRawTrackEndedListener: (() => void) | null = null;

  const stopUncommittedStreams = (): void => {
    for (const stream of uncommittedStreams) stopTracks(stream);
    uncommittedStreams.clear();
  };

  const disposeOutbound = (): void => {
    outboundPipeline?.dispose();
    outboundPipeline = null;
  };

  const mutateSender = <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const result = senderMutationChain.catch(() => undefined).then(operation);
    senderMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const clearRawTrackEndedListener = (): void => {
    removeRawTrackEndedListener?.();
    removeRawTrackEndedListener = null;
  };

  const watchRawTrackEnded = (track: MediaStreamTrack): void => {
    clearRawTrackEndedListener();
    const onEnded = (): void => {
      if (cleaned || rawMicrophoneTrack !== track) return;
      clearRawTrackEndedListener();
      const stream = localStream;
      const pipeline = outboundPipeline;
      localStream = null;
      rawMicrophoneTrack = null;
      microphoneTrack = null;
      outboundPipeline = null;
      rnnoiseActive = false;
      pipeline?.dispose();
      if (stream !== null) stopTracks(stream);
      const sender = audioSender;
      if (sender !== null) {
        void mutateSender(async () => {
          if (rawMicrophoneTrack !== null) return;
          await sender.replaceTrack(null);
        }).catch(() => undefined);
      }
      options.onMicrophoneEnded?.(
        new VoiceControllerError('MICROPHONE_CAPTURE_ENDED'),
      );
    };
    track.addEventListener('ended', onEnded, { once: true });
    removeRawTrackEndedListener = () => {
      track.removeEventListener('ended', onEnded);
    };
  };

  const isCurrentOperation = (operation: number): boolean =>
    !cleaned && operation === operationSequence;

  const applyMutedToTracks = (): void => {
    const enabled = !muted;
    if (rawMicrophoneTrack !== null) rawMicrophoneTrack.enabled = enabled;
    if (microphoneTrack !== null) microphoneTrack.enabled = enabled;
  };

  const captureRaw = async (
    deviceId: string | undefined,
    intensity: NoiseIntensity,
    preferRnnoise: boolean,
  ): Promise<{
    readonly stream: MediaStream;
    readonly rawTrack: MediaStreamTrack;
  }> => {
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia(
        voiceConstraints(deviceId, intensity, preferRnnoise),
      );
    } catch (error) {
      throw captureError(error);
    }
    const audioTracks = stream.getAudioTracks();
    if (
      audioTracks.length !== 1 ||
      stream.getVideoTracks().length !== 0 ||
      stream.getTracks().length !== 1
    ) {
      stopTracks(stream);
      throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
    }
    return { stream, rawTrack: audioTracks[0]! };
  };

  const makeOutbound = async (
    rawTrack: MediaStreamTrack,
    intensity: NoiseIntensity,
  ): Promise<{
    track: MediaStreamTrack;
    pipeline: OutboundPipeline;
    rnnoiseActive: boolean;
  }> => {
    const suppressor = await createNoiseSuppressor(intensity, {
      createAudioContext: () => createAudioContext(),
      loadRnnoise: options.loadRnnoise,
    });
    try {
      suppressor.setIntensity(intensity);
      const outbound = await suppressor.process(rawTrack, {
        gain: microphoneVolume,
      });
      const usedRnnoise = suppressor.active;
      outbound.enabled = !muted;
      return {
        track: outbound,
        rnnoiseActive: usedRnnoise,
        pipeline: {
          setVolume: (volume) => {
            suppressor.setGain(volume);
          },
          setIntensity: (intensity) => {
            suppressor.setIntensity(intensity);
          },
          dispose: () => {
            suppressor.dispose();
          },
          rnnoiseActive: usedRnnoise,
        },
      };
    } catch (error) {
      suppressor.dispose();
      throw error;
    }
  };

  const runCleanup = createIdempotentCleanup([
    async () => {
      const sender = audioSender;
      audioSender = null;
      if (sender !== null) {
        await mutateSender(() => sender.replaceTrack(null));
      }
    },
    () => {
      clearRawTrackEndedListener();
      disposeOutbound();
      const stream = localStream;
      localStream = null;
      rawMicrophoneTrack = null;
      microphoneTrack = null;
      rnnoiseActive = false;
      if (stream !== null) stopTracks(stream);
      stopUncommittedStreams();
    },
    () => options.audioOutput.cleanup(),
  ]);
  const cleanup = (): Promise<void> => {
    if (!cleaned) {
      cleaned = true;
      operationSequence += 1;
      senderBindingSequence += 1;
    }
    return runCleanup();
  };

  /**
   * Capture + build outbound. Prefer RNNoise when intensity is non-off; if
   * WASM/graph fails, enable browser-native NS on the same track when possible
   * (applyConstraints) and only re-getUserMedia as a last resort.
   */
  const captureAndBuild = async (
    deviceId?: string,
    intensity: NoiseIntensity = noiseIntensity,
  ): Promise<{
    stream: MediaStream;
    rawTrack: MediaStreamTrack;
    outboundTrack: MediaStreamTrack;
    pipeline: OutboundPipeline;
    usedRnnoise: boolean;
  }> => {
    const wantRnnoise = intensity !== 'off';
    // First attempt: prefer RNNoise (native NS off).
    let captured = await captureRaw(deviceId, intensity, wantRnnoise);
    const buildOutbound = async (): ReturnType<typeof makeOutbound> => {
      try {
        return await makeOutbound(captured.rawTrack, intensity);
      } catch (error) {
        stopTracks(captured.stream);
        throw error;
      }
    };
    let outbound = await buildOutbound();

    if (wantRnnoise && !outbound.rnnoiseActive) {
      outbound.pipeline.dispose();
      // Prefer applyConstraints so we keep the same stream (and unit tests
      // with a single getUserMedia mock still work).
      const apply = (
        captured.rawTrack as MediaStreamTrack & {
          applyConstraints?: (
            constraints: MediaTrackConstraints,
          ) => Promise<void>;
        }
      ).applyConstraints;
      if (typeof apply === 'function') {
        try {
          await apply.call(captured.rawTrack, { noiseSuppression: true });
        } catch {
          // Constraints rejected — re-open capture with native NS on.
          stopTracks(captured.stream);
          captured = await captureRaw(deviceId, intensity, false);
        }
      }
      // If applyConstraints is unavailable, keep the original track rather
      // than thrashing getUserMedia; audio still flows (just without NS).
      outbound = await buildOutbound();
    }

    return {
      stream: captured.stream,
      rawTrack: captured.rawTrack,
      outboundTrack: outbound.track,
      pipeline: outbound.pipeline,
      usedRnnoise: outbound.rnnoiseActive,
    };
  };

  const replaceMicrophone = async (
    deviceId: string,
    intensity: NoiseIntensity,
  ): Promise<MediaStreamTrack> => {
    if (cleaned) throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
    const operation = ++operationSequence;
    const built = await captureAndBuild(deviceId || undefined, intensity);
    if (!isCurrentOperation(operation)) {
      built.pipeline.dispose();
      stopTracks(built.stream);
      throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
    }
    let senderMayReferenceCapturedTrack = false;
    const previous = {
      stream: null as MediaStream | null,
      pipeline: null as OutboundPipeline | null,
    };
    try {
      await mutateSender(async () => {
        if (!isCurrentOperation(operation)) {
          throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
        }
        const sender = audioSender;
        const previousTrack = microphoneTrack;
        if (sender !== null) {
          await sender.replaceTrack(built.outboundTrack);
          senderMayReferenceCapturedTrack = true;
          stopUncommittedStreams();
        }
        if (!isCurrentOperation(operation)) {
          if (sender !== null) {
            await sender.replaceTrack(previousTrack);
            senderMayReferenceCapturedTrack = false;
          }
          throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
        }
        previous.stream = localStream;
        previous.pipeline = outboundPipeline;
        clearRawTrackEndedListener();
        localStream = built.stream;
        rawMicrophoneTrack = built.rawTrack;
        microphoneTrack = built.outboundTrack;
        outboundPipeline = built.pipeline;
        rnnoiseActive = built.usedRnnoise;
        watchRawTrackEnded(built.rawTrack);
        applyMutedToTracks();
      });
    } catch (error) {
      if (senderMayReferenceCapturedTrack) {
        uncommittedStreams.add(built.stream);
      } else {
        built.pipeline.dispose();
        stopTracks(built.stream);
      }
      throw error;
    }
    previous.pipeline?.dispose();
    if (previous.stream !== null) stopTracks(previous.stream);
    return built.outboundTrack;
  };

  const controller: VoiceController = {
    get microphoneTrack() {
      return microphoneTrack;
    },
    get muted() {
      return muted;
    },
    get outputMuted() {
      return outputMuted;
    },
    get remoteVolume() {
      return remoteVolume;
    },
    get microphoneVolume() {
      return microphoneVolume;
    },
    get supportsOutputSelection() {
      return options.audioOutput.supportsSinkSelection;
    },
    get noiseIntensity() {
      return noiseIntensity;
    },
    get rnnoiseActive() {
      return rnnoiseActive;
    },
    start: async (sender) => {
      if (
        cleaned ||
        microphoneTrack !== null ||
        localStream !== null ||
        rawMicrophoneTrack !== null
      ) {
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      const operation = ++operationSequence;
      const built = await captureAndBuild();
      if (!isCurrentOperation(operation)) {
        built.pipeline.dispose();
        stopTracks(built.stream);
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      const previousSender = audioSender;
      if (sender !== undefined) audioSender = sender;
      try {
        if (sender !== undefined) {
          await mutateSender(async () => {
            if (!isCurrentOperation(operation)) {
              throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
            }
            await sender.replaceTrack(built.outboundTrack);
          });
        }
      } catch (error) {
        if (audioSender === sender) audioSender = previousSender;
        built.pipeline.dispose();
        stopTracks(built.stream);
        throw error;
      }
      if (!isCurrentOperation(operation)) {
        built.pipeline.dispose();
        stopTracks(built.stream);
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      localStream = built.stream;
      rawMicrophoneTrack = built.rawTrack;
      microphoneTrack = built.outboundTrack;
      outboundPipeline = built.pipeline;
      rnnoiseActive = built.usedRnnoise;
      audioSender = sender ?? null;
      watchRawTrackEnded(built.rawTrack);
      applyMutedToTracks();
      return built.outboundTrack;
    },
    bindSender: async (sender) => {
      if (cleaned) throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      const binding = ++senderBindingSequence;
      audioSender = sender;
      await mutateSender(async () => {
        if (cleaned || binding !== senderBindingSequence) return;
        const track = microphoneTrack;
        if (track === null) throw new Error('Microphone has not been acquired');
        await sender.replaceTrack(track);
        stopUncommittedStreams();
      });
      if (cleaned) {
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
    },
    setMuted: (nextMuted) => {
      muted = nextMuted;
      applyMutedToTracks();
    },
    switchMicrophone: (deviceId) => replaceMicrophone(deviceId, noiseIntensity),
    attachRemoteTrack: (track) => options.audioOutput.attach(track),
    clearRemoteTracks: () => {
      options.audioOutput.clearRemoteTracks();
    },
    setOutputMuted: (nextMuted) => {
      outputMuted = nextMuted;
      options.audioOutput.setMuted(nextMuted);
    },
    setRemoteVolume: (volume) => {
      remoteVolume = clampRemoteVolume(volume);
      options.audioOutput.setVolume(remoteVolume);
    },
    setMicrophoneVolume: (volume) => {
      microphoneVolume = clampMicrophoneVolume(volume);
      outboundPipeline?.setVolume(microphoneVolume);
    },
    selectOutput: (deviceId) => options.audioOutput.selectSink(deviceId),
    setNoiseIntensity: async (nextIntensity) => {
      const previous = noiseIntensity;
      if (nextIntensity === previous) return;
      if (rawMicrophoneTrack === null) {
        noiseIntensity = nextIntensity;
        return;
      }
      // Level changes within RNNoise-active bands can update in place.
      if (
        previous !== 'off' &&
        nextIntensity !== 'off' &&
        rnnoiseActive &&
        outboundPipeline !== null
      ) {
        outboundPipeline.setIntensity(nextIntensity);
        noiseIntensity = nextIntensity;
        return;
      }
      // off ↔ on, or RNNoise was not active: rebuild capture pipeline.
      const deviceId = rawMicrophoneTrack.getSettings?.().deviceId ?? '';
      await replaceMicrophone(deviceId, nextIntensity);
      noiseIntensity = nextIntensity;
    },
    listDevices: async () => {
      const devices = await mediaDevices.enumerateDevices();
      const mapDevice = (device: MediaDeviceInfo): VoiceDevice => ({
        deviceId: device.deviceId,
        label: device.label || '未命名设备',
      });
      return {
        inputs: devices
          .filter((item) => item.kind === 'audioinput')
          .map(mapDevice),
        outputs: devices
          .filter((item) => item.kind === 'audiooutput')
          .map(mapDevice),
      };
    },
    cleanup,
  };
  return Object.freeze(controller);
}
