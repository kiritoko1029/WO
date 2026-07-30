import {
  DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
  DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
} from '../ipc-channels.js';
import {
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  type DesktopIpcEnvelope,
} from '../preload/ipc-envelope.js';
import { assertTrustedSender } from './ipc.js';

const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const MAX_STOP_TIMEOUT_MS = 10_000;

interface PreventableEvent {
  preventDefault(): void;
}

interface CaptureShutdownApp {
  on(
    event: 'before-quit',
    listener: (event: PreventableEvent) => void,
  ): unknown;
  removeListener(
    event: 'before-quit',
    listener: (event: PreventableEvent) => void,
  ): unknown;
  quit(): void;
}

interface CaptureShutdownIpcMain {
  handle(
    channel: typeof DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
    handler: (
      event: unknown,
      ...arguments_: readonly unknown[]
    ) => DesktopIpcEnvelope<null>,
  ): void;
  removeHandler(channel: typeof DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL): void;
}

interface CaptureShutdownWebContents {
  readonly id: number;
  readonly mainFrame?: unknown;
  isDestroyed(): boolean;
  send(
    channel: typeof DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
    requestId: number,
  ): void;
}

interface CaptureShutdownWindow {
  readonly webContents: CaptureShutdownWebContents;
  isDestroyed(): boolean;
  close(): void;
  on(event: 'close', listener: (event: PreventableEvent) => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(
    event: 'close',
    listener: (event: PreventableEvent) => void,
  ): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

export interface CaptureShutdownOptions {
  readonly app: CaptureShutdownApp;
  readonly ipcMain: CaptureShutdownIpcMain;
  readonly rendererEntry: string;
  readonly getMainWindow: () => CaptureShutdownWindow | null;
  readonly clearCaptureSources: (webContentsId: number) => void;
  readonly timeoutMs?: number;
}

export interface CaptureShutdownController {
  guardWindow(window: CaptureShutdownWindow): () => void;
  dispose(): void;
}

interface PendingStop {
  readonly webContentsId: number;
  finish(): void;
}

function invalidArguments(): Error & { readonly code: 'INVALID_ARGUMENTS' } {
  return Object.assign(new Error('Invalid arguments'), {
    code: 'INVALID_ARGUMENTS' as const,
  });
}

export function installCaptureShutdown(
  options: CaptureShutdownOptions,
): CaptureShutdownController {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_STOP_TIMEOUT_MS
  ) {
    throw new RangeError('Capture shutdown timeout is invalid');
  }

  const pendingStops = new Map<number, PendingStop>();
  const prepareFlights = new WeakMap<CaptureShutdownWindow, Promise<void>>();
  const guardedWindows = new Map<CaptureShutdownWindow, () => void>();
  const closeAllowed = new WeakSet<CaptureShutdownWindow>();
  let requestSequence = 0;
  let quitFlight: Promise<void> | null = null;
  let quitAllowed = false;
  let disposed = false;

  const prepareWindow = (window: CaptureShutdownWindow): Promise<void> => {
    const existing = prepareFlights.get(window);
    if (existing !== undefined) return existing;
    if (window.isDestroyed()) return Promise.resolve();

    const webContents = window.webContents;
    options.clearCaptureSources(webContents.id);
    if (webContents.isDestroyed()) return Promise.resolve();

    const requestId = ++requestSequence;
    const operation = new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(), timeoutMs);
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingStops.delete(requestId);
        resolve();
      };
      pendingStops.set(requestId, {
        webContentsId: webContents.id,
        finish,
      });
      try {
        webContents.send(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL, requestId);
      } catch {
        finish();
      }
    });
    prepareFlights.set(window, operation);
    void operation.finally(() => {
      if (prepareFlights.get(window) === operation) {
        prepareFlights.delete(window);
      }
    });
    return operation;
  };

  options.ipcMain.handle(
    DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
    (event, ...arguments_): DesktopIpcEnvelope<null> => {
      try {
        assertTrustedSender(event, options.rendererEntry);
        if (
          arguments_.length !== 1 ||
          !Number.isSafeInteger(arguments_[0]) ||
          (arguments_[0] as number) <= 0
        ) {
          throw invalidArguments();
        }
        const requestId = arguments_[0] as number;
        const pending = pendingStops.get(requestId);
        const senderId = (
          event as { readonly sender?: { readonly id?: unknown } }
        ).sender?.id;
        if (pending === undefined || senderId !== pending.webContentsId) {
          throw invalidArguments();
        }
        pending.finish();
        return createDesktopIpcSuccess(null);
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );

  const guardWindow = (window: CaptureShutdownWindow): (() => void) => {
    const existing = guardedWindows.get(window);
    if (existing !== undefined) return existing;

    const handleClose = (event: PreventableEvent): void => {
      if (
        disposed ||
        quitAllowed ||
        closeAllowed.has(window) ||
        window.isDestroyed()
      ) {
        return;
      }
      event.preventDefault();
      void prepareWindow(window).finally(() => {
        if (disposed || window.isDestroyed()) return;
        closeAllowed.add(window);
        window.close();
      });
    };
    const removeGuard = (): void => {
      window.removeListener('close', handleClose);
      window.removeListener('closed', removeGuard);
      guardedWindows.delete(window);
    };
    window.on('close', handleClose);
    window.once('closed', removeGuard);
    guardedWindows.set(window, removeGuard);
    return removeGuard;
  };

  const handleBeforeQuit = (event: PreventableEvent): void => {
    if (disposed || quitAllowed) return;
    event.preventDefault();
    if (quitFlight !== null) return;
    const window = options.getMainWindow();
    quitFlight = (
      window === null ? Promise.resolve() : prepareWindow(window)
    ).finally(() => {
      if (disposed) return;
      quitAllowed = true;
      options.app.quit();
    });
  };
  options.app.on('before-quit', handleBeforeQuit);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    options.app.removeListener('before-quit', handleBeforeQuit);
    options.ipcMain.removeHandler(DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL);
    for (const removeGuard of [...guardedWindows.values()]) removeGuard();
    for (const pending of [...pendingStops.values()]) pending.finish();
  };

  return Object.freeze({ guardWindow, dispose });
}
