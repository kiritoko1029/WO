import { describe, expect, it, vi } from 'vitest';

import { createDesktopClipboardBridge } from '../src/preload/clipboard-api.js';

describe('clipboard preload bridge', () => {
  it('invokes only the fixed write channel and unwraps null success', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const bridge = createDesktopClipboardBridge(invoke);

    expect(Object.keys(bridge)).toEqual(['writeText']);
    await expect(
      bridge.writeText('https://wo.example.cn/join/482731'),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(
      'desktop:clipboard:write-text',
      'https://wo.example.cn/join/482731',
    );
  });

  it('rejects safe failure envelopes and malformed responses', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'IPC_FORBIDDEN',
          message: 'IPC request was rejected',
        },
      })
      .mockResolvedValueOnce({ ok: true, value: 'unexpected' });
    const bridge = createDesktopClipboardBridge(invoke);

    await expect(bridge.writeText('first')).rejects.toMatchObject({
      code: 'IPC_FORBIDDEN',
      message: 'IPC request was rejected',
    });
    await expect(bridge.writeText('second')).rejects.toMatchObject({
      code: 'INVALID_IPC_RESPONSE',
      message: 'IPC response was rejected',
    });
  });

  it('rejects when the IPC transport is unavailable', async () => {
    const bridge = createDesktopClipboardBridge(
      vi.fn().mockRejectedValue(new Error('private transport detail')),
    );

    await expect(bridge.writeText('value')).rejects.toMatchObject({
      code: 'IPC_UNAVAILABLE',
      message: 'Desktop service is unavailable',
    });
  });
});
