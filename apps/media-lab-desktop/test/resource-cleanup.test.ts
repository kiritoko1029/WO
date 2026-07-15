import { describe, expect, test, vi } from 'vitest';

function resource(id: string, events: string[]) {
  return {
    id,
    close: vi.fn(() => events.push(`local:${id}`)),
  };
}

describe('media session resource cleanup', () => {
  test('requests every server close before local cleanup and is idempotent', async () => {
    const { closeMediaSessionResources } =
      await import('../src/renderer/src/resource-cleanup.js');
    const events: string[] = [];
    const resources = {
      producers: [resource('producer-1', events)],
      consumers: [resource('consumer-1', events)],
      transports: [
        resource('send-transport', events),
        resource('recv-transport', events),
      ],
    };
    const signaling = {
      request: vi.fn(async (_method: string, data: Record<string, unknown>) => {
        events.push(
          `server:${String(data.resourceType)}:${String(data.resourceId)}`,
        );
        return {};
      }),
    };

    await closeMediaSessionResources(signaling, resources);
    await closeMediaSessionResources(signaling, resources);

    expect(events).toEqual([
      'server:producer:producer-1',
      'server:consumer:consumer-1',
      'server:transport:send-transport',
      'server:transport:recv-transport',
      'local:producer-1',
      'local:consumer-1',
      'local:send-transport',
      'local:recv-transport',
    ]);
    expect(signaling.request).toHaveBeenCalledTimes(4);
    for (const entry of [
      ...resources.producers,
      ...resources.consumers,
      ...resources.transports,
    ]) {
      expect(entry.close).toHaveBeenCalledOnce();
    }
  });

  test('continues server and local cleanup when a close ack fails', async () => {
    const { closeMediaSessionResources } =
      await import('../src/renderer/src/resource-cleanup.js');
    const events: string[] = [];
    const resources = {
      producers: [],
      consumers: [],
      transports: [
        resource('send-transport', events),
        resource('recv-transport', events),
      ],
    };
    const signaling = {
      request: vi.fn(async (_method: string, data: Record<string, unknown>) => {
        const id = String(data.resourceId);
        events.push(`server:transport:${id}`);
        if (id === 'send-transport') throw new Error('ack lost');
        return {};
      }),
    };

    await expect(
      closeMediaSessionResources(signaling, resources),
    ).resolves.toBeUndefined();

    expect(events).toEqual([
      'server:transport:send-transport',
      'server:transport:recv-transport',
      'local:send-transport',
      'local:recv-transport',
    ]);
  });
});
