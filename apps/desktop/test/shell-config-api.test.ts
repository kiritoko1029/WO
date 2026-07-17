import { describe, expect, it, vi } from 'vitest';

import { createDesktopShellBridge } from '../src/preload/shell-config-api.js';
import { createRendererShellConfigApi } from '../src/renderer/src/api/shell-config-api.js';

describe('shell config preload bridge', () => {
  it('validates target snapshots and unwraps fixed envelopes', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          origin: 'https://wo.example.cn',
          source: 'environment',
          readOnly: true,
        },
      })
      .mockResolvedValueOnce({ ok: true, value: null });
    const api = createRendererShellConfigApi(createDesktopShellBridge(invoke));

    await expect(api.backendTarget.get()).resolves.toEqual({
      origin: 'https://wo.example.cn',
      source: 'environment',
      readOnly: true,
    });
    await expect(
      api.backendTarget.save('https://next.example.cn'),
    ).resolves.toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      ['desktop:shell:backend-target:get'],
      ['desktop:shell:backend-target:save', 'https://next.example.cn'],
    ]);
  });

  it('rejects non-canonical and internally inconsistent snapshots', async () => {
    const bridge = createDesktopShellBridge(
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          origin: 'https://wo.example.cn/path',
          source: 'environment',
          readOnly: false,
        },
      }),
    );

    await expect(bridge.backendTarget.get()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
  });

  it('validates join intents and exposes only a no-payload notification', async () => {
    const intent = {
      version: 1 as const,
      mode: 'server' as const,
      serverOrigin: 'https://wo.example.cn',
      roomCode: '123456',
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: intent })
      .mockResolvedValueOnce({ ok: true, value: null });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_channel: string, listener: () => void) => {
      listener();
      return unsubscribe;
    });
    const listener = vi.fn();
    const api = createRendererShellConfigApi(
      createDesktopShellBridge(invoke, subscribe),
    );

    const stop = api.joinIntent.subscribe(listener);
    await expect(api.joinIntent.consume()).resolves.toEqual(intent);
    await expect(api.joinIntent.switchServer(intent)).resolves.toBeUndefined();
    stop();

    expect(listener).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(
      'desktop:shell:join-intent:available',
      listener,
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent one-shot join intent consumption', async () => {
    const intent = {
      version: 1 as const,
      mode: 'server' as const,
      serverOrigin: 'https://wo.example.cn',
      roomCode: '123456',
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: intent });
    const api = createRendererShellConfigApi(createDesktopShellBridge(invoke));

    const first = api.joinIntent.consume();
    const second = api.joinIntent.consume();

    await expect(Promise.all([first, second])).resolves.toEqual([
      intent,
      intent,
    ]);
    expect(invoke).toHaveBeenCalledOnce();

    await expect(api.joinIntent.consume()).resolves.toEqual(intent);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
