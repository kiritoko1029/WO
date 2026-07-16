import { describe, expect, test } from 'vitest';

const capture = { width: 1920, height: 1080, frameRate: 60 } as const;

describe('RTC stats sampling', () => {
  test('computes outbound bitrate, fps, quality and network deltas', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 1_000,
      capture,
      reports: [
        {
          id: 'out',
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 1_000,
          framesEncoded: 100,
          frameWidth: 1920,
          frameHeight: 1080,
          codecId: 'codec',
          nackCount: 2,
          pliCount: 1,
          qualityLimitationReason: 'none',
        },
        {
          id: 'remote',
          type: 'remote-inbound-rtp',
          kind: 'video',
          packetsLost: 10,
          packetsReceived: 990,
          roundTripTime: 0.025,
          jitter: 0.004,
        },
        { id: 'codec', type: 'codec', mimeType: 'video/VP9' },
      ],
    } as const;
    const current = {
      timestampMs: 2_000,
      capture,
      reports: [
        {
          id: 'out',
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 751_000,
          framesEncoded: 159,
          frameWidth: 1920,
          frameHeight: 1080,
          codecId: 'codec',
          nackCount: 5,
          pliCount: 3,
          qualityLimitationReason: 'bandwidth',
          encoderImplementation: 'ExternalEncoder',
        },
        {
          id: 'remote',
          type: 'remote-inbound-rtp',
          kind: 'video',
          packetsLost: 12,
          packetsReceived: 1_088,
          roundTripTime: 0.03,
          jitter: 0.005,
        },
        { id: 'codec', type: 'codec', mimeType: 'video/VP9' },
      ],
    } as const;

    expect(calculateRtcStats(previous, current)).toEqual({
      timestampMs: 2_000,
      direction: 'outbound',
      rid: null,
      capture,
      codec: 'video/VP9',
      codecImplementation: 'ExternalEncoder',
      bitrateBps: 6_000_000,
      framesEncoded: 159,
      framesDecoded: null,
      width: 1920,
      height: 1080,
      fps: 59,
      rttMs: 30,
      lossPercent: 2,
      jitterMs: 5,
      nackCount: 5,
      pliCount: 3,
      freezeCount: null,
      qualityLimitationReason: 'bandwidth',
    });
  });

  test('selects the f outbound layer when q appears first', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 1_000,
      capture,
      reports: [
        {
          id: 'out-q',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'q',
          bytesSent: 1_000,
          framesEncoded: 30,
          frameWidth: 1280,
          frameHeight: 720,
        },
        {
          id: 'out-f',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'f',
          bytesSent: 10_000,
          framesEncoded: 60,
          frameWidth: 1920,
          frameHeight: 1080,
          codecId: 'codec-f',
        },
        {
          id: 'remote-q',
          type: 'remote-inbound-rtp',
          kind: 'video',
          localId: 'out-q',
          packetsLost: 0,
          packetsReceived: 100,
        },
        {
          id: 'remote-f',
          type: 'remote-inbound-rtp',
          kind: 'video',
          localId: 'out-f',
          packetsLost: 10,
          packetsReceived: 90,
        },
      ],
    } as const;
    const current = {
      timestampMs: 2_000,
      capture,
      reports: [
        {
          id: 'out-q',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'q',
          bytesSent: 1_001_000,
          framesEncoded: 60,
          frameWidth: 1280,
          frameHeight: 720,
          encoderImplementation: 'SoftwareEncoder',
        },
        {
          id: 'out-f',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'f',
          bytesSent: 760_000,
          framesEncoded: 119,
          frameWidth: 1920,
          frameHeight: 1080,
          codecId: 'codec-f',
          encoderImplementation: 'HardwareEncoder',
        },
        {
          id: 'remote-q',
          type: 'remote-inbound-rtp',
          kind: 'video',
          localId: 'out-q',
          packetsLost: 10,
          packetsReceived: 190,
          roundTripTime: 0.1,
          jitter: 0.02,
        },
        {
          id: 'remote-f',
          type: 'remote-inbound-rtp',
          kind: 'video',
          localId: 'out-f',
          packetsLost: 11,
          packetsReceived: 189,
          roundTripTime: 0.02,
          jitter: 0.003,
        },
        { id: 'codec-f', type: 'codec', mimeType: 'video/VP9' },
      ],
    } as const;

    expect(calculateRtcStats(previous, current)).toMatchObject({
      direction: 'outbound',
      rid: 'f',
      bitrateBps: 6_000_000,
      fps: 59,
      width: 1920,
      height: 1080,
      codec: 'video/VP9',
      codecImplementation: 'HardwareEncoder',
      rttMs: 20,
      lossPercent: 1,
      jitterMs: 3,
    });
  });

  test('selects the highest-resolution outbound stream after RID normalization', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 1_000,
      capture,
      reports: [
        {
          id: 'out-r0',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'r0',
          bytesSent: 1_000,
          framesEncoded: 30,
          frameWidth: 1280,
          frameHeight: 720,
        },
        {
          id: 'out-r1',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'r1',
          bytesSent: 10_000,
          framesEncoded: 60,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ],
    } as const;
    const current = {
      timestampMs: 2_000,
      capture,
      reports: [
        {
          id: 'out-r0',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'r0',
          bytesSent: 126_000,
          framesEncoded: 60,
          frameWidth: 1280,
          frameHeight: 720,
        },
        {
          id: 'out-r1',
          type: 'outbound-rtp',
          kind: 'video',
          rid: 'r1',
          bytesSent: 510_000,
          framesEncoded: 119,
          frameWidth: 1920,
          frameHeight: 1080,
          encoderImplementation: 'HardwareEncoder',
        },
      ],
    } as const;

    expect(calculateRtcStats(previous, current)).toMatchObject({
      direction: 'outbound',
      rid: 'r1',
      bitrateBps: 4_000_000,
      fps: 59,
      width: 1920,
      height: 1080,
      codecImplementation: 'HardwareEncoder',
    });
  });

  test('computes inbound bitrate, decoded fps and freeze counters', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 10_000,
      capture: null,
      reports: [
        {
          id: 'in',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 10_000,
          framesDecoded: 500,
          packetsLost: 4,
          packetsReceived: 496,
          codecId: 'codec',
          nackCount: 1,
          pliCount: 2,
          freezeCount: 0,
        },
        { id: 'codec', type: 'codec', mimeType: 'video/H264' },
      ],
    } as const;
    const current = {
      timestampMs: 12_000,
      capture: null,
      reports: [
        {
          id: 'in',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 1_010_000,
          framesDecoded: 618,
          frameWidth: 1920,
          frameHeight: 1080,
          packetsLost: 5,
          packetsReceived: 595,
          codecId: 'codec',
          jitter: 0.006,
          nackCount: 3,
          pliCount: 4,
          freezeCount: 1,
          decoderImplementation: 'ExternalDecoder',
        },
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.04,
        },
        { id: 'codec', type: 'codec', mimeType: 'video/H264' },
      ],
    } as const;

    expect(calculateRtcStats(previous, current)).toMatchObject({
      direction: 'inbound',
      rid: null,
      codecImplementation: 'ExternalDecoder',
      bitrateBps: 4_000_000,
      framesEncoded: null,
      framesDecoded: 618,
      fps: 59,
      rttMs: 40,
      lossPercent: 1,
      jitterMs: 6,
      nackCount: 3,
      pliCount: 4,
      freezeCount: 1,
      qualityLimitationReason: null,
    });
  });

  test('selects the highest-resolution inbound stream when no f RID exists', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 1_000,
      capture: null,
      reports: [
        {
          id: 'in-low',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 1_000,
          framesDecoded: 30,
          frameWidth: 640,
          frameHeight: 360,
        },
        {
          id: 'in-high',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 10_000,
          framesDecoded: 60,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ],
    } as const;
    const current = {
      timestampMs: 2_000,
      capture: null,
      reports: [
        {
          id: 'in-low',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 126_000,
          framesDecoded: 60,
          frameWidth: 640,
          frameHeight: 360,
          decoderImplementation: 'SoftwareDecoder',
        },
        {
          id: 'in-high',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 510_000,
          framesDecoded: 119,
          frameWidth: 1920,
          frameHeight: 1080,
          decoderImplementation: 'HardwareDecoder',
        },
      ],
    } as const;

    expect(calculateRtcStats(previous, current)).toMatchObject({
      direction: 'inbound',
      rid: null,
      bitrateBps: 4_000_000,
      fps: 59,
      width: 1920,
      height: 1080,
      codecImplementation: 'HardwareDecoder',
    });
  });

  test('returns null rates for the first sample', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const current = {
      timestampMs: 1_000,
      capture,
      reports: [
        {
          id: 'out',
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 10_000,
          framesEncoded: 60,
        },
      ],
    } as const;

    expect(calculateRtcStats(undefined, current)).toMatchObject({
      bitrateBps: null,
      fps: null,
      lossPercent: null,
    });
  });

  test('prefers the native fps gauge over a jittery sample interval', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');
    const previous = {
      timestampMs: 1_000,
      capture,
      reports: [
        {
          id: 'out',
          type: 'outbound-rtp',
          kind: 'video',
          framesEncoded: 100,
        },
      ],
    } as const;
    const current = {
      timestampMs: 2_001,
      capture,
      reports: [
        {
          id: 'out',
          type: 'outbound-rtp',
          kind: 'video',
          framesEncoded: 155,
          framesPerSecond: 55,
        },
      ],
    } as const;

    expect(calculateRtcStats(previous, current).fps).toBe(55);
  });

  test.each([
    ['counter reset', 2_000, 10, 2_000, 10],
    ['zero time delta', 6_000, 30, 1_000, 30],
  ])(
    'handles %s without negative or infinite rates',
    async (
      _label,
      currentBytes,
      currentFrames,
      timestampMs,
      expectedFrames,
    ) => {
      const { calculateRtcStats } = await import('../src/stats.js');
      const previous = {
        timestampMs: 1_000,
        capture,
        reports: [
          {
            id: 'out',
            type: 'outbound-rtp',
            kind: 'video',
            bytesSent: 5_000,
            framesEncoded: 20,
          },
        ],
      } as const;
      const current = {
        timestampMs,
        capture,
        reports: [
          {
            id: 'out',
            type: 'outbound-rtp',
            kind: 'video',
            bytesSent: currentBytes,
            framesEncoded: currentFrames,
          },
        ],
      } as const;

      expect(calculateRtcStats(previous, current)).toMatchObject({
        framesEncoded: expectedFrames,
        bitrateBps: null,
        fps: null,
      });
    },
  );

  test('returns an explicit empty measurement when video RTP stats are absent', async () => {
    const { calculateRtcStats } = await import('../src/stats.js');

    expect(
      calculateRtcStats(undefined, {
        timestampMs: 1_000,
        capture: null,
        reports: [],
      }),
    ).toEqual({
      timestampMs: 1_000,
      direction: null,
      rid: null,
      capture: null,
      codec: null,
      codecImplementation: null,
      bitrateBps: null,
      framesEncoded: null,
      framesDecoded: null,
      width: null,
      height: null,
      fps: null,
      rttMs: null,
      lossPercent: null,
      jitterMs: null,
      nackCount: null,
      pliCount: null,
      freezeCount: null,
      qualityLimitationReason: null,
    });
  });
});
