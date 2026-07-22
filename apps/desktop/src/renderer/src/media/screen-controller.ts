import {
  p2pScreenAcquireAckSchema,
  p2pScreenReleaseAckSchema,
  p2pScreenRenewAckSchema,
  type P2pScreenLease,
} from '@wo/protocol';

import type {
  CaptureSourceSummary,
  DesktopApi,
} from '../../../preload/types.js';
import type { RuntimeSchema } from './signaling-client.js';

const RENEWAL_CADENCE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 3_000;
const LEASE_SAFETY_MARGIN_MS = 3_500;
const RELEASE_PENDING_MESSAGE = '屏幕已在本机停止，服务端将在租约到期后释放';

export const DISPLAY_CAPTURE_CONSTRAINTS: DisplayMediaStreamOptions =
  Object.freeze({
    // Request system audio (loopback) alongside the video so the sharer can
    // broadcast desktop sound. On macOS the user must additionally check
    // "Share Computer Audio" in the system picker dialog.
    audio: true,
    video: Object.freeze({
      frameRate: Object.freeze({ ideal: 60 }),
    }),
  });

export type ScreenShareState =
  | 'idle'
  | 'acquiring'
  | 'picking'
  | 'capturing'
  | 'sharing'
  | 'stopping'
  | 'error';

export interface ScreenCaptureSettings {
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
}

export interface ScreenControllerSnapshot {
  readonly state: ScreenShareState;
  readonly sources: readonly CaptureSourceSummary[];
  readonly selectedToken: string | null;
  readonly captureSettings: ScreenCaptureSettings | null;
  readonly leaseId: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly error: string | null;
}

export interface ScreenController {
  getSnapshot(): ScreenControllerSnapshot;
  subscribe(listener: () => void): () => void;
  prepare(): Promise<void>;
  selectSource(token: string): Promise<void>;
  startSelectedCapture(): Promise<void>;
  stop(): Promise<void>;
  handleLeaseLost(): Promise<void>;
  handleSignalingClosed(): Promise<void>;
  cleanup(): Promise<void>;
}

interface ScreenSignaling {
  request<Response>(
    type: 'screen.acquire' | 'screen.renew' | 'screen.release',
    payload: unknown,
    responseSchema: RuntimeSchema<Response>,
    options: Readonly<{
      requestId: string;
      timeoutMs: number;
      retryTimeouts?: number;
    }>,
  ): Promise<Response>;
}

export interface ScreenControllerOptions {
  readonly roomId: string;
  readonly userId: string;
  readonly sender: Pick<RTCRtpSender, 'replaceTrack'>;
  /**
   * Optional sender for the desktop audio track captured alongside the screen
   * video. When provided and the capture yields an audio track, it is
   * attached here so the remote peer receives system audio.
   */
  readonly audioSender?: Pick<RTCRtpSender, 'replaceTrack'>;
  readonly signaling: ScreenSignaling;
  readonly capture: Pick<DesktopApi['capture'], 'list' | 'select'>;
  readonly mediaDevices?: Pick<MediaDevices, 'getDisplayMedia'>;
  readonly makeRequestId?: () => string;
  readonly now?: () => number;
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ScreenControllerError extends Error {
  constructor(readonly code: 'INVALID_STATE' | 'LEASE_LOST') {
    super(code);
    this.name = 'ScreenControllerError';
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

function failedAckError(response: {
  readonly payload: {
    readonly ok: false;
    readonly error: { readonly code: string; readonly message: string };
  };
}): Error {
  return Object.assign(new Error(response.payload.error.message), {
    code: response.payload.error.code,
  });
}

function responseLease(response: {
  readonly payload:
    | { readonly ok: true; readonly data: { readonly lease: P2pScreenLease } }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      };
}): P2pScreenLease {
  if (!response.payload.ok) throw failedAckError(response as never);
  return response.payload.data.lease;
}

function captureSettings(track: MediaStreamTrack): ScreenCaptureSettings {
  const settings = track.getSettings();
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : null;
  return Object.freeze({
    width: numberOrNull(settings.width),
    height: numberOrNull(settings.height),
    frameRate: numberOrNull(settings.frameRate),
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function trackEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended';
}

const defaultRequestId = (): string => crypto.randomUUID();

export function createScreenController(
  options: ScreenControllerOptions,
): ScreenController {
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  const makeRequestId = options.makeRequestId ?? defaultRequestId;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const listeners = new Set<() => void>();
  let snapshot: ScreenControllerSnapshot = Object.freeze({
    state: 'idle',
    sources: Object.freeze([]),
    selectedToken: null,
    captureSettings: null,
    leaseId: null,
    leaseExpiresAtMs: null,
    error: null,
  });
  let generation = 0;
  let currentLease: P2pScreenLease | null = null;
  let currentTrack: MediaStreamTrack | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  let lifecycleFailure: unknown = null;
  let senderQueue: Promise<void> = Promise.resolve();
  let renewalQueue: Promise<void> = Promise.resolve();

  const update = (change: Partial<ScreenControllerSnapshot>): void => {
    snapshot = Object.freeze({ ...snapshot, ...change });
    for (const listener of listeners) listener();
  };

  const queueSenderTrack = (track: MediaStreamTrack | null): Promise<void> => {
    const operation = senderQueue
      .catch(() => undefined)
      .then(() => options.sender.replaceTrack(track));
    senderQueue = operation;
    return operation;
  };

  const assertCurrent = (expectedGeneration: number): void => {
    if (generation !== expectedGeneration) {
      if (lifecycleFailure !== null) throw lifecycleFailure;
      throw new ScreenControllerError('INVALID_STATE');
    }
  };

  const validateLease = (value: P2pScreenLease): P2pScreenLease => {
    const expiresAtMs = Date.parse(value.expiresAt);
    if (
      value.roomId !== options.roomId ||
      value.holderId !== options.userId ||
      (currentLease !== null && value.leaseId !== currentLease.leaseId) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= now() + LEASE_SAFETY_MARGIN_MS
    ) {
      throw new ScreenControllerError('LEASE_LOST');
    }
    return value;
  };

  const renew = (expectedGeneration: number): Promise<void> => {
    const operation = renewalQueue
      .catch(() => undefined)
      .then(async () => {
        assertCurrent(expectedGeneration);
        const lease = currentLease;
        if (lease === null) throw new ScreenControllerError('LEASE_LOST');
        const response = await options.signaling.request(
          'screen.renew',
          { roomId: options.roomId, leaseId: lease.leaseId },
          p2pScreenRenewAckSchema,
          {
            requestId: makeRequestId(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            retryTimeouts: 1,
          },
        );
        assertCurrent(expectedGeneration);
        const nextLease = validateLease(responseLease(response));
        currentLease = nextLease;
        update({ leaseExpiresAtMs: Date.parse(nextLease.expiresAt) });
      });
    renewalQueue = operation.catch(() => undefined);
    return operation;
  };

  const clearRenewalTimer = (): void => {
    if (renewalTimer !== null) {
      clearTimer(renewalTimer);
      renewalTimer = null;
    }
  };

  const errorMessage = (error: unknown): string => {
    const code = errorCode(error);
    if (code === 'LEASE_LOST') return '屏幕共享权限已失效';
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'NotAllowedError'
    ) {
      return '需要屏幕录制权限才能共享';
    }
    return '屏幕共享失败，请重试';
  };

  const releaseLease = async (lease: P2pScreenLease): Promise<boolean> => {
    try {
      const response = await options.signaling.request(
        'screen.release',
        { roomId: options.roomId, leaseId: lease.leaseId },
        p2pScreenReleaseAckSchema,
        {
          requestId: makeRequestId(),
          timeoutMs: REQUEST_TIMEOUT_MS,
          retryTimeouts: 1,
        },
      );
      if (!response.payload.ok) {
        throw Object.assign(new Error(response.payload.error.message), {
          code: response.payload.error.code,
        });
      }
      return true;
    } catch {
      return false;
    }
  };

  const cleanupSession = (
    finalState: 'idle' | 'error',
    failure: unknown = null,
  ): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    if (failure !== null) lifecycleFailure = failure;
    if (
      currentLease === null &&
      currentTrack === null &&
      snapshot.state === 'idle'
    ) {
      return Promise.resolve();
    }
    generation += 1;
    clearRenewalTimer();
    const lease = currentLease;
    const track = currentTrack;
    currentLease = null;
    currentTrack = null;
    startPromise = null;
    update({ state: 'stopping' });
    stopPromise = (async () => {
      await queueSenderTrack(null).catch(() => undefined);
      track?.removeEventListener('ended', handleTrackEnded);
      track?.stop();
      const released = lease === null ? true : await releaseLease(lease);
      update({
        state: finalState,
        sources: Object.freeze([]),
        selectedToken: null,
        captureSettings: null,
        leaseId: null,
        leaseExpiresAtMs: null,
        error:
          finalState === 'error'
            ? errorMessage(failure)
            : released
              ? null
              : RELEASE_PENDING_MESSAGE,
      });
    })();
    return stopPromise;
  };

  function handleTrackEnded(): void {
    void cleanupSession('idle');
  }

  const fail = async (error: unknown): Promise<never> => {
    await cleanupSession('error', error);
    throw error;
  };

  const failForGeneration = async (
    expectedGeneration: number,
    error: unknown,
  ): Promise<never> => {
    if (generation !== expectedGeneration) {
      throw lifecycleFailure ?? error;
    }
    return fail(error);
  };

  const scheduleRenewal = (expectedGeneration: number): void => {
    clearRenewalTimer();
    renewalTimer = setTimer(() => {
      renewalTimer = null;
      void renew(expectedGeneration)
        .then(() => {
          if (generation === expectedGeneration) {
            scheduleRenewal(expectedGeneration);
          }
        })
        .catch((error: unknown) => {
          if (generation !== expectedGeneration) return;
          return cleanupSession('error', error);
        });
    }, RENEWAL_CADENCE_MS);
  };

  const controller: ScreenController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prepare() {
      if (snapshot.state !== 'idle' && snapshot.state !== 'error') {
        throw new ScreenControllerError('INVALID_STATE');
      }
      stopPromise = null;
      lifecycleFailure = null;
      generation += 1;
      const expectedGeneration = generation;
      update({
        state: 'acquiring',
        sources: Object.freeze([]),
        selectedToken: null,
        captureSettings: null,
        error: null,
      });
      try {
        const response = await options.signaling.request(
          'screen.acquire',
          { roomId: options.roomId },
          p2pScreenAcquireAckSchema,
          {
            requestId: makeRequestId(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            retryTimeouts: 1,
          },
        );
        const acquiredLease = responseLease(response);
        if (generation !== expectedGeneration) {
          if (!(await releaseLease(acquiredLease))) {
            update({ error: RELEASE_PENDING_MESSAGE });
          }
          assertCurrent(expectedGeneration);
        }
        try {
          currentLease = validateLease(acquiredLease);
        } catch (error) {
          await releaseLease(acquiredLease);
          throw error;
        }
        update({
          leaseId: currentLease.leaseId,
          leaseExpiresAtMs: Date.parse(currentLease.expiresAt),
        });
        await renew(expectedGeneration);
        assertCurrent(expectedGeneration);
        scheduleRenewal(expectedGeneration);
        const sources = await options.capture.list();
        assertCurrent(expectedGeneration);
        update({ state: 'picking', sources: Object.freeze([...sources]) });
      } catch (error) {
        await failForGeneration(expectedGeneration, error);
      }
    },
    async selectSource(token) {
      if (snapshot.state !== 'picking') {
        throw new ScreenControllerError('INVALID_STATE');
      }
      const expectedGeneration = generation;
      try {
        await options.capture.select(token);
        assertCurrent(expectedGeneration);
        update({ selectedToken: token, error: null });
      } catch (error) {
        await failForGeneration(expectedGeneration, error);
      }
    },
    startSelectedCapture() {
      if (snapshot.state !== 'picking' || snapshot.selectedToken === null) {
        return Promise.reject(new ScreenControllerError('INVALID_STATE'));
      }
      if (startPromise !== null) return startPromise;
      const expectedGeneration = generation;
      if (
        mediaDevices === null ||
        mediaDevices === undefined ||
        typeof mediaDevices.getDisplayMedia !== 'function'
      ) {
        console.error(
          '[screen-controller] mediaDevices.getDisplayMedia is unavailable:',
          mediaDevices,
        );
        return fail(
          Object.assign(new Error('Screen capture is unavailable'), {
            code: 'SCREEN_CAPTURE_UNAVAILABLE',
          }),
        );
      }
      let capturePromise: Promise<MediaStream>;
      try {
        capturePromise = Promise.resolve(
          mediaDevices.getDisplayMedia(DISPLAY_CAPTURE_CONSTRAINTS),
        );
      } catch (error) {
        console.error(
          '[screen-controller] getDisplayMedia threw synchronously:',
          error,
        );
        return fail(error);
      }
      update({ state: 'capturing', error: null });
      startPromise = (async () => {
        let stream: MediaStream;
        try {
          stream = await capturePromise;
        } catch (error) {
          console.error(
            '[screen-controller] getDisplayMedia was rejected:',
            error,
          );
          return failForGeneration(expectedGeneration, error);
        }
        if (generation !== expectedGeneration) {
          stopStream(stream);
          throw lifecycleFailure ?? new ScreenControllerError('INVALID_STATE');
        }
        const tracks = stream.getTracks();
        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        // Allow exactly 1 video track plus 0 or 1 audio track (desktop audio
        // is optional — the user may not check "Share Computer Audio").
        if (
          videoTracks.length !== 1 ||
          videoTracks[0]!.kind !== 'video' ||
          audioTracks.length > 1 ||
          tracks.length !== videoTracks.length + audioTracks.length
        ) {
          stopStream(stream);
          return fail(new ScreenControllerError('INVALID_STATE'));
        }
        const track = videoTracks[0]!;
        const audioTrack = audioTracks[0] ?? null;
        currentTrack = track;
        track.addEventListener('ended', handleTrackEnded, { once: true });
        const settings = captureSettings(track);
        try {
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          await renew(expectedGeneration);
          assertCurrent(expectedGeneration);
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          await queueSenderTrack(track);
          assertCurrent(expectedGeneration);
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          // Attach desktop audio if present and a sender is available.
          if (audioTrack !== null && options.audioSender !== undefined) {
            await options.audioSender.replaceTrack(audioTrack);
            assertCurrent(expectedGeneration);
          }
          update({ state: 'sharing', captureSettings: settings, error: null });
        } catch (error) {
          return failForGeneration(expectedGeneration, error);
        }
      })();
      return startPromise;
    },
    stop: () => cleanupSession('idle'),
    handleLeaseLost: () =>
      cleanupSession('error', new ScreenControllerError('LEASE_LOST')),
    handleSignalingClosed: () =>
      cleanupSession(
        'error',
        Object.assign(new Error('Signaling closed'), {
          code: 'SIGNALING_CLOSED',
        }),
      ),
    cleanup: () => cleanupSession('idle'),
  };
  return Object.freeze(controller);
}
