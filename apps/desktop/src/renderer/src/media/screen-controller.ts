import {
  p2pScreenAcquireAckSchema,
  p2pScreenReleaseAckSchema,
  p2pScreenRenewAckSchema,
  type P2pScreenLease,
} from '@wo/protocol';

import type {
  CaptureSourceSummary,
  DesktopApi,
  SystemAudioMode,
} from '../../../preload/types.js';
import type { RuntimeSchema } from './signaling-client.js';

const RENEWAL_CADENCE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 3_000;
const LEASE_SAFETY_MARGIN_MS = 3_500;
const RELEASE_PENDING_MESSAGE = '屏幕已在本机停止，服务端将在租约到期后释放';

export const DISPLAY_CAPTURE_CONSTRAINTS: DisplayMediaStreamOptions =
  Object.freeze({
    audio: false,
    video: Object.freeze({
      frameRate: Object.freeze({ ideal: 60 }),
    }),
  });

interface ProgramAudioTrackConstraints extends MediaTrackConstraints {
  readonly restrictOwnAudio: true;
  readonly suppressLocalAudioPlayback: false;
}

interface ProgramAudioDisplayMediaStreamOptions extends DisplayMediaStreamOptions {
  readonly audio: ProgramAudioTrackConstraints;
  readonly systemAudio: 'include';
  readonly windowAudio: 'window';
}

export const SYSTEM_AUDIO_DISPLAY_CAPTURE_CONSTRAINTS: ProgramAudioDisplayMediaStreamOptions =
  Object.freeze({
    audio: Object.freeze({
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false,
    }),
    systemAudio: 'include',
    video: DISPLAY_CAPTURE_CONSTRAINTS.video,
    windowAudio: 'window',
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
  readonly systemAudioEnabled: boolean;
  readonly captureSettings: ScreenCaptureSettings | null;
  readonly leaseId: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly error: string | null;
}

export interface ScreenController {
  getSnapshot(): ScreenControllerSnapshot;
  subscribe(listener: () => void): () => void;
  prepare(): Promise<void>;
  /**
   * Re-list OS capture sources while the picker is open so newly opened /
   * closed windows show up without re-acquiring the lease.
   */
  refreshSources(): Promise<void>;
  selectSource(token: string): Promise<void>;
  setSystemAudioEnabled(enabled: boolean): void;
  startSelectedCapture(): Promise<void>;
  stop(): Promise<void>;
  handleLeaseLost(): Promise<void>;
  handleSignalingClosed(): Promise<void>;
  /**
   * Swap the underlying RTP senders to a new RTCPeerConnection without
   * stopping capture or releasing the lease. Called when the transport is
   * rebuilt (e.g. negotiation reset triggered by a participant change).
   * Re-attaches the current video/audio tracks to the new senders.
   */
  reattachTransport(
    newSender: Pick<RTCRtpSender, 'replaceTrack'>,
    newAudioSender?: Pick<RTCRtpSender, 'replaceTrack'>,
  ): Promise<void>;
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
   *
   * Desktop/system audio is never run through the microphone RNNoise path —
   * only the voice-controller mic track is denoised.
   */
  readonly audioSender?: Pick<RTCRtpSender, 'replaceTrack'>;
  readonly signaling: ScreenSignaling;
  readonly capture: Pick<DesktopApi['capture'], 'list' | 'select'>;
  readonly getSystemAudioMode: () => SystemAudioMode;
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

function isCapturePermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}

type ScreenCaptureDiagnosticCode =
  | 'CAPTURE_REQUEST_REJECTED'
  | 'CAPTURE_STREAM_INVALID'
  | 'CAPTURE_VIDEO_TRACK_ENDED'
  | 'CAPTURE_LEASE_RENEW_FAILED'
  | 'VIDEO_SENDER_ATTACH_FAILED'
  | 'AUDIO_SENDER_ATTACH_FAILED'
  | 'SYSTEM_AUDIO_REQUEST_REJECTED'
  | 'SYSTEM_AUDIO_TRACK_UNAVAILABLE';

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
  // Sender references are mutable so they can be swapped when the underlying
  // RTCPeerConnection is rebuilt (e.g. on negotiation reset). The capture
  // track and lease survive the swap.
  let sender: Pick<RTCRtpSender, 'replaceTrack'> = options.sender;
  let audioSender: Pick<RTCRtpSender, 'replaceTrack'> | undefined =
    options.audioSender;
  let snapshot: ScreenControllerSnapshot = Object.freeze({
    state: 'idle',
    sources: Object.freeze([]),
    selectedToken: null,
    systemAudioEnabled: false,
    captureSettings: null,
    leaseId: null,
    leaseExpiresAtMs: null,
    error: null,
  });
  let generation = 0;
  let currentLease: P2pScreenLease | null = null;
  let currentTrack: MediaStreamTrack | null = null;
  let currentAudioTrack: MediaStreamTrack | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  let lifecycleFailure: unknown = null;
  let senderQueue: Promise<void> = Promise.resolve();
  let audioSenderQueue: Promise<void> = Promise.resolve();
  let renewalQueue: Promise<void> = Promise.resolve();
  let refreshPromise: Promise<void> | null = null;

  const update = (change: Partial<ScreenControllerSnapshot>): void => {
    snapshot = Object.freeze({ ...snapshot, ...change });
    for (const listener of listeners) listener();
  };

  const queueSenderTrack = (track: MediaStreamTrack | null): Promise<void> => {
    const operation = senderQueue
      .catch(() => undefined)
      .then(() => sender.replaceTrack(track));
    senderQueue = operation;
    return operation;
  };

  const queueAudioSenderTrack = (
    track: MediaStreamTrack | null,
  ): Promise<void> => {
    const target = audioSender;
    if (target === undefined) return Promise.resolve();
    const operation = audioSenderQueue
      .catch(() => undefined)
      .then(() => target.replaceTrack(track));
    audioSenderQueue = operation;
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
    if (code === 'SYSTEM_AUDIO_UNAVAILABLE') {
      return '未获取到系统音频，请关闭系统音频后重试';
    }
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
    refreshPromise = null;
    clearRenewalTimer();
    const lease = currentLease;
    const track = currentTrack;
    const audioTrack = currentAudioTrack;
    currentLease = null;
    currentTrack = null;
    currentAudioTrack = null;
    startPromise = null;
    update({ state: 'stopping' });
    stopPromise = (async () => {
      await queueSenderTrack(null).catch(() => undefined);
      if (audioTrack !== null && audioSender !== undefined) {
        await queueAudioSenderTrack(null).catch(() => undefined);
      }
      track?.removeEventListener('ended', handleTrackEnded);
      audioTrack?.removeEventListener('ended', handleAudioTrackEnded);
      track?.stop();
      audioTrack?.stop();
      const released = lease === null ? true : await releaseLease(lease);
      update({
        state: finalState,
        sources: Object.freeze([]),
        selectedToken: null,
        systemAudioEnabled: false,
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

  function handleAudioTrackEnded(): void {
    const track = currentAudioTrack;
    if (track === null) return;
    currentAudioTrack = null;
    track.removeEventListener('ended', handleAudioTrackEnded);
    track.stop();
    update({ systemAudioEnabled: false });
    void queueAudioSenderTrack(null).catch(() => undefined);
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

  const failCaptureStage = async (
    expectedGeneration: number,
    error: unknown,
    diagnosticCode: ScreenCaptureDiagnosticCode,
  ): Promise<never> => {
    if (isCapturePermissionError(error) || errorCode(error) === 'LEASE_LOST') {
      return failForGeneration(expectedGeneration, error);
    }
    if (generation !== expectedGeneration) {
      throw lifecycleFailure ?? error;
    }
    console.error(
      `[screen-controller] capture failed at ${diagnosticCode}:`,
      error,
    );
    await cleanupSession('error', error);
    throw error;
  };

  const recoverFromLoopbackFailure = async (
    expectedGeneration: number,
    selectedSource: CaptureSourceSummary | null,
    cause: unknown,
    diagnosticCode:
      'SYSTEM_AUDIO_REQUEST_REJECTED' | 'SYSTEM_AUDIO_TRACK_UNAVAILABLE',
  ): Promise<never> => {
    console.error(
      `[screen-controller] capture failed at ${diagnosticCode}:`,
      cause,
    );
    const failure = Object.assign(
      new Error('System audio capture could not start', { cause }),
      { code: 'SYSTEM_AUDIO_UNAVAILABLE' },
    );
    let sources: readonly CaptureSourceSummary[];
    let selectedToken: string | null = null;
    try {
      sources = Object.freeze([...(await options.capture.list())]);
      assertCurrent(expectedGeneration);
      if (selectedSource !== null) {
        const matches = sources.filter(
          (source) =>
            source.name === selectedSource.name &&
            source.kind === selectedSource.kind,
        );
        if (matches.length === 1) {
          selectedToken = matches[0]!.token;
          await options.capture.select(selectedToken);
          assertCurrent(expectedGeneration);
        }
      }
    } catch {
      return failForGeneration(expectedGeneration, failure);
    }
    startPromise = null;
    update({
      state: 'picking',
      sources,
      selectedToken,
      systemAudioEnabled: false,
      captureSettings: null,
      error:
        selectedToken === null
          ? '系统音频启动失败，已关闭系统音频；请重新选择共享内容'
          : '系统音频启动失败，已关闭系统音频；请再次点击开始共享',
    });
    throw failure;
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
      refreshPromise = null;
      const expectedGeneration = generation;
      update({
        state: 'acquiring',
        sources: Object.freeze([]),
        selectedToken: null,
        systemAudioEnabled: false,
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
        if (options.getSystemAudioMode() === 'native-picker') {
          update({
            state: 'picking',
            sources: Object.freeze([]),
            selectedToken: null,
          });
          return;
        }
        const sources = await options.capture.list();
        assertCurrent(expectedGeneration);
        update({ state: 'picking', sources: Object.freeze([...sources]) });
      } catch (error) {
        await failForGeneration(expectedGeneration, error);
      }
    },
    refreshSources() {
      if (snapshot.state !== 'picking') {
        return Promise.resolve();
      }
      if (options.getSystemAudioMode() === 'native-picker') {
        return Promise.resolve();
      }
      if (refreshPromise !== null) return refreshPromise;
      const expectedGeneration = generation;
      const operation = (async (): Promise<void> => {
        try {
          const sources = await options.capture.list();
          assertCurrent(expectedGeneration);
          const frozen = Object.freeze([...sources]);
          const selectedStillPresent =
            snapshot.selectedToken !== null &&
            frozen.some((source) => source.token === snapshot.selectedToken);
          update({
            sources: frozen,
            selectedToken: selectedStillPresent ? snapshot.selectedToken : null,
            error: null,
          });
        } catch (error) {
          // Keep the picker open with the previous list; surface a soft error.
          if (generation === expectedGeneration) {
            update({
              error:
                error instanceof Error
                  ? error.message
                  : '无法刷新可共享内容列表',
            });
          }
        }
      })();
      refreshPromise = operation;
      void operation.then(
        () => {
          if (refreshPromise === operation) refreshPromise = null;
        },
        () => {
          if (refreshPromise === operation) refreshPromise = null;
        },
      );
      return operation;
    },
    async selectSource(token) {
      if (
        snapshot.state !== 'picking' ||
        options.getSystemAudioMode() === 'native-picker'
      ) {
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
    setSystemAudioEnabled(enabled) {
      if (snapshot.state !== 'picking') {
        throw new ScreenControllerError('INVALID_STATE');
      }
      const systemAudioMode = options.getSystemAudioMode();
      if (systemAudioMode === 'native-picker') {
        throw new ScreenControllerError('INVALID_STATE');
      }
      if (enabled && systemAudioMode === 'unsupported') {
        throw Object.assign(new Error('System audio capture is unavailable'), {
          code: 'SYSTEM_AUDIO_UNSUPPORTED',
        });
      }
      update({ systemAudioEnabled: enabled, error: null });
    },
    startSelectedCapture() {
      const systemAudioMode = options.getSystemAudioMode();
      if (
        snapshot.state !== 'picking' ||
        (systemAudioMode !== 'native-picker' && snapshot.selectedToken === null)
      ) {
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
      const systemAudioEnabled = snapshot.systemAudioEnabled;
      const nativeSystemPicker = systemAudioMode === 'native-picker';
      const systemAudioRequested = nativeSystemPicker || systemAudioEnabled;
      if (systemAudioEnabled && systemAudioMode === 'unsupported') {
        return fail(
          Object.assign(new Error('System audio capture is unavailable'), {
            code: 'SYSTEM_AUDIO_UNSUPPORTED',
          }),
        );
      }
      const pendingRefresh = refreshPromise;
      update({ state: 'capturing', error: null });
      startPromise = (async () => {
        if (pendingRefresh !== null) {
          await pendingRefresh;
          assertCurrent(expectedGeneration);
        }
        const selectedSource =
          snapshot.selectedToken === null
            ? null
            : (snapshot.sources.find(
                (source) => source.token === snapshot.selectedToken,
              ) ?? null);
        if (!nativeSystemPicker && selectedSource === null) {
          return failCaptureStage(
            expectedGeneration,
            new ScreenControllerError('INVALID_STATE'),
            'CAPTURE_REQUEST_REJECTED',
          );
        }
        let capturePromise: Promise<MediaStream>;
        try {
          capturePromise = Promise.resolve(
            mediaDevices.getDisplayMedia(
              systemAudioRequested
                ? SYSTEM_AUDIO_DISPLAY_CAPTURE_CONSTRAINTS
                : DISPLAY_CAPTURE_CONSTRAINTS,
            ),
          );
        } catch (error) {
          console.error(
            '[screen-controller] getDisplayMedia threw synchronously:',
            error,
          );
          return failCaptureStage(
            expectedGeneration,
            error,
            'CAPTURE_REQUEST_REJECTED',
          );
        }
        let stream: MediaStream;
        try {
          stream = await capturePromise;
        } catch (error) {
          console.error(
            '[screen-controller] getDisplayMedia was rejected:',
            error,
          );
          if (
            systemAudioEnabled &&
            !nativeSystemPicker &&
            !isCapturePermissionError(error)
          ) {
            return recoverFromLoopbackFailure(
              expectedGeneration,
              selectedSource,
              error,
              'SYSTEM_AUDIO_REQUEST_REJECTED',
            );
          }
          return failCaptureStage(
            expectedGeneration,
            error,
            'CAPTURE_REQUEST_REJECTED',
          );
        }
        if (generation !== expectedGeneration) {
          stopStream(stream);
          throw lifecycleFailure ?? new ScreenControllerError('INVALID_STATE');
        }
        const tracks = stream.getTracks();
        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        // The native picker owns its audio consent. Custom pickers keep the
        // explicit application opt-in and reject unexpected audio.
        if (
          videoTracks.length !== 1 ||
          videoTracks[0]!.kind !== 'video' ||
          audioTracks.length > 1 ||
          (!systemAudioRequested && audioTracks.length > 0) ||
          tracks.length !== videoTracks.length + audioTracks.length
        ) {
          stopStream(stream);
          return failCaptureStage(
            expectedGeneration,
            new ScreenControllerError('INVALID_STATE'),
            'CAPTURE_STREAM_INVALID',
          );
        }
        let audioTrack: MediaStreamTrack | null = audioTracks[0] ?? null;
        if (
          systemAudioEnabled &&
          !nativeSystemPicker &&
          (audioTrack === null || trackEnded(audioTrack))
        ) {
          stopStream(stream);
          return recoverFromLoopbackFailure(
            expectedGeneration,
            selectedSource,
            new Error('System audio capture did not provide a live track'),
            'SYSTEM_AUDIO_TRACK_UNAVAILABLE',
          );
        }
        if (
          nativeSystemPicker &&
          audioTrack !== null &&
          trackEnded(audioTrack)
        ) {
          audioTrack.stop();
          audioTrack = null;
        }
        if (audioTrack !== null) {
          audioTrack.contentHint = 'music';
        }
        const track = videoTracks[0]!;
        currentTrack = track;
        currentAudioTrack = audioTrack;
        track.addEventListener('ended', handleTrackEnded, { once: true });
        audioTrack?.addEventListener('ended', handleAudioTrackEnded, {
          once: true,
        });
        const settings = captureSettings(track);
        let diagnosticCode: ScreenCaptureDiagnosticCode =
          'CAPTURE_VIDEO_TRACK_ENDED';
        try {
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          diagnosticCode = 'CAPTURE_LEASE_RENEW_FAILED';
          await renew(expectedGeneration);
          assertCurrent(expectedGeneration);
          diagnosticCode = 'CAPTURE_VIDEO_TRACK_ENDED';
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          diagnosticCode = 'VIDEO_SENDER_ATTACH_FAILED';
          await queueSenderTrack(track);
          assertCurrent(expectedGeneration);
          diagnosticCode = 'CAPTURE_VIDEO_TRACK_ENDED';
          if (trackEnded(track)) {
            throw new ScreenControllerError('INVALID_STATE');
          }
          // Attach desktop audio if present and a sender is available.
          if (
            audioTrack !== null &&
            currentAudioTrack === audioTrack &&
            !trackEnded(audioTrack) &&
            audioSender !== undefined
          ) {
            diagnosticCode = 'AUDIO_SENDER_ATTACH_FAILED';
            await queueAudioSenderTrack(audioTrack);
            assertCurrent(expectedGeneration);
          }
          update({
            state: 'sharing',
            systemAudioEnabled: audioTrack !== null,
            captureSettings: settings,
            error: null,
          });
        } catch (error) {
          return failCaptureStage(expectedGeneration, error, diagnosticCode);
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
    reattachTransport: async (newSender, newAudioSender) => {
      // Only re-attach if we're actively sharing. If idle/picking/etc.
      // there's nothing to preserve.
      if (snapshot.state !== 'sharing' && snapshot.state !== 'capturing') {
        sender = newSender;
        audioSender = newAudioSender;
        return;
      }
      const expectedGeneration = generation;
      const previousState = snapshot.state;
      sender = newSender;
      audioSender = newAudioSender;
      // Reset the sender queue so replaceTrack calls go to the new sender.
      senderQueue = Promise.resolve();
      audioSenderQueue = Promise.resolve();
      const video = currentTrack;
      const audio = currentAudioTrack;
      try {
        if (video !== null) {
          await queueSenderTrack(video);
          assertCurrent(expectedGeneration);
        }
        if (
          audio !== null &&
          currentAudioTrack === audio &&
          !trackEnded(audio) &&
          audioSender !== undefined
        ) {
          await queueAudioSenderTrack(audio);
          assertCurrent(expectedGeneration);
        }
        if (generation === expectedGeneration) {
          update({ state: previousState, error: null });
        }
      } catch (error) {
        await failForGeneration(expectedGeneration, error);
      }
    },
    cleanup: () => cleanupSession('idle'),
  };
  return Object.freeze(controller);
}
