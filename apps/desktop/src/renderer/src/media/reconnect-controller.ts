export type ReconnectState =
  | 'connected'
  | 'reconnecting-signal'
  | 'waiting-ice'
  | 'restarting-ice'
  | 'rebuilding-transport'
  | 'closing'
  | 'closed'
  | 'failed'
  | 'stopped';

export type ReconnectControllerErrorCode =
  'INVALID_CONFIGURATION' | 'RECOVERY_TIMEOUT' | 'RECOVERY_FAILED';

export class ReconnectControllerError extends Error {
  constructor(
    readonly code: ReconnectControllerErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ReconnectControllerError';
  }
}

export type ReconnectResumeResult =
  | Readonly<{
      status: 'resumed';
      transport: 'healthy';
    }>
  | Readonly<{ status: 'reset_required' }>
  | Readonly<{ status: 'room_closed' }>;

export interface ReconnectFailure {
  readonly code: 'RECOVERY_TIMEOUT' | 'RECOVERY_FAILED';
  readonly message: string;
}

export interface ReconnectSnapshot {
  readonly state: ReconnectState;
  readonly generation: number;
  readonly error: ReconnectFailure | null;
}

export interface SignalingCloseEvent {
  readonly code: number;
  readonly reason: string;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type IceRecoveryIntent = 'disconnected' | 'failed';

export interface ReconnectControllerOptions {
  readonly role: 'creator' | 'joiner';
  readonly cleanupShare: () => Promise<void>;
  readonly resume: () => Promise<ReconnectResumeResult>;
  readonly fullCleanup: () => Promise<void>;
  readonly rebuildTransport: () => Promise<void>;
  readonly refreshIceServers: () => Promise<void>;
  readonly waitForStable: () => Promise<void>;
  readonly prepareRecoveryCompletion: () => Promise<void>;
  readonly restartIce: () => void | Promise<void>;
  readonly requestRestart: (requestId: string) => Promise<void>;
  readonly recoverFailedRestart: (requestId: string) => Promise<void>;
  readonly makeRequestId?: () => string;
  readonly disconnectedGraceMs?: number;
  readonly operationTimeoutMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle) => void;
}

export interface ReconnectController {
  getSnapshot(): ReconnectSnapshot;
  subscribe(listener: () => void): () => void;
  handleSignalingClose(event: SignalingCloseEvent): Promise<void>;
  handleIceConnectionState(state: RTCIceConnectionState): Promise<void>;
  handleAuthoritativeReset(): Promise<boolean>;
  handleRoomClosed(): Promise<void>;
  /**
   * Peer left the room intentionally (or long enough to be dropped). Cancel
   * in-flight ICE recovery so a collapsing PeerConnection cannot mark the
   * session terminal while the remaining member waits for a rejoin.
   */
  clearMediaRecovery(): void;
  stop(): void;
}

const DEFAULT_DISCONNECTED_GRACE_MS = 2_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const MAX_DELAY_MS = 120_000;
const SESSION_REPLACED_CODE = 4409;
const SESSION_REPLACED_REASON = 'SESSION_REPLACED';
const RESOLVED = Promise.resolve();

function validDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DELAY_MS) {
    throw new ReconnectControllerError(
      'INVALID_CONFIGURATION',
      `${name} is out of range`,
    );
  }
  return value;
}

function failureFor(error: unknown): ReconnectFailure {
  if (
    error instanceof ReconnectControllerError &&
    (error.code === 'RECOVERY_TIMEOUT' || error.code === 'RECOVERY_FAILED')
  ) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  return Object.freeze({
    code: 'RECOVERY_FAILED',
    message: error instanceof Error ? error.message : 'Recovery failed',
  });
}

function recoveryError(error: unknown): ReconnectControllerError {
  return error instanceof ReconnectControllerError
    ? error
    : new ReconnectControllerError(
        'RECOVERY_FAILED',
        error instanceof Error ? error.message : 'Recovery failed',
        error,
      );
}

export function createReconnectController(
  options: ReconnectControllerOptions,
): ReconnectController {
  if (options.role !== 'creator' && options.role !== 'joiner') {
    throw new ReconnectControllerError(
      'INVALID_CONFIGURATION',
      'Invalid reconnect role',
    );
  }
  const disconnectedGraceMs = validDelay(
    options.disconnectedGraceMs ?? DEFAULT_DISCONNECTED_GRACE_MS,
    'disconnectedGraceMs',
  );
  const operationTimeoutMs = validDelay(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    'operationTimeoutMs',
  );
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  const makeRequestId = options.makeRequestId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  const operationTimers = new Set<TimerHandle>();
  let snapshot: ReconnectSnapshot = Object.freeze({
    state: 'connected',
    generation: 0,
    error: null,
  });
  let disconnectedTimer: TimerHandle | null = null;
  let resumeFlight: Promise<void> | null = null;
  let resumeAttemptOwnsSocket = false;
  let queuedSignalResume = false;
  let iceFlight: Promise<void> | null = null;
  let queuedIceFlight: Promise<void> | null = null;
  let queuedIceIntent: IceRecoveryIntent | null = null;
  let terminalFlight: Promise<void> | null = null;
  let authoritativeResetFlight: Promise<boolean> | null = null;
  let resumeAfterAuthoritativeReset = false;
  let deferredSignalResumeFlight: Promise<void> | null = null;
  let transportRebuiltGeneration: number | null = null;

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Observer failures cannot change recovery ownership.
      }
    }
  };

  const replaceSnapshot = (next: ReconnectSnapshot): void => {
    snapshot = Object.freeze(next);
    emit();
  };

  const begin = (state: ReconnectState): number => {
    const generation = snapshot.generation + 1;
    replaceSnapshot({ state, generation, error: null });
    return generation;
  };

  const updateState = (generation: number, state: ReconnectState): boolean => {
    if (snapshot.generation !== generation) return false;
    replaceSnapshot({ state, generation, error: null });
    return true;
  };

  const isCurrent = (generation: number): boolean =>
    snapshot.generation === generation &&
    snapshot.state !== 'closed' &&
    snapshot.state !== 'stopped';

  const clearDisconnectedTimer = (): void => {
    if (disconnectedTimer === null) return;
    clearTimer(disconnectedTimer);
    disconnectedTimer = null;
  };

  const clearOperationTimers = (): void => {
    for (const timer of operationTimers) clearTimer(timer);
    operationTimers.clear();
  };

  const timed = <T>(operation: Promise<T>): Promise<T> => {
    let timer: TimerHandle;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimer(() => {
        operationTimers.delete(timer);
        reject(
          new ReconnectControllerError(
            'RECOVERY_TIMEOUT',
            'Recovery operation timed out',
          ),
        );
      }, operationTimeoutMs);
      operationTimers.add(timer);
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (operationTimers.delete(timer)) clearTimer(timer);
    });
  };

  const failCurrent = (
    generation: number,
    error: ReconnectControllerError,
  ): void => {
    if (!isCurrent(generation)) return;
    clearDisconnectedTimer();
    clearOperationTimers();
    replaceSnapshot({
      state: 'failed',
      generation: generation + 1,
      error: failureFor(error),
    });
  };

  const finishFlight = <Value>(
    flight: Promise<Value>,
    current: () => Promise<Value> | null,
    clear: () => void,
  ): void => {
    void flight.then(
      () => {
        if (current() === flight) clear();
      },
      () => {
        if (current() === flight) clear();
      },
    );
  };

  const performIceRecovery = async (generation: number): Promise<void> => {
    const completed = options.prepareRecoveryCompletion();
    if (options.role === 'creator') {
      await options.refreshIceServers();
      if (!isCurrent(generation)) return;
      await options.waitForStable();
      if (!isCurrent(generation)) return;
      await options.restartIce();
      await completed;
      return;
    }
    await options.waitForStable();
    if (!isCurrent(generation)) return;
    const requestId = makeRequestId();
    if (requestId.length === 0) {
      throw new ReconnectControllerError(
        'RECOVERY_FAILED',
        'Restart request ID is empty',
      );
    }
    await options.requestRestart(requestId);
    await completed;
  };

  const startIceRecovery = (): Promise<void> => {
    if (snapshot.state === 'closed' || snapshot.state === 'stopped') {
      return RESOLVED;
    }
    if (terminalFlight !== null) return terminalFlight;
    if (authoritativeResetFlight !== null) {
      return authoritativeResetFlight.then(() => undefined);
    }
    if (resumeFlight !== null) return resumeFlight;
    if (iceFlight !== null) return iceFlight;
    clearDisconnectedTimer();
    const generation = begin('restarting-ice');
    const body = (async () => {
      try {
        await timed(performIceRecovery(generation));
        if (isCurrent(generation)) updateState(generation, 'connected');
      } catch (primaryError) {
        if (!isCurrent(generation)) return;
        updateState(generation, 'rebuilding-transport');
        try {
          await timed(
            (async () => {
              await options.cleanupShare();
              if (!isCurrent(generation)) return;
              const requestId = makeRequestId();
              if (requestId.length === 0) {
                throw new ReconnectControllerError(
                  'RECOVERY_FAILED',
                  'Recovery reset request ID is empty',
                );
              }
              await options.recoverFailedRestart(requestId);
            })(),
          );
          if (isCurrent(generation)) updateState(generation, 'connected');
        } catch (fallbackError) {
          if (!isCurrent(generation)) return;
          const typed = recoveryError(fallbackError);
          failCurrent(generation, typed);
          throw new ReconnectControllerError(
            typed.code,
            typed.message,
            Object.freeze({ primaryError, fallbackError }),
          );
        }
      }
    })();
    const flight = body;
    iceFlight = flight;
    finishFlight(
      flight,
      () => iceFlight,
      () => {
        iceFlight = null;
      },
    );
    return flight;
  };

  const queueIceIntent = (intent: IceRecoveryIntent): void => {
    if (intent === 'failed' || queuedIceIntent === null) {
      queuedIceIntent = intent;
    }
  };

  const startDisconnectedGrace = (): Promise<void> => {
    if (snapshot.state === 'closed' || snapshot.state === 'stopped') {
      return RESOLVED;
    }
    if (terminalFlight !== null) return terminalFlight;
    if (authoritativeResetFlight !== null) {
      return authoritativeResetFlight.then(() => undefined);
    }
    if (iceFlight !== null) return iceFlight;
    if (disconnectedTimer !== null) return RESOLVED;
    const generation = begin('waiting-ice');
    disconnectedTimer = setTimer(() => {
      disconnectedTimer = null;
      if (isCurrent(generation)) void startIceRecovery().catch(() => undefined);
    }, disconnectedGraceMs);
    return RESOLVED;
  };

  const startTerminalCleanup = (): Promise<void> => {
    if (snapshot.state === 'stopped') return RESOLVED;
    if (terminalFlight !== null) return terminalFlight;
    if (snapshot.state === 'closed') return RESOLVED;
    queuedIceIntent = null;
    clearDisconnectedTimer();
    clearOperationTimers();
    const generation = begin('closing');
    const body = (async () => {
      await options.fullCleanup();
      if (isCurrent(generation)) updateState(generation, 'closed');
    })();
    const flight = timed(body).catch((error: unknown) => {
      if (!isCurrent(generation)) return;
      const typed = recoveryError(error);
      failCurrent(generation, typed);
      throw typed;
    });
    terminalFlight = flight;
    finishFlight(
      flight,
      () => terminalFlight,
      () => {
        terminalFlight = null;
      },
    );
    return flight;
  };

  const startAuthoritativeReset = (): Promise<boolean> => {
    if (snapshot.state === 'closed' || snapshot.state === 'stopped') {
      return Promise.resolve(false);
    }
    if (terminalFlight !== null) return terminalFlight.then(() => false);
    if (authoritativeResetFlight !== null) return authoritativeResetFlight;
    clearDisconnectedTimer();
    clearOperationTimers();
    queuedIceIntent = null;
    queuedSignalResume = false;
    iceFlight = null;
    const generation = begin('rebuilding-transport');
    const body = (async (): Promise<boolean> => {
      await options.cleanupShare();
      if (!isCurrent(generation) || resumeAfterAuthoritativeReset) return false;
      await options.rebuildTransport();
      if (!isCurrent(generation) || resumeAfterAuthoritativeReset) return false;
      updateState(generation, 'connected');
      return true;
    })();
    const flight = timed(body).catch((error: unknown) => {
      if (resumeAfterAuthoritativeReset || !isCurrent(generation)) return false;
      const typed = recoveryError(error);
      failCurrent(generation, typed);
      throw typed;
    });
    authoritativeResetFlight = flight;
    finishFlight(
      flight,
      () => authoritativeResetFlight,
      () => {
        authoritativeResetFlight = null;
      },
    );
    return flight;
  };

  const queueIceAfterResume = (intent: IceRecoveryIntent): Promise<void> => {
    queueIceIntent(intent);
    if (queuedIceFlight !== null) return queuedIceFlight;
    const activeResume = resumeFlight;
    if (activeResume === null) {
      const recovery = queuedIceIntent;
      queuedIceIntent = null;
      return recovery === 'failed'
        ? startIceRecovery()
        : startDisconnectedGrace();
    }
    const resumeGeneration = snapshot.generation;
    const flight = activeResume.then(() => {
      if (
        snapshot.state === 'closed' ||
        snapshot.state === 'stopped' ||
        snapshot.generation !== resumeGeneration ||
        transportRebuiltGeneration === resumeGeneration
      ) {
        if (transportRebuiltGeneration === resumeGeneration) {
          queuedIceIntent = null;
        }
        return;
      }
      const recovery = queuedIceIntent;
      queuedIceIntent = null;
      if (recovery === 'failed') return startIceRecovery();
      if (recovery === 'disconnected') return startDisconnectedGrace();
    });
    queuedIceFlight = flight;
    finishFlight(
      flight,
      () => queuedIceFlight,
      () => {
        queuedIceFlight = null;
      },
    );
    return flight;
  };

  const startSignalResume = (
    afterAuthoritativeReset = false,
  ): Promise<void> => {
    if (snapshot.state === 'closed' || snapshot.state === 'stopped') {
      return RESOLVED;
    }
    if (terminalFlight !== null) return terminalFlight;
    if (authoritativeResetFlight !== null && !afterAuthoritativeReset) {
      resumeAfterAuthoritativeReset = true;
      if (deferredSignalResumeFlight !== null) {
        return deferredSignalResumeFlight;
      }
      const pendingReset = authoritativeResetFlight;
      const deferred = pendingReset
        .catch(() => false)
        .then(() => {
          resumeAfterAuthoritativeReset = false;
          return startSignalResume(true);
        });
      deferredSignalResumeFlight = deferred;
      finishFlight(
        deferred,
        () => deferredSignalResumeFlight,
        () => {
          deferredSignalResumeFlight = null;
        },
      );
      return deferred;
    }
    if (resumeFlight !== null) {
      if (resumeAttemptOwnsSocket) queuedSignalResume = true;
      return resumeFlight;
    }
    if (
      !afterAuthoritativeReset &&
      (iceFlight !== null ||
        snapshot.state === 'restarting-ice' ||
        snapshot.state === 'failed')
    ) {
      queueIceIntent('failed');
    } else if (
      !afterAuthoritativeReset &&
      (disconnectedTimer !== null || snapshot.state === 'waiting-ice')
    ) {
      queueIceIntent('disconnected');
    }
    iceFlight = null;
    clearDisconnectedTimer();
    const generation = begin('reconnecting-signal');
    const body = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        queuedSignalResume = false;
        try {
          await options.cleanupShare();
          if (!isCurrent(generation)) return;
          resumeAttemptOwnsSocket = true;
          const result = await options.resume();
          if (!isCurrent(generation)) return;
          if (result.status === 'room_closed') {
            await startTerminalCleanup();
            return;
          }
          if (result.status === 'reset_required') {
            updateState(generation, 'rebuilding-transport');
            await options.rebuildTransport();
            if (isCurrent(generation)) {
              transportRebuiltGeneration = generation;
              updateState(generation, 'connected');
            }
            if (queuedSignalResume) {
              throw new Error('Signaling closed during transport rebuild');
            }
            resumeAttemptOwnsSocket = false;
            return;
          }
          if (isCurrent(generation)) updateState(generation, 'connected');
          if (queuedSignalResume) {
            throw new Error('Signaling closed during resume completion');
          }
          resumeAttemptOwnsSocket = false;
          return;
        } catch (error) {
          resumeAttemptOwnsSocket = false;
          if (!isCurrent(generation)) return;
          if (!queuedSignalResume || attempt === 1) throw error;
        }
      }
    })();
    const flight = timed(body).catch((error: unknown) => {
      if (!isCurrent(generation)) return;
      const typed = recoveryError(error);
      failCurrent(generation, typed);
      throw typed;
    });
    resumeFlight = flight;
    finishFlight(
      flight,
      () => resumeFlight,
      () => {
        resumeFlight = null;
      },
    );
    if (queuedIceIntent !== null) {
      void queueIceAfterResume(queuedIceIntent).catch(() => undefined);
    }
    return flight;
  };

  const controller: ReconnectController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handleSignalingClose(event) {
      if (
        event.code === SESSION_REPLACED_CODE &&
        event.reason === SESSION_REPLACED_REASON
      ) {
        return startTerminalCleanup();
      }
      return startSignalResume();
    },
    handleIceConnectionState(state) {
      if (snapshot.state === 'closed' || snapshot.state === 'stopped') {
        return RESOLVED;
      }
      if (authoritativeResetFlight !== null) {
        return authoritativeResetFlight.then(() => undefined);
      }
      if (state === 'connected' || state === 'completed') {
        queuedIceIntent = null;
        if (disconnectedTimer !== null) {
          clearDisconnectedTimer();
          begin('connected');
        }
        return RESOLVED;
      }
      if (state === 'failed') {
        return resumeFlight === null
          ? startIceRecovery()
          : queueIceAfterResume('failed');
      }
      if (state !== 'disconnected') return RESOLVED;
      if (resumeFlight !== null) {
        return queueIceAfterResume('disconnected');
      }
      if (
        disconnectedTimer !== null ||
        iceFlight !== null ||
        terminalFlight !== null
      ) {
        return iceFlight ?? terminalFlight ?? RESOLVED;
      }
      return startDisconnectedGrace();
    },
    handleAuthoritativeReset: startAuthoritativeReset,
    handleRoomClosed: startTerminalCleanup,
    clearMediaRecovery() {
      if (
        snapshot.state === 'closed' ||
        snapshot.state === 'stopped' ||
        snapshot.state === 'closing'
      ) {
        return;
      }
      clearDisconnectedTimer();
      clearOperationTimers();
      queuedIceIntent = null;
      // Bump generation so any in-flight ICE / rebuild recovery sees isCurrent
      // as false and cannot transition the controller to failed.
      iceFlight = null;
      begin('connected');
    },
    stop() {
      if (snapshot.state === 'stopped') return;
      clearDisconnectedTimer();
      clearOperationTimers();
      queuedIceIntent = null;
      queuedSignalResume = false;
      resumeAttemptOwnsSocket = false;
      authoritativeResetFlight = null;
      deferredSignalResumeFlight = null;
      resumeAfterAuthoritativeReset = false;
      replaceSnapshot({
        state: 'stopped',
        generation: snapshot.generation + 1,
        error: null,
      });
      listeners.clear();
    },
  };
  return Object.freeze(controller);
}
