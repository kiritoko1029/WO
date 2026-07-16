import { createIdempotentCleanup } from './media-cleanup.js';

import type { AudioOutput } from './audio-output.js';

export type VoiceControllerErrorCode =
  'MICROPHONE_PERMISSION_DENIED' | 'MICROPHONE_CAPTURE_INVALID';

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
}

export interface VoiceController {
  readonly microphoneTrack: MediaStreamTrack | null;
  readonly muted: boolean;
  readonly outputMuted: boolean;
  readonly supportsOutputSelection: boolean;
  start(sender?: RTCRtpSender): Promise<MediaStreamTrack>;
  bindSender(
    sender: RTCRtpSender,
    trackAlreadyAttached?: boolean,
  ): Promise<void>;
  setMuted(muted: boolean): void;
  switchMicrophone(deviceId: string): Promise<MediaStreamTrack>;
  attachRemoteTrack(track: MediaStreamTrack): Promise<void>;
  setOutputMuted(muted: boolean): void;
  selectOutput(deviceId: string): Promise<boolean>;
  listDevices(): Promise<VoiceDevices>;
  cleanup(): Promise<void>;
}

const voiceConstraints = (deviceId?: string): MediaStreamConstraints => ({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
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

export function createVoiceController(
  options: VoiceControllerOptions,
): VoiceController {
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  let localStream: MediaStream | null = null;
  let microphoneTrack: MediaStreamTrack | null = null;
  let audioSender: RTCRtpSender | null = null;
  let muted = false;
  let outputMuted = false;
  let operationSequence = 0;
  let senderBindingSequence = 0;
  let cleaned = false;
  let senderMutationChain = Promise.resolve();
  const uncommittedStreams = new Set<MediaStream>();

  const stopUncommittedStreams = (): void => {
    for (const stream of uncommittedStreams) stopTracks(stream);
    uncommittedStreams.clear();
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

  const isCurrentOperation = (operation: number): boolean =>
    !cleaned && operation === operationSequence;

  const capture = async (
    deviceId?: string,
  ): Promise<{
    readonly stream: MediaStream;
    readonly track: MediaStreamTrack;
  }> => {
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia(voiceConstraints(deviceId));
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
    return { stream, track: audioTracks[0]! };
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
      const stream = localStream;
      localStream = null;
      microphoneTrack = null;
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
    get supportsOutputSelection() {
      return options.audioOutput.supportsSinkSelection;
    },
    start: async (sender) => {
      if (cleaned || microphoneTrack !== null || localStream !== null) {
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      const operation = ++operationSequence;
      const captured = await capture();
      if (!isCurrentOperation(operation)) {
        stopTracks(captured.stream);
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      captured.track.enabled = !muted;
      const previousSender = audioSender;
      if (sender !== undefined) audioSender = sender;
      try {
        if (sender !== undefined) {
          await mutateSender(async () => {
            if (!isCurrentOperation(operation)) {
              throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
            }
            await sender.replaceTrack(captured.track);
          });
        }
      } catch (error) {
        if (audioSender === sender) audioSender = previousSender;
        stopTracks(captured.stream);
        throw error;
      }
      if (!isCurrentOperation(operation)) {
        stopTracks(captured.stream);
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      localStream = captured.stream;
      microphoneTrack = captured.track;
      audioSender = sender ?? null;
      return captured.track;
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
      if (microphoneTrack !== null) microphoneTrack.enabled = !nextMuted;
    },
    switchMicrophone: async (deviceId) => {
      if (cleaned) throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      const operation = ++operationSequence;
      const captured = await capture(deviceId || undefined);
      if (!isCurrentOperation(operation)) {
        stopTracks(captured.stream);
        throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
      }
      captured.track.enabled = !muted;
      let senderMayReferenceCapturedTrack = false;
      let previousStream: MediaStream | null = null;
      try {
        await mutateSender(async () => {
          if (!isCurrentOperation(operation)) {
            throw new VoiceControllerError('MICROPHONE_CAPTURE_INVALID');
          }
          const sender = audioSender;
          const previousTrack = microphoneTrack;
          if (sender !== null) {
            await sender.replaceTrack(captured.track);
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
          previousStream = localStream;
          localStream = captured.stream;
          microphoneTrack = captured.track;
        });
      } catch (error) {
        if (senderMayReferenceCapturedTrack) {
          uncommittedStreams.add(captured.stream);
        } else {
          stopTracks(captured.stream);
        }
        throw error;
      }
      if (previousStream !== null) stopTracks(previousStream);
      return captured.track;
    },
    attachRemoteTrack: (track) => options.audioOutput.attach(track),
    setOutputMuted: (nextMuted) => {
      outputMuted = nextMuted;
      options.audioOutput.setMuted(nextMuted);
    },
    selectOutput: (deviceId) => options.audioOutput.selectSink(deviceId),
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
