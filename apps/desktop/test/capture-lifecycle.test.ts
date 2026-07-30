import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL } from '../src/ipc-channels.js';
import { installCaptureLifecycle } from '../src/main/capture-lifecycle.js';

function createHarness() {
  const listeners = new Map<string, () => void>();
  const powerMonitor = {
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
  };
  let windowDestroyed = false;
  let webContentsDestroyed = false;
  const webContents = {
    id: 41,
    isDestroyed: () => webContentsDestroyed,
    send: vi.fn(),
  };
  const window = {
    webContents,
    isDestroyed: () => windowDestroyed,
  };
  const clearCaptureSources = vi.fn();
  const stopLanSession = vi.fn().mockResolvedValue(undefined);
  const dispose = installCaptureLifecycle({
    powerMonitor,
    getMainWindow: () => window,
    clearCaptureSources,
    stopLanSession,
  });

  return {
    powerMonitor,
    webContents,
    clearCaptureSources,
    stopLanSession,
    dispose,
    emit: (event: 'lock-screen' | 'suspend') => listeners.get(event)?.(),
    destroyWindow: () => {
      windowDestroyed = true;
    },
    destroyWebContents: () => {
      webContentsDestroyed = true;
    },
  };
}

describe('desktop capture lifecycle', () => {
  it('stops capture on lock and suspend but stops LAN only on suspend', () => {
    const harness = createHarness();

    harness.emit('lock-screen');

    expect(harness.clearCaptureSources).toHaveBeenCalledOnce();
    expect(harness.clearCaptureSources).toHaveBeenCalledWith(41);
    expect(harness.webContents.send).toHaveBeenCalledWith(
      DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
    );
    expect(harness.stopLanSession).not.toHaveBeenCalled();

    harness.emit('suspend');

    expect(harness.clearCaptureSources).toHaveBeenCalledTimes(2);
    expect(harness.webContents.send).toHaveBeenCalledTimes(2);
    expect(harness.stopLanSession).toHaveBeenCalledOnce();

    harness.dispose();
    harness.emit('lock-screen');
    harness.emit('suspend');

    expect(harness.powerMonitor.removeListener).toHaveBeenCalledTimes(2);
    expect(harness.clearCaptureSources).toHaveBeenCalledTimes(2);
    expect(harness.stopLanSession).toHaveBeenCalledOnce();
  });

  it('clears tokens without sending to destroyed renderer resources', () => {
    const destroyedContents = createHarness();
    destroyedContents.destroyWebContents();

    destroyedContents.emit('lock-screen');

    expect(destroyedContents.clearCaptureSources).toHaveBeenCalledWith(41);
    expect(destroyedContents.webContents.send).not.toHaveBeenCalled();

    const destroyedWindow = createHarness();
    destroyedWindow.destroyWindow();

    destroyedWindow.emit('suspend');

    expect(destroyedWindow.clearCaptureSources).not.toHaveBeenCalled();
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
    expect(destroyedWindow.stopLanSession).toHaveBeenCalledOnce();
  });

  it('consumes synchronous and asynchronous LAN shutdown failures', async () => {
    const synchronousFailure = createHarness();
    synchronousFailure.stopLanSession.mockImplementationOnce(() => {
      throw new Error('sync shutdown failure');
    });

    expect(() => synchronousFailure.emit('suspend')).not.toThrow();
    expect(synchronousFailure.clearCaptureSources).toHaveBeenCalledOnce();
    expect(synchronousFailure.webContents.send).toHaveBeenCalledOnce();

    const asynchronousFailure = createHarness();
    const rejection = Promise.reject(new Error('async shutdown failure'));
    const catchRejection = vi.spyOn(rejection, 'catch');
    asynchronousFailure.stopLanSession.mockReturnValueOnce(rejection);

    expect(() => asynchronousFailure.emit('suspend')).not.toThrow();
    await vi.waitFor(() => expect(catchRejection).toHaveBeenCalledOnce());
    expect(asynchronousFailure.clearCaptureSources).toHaveBeenCalledOnce();
    expect(asynchronousFailure.webContents.send).toHaveBeenCalledOnce();
  });
});
