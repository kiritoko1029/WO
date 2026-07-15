import { describe, expect, test, vi } from 'vitest';

function resource(id: string) {
  return { id, close: vi.fn() };
}

describe('connection resource ownership', () => {
  test('rejects duplicate IDs and wrong resource lookups', async () => {
    const { ConnectionResources } = await import('../src/lab-server.js');
    const resources = new ConnectionResources();
    const transport = resource('same-id');

    resources.addTransport(transport);

    expect(() => resources.addTransport(resource('same-id'))).toThrow(
      /duplicate/i,
    );
    expect(() => resources.getTransport('missing')).toThrow(
      /transport.*missing/i,
    );
  });

  test('closes an owned resource once and removes a producer from discovery', async () => {
    const { ConnectionResources, ProducerDirectory } =
      await import('../src/lab-server.js');
    const directory = new ProducerDirectory();
    const resources = new ConnectionResources(directory);
    const producer = resource('producer-1');

    resources.addProducer(producer);
    expect(directory.ids()).toEqual(['producer-1']);

    resources.closeResource('producer', 'producer-1');
    resources.closeResource('producer', 'producer-1');

    expect(producer.close).toHaveBeenCalledTimes(1);
    expect(directory.ids()).toEqual([]);
  });

  test('disconnect cleanup is idempotent across transports, producers and consumers', async () => {
    const { ConnectionResources, ProducerDirectory } =
      await import('../src/lab-server.js');
    const directory = new ProducerDirectory();
    const resources = new ConnectionResources(directory);
    const transport = resource('transport-1');
    const producer = resource('producer-1');
    const consumer = resource('consumer-1');
    resources.addTransport(transport);
    resources.addProducer(producer);
    resources.addConsumer(consumer);

    resources.closeAll();
    resources.closeAll();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(producer.close).toHaveBeenCalledTimes(1);
    expect(consumer.close).toHaveBeenCalledTimes(1);
    expect(directory.ids()).toEqual([]);
  });

  test('accepts only an explicit IPv4 loopback bind address', async () => {
    const { assertLoopbackHost } = await import('../src/lab-server.js');

    expect(assertLoopbackHost('127.0.0.1')).toBe('127.0.0.1');
    expect(() => assertLoopbackHost('0.0.0.0')).toThrow(/loopback/i);
    expect(() => assertLoopbackHost('localhost')).toThrow(/127\.0\.0\.1/i);
  });
});
