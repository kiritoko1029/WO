import { DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL } from '../ipc-channels.js';

interface CaptureDiagnosticIpcRenderer {
  on(
    channel: typeof DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
}

interface CaptureDiagnosticLogger {
  warn(message: string): void;
}

const CAPTURE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CAPTURE_DIAGNOSTIC_STAGES = new Set([
  'AUTHORIZATION',
  'DISPLAY_MEDIA_HANDLER',
  'WINDOW_AUDIO_TARGET',
]);

export function installCaptureDiagnosticLogger(
  ipcRenderer: CaptureDiagnosticIpcRenderer,
  logger: CaptureDiagnosticLogger = console,
): void {
  ipcRenderer.on(DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL, (_event, value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.stage !== 'string' ||
      !CAPTURE_DIAGNOSTIC_STAGES.has(record.stage) ||
      typeof record.code !== 'string' ||
      !CAPTURE_DIAGNOSTIC_CODE.test(record.code)
    ) {
      return;
    }
    logger.warn(
      `[screen-controller] main capture rejected at ${record.stage}: ${record.code}`,
    );
  });
}
