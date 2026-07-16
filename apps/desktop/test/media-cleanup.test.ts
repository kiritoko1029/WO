import { describe, expect, it, vi } from 'vitest';

import { createIdempotentCleanup } from '../src/renderer/src/media/media-cleanup.js';

describe('idempotent media cleanup', () => {
  it('runs concurrent cleanup calls once and in registration order', async () => {
    const order: string[] = [];
    const cleanup = createIdempotentCleanup([
      () => {
        order.push('listeners');
      },
      async () => {
        order.push('sender');
      },
      () => {
        order.push('tracks');
      },
    ]);

    const first = cleanup();
    const second = cleanup();
    expect(second).toBe(first);
    await first;

    expect(order).toEqual(['listeners', 'sender', 'tracks']);
    await cleanup();
    expect(order).toEqual(['listeners', 'sender', 'tracks']);
  });

  it('attempts every cleanup step and reports all failures', async () => {
    const last = vi.fn();
    const cleanup = createIdempotentCleanup([
      () => {
        throw new Error('first');
      },
      async () => {
        throw new Error('second');
      },
      last,
    ]);

    await expect(cleanup()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'first' }),
        expect.objectContaining({ message: 'second' }),
      ],
    });
    expect(last).toHaveBeenCalledOnce();
  });
});
