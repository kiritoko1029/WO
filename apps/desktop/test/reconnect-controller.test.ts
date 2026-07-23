import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ReconnectControllerError,
  createReconnectController,
  type ReconnectControllerOptions,
  type ReconnectResumeResult,
} from '../src/renderer/src/media/reconnect-controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  input: Partial<ReconnectControllerOptions> & {
    readonly role?: 'creator' | 'joiner';
  } = {},
) {
  let requestSequence = 0;
  const order: string[] = [];
  const cleanupShare = vi.fn(async () => {
    order.push('cleanup-share');
  });
  const resume = vi.fn(async (): Promise<ReconnectResumeResult> => {
    order.push('resume');
    return { status: 'resumed', transport: 'healthy' };
  });
  const fullCleanup = vi.fn(async () => {
    order.push('full-cleanup');
  });
  const rebuildTransport = vi.fn(async () => {
    order.push('rebuild-transport');
  });
  const refreshIceServers = vi.fn(async () => {
    order.push('refresh-ice-servers');
  });
  const waitForStable = vi.fn(async () => {
    order.push('wait-for-stable');
  });
  const prepareRecoveryCompletion = vi.fn(async () => undefined);
  const restartIce = vi.fn(async () => {
    order.push('restart-ice');
  });
  const requestRestart = vi.fn(async (requestId: string) => {
    order.push(`request-restart:${requestId}`);
  });
  const recoverFailedRestart = vi.fn(async (requestId: string) => {
    order.push(`recover-failed-restart:${requestId}`);
  });
  const defaults: ReconnectControllerOptions = {
    role: input.role ?? 'creator',
    cleanupShare,
    resume,
    fullCleanup,
    rebuildTransport,
    refreshIceServers,
    waitForStable,
    prepareRecoveryCompletion,
    restartIce,
    requestRestart,
    recoverFailedRestart,
    makeRequestId: () => `restart-${++requestSequence}`,
    disconnectedGraceMs: 1_500,
    operationTimeoutMs: 5_000,
  };
  const options = { ...defaults, ...input };
  const controller = createReconnectController(options);
  return {
    cleanupShare: vi.mocked(options.cleanupShare),
    controller,
    fullCleanup: vi.mocked(options.fullCleanup),
    order,
    rebuildTransport: vi.mocked(options.rebuildTransport),
    refreshIceServers: vi.mocked(options.refreshIceServers),
    recoverFailedRestart: vi.mocked(options.recoverFailedRestart),
    requestRestart: vi.mocked(options.requestRestart),
    restartIce: vi.mocked(options.restartIce),
    resume: vi.mocked(options.resume),
    waitForStable: vi.mocked(options.waitForStable),
    prepareRecoveryCompletion: vi.mocked(options.prepareRecoveryCompletion),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('reconnect controller', () => {
  test('clearMediaRecovery cancels in-flight ICE recovery so peer leave cannot fail the session', async () => {
    const harness = createHarness({
      role: 'creator',
      restartIce: vi.fn(async () => {
        await new Promise(() => undefined);
      }),
    });

    const recovery = harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() =>
      expect(harness.controller.getSnapshot().state).toBe('restarting-ice'),
    );

    harness.controller.clearMediaRecovery();
    expect(harness.controller.getSnapshot().state).toBe('connected');
    expect(harness.controller.getSnapshot().error).toBeNull();

    // In-flight recovery must not force the controller into failed after leave.
    await Promise.race([
      recovery.then(
        () => undefined,
        () => undefined,
      ),
      vi.advanceTimersByTimeAsync(10_000),
    ]);
    expect(harness.controller.getSnapshot().state).toBe('connected');
    expect(harness.controller.getSnapshot().error).toBeNull();
  });

  test('cleans share immediately and single-flights a normal WSS resume while reusing healthy transport', async () => {
    const shareCleanup = deferred<void>();
    const harness = createHarness({
      cleanupShare: vi.fn(() => shareCleanup.promise),
    });

    const first = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    const duplicate = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost again',
    });

    expect(duplicate).toBe(first);
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'reconnecting-signal',
      error: null,
    });
    expect(harness.controller.getSnapshot().generation).toBe(1);
    expect(harness.resume).not.toHaveBeenCalled();
    shareCleanup.resolve();
    await first;

    expect(harness.resume).toHaveBeenCalledOnce();
    expect(harness.rebuildTransport).not.toHaveBeenCalled();
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'connected',
      error: null,
    });
  });

  test('retries once on a fresh socket when the resume socket closes mid-request', async () => {
    const firstResume = deferred<ReconnectResumeResult>();
    const resume = vi
      .fn<() => Promise<ReconnectResumeResult>>()
      .mockImplementationOnce(() => firstResume.promise)
      .mockResolvedValueOnce({ status: 'resumed', transport: 'healthy' });
    const harness = createHarness({ resume });
    const recovery = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

    const duplicate = harness.controller.handleSignalingClose({
      code: 1011,
      reason: 'SIGNALING_RECOVERY_FAILED',
    });
    expect(duplicate).toBe(recovery);
    firstResume.reject(new Error('resume socket closed'));

    await recovery;
    expect(resume).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('retries on a fresh socket when it closes during resumed reset rebuild', async () => {
    const rebuilding = deferred<void>();
    const resume = vi
      .fn<() => Promise<ReconnectResumeResult>>()
      .mockResolvedValueOnce({ status: 'reset_required' })
      .mockResolvedValueOnce({ status: 'resumed', transport: 'healthy' });
    const harness = createHarness({
      resume,
      rebuildTransport: vi.fn(() => rebuilding.promise),
    });
    const recovery = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() =>
      expect(harness.rebuildTransport).toHaveBeenCalledOnce(),
    );

    const duplicate = harness.controller.handleSignalingClose({
      code: 1011,
      reason: 'socket closed during rebuild',
    });
    expect(duplicate).toBe(recovery);
    rebuilding.resolve();

    await recovery;
    expect(resume).toHaveBeenCalledTimes(2);
    expect(harness.rebuildTransport).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('treats 4409 SESSION_REPLACED as terminal without attempting resume', async () => {
    const harness = createHarness();

    const first = harness.controller.handleSignalingClose({
      code: 4409,
      reason: 'SESSION_REPLACED',
    });
    const duplicate = harness.controller.handleSignalingClose({
      code: 4409,
      reason: 'SESSION_REPLACED',
    });
    expect(duplicate).toBe(first);
    await first;

    expect(harness.fullCleanup).toHaveBeenCalledOnce();
    expect(harness.cleanupShare).not.toHaveBeenCalled();
    expect(harness.resume).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot().state).toBe('closed');
  });

  test('rebuilds transport once when resume reports reset_required', async () => {
    const harness = createHarness({
      resume: vi.fn(async () => ({ status: 'reset_required' as const })),
    });

    await harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });

    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.rebuildTransport).toHaveBeenCalledOnce();
    expect(harness.order).toEqual(['cleanup-share', 'rebuild-transport']);
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('routes a room-closed resume outcome through full cleanup', async () => {
    const harness = createHarness({
      resume: vi.fn(async () => ({ status: 'room_closed' as const })),
    });

    await harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'server restart',
    });

    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.fullCleanup).toHaveBeenCalledOnce();
    expect(harness.rebuildTransport).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot().state).toBe('closed');
  });

  test('room closed invalidates and discards a late resume result', async () => {
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({
      resume: vi.fn(() => resumed.promise),
    });
    const resuming = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());

    await harness.controller.handleRoomClosed();
    const closedGeneration = harness.controller.getSnapshot().generation;
    resumed.resolve({ status: 'reset_required' });
    await resuming;

    expect(harness.fullCleanup).toHaveBeenCalledOnce();
    expect(harness.rebuildTransport).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'closed',
      generation: closedGeneration,
    });
  });

  test('cancels the disconnected grace when ICE recovers', async () => {
    const harness = createHarness();

    await harness.controller.handleIceConnectionState('disconnected');
    expect(harness.controller.getSnapshot().state).toBe('waiting-ice');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await harness.controller.handleIceConnectionState('connected');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    expect(harness.requestRestart).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('starts creator ICE recovery only after disconnected grace expires', async () => {
    const harness = createHarness();

    await harness.controller.handleIceConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(harness.controller.getSnapshot().state).toBe('connected'),
    );

    expect(harness.refreshIceServers).toHaveBeenCalledOnce();
    expect(harness.waitForStable).toHaveBeenCalledOnce();
    expect(harness.restartIce).toHaveBeenCalledOnce();
  });

  test('publishes snapshots until the observer unsubscribes', async () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = harness.controller.subscribe(listener);

    await harness.controller.handleIceConnectionState('disconnected');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await harness.controller.handleIceConnectionState('connected');

    expect(listener).toHaveBeenCalledOnce();
  });

  test('single-flights creator ICE failure in refresh, stable, restart order', async () => {
    const restart = deferred<void>();
    const harness = createHarness({
      restartIce: vi.fn(() => restart.promise),
    });

    const first = harness.controller.handleIceConnectionState('failed');
    const duplicate = harness.controller.handleIceConnectionState('failed');

    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(harness.restartIce).toHaveBeenCalledOnce());
    expect(harness.order).toEqual(['refresh-ice-servers', 'wait-for-stable']);
    restart.resolve();
    await first;

    expect(harness.requestRestart).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('keeps recovery in flight until the restarted negotiation is accepted', async () => {
    const completed = deferred<void>();
    const harness = createHarness({
      prepareRecoveryCompletion: vi.fn(() => completed.promise),
    });

    const recovery = harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(harness.restartIce).toHaveBeenCalledOnce());
    expect(harness.controller.getSnapshot().state).toBe('restarting-ice');

    completed.resolve();
    await recovery;
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('falls back when restart signaling succeeds but media never reconnects', async () => {
    const neverConnected = deferred<void>();
    const harness = createHarness({
      prepareRecoveryCompletion: vi.fn(() => neverConnected.promise),
      operationTimeoutMs: 1_000,
    });

    const recovery = harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(harness.restartIce).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await recovery;

    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.recoverFailedRestart).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('queues an ICE failure that arrives during signal resume', async () => {
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({ resume: vi.fn(() => resumed.promise) });
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());

    const first = harness.controller.handleIceConnectionState('failed');
    const duplicate = harness.controller.handleIceConnectionState('failed');
    expect(duplicate).toBe(first);
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    resumed.resolve({ status: 'resumed', transport: 'healthy' });
    await Promise.all([signalFlight, first]);

    expect(harness.refreshIceServers).toHaveBeenCalledOnce();
    expect(harness.waitForStable).toHaveBeenCalledOnce();
    expect(harness.restartIce).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('upgrades queued disconnected recovery to failed recovery during signal resume', async () => {
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({ resume: vi.fn(() => resumed.promise) });
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());

    const disconnected =
      harness.controller.handleIceConnectionState('disconnected');
    const failed = harness.controller.handleIceConnectionState('failed');
    expect(failed).toBe(disconnected);
    resumed.resolve({ status: 'resumed', transport: 'healthy' });
    await Promise.all([signalFlight, failed]);

    expect(harness.refreshIceServers).toHaveBeenCalledOnce();
    expect(harness.restartIce).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('replays an ICE failure after a later healthy signal resume', async () => {
    const firstRestart = deferred<void>();
    const resumed = deferred<ReconnectResumeResult>();
    const restartIce = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRestart.promise)
      .mockResolvedValueOnce();
    const harness = createHarness({
      restartIce,
      resume: vi.fn(() => resumed.promise),
    });

    const staleIceFlight =
      harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(restartIce).toHaveBeenCalledOnce());
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost after ICE failed',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());

    resumed.resolve({ status: 'resumed', transport: 'healthy' });
    await signalFlight;
    await vi.waitFor(() => expect(restartIce).toHaveBeenCalledTimes(2));
    firstRestart.resolve();
    await staleIceFlight;

    expect(harness.refreshIceServers).toHaveBeenCalledTimes(2);
    expect(harness.waitForStable).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('restarts the disconnected grace after a later healthy signal resume', async () => {
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({ resume: vi.fn(() => resumed.promise) });

    await harness.controller.handleIceConnectionState('disconnected');
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost while ICE was disconnected',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());
    resumed.resolve({ status: 'resumed', transport: 'healthy' });
    await signalFlight;

    expect(harness.controller.getSnapshot().state).toBe('waiting-ice');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(harness.controller.getSnapshot().state).toBe('connected'),
    );

    expect(harness.refreshIceServers).toHaveBeenCalledOnce();
    expect(harness.restartIce).toHaveBeenCalledOnce();
  });

  test('keeps the replacement ICE flight when the stale flight settles', async () => {
    const firstRestart = deferred<void>();
    const secondRestart = deferred<void>();
    const resumed = deferred<ReconnectResumeResult>();
    const restartIce = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRestart.promise)
      .mockImplementationOnce(() => secondRestart.promise);
    const harness = createHarness({
      restartIce,
      resume: vi.fn(() => resumed.promise),
    });

    const staleIceFlight =
      harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(restartIce).toHaveBeenCalledOnce());
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost after ICE failed',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());
    resumed.resolve({ status: 'resumed', transport: 'healthy' });
    await signalFlight;
    await vi.waitFor(() => expect(restartIce).toHaveBeenCalledTimes(2));

    const replacementFlight =
      harness.controller.handleIceConnectionState('failed');
    firstRestart.resolve();
    await staleIceFlight;
    const duplicate = harness.controller.handleIceConnectionState('failed');

    expect(duplicate).toBe(replacementFlight);
    expect(harness.refreshIceServers).toHaveBeenCalledTimes(2);
    secondRestart.resolve();
    await replacementFlight;
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('does not replay stale ICE recovery after reset_required rebuilds transport', async () => {
    const firstRestart = deferred<void>();
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({
      restartIce: vi.fn(() => firstRestart.promise),
      resume: vi.fn(() => resumed.promise),
    });

    const staleIceFlight =
      harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(harness.restartIce).toHaveBeenCalledOnce());
    const signalFlight = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost after ICE failed',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());
    resumed.resolve({ status: 'reset_required' });
    await signalFlight;
    firstRestart.resolve();
    await staleIceFlight;
    await vi.runAllTicks();

    expect(harness.rebuildTransport).toHaveBeenCalledOnce();
    expect(harness.refreshIceServers).toHaveBeenCalledOnce();
    expect(harness.restartIce).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('authoritative reset invalidates an in-flight ICE restart and owns rebuild', async () => {
    const staleRestart = deferred<void>();
    const harness = createHarness({
      restartIce: vi.fn(() => staleRestart.promise),
    });
    const staleRecovery = harness.controller.handleIceConnectionState('failed');
    await vi.waitFor(() => expect(harness.restartIce).toHaveBeenCalledOnce());

    await expect(harness.controller.handleAuthoritativeReset()).resolves.toBe(
      true,
    );
    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.rebuildTransport).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');

    staleRestart.resolve();
    await staleRecovery;
    expect(harness.recoverFailedRestart).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('lets a fresh socket resume supersede an authoritative reset in progress', async () => {
    const rebuilding = deferred<void>();
    const harness = createHarness({
      rebuildTransport: vi.fn(() => rebuilding.promise),
    });
    const reset = harness.controller.handleAuthoritativeReset();
    await vi.waitFor(() =>
      expect(harness.rebuildTransport).toHaveBeenCalledOnce(),
    );

    const signal = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'socket closed during reset',
    });
    expect(harness.resume).not.toHaveBeenCalled();
    rebuilding.resolve();

    await expect(reset).resolves.toBe(false);
    await signal;
    expect(harness.resume).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test.each(['failed', 'disconnected'] as const)(
    'does not let ICE %s supersede an authoritative reset rebuild',
    async (iceState) => {
      const rebuilding = deferred<void>();
      const harness = createHarness({
        rebuildTransport: vi.fn(() => rebuilding.promise),
      });
      const reset = harness.controller.handleAuthoritativeReset();
      await vi.waitFor(() =>
        expect(harness.rebuildTransport).toHaveBeenCalledOnce(),
      );
      const resetGeneration = harness.controller.getSnapshot().generation;

      const ice = harness.controller.handleIceConnectionState(iceState);
      expect(harness.controller.getSnapshot()).toMatchObject({
        state: 'rebuilding-transport',
        generation: resetGeneration,
      });
      expect(harness.refreshIceServers).not.toHaveBeenCalled();

      rebuilding.resolve();
      await expect(reset).resolves.toBe(true);
      await ice;
      expect(harness.rebuildTransport).toHaveBeenCalledOnce();
      expect(harness.controller.getSnapshot().state).toBe('connected');
    },
  );

  test('single-flights one idempotent restartRequested for joiner ICE failure', async () => {
    const stable = deferred<void>();
    const requested = deferred<void>();
    const requestRestart = vi.fn(() => requested.promise);
    const harness = createHarness({
      role: 'joiner',
      requestRestart,
      waitForStable: vi.fn(() => stable.promise),
    });

    const first = harness.controller.handleIceConnectionState('failed');
    const duplicate = harness.controller.handleIceConnectionState('failed');

    expect(duplicate).toBe(first);
    expect(harness.waitForStable).toHaveBeenCalledOnce();
    expect(requestRestart).not.toHaveBeenCalled();
    stable.resolve();
    await vi.waitFor(() => expect(requestRestart).toHaveBeenCalledOnce());
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(requestRestart).toHaveBeenCalledWith('restart-1');
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    expect(harness.restartIce).not.toHaveBeenCalled();
    requested.resolve();
    await first;

    expect(harness.controller.getSnapshot().state).toBe('connected');
  });

  test('falls back once through share cleanup and authoritative transport reset', async () => {
    const harness = createHarness({
      restartIce: vi.fn(async () => {
        throw new Error('restart failed');
      }),
    });

    await harness.controller.handleIceConnectionState('failed');

    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.recoverFailedRestart).toHaveBeenCalledOnce();
    expect(harness.order).toEqual([
      'refresh-ice-servers',
      'wait-for-stable',
      'cleanup-share',
      'recover-failed-restart:restart-1',
    ]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'connected',
      error: null,
    });
  });

  test('fails visibly when both ICE recovery and transport reset fail', async () => {
    const harness = createHarness({
      restartIce: vi.fn(async () => {
        throw new Error('restart failed');
      }),
      recoverFailedRestart: vi.fn(async () => {
        throw new Error('reset failed');
      }),
    });

    await expect(
      harness.controller.handleIceConnectionState('failed'),
    ).rejects.toMatchObject({ code: 'RECOVERY_FAILED' });
    expect(harness.cleanupShare).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'failed',
      error: { code: 'RECOVERY_FAILED', message: 'reset failed' },
    });
  });

  test('makes a coalesced recovery timeout visible and ignores its late completion', async () => {
    const requested = deferred<void>();
    const harness = createHarness({
      role: 'joiner',
      requestRestart: vi.fn(() => requested.promise),
      recoverFailedRestart: vi.fn(async () => {
        throw new ReconnectControllerError(
          'RECOVERY_TIMEOUT',
          'Recovery reset timed out',
        );
      }),
      operationTimeoutMs: 1_000,
    });

    const first = harness.controller.handleIceConnectionState('failed');
    const duplicate = harness.controller.handleIceConnectionState('failed');
    expect(duplicate).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTicks();

    await expect(first).rejects.toMatchObject({ code: 'RECOVERY_TIMEOUT' });
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'failed',
      error: { code: 'RECOVERY_TIMEOUT' },
    });
    const failedGeneration = harness.controller.getSnapshot().generation;
    requested.resolve();
    await vi.runAllTicks();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'failed',
      generation: failedGeneration,
    });
  });

  test('stop clears grace/operation timers and prevents late operations from changing state', async () => {
    const resumed = deferred<ReconnectResumeResult>();
    const harness = createHarness({
      resume: vi.fn(() => resumed.promise),
    });
    await harness.controller.handleIceConnectionState('disconnected');
    const resuming = harness.controller.handleSignalingClose({
      code: 1006,
      reason: 'network lost',
    });
    await vi.waitFor(() => expect(harness.resume).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    harness.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    const stoppedGeneration = harness.controller.getSnapshot().generation;
    resumed.resolve({ status: 'reset_required' });
    await resuming;
    await harness.controller.handleIceConnectionState('failed');

    expect(harness.rebuildTransport).not.toHaveBeenCalled();
    expect(harness.refreshIceServers).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'stopped',
      generation: stoppedGeneration,
    });
  });

  test('exposes typed errors for invalid timeout configuration', () => {
    expect(() => createHarness({ operationTimeoutMs: 0 })).toThrowError(
      ReconnectControllerError,
    );
    expect(() =>
      createHarness({ disconnectedGraceMs: Number.NaN }),
    ).toThrowError(ReconnectControllerError);
  });
});
