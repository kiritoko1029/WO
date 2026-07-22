import { createIdempotentCleanup } from './media-cleanup.js';

export interface AudioElementLike {
  autoplay: boolean;
  playsInline: boolean;
  muted: boolean;
  volume: number;
  srcObject: MediaStream | null;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
  setSinkId?(sinkId: string): Promise<void>;
}

export interface AudioOutputOptions {
  readonly createElement?: () => AudioElementLike;
  readonly createMediaStream?: (
    tracks: readonly MediaStreamTrack[],
  ) => MediaStream;
  readonly onPlaybackError?: (error: unknown) => void;
  readonly onSinkSelectionError?: (error: unknown) => void;
}

export interface AudioOutput {
  readonly supportsSinkSelection: boolean;
  attach(track: MediaStreamTrack): Promise<void>;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  selectSink(sinkId: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

const createBrowserElement = (): AudioElementLike =>
  document.createElement('audio') as unknown as AudioElementLike;

const createBrowserMediaStream = (
  tracks: readonly MediaStreamTrack[],
): MediaStream => new MediaStream([...tracks]);

export function createAudioOutput(
  options: AudioOutputOptions = {},
): AudioOutput {
  const element = (options.createElement ?? createBrowserElement)();
  const createStream = options.createMediaStream ?? createBrowserMediaStream;
  let cleaned = false;
  element.autoplay = true;
  element.playsInline = true;
  const runCleanup = createIdempotentCleanup([
    () => {
      element.pause();
      element.srcObject = null;
      element.remove();
    },
  ]);
  const cleanup = (): Promise<void> => {
    cleaned = true;
    return runCleanup();
  };

  return Object.freeze({
    get supportsSinkSelection() {
      return typeof element.setSinkId === 'function';
    },
    attach: async (track: MediaStreamTrack) => {
      if (cleaned) throw new Error('Audio output has been cleaned');
      if (track.kind !== 'audio') {
        throw new TypeError('Remote playback requires an audio track');
      }
      element.srcObject = createStream([track]);
      try {
        await element.play();
      } catch (error) {
        options.onPlaybackError?.(error);
        throw error;
      }
    },
    setMuted: (muted: boolean) => {
      if (cleaned) return;
      element.muted = muted;
    },
    setVolume: (volume: number) => {
      if (cleaned) return;
      element.volume = Math.min(1, Math.max(0, volume));
    },
    selectSink: async (sinkId: string) => {
      if (cleaned) return false;
      if (typeof element.setSinkId !== 'function') return false;
      try {
        await element.setSinkId(sinkId);
        return true;
      } catch (error) {
        options.onSinkSelectionError?.(error);
        return false;
      }
    },
    cleanup,
  });
}
