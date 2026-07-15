import { describe, expect, test, vi } from 'vitest';

const encodings = [
  {
    rid: 'q',
    maxBitrate: 2_000_000,
    maxFramerate: 30,
    scaleResolutionDownBy: 1.5,
  },
  {
    rid: 'f',
    maxBitrate: 4_000_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1,
  },
];

describe('producer bitrate controller', () => {
  test('updates only the f RID while preserving Producer ID', async () => {
    const { applyProducerBitrate } =
      await import('../src/renderer/src/bitrate-controller.js');
    const sender = {
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const producer = { id: 'producer-1', rtpSender: sender };

    const result = await applyProducerBitrate(producer, 8_000_000);

    expect(result).toEqual({ producerId: 'producer-1', bitrateBps: 8_000_000 });
    expect(producer.id).toBe('producer-1');
    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [encodings[0], { ...encodings[1], maxBitrate: 8_000_000 }],
    });
    expect(encodings[1]?.maxBitrate).toBe(4_000_000);
  });

  test('rolls back sender parameters when the hot update fails', async () => {
    const { applyProducerBitrate } =
      await import('../src/renderer/src/bitrate-controller.js');
    const setParameters = vi
      .fn()
      .mockRejectedValueOnce(new Error('encoder rejected update'))
      .mockResolvedValueOnce(undefined);
    const sender = {
      getParameters: vi.fn(() => ({ encodings })),
      setParameters,
    };
    const producer = { id: 'producer-1', rtpSender: sender };

    await expect(applyProducerBitrate(producer, 6_000_000)).rejects.toThrow(
      'encoder rejected update',
    );

    expect(setParameters).toHaveBeenCalledTimes(2);
    expect(setParameters.mock.calls[1]?.[0]).toEqual({ encodings });
    expect(producer.id).toBe('producer-1');
  });

  test('fails explicitly when the Producer has no RTCRtpSender', async () => {
    const { applyProducerBitrate } =
      await import('../src/renderer/src/bitrate-controller.js');

    await expect(
      applyProducerBitrate({ id: 'producer-1' }, 4_000_000),
    ).rejects.toThrow(/rtp sender/i);
  });

  test('records requested and clamped bitrate with stable Producer identity', async () => {
    const { applyProducerBitrateWithEvent } =
      await import('../src/renderer/src/bitrate-controller.js');
    const sender = {
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const producer = { id: 'producer-1', rtpSender: sender };
    const now = vi
      .fn()
      .mockReturnValueOnce('2026-07-15T12:00:00.000Z')
      .mockReturnValueOnce('2026-07-15T12:00:00.025Z');

    await expect(
      applyProducerBitrateWithEvent(producer, 12_000_000, now),
    ).resolves.toEqual({
      requestedBitrateBps: 12_000_000,
      clampedBitrateBps: 10_000_000,
      requestedAt: '2026-07-15T12:00:00.000Z',
      appliedAt: '2026-07-15T12:00:00.025Z',
      success: true,
      error: null,
      producerIdBefore: 'producer-1',
      producerIdAfter: 'producer-1',
      producerIdUnchanged: true,
    });
    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [encodings[0], { ...encodings[1], maxBitrate: 10_000_000 }],
    });
  });

  test('records a safe failure without exporting the underlying error', async () => {
    const { applyProducerBitrateWithEvent } =
      await import('../src/renderer/src/bitrate-controller.js');
    const setParameters = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('encoder rejected update at C:\\private\\driver.dll'),
      )
      .mockResolvedValueOnce(undefined);
    const producer = {
      id: 'producer-1',
      rtpSender: {
        getParameters: vi.fn(() => ({ encodings })),
        setParameters,
      },
    };

    const event = await applyProducerBitrateWithEvent(
      producer,
      6_000_000,
      () => '2026-07-15T12:00:00.000Z',
    );

    expect(event).toEqual({
      requestedBitrateBps: 6_000_000,
      clampedBitrateBps: 6_000_000,
      requestedAt: '2026-07-15T12:00:00.000Z',
      appliedAt: null,
      success: false,
      error: {
        code: 'BITRATE_UPDATE_FAILED',
        message: 'The sender rejected the bitrate update',
      },
      producerIdBefore: 'producer-1',
      producerIdAfter: 'producer-1',
      producerIdUnchanged: true,
    });
    expect(JSON.stringify(event)).not.toContain('private');
    expect(JSON.stringify(event)).not.toContain('stack');
    expect(setParameters).toHaveBeenCalledTimes(2);
  });

  test('records an unapplied target when no Producer exists yet', async () => {
    const { applyProducerBitrateWithEvent } =
      await import('../src/renderer/src/bitrate-controller.js');

    await expect(
      applyProducerBitrateWithEvent(
        null,
        500_000,
        () => '2026-07-15T12:00:00.000Z',
      ),
    ).resolves.toEqual({
      requestedBitrateBps: 500_000,
      clampedBitrateBps: 1_000_000,
      requestedAt: '2026-07-15T12:00:00.000Z',
      appliedAt: null,
      success: false,
      error: {
        code: 'PRODUCER_UNAVAILABLE',
        message: 'No Producer exists for this bitrate target',
      },
      producerIdBefore: null,
      producerIdAfter: null,
      producerIdUnchanged: false,
    });
  });

  test('does not misclassify a sender TypeError as an invalid target', async () => {
    const { applyProducerBitrateWithEvent } =
      await import('../src/renderer/src/bitrate-controller.js');
    const producer = {
      id: 'producer-1',
      rtpSender: {
        getParameters: vi.fn(() => ({ encodings })),
        setParameters: vi
          .fn()
          .mockRejectedValueOnce(new TypeError('native sender failure'))
          .mockResolvedValueOnce(undefined),
      },
    };

    const event = await applyProducerBitrateWithEvent(
      producer,
      6_000_000,
      () => '2026-07-15T12:00:00.000Z',
    );

    expect(event.error?.code).toBe('BITRATE_UPDATE_FAILED');
    expect(event.clampedBitrateBps).toBe(6_000_000);
  });
});
