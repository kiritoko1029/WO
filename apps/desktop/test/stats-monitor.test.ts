import { describe, expect, test, vi } from 'vitest';

import { createStatsBuffer } from '../src/renderer/src/media/stats-buffer.js';
import {
  createPresentationFpsSampler,
  createStatsMonitor,
} from '../src/renderer/src/media/stats-monitor.js';

type Report = Readonly<{ id: string; type: string; [key: string]: unknown }>;

function report(values: readonly Report[]): RTCStatsReport {
  return new Map(values.map((value) => [value.id, value])) as RTCStatsReport;
}

function outbound(
  bytesSent: number,
  framesEncoded: number,
  pairId = 'pair-1',
): RTCStatsReport {
  return report([
    {
      id: 'out',
      type: 'outbound-rtp',
      kind: 'video',
      bytesSent,
      framesEncoded,
      frameWidth: 1_920,
      frameHeight: 1_080,
      codecId: 'codec-out',
      remoteId: 'remote-in',
    },
    {
      id: 'remote-in',
      type: 'remote-inbound-rtp',
      kind: 'video',
      localId: 'out',
      packetsLost: 1,
      packetsReceived: 999,
      roundTripTime: 0.028,
      jitter: 0.004,
    },
    { id: 'codec-out', type: 'codec', mimeType: 'video/H264' },
    {
      id: pairId,
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
    },
    {
      id: 'local',
      type: 'local-candidate',
      candidateType: 'relay',
      protocol: 'udp',
      address: '192.168.1.20',
    },
    {
      id: 'remote',
      type: 'remote-candidate',
      candidateType: 'host',
      protocol: 'udp',
      address: '10.0.0.9',
    },
  ]);
}

function inbound(bytesReceived: number, framesDecoded: number): RTCStatsReport {
  return report([
    {
      id: 'in',
      type: 'inbound-rtp',
      kind: 'video',
      bytesReceived,
      framesDecoded,
      frameWidth: 1_920,
      frameHeight: 1_080,
      packetsLost: 2,
      packetsReceived: 998,
      jitter: 0.005,
      codecId: 'codec-in',
    },
    { id: 'codec-in', type: 'codec', mimeType: 'video/H264' },
  ]);
}

describe('screen stats monitor', () => {
  test('collects actual outbound/inbound quality and exposes only public path data', async () => {
    const buffer = createStatsBuffer({ capacity: 4 });
    const onSample = vi.fn();
    const outboundReports = [outbound(1_000, 10), outbound(501_000, 70)];
    const inboundReports = [inbound(2_000, 20), inbound(502_000, 80)];
    let sampleIndex = 0;
    let nowMs = 1_000;
    const monitor = createStatsMonitor({
      buffer,
      now: () => nowMs,
      getNegotiationGeneration: () => 3,
      getOutboundStats: async () => outboundReports[sampleIndex]!,
      getInboundStats: async () => inboundReports[sampleIndex]!,
      getCaptureSettings: () => ({
        width: 1_920,
        height: 1_080,
        frameRate: 60,
      }),
      getTargetBitrateBps: () => 4_000_000,
      onSample,
    });

    await monitor.poll();
    sampleIndex = 1;
    nowMs = 2_000;
    const current = await monitor.poll();

    expect(current).toMatchObject({
      negotiationGeneration: 3,
      path: { candidateType: 'relay', protocol: 'udp' },
      capture: { width: 1_920, height: 1_080, frameRate: 60 },
      targetBitrateBps: 4_000_000,
      outbound: {
        bitrateBps: 4_000_000,
        fps: 60,
        codec: 'video/H264',
      },
      inbound: {
        bitrateBps: 4_000_000,
        fps: 60,
        codec: 'video/H264',
      },
    });
    expect(onSample).toHaveBeenLastCalledWith(current);
    const serialized = JSON.stringify(buffer.exportSnapshot());
    expect(serialized).not.toMatch(/192\.168|10\.0\.0|candidate-pair|pair-1/);
  });

  test('resets bitrate and FPS baselines after generation or selected-pair changes', async () => {
    const buffer = createStatsBuffer();
    let generation = 1;
    let currentReport = outbound(1_000, 10, 'pair-1');
    let nowMs = 1_000;
    const monitor = createStatsMonitor({
      buffer,
      now: () => nowMs,
      getNegotiationGeneration: () => generation,
      getOutboundStats: async () => currentReport,
    });

    await monitor.poll();
    nowMs = 2_000;
    currentReport = outbound(501_000, 70, 'pair-1');
    expect((await monitor.poll()).outbound).toMatchObject({
      bitrateBps: 4_000_000,
      fps: 60,
    });

    generation = 2;
    nowMs = 3_000;
    currentReport = outbound(1_001_000, 130, 'pair-1');
    expect((await monitor.poll()).outbound).toMatchObject({
      bitrateBps: null,
      fps: null,
    });

    nowMs = 4_000;
    currentReport = outbound(1_501_000, 190, 'pair-2');
    expect((await monitor.poll()).outbound).toMatchObject({
      bitrateBps: null,
      fps: null,
    });
  });

  test('cancels an in-flight poll when transport baselines are reset', async () => {
    const buffer = createStatsBuffer();
    let resolveStats!: (value: RTCStatsReport) => void;
    const getOutboundStats = vi.fn(
      () =>
        new Promise<RTCStatsReport>((resolve) => {
          resolveStats = resolve;
        }),
    );
    const onSample = vi.fn();
    const monitor = createStatsMonitor({
      buffer,
      getNegotiationGeneration: () => 1,
      getOutboundStats,
      onSample,
    });
    const polling = monitor.poll();
    expect(getOutboundStats).toHaveBeenCalledOnce();

    monitor.resetBaselines();
    resolveStats(outbound(1_000, 10));

    await expect(polling).rejects.toThrow('Stats poll was canceled');
    expect(buffer.size).toBe(0);
    expect(onSample).not.toHaveBeenCalled();
  });

  test('computes presentation FPS from playback quality and resets explicitly', () => {
    let totalVideoFrames = 100;
    const sampler = createPresentationFpsSampler({
      getVideoPlaybackQuality: () =>
        ({ totalVideoFrames }) as VideoPlaybackQuality,
    });

    expect(sampler.sample(1_000)).toBeNull();
    totalVideoFrames = 160;
    expect(sampler.sample(2_000)).toBe(60);
    sampler.reset();
    totalVideoFrames = 220;
    expect(sampler.sample(3_000)).toBeNull();
  });

  test('serializes timer polls, reports errors, and stops idempotently', async () => {
    vi.useFakeTimers();
    try {
      let resolveStats: ((value: RTCStatsReport) => void) | undefined;
      const getOutboundStats = vi.fn(
        () =>
          new Promise<RTCStatsReport>((resolve) => {
            resolveStats = resolve;
          }),
      );
      const onError = vi.fn();
      const monitor = createStatsMonitor({
        buffer: createStatsBuffer(),
        intervalMs: 1_000,
        getNegotiationGeneration: () => 1,
        getOutboundStats,
        onError,
      });

      monitor.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(getOutboundStats).toHaveBeenCalledOnce();
      resolveStats?.(outbound(1_000, 10));
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getOutboundStats).toHaveBeenCalledTimes(2);

      monitor.stop();
      monitor.stop();
      resolveStats?.(outbound(2_000, 20));
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(getOutboundStats).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
