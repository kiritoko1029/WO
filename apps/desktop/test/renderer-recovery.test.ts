import { describe, expect, it, vi } from 'vitest';

import { createRendererRecovery } from '../src/main/renderer-recovery.js';

function deferred() {
  let resolve: (() => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
    reject: (error: unknown) => reject?.(error),
  };
}

function createHarness() {
  let windowDestroyed = false;
  let windowClosing = false;
  const clearCaptureSources = vi.fn();
  const reloadRenderer = vi.fn().mockResolvedValue(undefined);
  const logError = vi.fn();
  const controller = createRendererRecovery({
    clearCaptureSources,
    canReloadRenderer: () => !windowClosing,
    isWindowDestroyed: () => windowDestroyed,
    reloadRenderer,
    logError,
  });

  return {
    clearCaptureSources,
    closeWindow: () => {
      windowClosing = true;
    },
    controller,
    destroyWindow: () => {
      windowDestroyed = true;
    },
    logError,
    reloadRenderer,
  };
}

describe('desktop renderer recovery', () => {
  it('clears capture tokens before reloading a crashed renderer', async () => {
    const harness = createHarness();

    harness.controller.rendererGone({ reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() =>
      expect(harness.reloadRenderer).toHaveBeenCalledOnce(),
    );
    expect(
      harness.clearCaptureSources.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.reloadRenderer.mock.invocationCallOrder[0]!);
    expect(harness.logError).toHaveBeenCalledWith(
      '[main] Renderer process gone:',
      'reason=crashed',
      'exitCode=139',
    );
  });

  it('coalesces a reload flight and permits a later recovered crash', async () => {
    const harness = createHarness();
    const firstReload = deferred();
    harness.reloadRenderer.mockReturnValueOnce(firstReload.promise);

    harness.controller.rendererGone({ reason: 'oom', exitCode: 9 });
    harness.controller.rendererGone({ reason: 'crashed', exitCode: 139 });
    await vi.waitFor(() =>
      expect(harness.reloadRenderer).toHaveBeenCalledOnce(),
    );

    firstReload.resolve();
    await firstReload.promise;
    await Promise.resolve();
    harness.controller.rendererGone({ reason: 'abnormal-exit', exitCode: 1 });

    await vi.waitFor(() =>
      expect(harness.reloadRenderer).toHaveBeenCalledTimes(2),
    );
    expect(harness.clearCaptureSources).toHaveBeenCalledTimes(3);
  });

  it('does not reload a clean exit or a destroyed window', async () => {
    const harness = createHarness();

    harness.controller.rendererGone({ reason: 'clean-exit', exitCode: 0 });
    harness.destroyWindow();
    harness.controller.rendererGone({ reason: 'crashed', exitCode: 139 });
    await Promise.resolve();

    expect(harness.clearCaptureSources).toHaveBeenCalledTimes(2);
    expect(harness.reloadRenderer).not.toHaveBeenCalled();
  });

  it('reloads a killed renderer unless the window is closing', async () => {
    const activeWindow = createHarness();

    activeWindow.controller.rendererGone({ reason: 'killed', exitCode: 2 });
    await vi.waitFor(() =>
      expect(activeWindow.reloadRenderer).toHaveBeenCalledOnce(),
    );

    const closingWindow = createHarness();
    closingWindow.closeWindow();
    closingWindow.controller.rendererGone({ reason: 'killed', exitCode: 2 });
    await Promise.resolve();

    expect(closingWindow.clearCaptureSources).toHaveBeenCalledOnce();
    expect(closingWindow.reloadRenderer).not.toHaveBeenCalled();
  });

  it('consumes clear and reload failures without retrying a broken entry', async () => {
    const harness = createHarness();
    const reloadFailure = new Error('reload failed');
    harness.clearCaptureSources.mockImplementationOnce(() => {
      throw new Error('clear failed');
    });
    harness.reloadRenderer.mockRejectedValueOnce(reloadFailure);

    expect(() =>
      harness.controller.rendererGone({ reason: 'crashed', exitCode: 139 }),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(harness.logError).toHaveBeenCalledWith(
        '[main] Renderer reload failed:',
        reloadFailure,
      ),
    );
    harness.controller.rendererGone({ reason: 'crashed', exitCode: 139 });
    await Promise.resolve();

    expect(harness.reloadRenderer).toHaveBeenCalledOnce();
    expect(harness.logError).toHaveBeenCalledWith(
      '[main] Failed to clear renderer capture sources:',
      expect.any(Error),
    );
  });

  it('reports an unresponsive renderer without reloading it', () => {
    const harness = createHarness();

    harness.controller.rendererUnresponsive();

    expect(harness.logError).toHaveBeenCalledWith(
      '[main] Renderer became unresponsive',
    );
    expect(harness.reloadRenderer).not.toHaveBeenCalled();
  });
});
