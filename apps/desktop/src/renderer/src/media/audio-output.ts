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
  /**
   * Attach a remote audio track for playback. Multiple tracks (microphone +
   * desktop/system audio from screen share) are mixed into one MediaStream —
   * later attaches must not replace earlier ones, otherwise voice is silenced
   * when the screen-audio receiver track arrives second.
   */
  attach(track: MediaStreamTrack): Promise<void>;
  /** Drop every remote track (e.g. peer left the room). */
  clearRemoteTracks(): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  selectSink(sinkId: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export const DEFAULT_REMOTE_VOLUME = 1;
export const MIN_REMOTE_VOLUME = 0;
export const MAX_REMOTE_VOLUME = 1;

export function clampRemoteVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REMOTE_VOLUME;
  return Math.min(MAX_REMOTE_VOLUME, Math.max(MIN_REMOTE_VOLUME, value));
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
  /** Remote audio tracks currently mixed into the playback element. */
  const remoteTracks = new Map<string, MediaStreamTrack>();
  const endedListeners = new Map<string, () => void>();
  element.autoplay = true;
  element.playsInline = true;

  const clearEndedListeners = (): void => {
    for (const [id, listener] of endedListeners) {
      const track = remoteTracks.get(id);
      track?.removeEventListener('ended', listener);
    }
    endedListeners.clear();
  };

  const liveTracks = (): MediaStreamTrack[] =>
    [...remoteTracks.values()].filter((track) => track.readyState !== 'ended');

  const syncElementStream = async (): Promise<void> => {
    if (cleaned) return;
    const tracks = liveTracks();
    // Drop ended entries so the map stays small across renegotiations.
    for (const [id, track] of remoteTracks) {
      if (track.readyState === 'ended') {
        const listener = endedListeners.get(id);
        if (listener) track.removeEventListener('ended', listener);
        endedListeners.delete(id);
        remoteTracks.delete(id);
      }
    }
    if (tracks.length === 0) {
      element.srcObject = null;
      return;
    }
    element.srcObject = createStream(tracks);
    try {
      await element.play();
    } catch (error) {
      options.onPlaybackError?.(error);
      throw error;
    }
  };

  const runCleanup = createIdempotentCleanup([
    () => {
      clearEndedListeners();
      remoteTracks.clear();
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
      // Replacing an existing id (renegotiation) drops the old ended listener.
      const previous = remoteTracks.get(track.id);
      const previousListener = endedListeners.get(track.id);
      if (previous !== undefined && previousListener !== undefined) {
        previous.removeEventListener('ended', previousListener);
      }
      remoteTracks.set(track.id, track);
      const onEnded = (): void => {
        if (
          remoteTracks.get(track.id) !== track ||
          endedListeners.get(track.id) !== onEnded
        ) {
          return;
        }
        remoteTracks.delete(track.id);
        endedListeners.delete(track.id);
        void syncElementStream().catch(() => undefined);
      };
      endedListeners.set(track.id, onEnded);
      track.addEventListener('ended', onEnded);
      await syncElementStream();
    },
    clearRemoteTracks: () => {
      if (cleaned) return;
      clearEndedListeners();
      remoteTracks.clear();
      element.pause();
      element.srcObject = null;
    },
    setMuted: (muted: boolean) => {
      if (cleaned) return;
      element.muted = muted;
    },
    setVolume: (volume: number) => {
      if (cleaned) return;
      element.volume = clampRemoteVolume(volume);
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
