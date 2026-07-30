import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
  DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
} from '../src/ipc-channels.js';
import { createCaptureStopSubscribe } from '../src/preload/capture-stop-subscription.js';

function createHarness() {
  let handler:
    | ((event: unknown, requestId: unknown) => void)
    | undefined;
  const ipcRenderer = {
    on: vi.fn(
      (
        channel: string,
        listener: (event: unknown, requestId: unknown) => void,
      ) => {
        expect(channel).toBe(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL);
        handler = listener;
      },
    ),
    invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
  };
  const subscribe = createCaptureStopSubscribe(ipcRenderer);
  return {
    emit: (requestId?: unknown) => handler?.({}, requestId),
    ipcRenderer,
    subscribe,
  };
}

describe('capture stop preload subscription', () => {
  it('acknowledges only after every asynchronous renderer listener settles', async () => {
    const harness = createHarness();
    let finish: (() => void) | undefined;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const second = vi.fn().mockRejectedValue(new Error('stop failed'));
    harness.subscribe(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL, first);
    harness.subscribe(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL, second);

    harness.emit(7);
    await Promise.resolve();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(harness.ipcRenderer.invoke).not.toHaveBeenCalled();

    finish?.();
    await vi.waitFor(() =>
      expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith(
        DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
        7,
      ),
    );
  });

  it('acknowledges with no active call listener and keeps unsubscribe idempotent', async () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = harness.subscribe(
      DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
      listener,
    );
    unsubscribe();
    unsubscribe();

    harness.emit(3);

    await vi.waitFor(() =>
      expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith(
        DESKTOP_CAPTURE_STOP_COMPLETED_CHANNEL,
        3,
      ),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it('runs lifecycle stops without acknowledging missing or invalid request IDs', async () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.subscribe(DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL, listener);

    harness.emit();
    harness.emit(0);
    harness.emit('1');
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(3);
    expect(harness.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('rejects any renderer-selected subscription channel', () => {
    const harness = createHarness();

    expect(() => harness.subscribe('desktop:arbitrary', vi.fn())).toThrow(
      'Capture stop subscription channel is invalid',
    );
  });
});
