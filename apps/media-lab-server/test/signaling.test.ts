import { describe, expect, test, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('lab signaling state machine', () => {
  test('creates, connects and produces on an owned send transport', async () => {
    const { ConnectionResources, ProducerDirectory, handleLabRequest } =
      await import('../src/lab-server.js');
    const producer = {
      id: 'producer-1',
      close: vi.fn(),
      observer: { on: vi.fn() },
    };
    const transport = {
      id: 'send-1',
      close: vi.fn(),
      iceParameters: { usernameFragment: 'ice' },
      iceCandidates: [{ ip: '127.0.0.1' }],
      dtlsParameters: { role: 'auto', fingerprints: [] },
      sctpParameters: undefined,
      connect: vi.fn().mockResolvedValue(undefined),
      produce: vi.fn().mockResolvedValue(producer),
    };
    const router = {
      rtpCapabilities: { codecs: [] },
      createWebRtcTransport: vi.fn().mockResolvedValue(transport),
    };
    const producers = new ProducerDirectory();
    const resources = new ConnectionResources(producers);
    const context = {
      router,
      webRtcServer: { id: 'rtc-server' },
      producers,
      resources,
    };

    expect(
      await handleLabRequest(
        {
          type: 'request',
          id: 'r1',
          method: 'createTransport',
          data: { direction: 'send' },
        },
        context,
      ),
    ).toMatchObject({
      id: 'send-1',
      iceParameters: { usernameFragment: 'ice' },
    });
    await handleLabRequest(
      {
        type: 'request',
        id: 'r2',
        method: 'connectTransport',
        data: { transportId: 'send-1', dtlsParameters: {} },
      },
      context,
    );
    expect(transport.connect).toHaveBeenCalledWith({ dtlsParameters: {} });

    expect(
      await handleLabRequest(
        {
          type: 'request',
          id: 'r3',
          method: 'produce',
          data: {
            transportId: 'send-1',
            kind: 'video',
            rtpParameters: {},
            appData: { codec: 'video/VP8' },
          },
        },
        context,
      ),
    ).toEqual({ id: 'producer-1' });
    expect(producers.ids()).toEqual(['producer-1']);
  });

  test('creates a paused consumer and resumes and closes owned resources', async () => {
    const { ConnectionResources, ProducerDirectory, handleLabRequest } =
      await import('../src/lab-server.js');
    const published = { id: 'producer-1', close: vi.fn() };
    const consumer = {
      id: 'consumer-1',
      producerId: 'producer-1',
      kind: 'video',
      rtpParameters: { codecs: [] },
      type: 'simulcast',
      producerPaused: false,
      close: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
    };
    const transport = {
      id: 'recv-1',
      close: vi.fn(),
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      sctpParameters: undefined,
      consume: vi.fn().mockResolvedValue(consumer),
    };
    const router = {
      rtpCapabilities: { codecs: [] },
      createWebRtcTransport: vi.fn().mockResolvedValue(transport),
      canConsume: vi.fn().mockReturnValue(true),
    };
    const producers = new ProducerDirectory();
    producers.add(published);
    const resources = new ConnectionResources(producers);
    const context = {
      router,
      webRtcServer: { id: 'rtc-server' },
      producers,
      resources,
    };

    await handleLabRequest(
      {
        type: 'request',
        id: 'r1',
        method: 'createTransport',
        data: { direction: 'recv' },
      },
      context,
    );
    const result = await handleLabRequest(
      {
        type: 'request',
        id: 'r2',
        method: 'consume',
        data: {
          transportId: 'recv-1',
          producerId: 'producer-1',
          rtpCapabilities: {},
        },
      },
      context,
    );
    expect(transport.consume).toHaveBeenCalledWith(
      expect.objectContaining({ producerId: 'producer-1', paused: true }),
    );
    expect(result).toMatchObject({
      id: 'consumer-1',
      producerId: 'producer-1',
    });

    await handleLabRequest(
      {
        type: 'request',
        id: 'r3',
        method: 'resumeConsumer',
        data: { consumerId: 'consumer-1' },
      },
      context,
    );
    expect(consumer.resume).toHaveBeenCalledTimes(1);

    await handleLabRequest(
      {
        type: 'request',
        id: 'r4',
        method: 'close',
        data: { resourceType: 'consumer', resourceId: 'consumer-1' },
      },
      context,
    );
    expect(consumer.close).toHaveBeenCalledTimes(1);
  });

  test('closes a transport created after disconnect cleanup', async () => {
    const { ConnectionResources, ProducerDirectory, handleLabRequest } =
      await import('../src/lab-server.js');
    const transport = {
      id: 'late-transport',
      close: vi.fn(),
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      sctpParameters: undefined,
    };
    const creation = deferred<typeof transport>();
    const router = {
      rtpCapabilities: { codecs: [] },
      createWebRtcTransport: vi.fn(() => creation.promise),
    };
    const producers = new ProducerDirectory();
    const resources = new ConnectionResources(producers);

    const pending = handleLabRequest(
      {
        type: 'request',
        id: 'late-transport-request',
        method: 'createTransport',
        data: { direction: 'send' },
      },
      {
        router,
        webRtcServer: { id: 'rtc-server' },
        producers,
        resources,
      },
    );
    expect(router.createWebRtcTransport).toHaveBeenCalledOnce();

    resources.closeAll();
    creation.resolve(transport);

    await expect(pending).rejects.toThrow(/closed/i);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  test('closes a producer created after disconnect cleanup', async () => {
    const { ConnectionResources, ProducerDirectory, handleLabRequest } =
      await import('../src/lab-server.js');
    const producer = {
      id: 'late-producer',
      close: vi.fn(),
      observer: { on: vi.fn() },
    };
    const creation = deferred<typeof producer>();
    const transport = {
      id: 'send-transport',
      close: vi.fn(),
      produce: vi.fn(() => creation.promise),
    };
    const producers = new ProducerDirectory();
    const resources = new ConnectionResources(producers);
    resources.addTransport(transport, 'send');

    const pending = handleLabRequest(
      {
        type: 'request',
        id: 'late-producer-request',
        method: 'produce',
        data: {
          transportId: transport.id,
          kind: 'video',
          rtpParameters: {},
        },
      },
      {
        router: {
          rtpCapabilities: { codecs: [] },
          createWebRtcTransport: vi.fn(),
        },
        webRtcServer: { id: 'rtc-server' },
        producers,
        resources,
      },
    );
    expect(transport.produce).toHaveBeenCalledOnce();

    resources.closeAll();
    creation.resolve(producer);

    await expect(pending).rejects.toThrow(/closed/i);
    expect(producer.close).toHaveBeenCalledOnce();
  });

  test('closes a consumer created after disconnect cleanup', async () => {
    const { ConnectionResources, ProducerDirectory, handleLabRequest } =
      await import('../src/lab-server.js');
    const consumer = {
      id: 'late-consumer',
      producerId: 'published-producer',
      kind: 'video',
      rtpParameters: {},
      type: 'simulcast',
      producerPaused: false,
      close: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
    };
    const creation = deferred<typeof consumer>();
    const transport = {
      id: 'recv-transport',
      close: vi.fn(),
      consume: vi.fn(() => creation.promise),
    };
    const producers = new ProducerDirectory();
    producers.add({ id: consumer.producerId, close: vi.fn() });
    const resources = new ConnectionResources(producers);
    resources.addTransport(transport, 'recv');

    const pending = handleLabRequest(
      {
        type: 'request',
        id: 'late-consumer-request',
        method: 'consume',
        data: {
          transportId: transport.id,
          producerId: consumer.producerId,
          rtpCapabilities: {},
        },
      },
      {
        router: {
          rtpCapabilities: { codecs: [] },
          createWebRtcTransport: vi.fn(),
          canConsume: vi.fn(() => true),
        },
        webRtcServer: { id: 'rtc-server' },
        producers,
        resources,
      },
    );
    expect(transport.consume).toHaveBeenCalledOnce();

    resources.closeAll();
    creation.resolve(consumer);

    await expect(pending).rejects.toThrow(/closed/i);
    expect(consumer.close).toHaveBeenCalledOnce();
  });
});
