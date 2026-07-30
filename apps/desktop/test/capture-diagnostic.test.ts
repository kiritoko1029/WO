import { describe, expect, test, vi } from 'vitest';

import { DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL } from '../src/ipc-channels.js';
import { installCaptureDiagnosticLogger } from '../src/preload/capture-diagnostic.js';

describe('desktop capture diagnostics', () => {
  test('logs a validated bounded main-process diagnostic', () => {
    let listener: ((event: unknown, value: unknown) => void) | undefined;
    const ipcRenderer = {
      on: vi.fn(
        (
          _channel: typeof DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL,
          next: (event: unknown, value: unknown) => void,
        ) => {
          listener = next;
        },
      ),
    };
    const logger = { warn: vi.fn() };

    installCaptureDiagnosticLogger(ipcRenderer, logger);
    expect(ipcRenderer.on).toHaveBeenCalledWith(
      DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL,
      expect.any(Function),
    );

    listener?.(null, {
      stage: 'WINDOW_AUDIO_TARGET',
      code: 'PROBE_EXIT_15',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[screen-controller] main capture rejected at WINDOW_AUDIO_TARGET: PROBE_EXIT_15',
    );
  });

  test.each([
    null,
    [],
    { stage: 'WINDOW_AUDIO_TARGET' },
    { stage: 'UNKNOWN', code: 'PROBE_EXIT_15' },
    { stage: 'WINDOW_AUDIO_TARGET', code: 'probe_failed' },
    { stage: 'WINDOW_AUDIO_TARGET', code: 'PROBE_EXIT_15\nsecret' },
    {
      stage: 'WINDOW_AUDIO_TARGET',
      code: 'PROBE_EXIT_15',
      detail: 'secret',
    },
  ])('ignores malformed or unbounded diagnostic %#', (value) => {
    let listener: ((event: unknown, value: unknown) => void) | undefined;
    const logger = { warn: vi.fn() };
    installCaptureDiagnosticLogger(
      {
        on: (_channel, next) => {
          listener = next;
        },
      },
      logger,
    );

    listener?.(null, value);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
