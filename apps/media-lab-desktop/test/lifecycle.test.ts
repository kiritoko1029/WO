import { readFile } from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

describe('Electron main lifecycle', () => {
  test('registers ready work without awaiting it during module evaluation', async () => {
    const { registerAppReady } = await import('../src/main/lifecycle.js');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const onReady = vi.fn();
    const app = { whenReady: vi.fn(() => ready) };

    expect(registerAppReady(app, onReady)).toBeUndefined();
    expect(onReady).not.toHaveBeenCalled();

    resolveReady();
    await ready;
    await Promise.resolve();

    expect(onReady).toHaveBeenCalledOnce();
  });

  test('retains each window until its closed event', async () => {
    const { WindowOwner } = await import('../src/main/lifecycle.js');
    let closed: (() => void) | undefined;
    const window = {
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'closed') closed = listener;
      }),
    };
    const owner = new WindowOwner<typeof window>();

    owner.add(window);

    expect(owner.size).toBe(1);
    expect(owner.has(window)).toBe(true);
    closed?.();
    expect(owner.size).toBe(0);
    expect(owner.has(window)).toBe(false);
  });

  test('main entry uses non-blocking ready registration and window ownership', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('await app.whenReady()');
    expect(source).toContain('registerAppReady(app');
    expect(source).toContain('windowOwner.add(createLabWindow(role))');
  });

  test('keeps media renderers active while their windows are occluded', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('backgroundThrottling: false');
  });
});
