import {
  DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
  DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
} from '../ipc-channels.js';
import type { Subscribe } from './api.js';

interface CaptureStopIpcRenderer {
  on(
    channel: typeof DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
    listener: (event: unknown, requestId: unknown) => void,
  ): unknown;
  invoke(
    channel: typeof DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
    requestId: number,
  ): Promise<unknown>;
}

export function createCaptureStopSubscribe(
  ipcRenderer: CaptureStopIpcRenderer,
): Subscribe {
  const listeners = new Set<() => void | Promise<void>>();
  ipcRenderer.on(
    DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
    (_event, requestId) => {
      const completion = Promise.allSettled(
        [...listeners].map((listener) =>
          Promise.resolve().then(() => listener()),
        ),
      );
      if (!Number.isSafeInteger(requestId) || (requestId as number) <= 0) {
        void completion;
        return;
      }
      void completion
        .then(() =>
          ipcRenderer.invoke(
            DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
            requestId as number,
          ),
        )
        .catch(() => undefined);
    },
  );

  return (channel, listener) => {
    if (channel !== DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL) {
      throw new TypeError('Capture stop subscription channel is invalid');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
}
