import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
  DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
} from '../src/ipc-channels.js';
import { installCaptureShutdown } from '../src/main/capture-shutdown.js';

const rendererEntry = 'file:///C:/app/out/renderer/index.html';

function createHarness() {
  const appListeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const ipcHandlers = new Map<
    string,
    (event: unknown, ...arguments_: readonly unknown[]) => unknown
  >();
  const windowListeners = new Map<string, Set<(event?: unknown) => void>>();
  const app = {
    on: vi.fn(
      (
        event: string,
        listener: (event: { preventDefault(): void }) => void,
      ) => {
        appListeners.set(event, listener);
      },
    ),
    removeListener: vi.fn(
      (
        event: string,
        listener: (event: { preventDefault(): void }) => void,
      ) => {
        if (appListeners.get(event) === listener) appListeners.delete(event);
      },
    ),
    quit: vi.fn(),
  };
  const ipcMain = {
    handle: vi.fn(
      (
        channel: string,
        handler: (
          event: unknown,
          ...arguments_: readonly unknown[]
        ) => unknown,
      ) => {
        ipcHandlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  };
  let windowDestroyed = false;
  let webContentsDestroyed = false;
  const webContents = {
    id: 41,
    mainFrame: { url: rendererEntry },
    isDestroyed: () => webContentsDestroyed,
    send: vi.fn(),
  };
  const emitWindow = (event: 'close' | 'closed', value?: unknown): void => {
    for (const listener of [...(windowListeners.get(event) ?? [])]) {
      listener(value);
    }
  };
  const window = {
    webContents,
    isDestroyed: () => windowDestroyed,
    close: vi.fn(() => emitWindow('close', { preventDefault: vi.fn() })),
    on: vi.fn((event: string, listener: (event?: unknown) => void) => {
      const listeners = windowListeners.get(event) ?? new Set();
      listeners.add(listener);
      windowListeners.set(event, listeners);
    }),
    once: vi.fn((event: string, listener: (event?: unknown) => void) => {
      const onceListener = (value?: unknown): void => {
        windowListeners.get(event)?.delete(onceListener);
        listener(value);
      };
      const listeners = windowListeners.get(event) ?? new Set();
      listeners.add(onceListener);
      windowListeners.set(event, listeners);
    }),
    removeListener: vi.fn(
      (event: string, listener: (event?: unknown) => void) => {
        windowListeners.get(event)?.delete(listener);
      },
    ),
  };
  const clearCaptureSources = vi.fn();
  const controller = installCaptureShutdown({
    app,
    ipcMain,
    rendererEntry,
    getMainWindow: () => window,
    clearCaptureSources,
    timeoutMs: 2_000,
  });
  controller.guardWindow(window);
  const mainFrame = webContents.mainFrame;
  const trustedEvent = {
    senderFrame: mainFrame,
    sender: { id: webContents.id, mainFrame },
  };

  return {
    app,
    appListeners,
    clearCaptureSources,
    controller,
    emitBeforeQuit: () => {
      const event = { preventDefault: vi.fn() };
      appListeners.get('before-quit')?.(event);
      return event;
    },
    emitWindowClose: () => {
      const event = { preventDefault: vi.fn() };
      emitWindow('close', event);
      return event;
    },
    ipcHandlers,
    trustedEvent,
    webContents,
    window,
    destroyWindow: () => {
      windowDestroyed = true;
    },
    destroyWebContents: () => {
      webContentsDestroyed = true;
    },
  };
}

describe('desktop capture shutdown', () => {
  it('waits for the trusted renderer acknowledgement before quitting', async () => {
    const harness = createHarness();
    const quitEvent = harness.emitBeforeQuit();

    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.clearCaptureSources).toHaveBeenCalledWith(41);
    expect(harness.webContents.send).toHaveBeenCalledWith(
      DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
      1,
    );
    expect(harness.app.quit).not.toHaveBeenCalled();

    const response = harness.ipcHandlers
      .get(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL)
      ?.(harness.trustedEvent, 1);

    expect(response).toEqual({ ok: true, value: null });
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
    expect(harness.clearCaptureSources.mock.invocationCallOrder[0]).toBeLessThan(
      harness.webContents.send.mock.invocationCallOrder[0]!,
    );

    const allowedEvent = harness.emitBeforeQuit();
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('coalesces repeated quit requests and rejects stale or foreign acknowledgements', async () => {
    const harness = createHarness();
    const first = harness.emitBeforeQuit();
    const second = harness.emitBeforeQuit();

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(harness.webContents.send).toHaveBeenCalledOnce();

    const mainFrame = { url: rendererEntry };
    const foreign = harness.ipcHandlers
      .get(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL)
      ?.( { senderFrame: mainFrame, sender: { id: 99, mainFrame } }, 1);
    expect(foreign).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_ARGUMENTS' }),
      }),
    );
    expect(harness.app.quit).not.toHaveBeenCalled();

    const stale = harness.ipcHandlers
      .get(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL)
      ?.(harness.trustedEvent, 2);
    expect(stale).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_ARGUMENTS' }),
      }),
    );
    expect(harness.app.quit).not.toHaveBeenCalled();

    harness.ipcHandlers
      .get(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL)
      ?.(harness.trustedEvent, 1);
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
  });

  it('guards direct window close and lets the prepared close continue once', async () => {
    const harness = createHarness();
    const closeEvent = harness.emitWindowClose();

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.window.close).not.toHaveBeenCalled();

    harness.ipcHandlers
      .get(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL)
      ?.(harness.trustedEvent, 1);
    await vi.waitFor(() => expect(harness.window.close).toHaveBeenCalledOnce());

    const preparedEvent = harness.emitWindowClose();
    expect(preparedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('continues after the bounded timeout and skips destroyed resources', async () => {
    vi.useFakeTimers();
    try {
      const timedOut = createHarness();
      timedOut.emitBeforeQuit();

      await vi.advanceTimersByTimeAsync(1_999);
      expect(timedOut.app.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(timedOut.app.quit).toHaveBeenCalledOnce();

      const destroyedContents = createHarness();
      destroyedContents.destroyWebContents();
      destroyedContents.emitBeforeQuit();
      await vi.runAllTimersAsync();
      expect(destroyedContents.clearCaptureSources).toHaveBeenCalledWith(41);
      expect(destroyedContents.webContents.send).not.toHaveBeenCalled();
      expect(destroyedContents.app.quit).toHaveBeenCalledOnce();

      const destroyedWindow = createHarness();
      destroyedWindow.destroyWindow();
      destroyedWindow.emitBeforeQuit();
      await vi.runAllTimersAsync();
      expect(destroyedWindow.clearCaptureSources).not.toHaveBeenCalled();
      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
      expect(destroyedWindow.app.quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes every listener and resolves an in-flight shutdown on dispose', async () => {
    const harness = createHarness();
    harness.emitBeforeQuit();

    harness.controller.dispose();

    expect(harness.appListeners.has('before-quit')).toBe(false);
    expect(
      harness.ipcHandlers.has(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL),
    ).toBe(false);
    await Promise.resolve();
    expect(harness.app.quit).not.toHaveBeenCalled();
  });
});
