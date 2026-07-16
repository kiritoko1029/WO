import { describe, expect, test, vi } from 'vitest';

describe('mediasoup-client flow', () => {
  test('produces a screen track with the selected codec and one full layer', async () => {
    const { produceScreen } = await import('../src/renderer/src/media-flow.js');
    const vp9 = { kind: 'video', mimeType: 'video/VP9' };
    const track = { kind: 'video', contentHint: '' };
    const producer = { id: 'producer-1' };
    const transport = { produce: vi.fn().mockResolvedValue(producer) };

    expect(
      await produceScreen(
        transport,
        track,
        { codecs: [vp9] },
        'VP9',
        6_000_000,
      ),
    ).toBe(producer);
    expect(track.contentHint).toBe('');
    expect(transport.produce).toHaveBeenCalledWith({
      track,
      codec: vp9,
      encodings: [
        {
          rid: 'f',
          active: true,
          maxBitrate: 6_000_000,
          scalabilityMode: 'L1T1',
          scaleResolutionDownBy: 1,
        },
      ],
      codecOptions: {
        videoGoogleMaxBitrate: 10_000,
        videoGoogleStartBitrate: 8_000,
      },
      stopTracks: false,
    });
  });

  test('wires send transport connect and produce requests', async () => {
    const { createLabSendTransport } =
      await import('../src/renderer/src/media-flow.js');
    const handlers = new Map<string, (...args: never[]) => void>();
    const transport = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const device = { createSendTransport: vi.fn(() => transport) };
    const signaling = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'send-1',
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {},
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ id: 'producer-1' }),
    };

    expect(await createLabSendTransport(device, signaling)).toBe(transport);
    const connected = vi.fn();
    handlers.get('connect')?.(
      { dtlsParameters: { role: 'client' } } as never,
      connected as never,
      vi.fn() as never,
    );
    await vi.waitFor(() => expect(connected).toHaveBeenCalled());

    const produced = vi.fn();
    handlers.get('produce')?.(
      { kind: 'video', rtpParameters: {}, appData: {} } as never,
      produced as never,
      vi.fn() as never,
    );
    await vi.waitFor(() =>
      expect(produced).toHaveBeenCalledWith({ id: 'producer-1' }),
    );
  });

  test('creates the local consumer before requesting server resume', async () => {
    const { consumeFirstProducer, createLabReceiveTransport } =
      await import('../src/renderer/src/media-flow.js');
    const consumer = { id: 'consumer-1', track: { kind: 'video' } };
    const transport = {
      on: vi.fn(),
      consume: vi.fn().mockResolvedValue(consumer),
    };
    const device = {
      rtpCapabilities: { codecs: [] },
      createRecvTransport: vi.fn(() => transport),
    };
    const signaling = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'recv-1',
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {},
        })
        .mockResolvedValueOnce({ producerIds: ['producer-1'] })
        .mockResolvedValueOnce({
          id: 'consumer-1',
          producerId: 'producer-1',
          kind: 'video',
          rtpParameters: {},
        })
        .mockResolvedValueOnce({}),
    };

    const receiveTransport = await createLabReceiveTransport(device, signaling);
    expect(
      await consumeFirstProducer(device, receiveTransport, signaling),
    ).toBe(consumer);
    expect(transport.consume.mock.invocationCallOrder[0]).toBeLessThan(
      signaling.request.mock.invocationCallOrder[3]!,
    );
    expect(signaling.request.mock.calls[3]).toEqual([
      'resumeConsumer',
      { consumerId: 'consumer-1' },
    ]);
  });
});
