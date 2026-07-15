import { describe, expect, test } from 'vitest';

describe('media lab stats export model', () => {
  test('exports samples and sanitized bitrate events', async () => {
    const { buildMediaLabStatsExport } =
      await import('../src/renderer/src/stats-export.js');
    const sample = {
      timestampMs: 1_000,
      direction: 'outbound',
      rid: 'f',
      capture: { width: 1920, height: 1080, frameRate: 60 },
      codec: 'video/VP9',
      codecImplementation: 'HardwareEncoder',
      bitrateBps: 6_000_000,
      framesEncoded: 60,
      framesDecoded: null,
      width: 1920,
      height: 1080,
      fps: 59,
      rttMs: 20,
      lossPercent: 0,
      jitterMs: 1,
      nackCount: 0,
      pliCount: 0,
      freezeCount: null,
      qualityLimitationReason: 'none',
    } as const;
    const event = {
      requestedBitrateBps: 6_000_000,
      clampedBitrateBps: 6_000_000,
      requestedAt: '2026-07-15T12:00:00.000Z',
      appliedAt: null,
      success: false,
      error: {
        code: 'BITRATE_UPDATE_FAILED',
        message: 'The sender rejected the bitrate update',
        stack: 'C:\\private\\driver.dll',
      },
      producerIdBefore: 'producer-1',
      producerIdAfter: 'producer-1',
      producerIdUnchanged: true,
    } as const;

    const exported = buildMediaLabStatsExport({
      role: 'publisher',
      labUrl: 'wss://127.0.0.1:4443',
      exportedAt: '2026-07-15T12:01:00.000Z',
      samples: [sample],
      events: [event],
    });

    expect(exported).toEqual({
      schemaVersion: 1,
      role: 'publisher',
      labUrl: 'wss://127.0.0.1:4443',
      exportedAt: '2026-07-15T12:01:00.000Z',
      samples: [sample],
      events: [
        {
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
        },
      ],
    });
    expect(JSON.stringify(exported)).not.toContain('stack');
    expect(JSON.stringify(exported)).not.toContain('private');
  });
});
