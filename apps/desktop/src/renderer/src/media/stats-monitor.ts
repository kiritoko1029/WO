import {
  calculateRtcStats,
  type CaptureSettings,
  type MediaStats,
  type RtcStatsRecord,
  type RtcStatsSample,
} from '@wo/media-policy';

import type {
  PublicCaptureMetrics,
  PublicConnectionPath,
  PublicMediaMetrics,
  QualityDiagnosticSample,
  StatsBuffer,
} from './stats-buffer.js';

export interface PresentationFpsSampler {
  sample(timestampMs: number): number | null;
  reset(): void;
}

export interface PresentationVideo {
  getVideoPlaybackQuality(): VideoPlaybackQuality;
}

export interface StatsMonitorOptions {
  readonly buffer: StatsBuffer;
  readonly getNegotiationGeneration: () => number;
  readonly getOutboundStats?: () => Promise<RTCStatsReport>;
  readonly getInboundStats?: () => Promise<RTCStatsReport>;
  readonly getCaptureSettings?: () => PublicCaptureMetrics | null;
  readonly getTargetBitrateBps?: () => number | null;
  readonly presentationSampler?: PresentationFpsSampler;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly onSample?: (sample: QualityDiagnosticSample) => void;
  readonly onError?: (error: unknown) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export interface StatsMonitor {
  poll(): Promise<QualityDiagnosticSample>;
  resetBaselines(): void;
  start(): void;
  stop(): void;
}

class StatsPollCanceledError extends Error {
  constructor() {
    super('Stats poll was canceled');
    this.name = 'StatsPollCanceledError';
  }
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function createPresentationFpsSampler(
  video: PresentationVideo,
): PresentationFpsSampler {
  let previousTimestampMs: number | null = null;
  let previousFrames: number | null = null;

  const reset = (): void => {
    previousTimestampMs = null;
    previousFrames = null;
  };

  const sampler: PresentationFpsSampler = {
    sample(timestampMs) {
      const frames = video.getVideoPlaybackQuality().totalVideoFrames;
      if (
        !Number.isFinite(timestampMs) ||
        !Number.isSafeInteger(frames) ||
        frames < 0
      ) {
        reset();
        return null;
      }
      const priorTimestamp = previousTimestampMs;
      const priorFrames = previousFrames;
      previousTimestampMs = timestampMs;
      previousFrames = frames;
      if (
        priorTimestamp === null ||
        priorFrames === null ||
        timestampMs <= priorTimestamp ||
        frames < priorFrames
      ) {
        return null;
      }
      return rounded(
        ((frames - priorFrames) * 1_000) / (timestampMs - priorTimestamp),
      );
    },
    reset,
  };
  return Object.freeze(sampler);
}

function recordsFrom(report: RTCStatsReport | null): readonly RtcStatsRecord[] {
  if (report === null) return Object.freeze([]);
  const records: RtcStatsRecord[] = [];
  report.forEach((value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof value.id === 'string' &&
      typeof value.type === 'string'
    ) {
      records.push({ ...value, id: value.id, type: value.type });
    }
  });
  return Object.freeze(records);
}

function selectedPair(
  reports: readonly RtcStatsRecord[],
): RtcStatsRecord | undefined {
  const transport = reports.find(
    (item) =>
      item.type === 'transport' &&
      typeof item.selectedCandidatePairId === 'string',
  );
  if (transport && typeof transport.selectedCandidatePairId === 'string') {
    const selected = reports.find(
      (item) => item.id === transport.selectedCandidatePairId,
    );
    if (selected?.type === 'candidate-pair') return selected;
  }
  return reports.find(
    (item) =>
      item.type === 'candidate-pair' &&
      item.state === 'succeeded' &&
      item.nominated === true,
  );
}

function publicConnectionPath(input: {
  readonly outbound: readonly RtcStatsRecord[];
  readonly inbound: readonly RtcStatsRecord[];
}): Readonly<{ path: PublicConnectionPath; pairId: string }> {
  const reports = [...input.outbound, ...input.inbound];
  const pair = selectedPair(reports);
  const localCandidateId =
    typeof pair?.localCandidateId === 'string' ? pair.localCandidateId : null;
  const local =
    localCandidateId === null
      ? undefined
      : reports.find(
          (item) =>
            item.id === localCandidateId && item.type === 'local-candidate',
        );
  const candidateType =
    local?.candidateType === 'host' ||
    local?.candidateType === 'srflx' ||
    local?.candidateType === 'prflx' ||
    local?.candidateType === 'relay'
      ? local.candidateType
      : 'unknown';
  const candidateProtocol =
    typeof local?.relayProtocol === 'string'
      ? local.relayProtocol
      : local?.protocol;
  const protocol =
    candidateProtocol === 'udp' ||
    candidateProtocol === 'tcp' ||
    candidateProtocol === 'tls'
      ? candidateProtocol
      : 'unknown';
  return Object.freeze({
    path: Object.freeze({ candidateType, protocol }),
    pairId: pair?.id ?? 'unknown',
  });
}

function captureForPolicy(
  capture: PublicCaptureMetrics | null,
): CaptureSettings | null {
  if (capture === null) return null;
  return Object.freeze({
    ...(capture.width === null ? {} : { width: capture.width }),
    ...(capture.height === null ? {} : { height: capture.height }),
    ...(capture.frameRate === null ? {} : { frameRate: capture.frameRate }),
  });
}

function policySample(
  timestampMs: number,
  capture: PublicCaptureMetrics | null,
  reports: readonly RtcStatsRecord[],
): RtcStatsSample {
  return Object.freeze({
    timestampMs,
    capture: captureForPolicy(capture),
    reports,
  });
}

function publicMedia(stats: MediaStats): PublicMediaMetrics | null {
  if (stats.direction === null) return null;
  return Object.freeze({
    bitrateBps: stats.bitrateBps,
    fps: stats.fps,
    width: stats.width,
    height: stats.height,
    lossPercent: stats.lossPercent,
    rttMs: stats.rttMs,
    jitterMs: stats.jitterMs,
    codec: stats.codec,
    nackCount: stats.nackCount,
    pliCount: stats.pliCount,
    freezeCount: stats.freezeCount,
  });
}

export function createStatsMonitor(options: StatsMonitorOptions): StatsMonitor {
  if (
    options.getOutboundStats === undefined &&
    options.getInboundStats === undefined
  ) {
    throw new TypeError('At least one stats source is required');
  }
  const intervalMs = options.intervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 250 ||
    intervalMs > 60_000
  ) {
    throw new RangeError('Stats interval is out of range');
  }
  const now = options.now ?? Date.now;
  const setIntervalFunction = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFunction =
    options.clearInterval ?? globalThis.clearInterval;
  let previousOutbound: RtcStatsSample | undefined;
  let previousInbound: RtcStatsSample | undefined;
  let baselineKey: string | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<QualityDiagnosticSample> | null = null;
  let lifecycleGeneration = 0;

  const resetBaselines = (): void => {
    lifecycleGeneration += 1;
    previousOutbound = undefined;
    previousInbound = undefined;
    baselineKey = null;
    options.presentationSampler?.reset();
  };

  const runPoll = async (
    expectedLifecycleGeneration: number,
  ): Promise<QualityDiagnosticSample> => {
    const timestampMs = now();
    const negotiationGeneration = options.getNegotiationGeneration();
    const [outboundReport, inboundReport] = await Promise.all([
      options.getOutboundStats?.() ?? Promise.resolve(null),
      options.getInboundStats?.() ?? Promise.resolve(null),
    ]);
    if (lifecycleGeneration !== expectedLifecycleGeneration) {
      throw new StatsPollCanceledError();
    }
    const outboundRecords = recordsFrom(outboundReport);
    const inboundRecords = recordsFrom(inboundReport);
    const connection = publicConnectionPath({
      outbound: outboundRecords,
      inbound: inboundRecords,
    });
    const nextBaselineKey = `${negotiationGeneration}:${connection.pairId}`;
    if (baselineKey !== nextBaselineKey) resetBaselines();
    baselineKey = nextBaselineKey;
    const capture = options.getCaptureSettings?.() ?? null;
    const outboundSample = policySample(timestampMs, capture, outboundRecords);
    const inboundSample = policySample(timestampMs, null, inboundRecords);
    const outboundStats = calculateRtcStats(previousOutbound, outboundSample);
    const inboundStats = calculateRtcStats(previousInbound, inboundSample);
    previousOutbound = outboundSample;
    previousInbound = inboundSample;
    const sample = options.buffer.append({
      timestampMs,
      negotiationGeneration,
      path: connection.path,
      capture,
      targetBitrateBps: options.getTargetBitrateBps?.() ?? null,
      outbound: publicMedia(outboundStats),
      inbound: publicMedia(inboundStats),
      presentationFps: options.presentationSampler?.sample(timestampMs) ?? null,
    });
    options.onSample?.(sample);
    return sample;
  };

  const poll = (): Promise<QualityDiagnosticSample> => {
    if (inFlight !== null) return inFlight;
    const expectedLifecycleGeneration = lifecycleGeneration;
    const operation = runPoll(expectedLifecycleGeneration).finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation;
  };

  const monitor: StatsMonitor = {
    poll,
    resetBaselines,
    start() {
      if (interval !== null) return;
      interval = setIntervalFunction(() => {
        void poll().catch((error: unknown) => {
          if (!(error instanceof StatsPollCanceledError)) {
            options.onError?.(error);
          }
        });
      }, intervalMs);
    },
    stop() {
      if (interval === null) return;
      clearIntervalFunction(interval);
      interval = null;
      lifecycleGeneration += 1;
      resetBaselines();
    },
  };
  return Object.freeze(monitor);
}
