import { DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL } from '../ipc-channels.js';

type CaptureLifecycleEvent = 'lock-screen' | 'suspend';

interface PowerMonitorLike {
  on(event: CaptureLifecycleEvent, listener: () => void): unknown;
  removeListener(event: CaptureLifecycleEvent, listener: () => void): unknown;
}

interface CaptureLifecycleWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string): void;
}

interface CaptureLifecycleWindow {
  readonly webContents: CaptureLifecycleWebContents;
  isDestroyed(): boolean;
}

export interface CaptureLifecycleOptions {
  readonly powerMonitor: PowerMonitorLike;
  readonly getMainWindow: () => CaptureLifecycleWindow | null;
  readonly clearCaptureSources: (webContentsId: number) => void;
  readonly stopLanSession: () => void | Promise<void>;
}

export function installCaptureLifecycle(
  options: CaptureLifecycleOptions,
): () => void {
  const stopCapture = (): void => {
    const window = options.getMainWindow();
    if (window === null || window.isDestroyed()) return;

    options.clearCaptureSources(window.webContents.id);
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL);
    }
  };
  const handleLockScreen = (): void => stopCapture();
  const handleSuspend = (): void => {
    stopCapture();
    try {
      const stop = options.stopLanSession();
      if (stop !== undefined) void stop.catch(() => undefined);
    } catch {
      // Capture cleanup must remain best-effort when LAN shutdown fails.
    }
  };

  options.powerMonitor.on('lock-screen', handleLockScreen);
  options.powerMonitor.on('suspend', handleSuspend);

  return () => {
    options.powerMonitor.removeListener('lock-screen', handleLockScreen);
    options.powerMonitor.removeListener('suspend', handleSuspend);
  };
}
