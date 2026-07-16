export const BITRATE_TARGETS_MBPS = Object.freeze([2, 4, 6, 8]);
export const BITRATE_TOLERANCE_RATIO = 0.2;
export const BITRATE_SETTLE_WINDOW_MS = 5_000;
export const QUALITY_TARGET_BITRATE_BPS = 8_000_000;
// Bitrate evidence is exported at a nominal one-second cadence. These bounds
// tolerate scheduler jitter and a missed tick without accepting burst copies.
export const BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES = 3;
export const BITRATE_EVIDENCE_NOMINAL_INTERVAL_MS = 1_000;
export const BITRATE_EVIDENCE_MIN_ADJACENT_INTERVAL_MS = 750;
export const BITRATE_EVIDENCE_MAX_ADJACENT_INTERVAL_MS = 2_000;
export const BITRATE_EVIDENCE_MIN_STREAK_SPAN_MS = 1_500;
export const FPS_WINDOW_SAMPLE_SPAN = 2;
export const MAX_FPS_WINDOW_ELAPSED_MS = 2_500;
export const MIN_SAMPLE_COVERAGE_RATIO = 0.95;

const LEGACY_EXPERIMENT_CHECK_NAMES = Object.freeze([
  'formalDurationRequested',
  'measuredDurationReached',
  'sourceTypeWindow',
  'validatesWindowDesktopSharePathOnly',
  'publisherCapture1920x1080',
  'machine',
  'publisher',
  'receiver',
  'bitrateChanges',
  'codecPath',
]);

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function maxConsecutive(values, predicate) {
  let maximum = 0;
  let current = 0;
  for (const value of values) {
    if (predicate(value)) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function inspectBitrateEvidenceWindow(samples, readTimestamp) {
  const timestampsMs = samples.map(readTimestamp);
  const adjacentIntervalsMs = timestampsMs
    .slice(1)
    .map((timestampMs, index) => timestampMs - timestampsMs[index]);
  const hasRequiredSamples =
    samples.length === BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES;
  const adjacentIntervalsWithinCadence =
    hasRequiredSamples &&
    adjacentIntervalsMs.every(
      (intervalMs) =>
        Number.isFinite(intervalMs) &&
        intervalMs >= BITRATE_EVIDENCE_MIN_ADJACENT_INTERVAL_MS &&
        intervalMs <= BITRATE_EVIDENCE_MAX_ADJACENT_INTERVAL_MS,
    );
  const rawSpanMs =
    timestampsMs.length > 1
      ? timestampsMs.at(-1) - timestampsMs[0]
      : Number.NaN;
  const spanMs = Number.isFinite(rawSpanMs) ? rawSpanMs : null;
  const spanAtLeastMinimum =
    hasRequiredSamples &&
    spanMs !== null &&
    spanMs >= BITRATE_EVIDENCE_MIN_STREAK_SPAN_MS;

  return {
    timestampsMs,
    adjacentIntervalsMs,
    spanMs,
    hasRequiredSamples,
    adjacentIntervalsWithinCadence,
    spanAtLeastMinimum,
    pass: adjacentIntervalsWithinCadence && spanAtLeastMinimum,
  };
}

function evaluateBitrateEvidenceStreak(values, predicate, readTimestamp) {
  let currentRun = [];
  let longestRun = [];
  const candidates = [];

  const finishRun = () => {
    if (currentRun.length > longestRun.length) longestRun = currentRun;
    for (
      let index = 0;
      index <= currentRun.length - BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES;
      index += 1
    ) {
      candidates.push(
        inspectBitrateEvidenceWindow(
          currentRun.slice(
            index,
            index + BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES,
          ),
          readTimestamp,
        ),
      );
    }
    currentRun = [];
  };

  for (const value of values) {
    if (predicate(value)) currentRun.push(value);
    else finishRun();
  }
  finishRun();

  const selected =
    candidates.find((candidate) => candidate.pass) ??
    candidates[0] ??
    inspectBitrateEvidenceWindow(
      longestRun.slice(0, BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES),
      readTimestamp,
    );

  return {
    requiredSampleCount: BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES,
    nominalIntervalMs: BITRATE_EVIDENCE_NOMINAL_INTERVAL_MS,
    minimumAdjacentIntervalMs: BITRATE_EVIDENCE_MIN_ADJACENT_INTERVAL_MS,
    maximumAdjacentIntervalMs: BITRATE_EVIDENCE_MAX_ADJACENT_INTERVAL_MS,
    minimumSpanMs: BITRATE_EVIDENCE_MIN_STREAK_SPAN_MS,
    candidateCount: candidates.length,
    ...selected,
  };
}

// This gate belongs to the legacy SFU whole-desktop PoC, not the P2P window matrix.
export function evaluateLegacyDesktopCertificationScope(scope) {
  const checks = {
    separatePhysicalDevices: scope?.separatePhysicalDevices === true,
    wholeMonitorSource:
      scope?.sourceType === 'monitor' && scope?.validatesWholeMonitor === true,
  };

  return { checks, pass: Object.values(checks).every(Boolean) };
}

export function evaluateLegacyHardwareGate({
  formal,
  preflight,
  experimentChecks,
  certificationScopeGate,
}) {
  const normalizedExperimentChecks = Object.fromEntries(
    LEGACY_EXPERIMENT_CHECK_NAMES.map((name) => [
      name,
      experimentChecks?.[name] === true,
    ]),
  );
  const gateChecks = {
    ...normalizedExperimentChecks,
    certificationScope: certificationScopeGate?.pass === true,
  };
  const experimentPass = Object.values({
    ...normalizedExperimentChecks,
    formalDurationRequested: true,
  }).every(Boolean);
  const hardwarePass =
    formal === true && Object.values(gateChecks).every(Boolean);
  const status = hardwarePass
    ? 'HARDWARE_PASS'
    : experimentPass
      ? preflight === true
        ? 'PRECHECK_PASS'
        : 'EXPERIMENT_PASS'
      : 'GATE_FAILED';

  return { status, hardwarePass, experimentPass, gateChecks };
}

export function evaluateTimeSeriesIntegrity(
  samples,
  readTimestamp,
  options = {},
) {
  const minimumSamples = options.minimumSamples ?? 1;
  const reasons = [];
  const timestamps = [];
  if (samples.length === 0) reasons.push({ code: 'EMPTY_SERIES' });
  if (samples.length < minimumSamples) {
    reasons.push({
      code: 'INSUFFICIENT_SAMPLES',
      actual: samples.length,
      minimum: minimumSamples,
    });
  }

  let previousTimestampMs = null;
  for (const [index, sample] of samples.entries()) {
    const timestampMs = readTimestamp(sample);
    timestamps.push(timestampMs);
    if (!Number.isFinite(timestampMs)) {
      reasons.push({ code: 'INVALID_TIMESTAMP', index, timestampMs });
      continue;
    }
    if (previousTimestampMs !== null) {
      if (timestampMs === previousTimestampMs) {
        reasons.push({
          code: 'DUPLICATE_TIMESTAMP',
          index,
          timestampMs,
        });
      } else if (timestampMs < previousTimestampMs) {
        reasons.push({
          code: 'OUT_OF_ORDER_TIMESTAMP',
          index,
          previousTimestampMs,
          timestampMs,
        });
      }
    }
    previousTimestampMs = timestampMs;
  }

  const hasMeasurementEnd = Object.hasOwn(options, 'measurementEndMs');
  const measurementEndMs = options.measurementEndMs;
  if (hasMeasurementEnd && !Number.isFinite(measurementEndMs)) {
    reasons.push({ code: 'INVALID_MEASUREMENT_END', measurementEndMs });
  } else if (hasMeasurementEnd) {
    const finiteTimestamps = timestamps.filter(Number.isFinite);
    const maximumTimestampMs =
      finiteTimestamps.length === 0 ? null : Math.max(...finiteTimestamps);
    if (maximumTimestampMs !== null && measurementEndMs <= maximumTimestampMs) {
      reasons.push({
        code: 'MEASUREMENT_END_NOT_AFTER_LAST_SAMPLE',
        measurementEndMs,
        lastTimestampMs: maximumTimestampMs,
      });
    }
  }

  return {
    pass: reasons.length === 0,
    sampleCount: samples.length,
    minimumSamples,
    firstTimestampMs: timestamps.at(0) ?? null,
    lastTimestampMs: timestamps.at(-1) ?? null,
    measurementEndMs: hasMeasurementEnd ? measurementEndMs : null,
    reasons,
  };
}

export function evaluateMaximumSustainedDurationMs(
  samples,
  predicate,
  readTimestamp,
  measurementEndedAtMs,
) {
  const timelineIntegrity = evaluateTimeSeriesIntegrity(
    samples,
    readTimestamp,
    { minimumSamples: 2, measurementEndMs: measurementEndedAtMs },
  );
  if (!timelineIntegrity.pass) {
    return { pass: false, maximumDurationMs: null, timelineIntegrity };
  }

  let maximumDurationMs = 0;
  let streakStartedAtMs = null;
  for (const sample of samples) {
    const timestampMs = readTimestamp(sample);
    if (predicate(sample)) {
      if (streakStartedAtMs === null) streakStartedAtMs = timestampMs;
    } else if (streakStartedAtMs !== null) {
      maximumDurationMs = Math.max(
        maximumDurationMs,
        timestampMs - streakStartedAtMs,
      );
      streakStartedAtMs = null;
    }
  }

  if (streakStartedAtMs !== null) {
    maximumDurationMs = Math.max(
      maximumDurationMs,
      measurementEndedAtMs - streakStartedAtMs,
    );
  }

  return { pass: true, maximumDurationMs, timelineIntegrity };
}

function evaluateCounterRate(samples, minimumFps, readTimestamp, readCounter) {
  const timelineIntegrity = evaluateTimeSeriesIntegrity(
    samples,
    readTimestamp,
    { minimumSamples: FPS_WINDOW_SAMPLE_SPAN + 1 },
  );
  const ordered = samples
    .map((sample) => ({
      timestampMs: readTimestamp(sample),
      counter: readCounter(sample),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.timestampMs) && Number.isFinite(sample.counter),
    );
  const windows = [];
  let rejectedGapWindowCount = 0;
  let counterResetWindowCount = 0;
  let nonPositiveElapsedWindowCount = 0;
  if (timelineIntegrity.pass) {
    for (
      let index = FPS_WINDOW_SAMPLE_SPAN;
      index < ordered.length;
      index += 1
    ) {
      const previous = ordered[index - FPS_WINDOW_SAMPLE_SPAN];
      const current = ordered[index];
      const elapsedMs = current.timestampMs - previous.timestampMs;
      const frameDelta = current.counter - previous.counter;
      if (elapsedMs <= 0) {
        nonPositiveElapsedWindowCount += 1;
        continue;
      }
      if (frameDelta < 0) {
        counterResetWindowCount += 1;
        continue;
      }
      if (elapsedMs > MAX_FPS_WINDOW_ELAPSED_MS) {
        rejectedGapWindowCount += 1;
        continue;
      }
      windows.push((frameDelta * 1_000) / elapsedMs);
    }
  }
  const passingWindowCount = windows.filter((fps) => fps >= minimumFps).length;
  const expectedWindowCount = Math.max(
    0,
    samples.length - FPS_WINDOW_SAMPLE_SPAN,
  );

  return {
    windowSampleSpan: FPS_WINDOW_SAMPLE_SPAN,
    maximumWindowElapsedMs: MAX_FPS_WINDOW_ELAPSED_MS,
    timelineIntegrity,
    directedSampleCount: samples.length,
    counterSampleCount: ordered.length,
    counterCoverageRatio:
      samples.length === 0 ? 0 : round(ordered.length / samples.length),
    expectedWindowCount,
    validWindowCoverageRatio:
      expectedWindowCount === 0
        ? 0
        : round(windows.length / expectedWindowCount),
    counterResetWindowCount,
    nonPositiveElapsedWindowCount,
    rejectedGapWindowCount,
    validWindowCount: windows.length,
    passingWindowCount,
    passRatio:
      windows.length === 0 ? 0 : round(passingWindowCount / windows.length),
    minimumFps: windows.length === 0 ? null : round(Math.min(...windows)),
    maximumFps: windows.length === 0 ? null : round(Math.max(...windows)),
  };
}

export function evaluateRollingFps(samples, direction, minimumFps) {
  const frameKey = direction === 'outbound' ? 'framesEncoded' : 'framesDecoded';
  const directed = samples.filter((sample) => sample.direction === direction);
  return evaluateCounterRate(
    directed,
    minimumFps,
    (sample) => sample.timestampMs,
    (sample) => sample[frameKey],
  );
}

export function evaluatePresentedFps(samples, minimumFps) {
  return evaluateCounterRate(
    samples,
    minimumFps,
    (sample) => Date.parse(sample.capturedAt),
    (sample) => {
      const total = sample.videoSignal?.totalVideoFrames;
      const dropped = sample.videoSignal?.droppedVideoFrames;
      if (!Number.isFinite(total) || !Number.isFinite(dropped)) return null;
      const presented = total - dropped;
      return presented >= 0 ? presented : null;
    },
  );
}

function ratio(values, predicate) {
  return values.length === 0
    ? 0
    : values.filter(predicate).length / values.length;
}

function evaluateMeasurementIntegrity(measurement) {
  const reasons = [];
  if (!Number.isFinite(measurement?.startedAtMs)) {
    reasons.push({ code: 'INVALID_MEASUREMENT_START' });
  }
  if (!Number.isFinite(measurement?.endedAtMs)) {
    reasons.push({ code: 'INVALID_MEASUREMENT_END' });
  }
  if (
    Number.isFinite(measurement?.startedAtMs) &&
    Number.isFinite(measurement?.endedAtMs) &&
    measurement.endedAtMs <= measurement.startedAtMs
  ) {
    reasons.push({ code: 'MEASUREMENT_END_NOT_AFTER_START' });
  }
  if (
    !Number.isInteger(measurement?.expectedOneSecondSamples) ||
    measurement.expectedOneSecondSamples <= 0
  ) {
    reasons.push({ code: 'INVALID_EXPECTED_SAMPLE_COUNT' });
  }
  return { pass: reasons.length === 0, reasons };
}

function analyzeTemporalCoverage(timestamps, measurement) {
  const timelineIntegrity = evaluateTimeSeriesIntegrity(
    timestamps,
    (timestamp) => timestamp,
    { minimumSamples: 2, measurementEndMs: measurement?.endedAtMs },
  );
  const measurementIntegrity = evaluateMeasurementIntegrity(measurement);
  if (!timelineIntegrity.pass || !measurementIntegrity.pass) {
    return {
      validTimestampCount: 0,
      coveredOneSecondBuckets: 0,
      coverageRatio: 0,
      maximumIntervalMs: Number.POSITIVE_INFINITY,
      timelineIntegrity,
      measurementIntegrity,
    };
  }

  const coveredBuckets = new Set();
  for (const timestamp of timestamps) {
    const bucket = Math.floor((timestamp - measurement.startedAtMs) / 1_000);
    if (bucket >= 0 && bucket < measurement.expectedOneSecondSamples) {
      coveredBuckets.add(bucket);
    }
  }

  const anchored = [
    measurement.startedAtMs,
    ...timestamps,
    measurement.endedAtMs,
  ];
  let maximumIntervalMs = 0;
  for (let index = 1; index < anchored.length; index += 1) {
    maximumIntervalMs = Math.max(
      maximumIntervalMs,
      anchored[index] - anchored[index - 1],
    );
  }

  return {
    validTimestampCount: timestamps.length,
    coveredOneSecondBuckets: coveredBuckets.size,
    coverageRatio: Math.min(
      1,
      coveredBuckets.size / measurement.expectedOneSecondSamples,
    ),
    maximumIntervalMs,
    timelineIntegrity,
    measurementIntegrity,
  };
}

export function evaluateHardwareRoleGate(
  role,
  productExport,
  samples,
  measurement,
) {
  const expectedDirection = role === 'publisher' ? 'outbound' : 'inbound';
  const productSamples = productExport.samples ?? [];
  const roleProductSamples = productSamples.filter(
    (sample) => sample.direction === expectedDirection,
  );
  const productTimelineIntegrity = evaluateTimeSeriesIntegrity(
    roleProductSamples,
    (sample) => sample.timestampMs,
    { minimumSamples: 2 },
  );
  const measurementIntegrity = evaluateMeasurementIntegrity(measurement);
  const measured = roleProductSamples.filter(
    (sample) =>
      Number.isFinite(sample.timestampMs) &&
      Number.isFinite(measurement?.startedAtMs) &&
      Number.isFinite(measurement?.endedAtMs) &&
      sample.timestampMs >= measurement.startedAtMs &&
      sample.timestampMs <= measurement.endedAtMs,
  );
  const measuredTimelineIntegrity = evaluateTimeSeriesIntegrity(
    measured,
    (sample) => sample.timestampMs,
    { minimumSamples: 3, measurementEndMs: measurement?.endedAtMs },
  );
  const harnessTimelineIntegrity = evaluateTimeSeriesIntegrity(
    samples,
    (sample) => Date.parse(sample.capturedAt),
    { minimumSamples: 3, measurementEndMs: measurement?.endedAtMs },
  );
  const validStats = measured.filter(
    (sample) =>
      Number.isFinite(sample.bitrateBps) &&
      Number.isFinite(sample.fps) &&
      Number.isFinite(sample.width) &&
      Number.isFinite(sample.height),
  );
  const analyzableVideoSamples = samples.filter((sample) => {
    const timestamp = Date.parse(sample.capturedAt);
    return (
      Number.isFinite(measurement?.startedAtMs) &&
      Number.isFinite(measurement?.endedAtMs) &&
      timestamp >= measurement.startedAtMs &&
      timestamp <= measurement.endedAtMs &&
      sample.videoSignal?.error === null &&
      Number.isFinite(sample.videoSignal?.brightnessMean) &&
      Number.isFinite(sample.videoSignal?.blackPixelRatio) &&
      Number.isFinite(sample.videoSignal?.meanAbsoluteDelta) &&
      Number.isFinite(sample.videoSignal?.changedPixelRatio)
    );
  });
  const productTemporalCoverage = analyzeTemporalCoverage(
    validStats.map((sample) => sample.timestampMs),
    measurement,
  );
  const harnessVideoTemporalCoverage = analyzeTemporalCoverage(
    analyzableVideoSamples.map((sample) => Date.parse(sample.capturedAt)),
    measurement,
  );
  const resolutionPass =
    measured.length > 0 &&
    measured.every(
      (sample) => sample.width === 1_920 && sample.height === 1_080,
    );
  const nativeFpsGaugeRatio = ratio(validStats, (sample) => sample.fps >= 55);
  const rollingFps = evaluateRollingFps(measured, expectedDirection, 55);
  const presentedFps = evaluatePresentedFps(samples, 55);
  const rollingFpsPassRatio =
    rollingFps.validWindowCount === 0
      ? 0
      : rollingFps.passingWindowCount / rollingFps.validWindowCount;
  const rollingFpsCounterCoverage =
    rollingFps.directedSampleCount === 0
      ? 0
      : rollingFps.counterSampleCount / rollingFps.directedSampleCount;
  const rollingFpsWindowCoverage =
    rollingFps.expectedWindowCount === 0
      ? 0
      : rollingFps.validWindowCount / rollingFps.expectedWindowCount;
  const presentedFpsPassRatio =
    presentedFps.validWindowCount === 0
      ? 0
      : presentedFps.passingWindowCount / presentedFps.validWindowCount;
  const presentationCounterCoverage =
    presentedFps.directedSampleCount === 0
      ? 0
      : presentedFps.counterSampleCount / presentedFps.directedSampleCount;
  const presentationWindowCoverage =
    presentedFps.expectedWindowCount === 0
      ? 0
      : presentedFps.validWindowCount / presentedFps.expectedWindowCount;
  const maximumBlackDuration = evaluateMaximumSustainedDurationMs(
    analyzableVideoSamples,
    (sample) =>
      sample.videoSignal?.brightnessMean < 3 &&
      sample.videoSignal?.blackPixelRatio > 0.98,
    (sample) => Date.parse(sample.capturedAt),
    measurement?.endedAtMs,
  );
  const maximumFrozenDuration = evaluateMaximumSustainedDurationMs(
    analyzableVideoSamples,
    (sample) =>
      sample.videoSignal?.meanAbsoluteDelta < 0.5 &&
      sample.videoSignal?.changedPixelRatio < 0.005,
    (sample) => Date.parse(sample.capturedAt),
    measurement?.endedAtMs,
  );
  const maximumQualityLimitationDuration = evaluateMaximumSustainedDurationMs(
    measured,
    (sample) =>
      sample.qualityLimitationReason === 'cpu' ||
      sample.qualityLimitationReason === 'bandwidth',
    (sample) => sample.timestampMs,
    measurement?.endedAtMs,
  );
  const checks = {
    measurementIntegrity: measurementIntegrity.pass,
    productTimelineIntegrity: productTimelineIntegrity.pass,
    measuredTimelineIntegrity: measuredTimelineIntegrity.pass,
    harnessTimelineIntegrity: harnessTimelineIntegrity.pass,
    schemaVersion1: productExport.schemaVersion === 1,
    correctRole: productExport.role === role,
    hasMeasuredSamples: measured.length > 0,
    productStatsCoverageAtLeast95Percent:
      productTemporalCoverage.coverageRatio >= MIN_SAMPLE_COVERAGE_RATIO,
    harnessVideoAnalysisCoverageAtLeast95Percent:
      harnessVideoTemporalCoverage.coverageRatio >= MIN_SAMPLE_COVERAGE_RATIO,
    productStatsMaximumIntervalAtMost2Seconds:
      productTemporalCoverage.maximumIntervalMs <= 2_000,
    harnessVideoMaximumIntervalAtMost2Seconds:
      harnessVideoTemporalCoverage.maximumIntervalMs <= 2_000,
    allVideoSignalsErrorFree:
      samples.length > 0 &&
      samples.every((sample) => sample.videoSignal?.error === null),
    resolution1920x1080Throughout: resolutionPass,
    frameTimelineIntegrity: rollingFps.timelineIntegrity.pass,
    frameCounterCoverageAtLeast95Percent:
      rollingFpsCounterCoverage >= MIN_SAMPLE_COVERAGE_RATIO,
    frameCounterWindowCoverageAtLeast95Percent:
      rollingFpsWindowCoverage >= MIN_SAMPLE_COVERAGE_RATIO,
    noFrameCounterReset: rollingFps.counterResetWindowCount === 0,
    noNonPositiveFrameCounterWindow:
      rollingFps.nonPositiveElapsedWindowCount === 0,
    noOversizedFrameCounterWindow: rollingFps.rejectedGapWindowCount === 0,
    fps55RatioAtLeast95Percent:
      rollingFps.validWindowCount > 0 &&
      rollingFpsPassRatio >= MIN_SAMPLE_COVERAGE_RATIO,
    ...(role === 'receiver'
      ? {
          presentationTimelineIntegrity: presentedFps.timelineIntegrity.pass,
          presentationCounterCoverageAtLeast95Percent:
            presentationCounterCoverage >= MIN_SAMPLE_COVERAGE_RATIO,
          presentationWindowCoverageAtLeast95Percent:
            presentationWindowCoverage >= MIN_SAMPLE_COVERAGE_RATIO,
          noPresentationCounterReset:
            presentedFps.counterResetWindowCount === 0,
          noNonPositivePresentationWindow:
            presentedFps.nonPositiveElapsedWindowCount === 0,
          noOversizedPresentationWindow:
            presentedFps.rejectedGapWindowCount === 0,
          presentedFps55RatioAtLeast95Percent:
            presentedFps.validWindowCount > 0 &&
            presentedFpsPassRatio >= MIN_SAMPLE_COVERAGE_RATIO,
        }
      : {}),
    noBlackOutputOver2Seconds:
      maximumBlackDuration.pass &&
      maximumBlackDuration.maximumDurationMs <= 2_000,
    noFrozenOutputOver2Seconds:
      maximumFrozenDuration.pass &&
      maximumFrozenDuration.maximumDurationMs <= 2_000,
    noCpuOrBandwidthLimitOver5Seconds:
      maximumQualityLimitationDuration.pass &&
      maximumQualityLimitationDuration.maximumDurationMs <= 5_000,
  };

  return {
    role,
    checks,
    pass: Object.values(checks).every(Boolean),
    evidence: {
      measurementIntegrity,
      productTimelineIntegrity,
      measuredTimelineIntegrity,
      harnessTimelineIntegrity,
      productSampleCount: productSamples.length,
      measuredSampleCount: measured.length,
      validStatsSampleCount: validStats.length,
      harnessSampleCount: samples.length,
      analyzableVideoSampleCount: analyzableVideoSamples.length,
      expectedOneSecondSamples: measurement?.expectedOneSecondSamples ?? null,
      minimumCoverageRatio: MIN_SAMPLE_COVERAGE_RATIO,
      productStatsCoverage:
        Math.round(productTemporalCoverage.coverageRatio * 10_000) / 10_000,
      harnessVideoAnalysisCoverage:
        Math.round(harnessVideoTemporalCoverage.coverageRatio * 10_000) /
        10_000,
      productStatsCoveredOneSecondBuckets:
        productTemporalCoverage.coveredOneSecondBuckets,
      harnessVideoCoveredOneSecondBuckets:
        harnessVideoTemporalCoverage.coveredOneSecondBuckets,
      productStatsMaximumIntervalMs: productTemporalCoverage.maximumIntervalMs,
      harnessVideoMaximumIntervalMs:
        harnessVideoTemporalCoverage.maximumIntervalMs,
      fps55Ratio: Math.round(rollingFpsPassRatio * 10_000) / 10_000,
      frameCounterCoverage:
        Math.round(rollingFpsCounterCoverage * 10_000) / 10_000,
      frameCounterWindowCoverage:
        Math.round(rollingFpsWindowCoverage * 10_000) / 10_000,
      rollingFps,
      ...(role === 'receiver'
        ? {
            presentedFps55Ratio:
              Math.round(presentedFpsPassRatio * 10_000) / 10_000,
            presentationCounterCoverage:
              Math.round(presentationCounterCoverage * 10_000) / 10_000,
            presentationWindowCoverage:
              Math.round(presentationWindowCoverage * 10_000) / 10_000,
            presentedFps,
          }
        : {}),
      nativeFpsGauge55Ratio: Math.round(nativeFpsGaugeRatio * 10_000) / 10_000,
      maximumBlackDuration,
      maximumFrozenDuration,
      maximumQualityLimitationDuration,
    },
  };
}

function readFmtpParameter(line, name) {
  if (typeof line !== 'string') return null;
  const prefix = `${name.toLowerCase()}=`;
  for (const part of line.split(';')) {
    const normalized = part.trim().toLowerCase();
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return null;
}

export function evaluateCodecGate(
  samples,
  expected,
  qualityProductSamples = [],
) {
  const evidence = samples
    .map((sample) => sample.codecEvidence)
    .filter((value) => value && typeof value === 'object');
  const expectedMimeType = expected.mimeType.toLowerCase();
  const expectedProfileLevelId = expected.profileLevelId.toLowerCase();
  const encoderImplementations = new Set(
    evidence
      .map((item) => item.encoderImplementation)
      .filter(
        (implementation) =>
          typeof implementation === 'string' && implementation.length > 0,
      ),
  );
  const checks = {
    hasCodecEvidence: samples.length > 0 && evidence.length === samples.length,
    expectedMimeTypeThroughout:
      evidence.length > 0 &&
      evidence.every(
        (item) => item.mimeType?.toLowerCase() === expectedMimeType,
      ),
    expectedProfileLevelIdThroughout:
      evidence.length > 0 &&
      evidence.every(
        (item) =>
          readFmtpParameter(item.sdpFmtpLine, 'profile-level-id') ===
          expectedProfileLevelId,
      ),
    encoderImplementationReportedThroughout:
      evidence.length > 0 &&
      evidence.every(
        (item) =>
          typeof item.encoderImplementation === 'string' &&
          item.encoderImplementation.trim().length > 0,
      ),
    oneEncoderImplementationThroughout: encoderImplementations.size === 1,
    powerEfficientEncoderThroughout:
      evidence.length > 0 &&
      evidence.every((item) => item.powerEfficientEncoder === true),
    hasQualityProductCodecEvidence: qualityProductSamples.length > 0,
    expectedQualityMimeTypeThroughout:
      qualityProductSamples.length > 0 &&
      qualityProductSamples.every(
        (item) => item.codec?.toLowerCase() === expectedMimeType,
      ),
    qualityEncoderImplementationReportedThroughout:
      qualityProductSamples.length > 0 &&
      qualityProductSamples.every(
        (item) =>
          typeof item.codecImplementation === 'string' &&
          item.codecImplementation.trim().length > 0,
      ),
    qualityEncoderImplementationMatchesRawEvidence:
      encoderImplementations.size === 1 &&
      qualityProductSamples.length > 0 &&
      qualityProductSamples.every((item) =>
        encoderImplementations.has(item.codecImplementation),
      ),
  };
  const observed = [
    ...new Map(
      evidence.map((item) => [
        JSON.stringify(item),
        {
          ...item,
          profileLevelId: readFmtpParameter(
            item.sdpFmtpLine,
            'profile-level-id',
          ),
        },
      ]),
    ).values(),
  ];

  return {
    expected: {
      mimeType: expected.mimeType,
      profileLevelId: expected.profileLevelId,
    },
    checks,
    pass: Object.values(checks).every(Boolean),
    evidence: {
      sampleCount: samples.length,
      codecEvidenceCount: evidence.length,
      qualityProductSampleCount: qualityProductSamples.length,
      encoderImplementations: [...encoderImplementations],
      observed,
    },
  };
}

export function evaluateBitrateGate(publisherExport, publisherSamples) {
  const events = publisherExport.events ?? [];
  const outboundProductSamples = (publisherExport.samples ?? []).filter(
    (sample) => sample.direction === 'outbound',
  );
  const timelineIntegrity = {
    events: evaluateTimeSeriesIntegrity(
      events,
      (event) => Date.parse(event.requestedAt),
      { minimumSamples: BITRATE_TARGETS_MBPS.length },
    ),
    configuredSamples: evaluateTimeSeriesIntegrity(
      publisherSamples,
      (sample) => Date.parse(sample.capturedAt),
      { minimumSamples: BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES },
    ),
    productSamples: evaluateTimeSeriesIntegrity(
      outboundProductSamples,
      (sample) => sample.timestampMs,
      { minimumSamples: BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES },
    ),
  };
  const timelinesPass = Object.values(timelineIntegrity).every(
    (integrity) => integrity.pass,
  );
  const tolerance = {
    ratio: BITRATE_TOLERANCE_RATIO,
    lowerMultiplier: 1 - BITRATE_TOLERANCE_RATIO,
    upperMultiplier: 1 + BITRATE_TOLERANCE_RATIO,
    evidenceCadence: {
      requiredSampleCount: BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES,
      nominalIntervalMs: BITRATE_EVIDENCE_NOMINAL_INTERVAL_MS,
      minimumAdjacentIntervalMs: BITRATE_EVIDENCE_MIN_ADJACENT_INTERVAL_MS,
      maximumAdjacentIntervalMs: BITRATE_EVIDENCE_MAX_ADJACENT_INTERVAL_MS,
      minimumStreakSpanMs: BITRATE_EVIDENCE_MIN_STREAK_SPAN_MS,
    },
    requirement: `all targets require ${BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES} consecutive configured sender samples within five seconds, with adjacent samples ${BITRATE_EVIDENCE_MIN_ADJACENT_INTERVAL_MS}-${BITRATE_EVIDENCE_MAX_ADJACENT_INTERVAL_MS} ms apart and a span of at least ${BITRATE_EVIDENCE_MIN_STREAK_SPAN_MS} ms; only 8 Mbps also requires actual outbound bitrate evidence under the same cadence within tolerance`,
  };
  const results = BITRATE_TARGETS_MBPS.map((megabits) => {
    const target = megabits * 1_000_000;
    const requiresActualBitrate = target === QUALITY_TARGET_BITRATE_BPS;
    const event = events.find(
      (candidate) => candidate.requestedBitrateBps === target,
    );
    if (!event) {
      return {
        targetBitrateBps: target,
        requiresActualBitrate,
        pass: false,
        reason: 'missing-event',
      };
    }

    const requestedAt = Date.parse(event.requestedAt);
    const appliedAt = event.appliedAt
      ? Date.parse(event.appliedAt)
      : Number.NaN;
    const applyLatencyMs = appliedAt - requestedAt;
    const observationStartedAt = Math.max(requestedAt, appliedAt);
    const observationEndedAt = requestedAt + BITRATE_SETTLE_WINDOW_MS;
    const windowSamples = publisherSamples.filter((sample) => {
      const timestamp = Date.parse(sample.capturedAt);
      return (
        timestamp >= observationStartedAt && timestamp <= observationEndedAt
      );
    });
    const stableConfiguredStreak = maxConsecutive(windowSamples, (sample) =>
      sample.senderMaxBitrates.includes(target),
    );
    const configuredStreakTiming = evaluateBitrateEvidenceStreak(
      windowSamples,
      (sample) => sample.senderMaxBitrates.includes(target),
      (sample) => Date.parse(sample.capturedAt),
    );
    const lowerBitrateBps = target * tolerance.lowerMultiplier;
    const upperBitrateBps = target * tolerance.upperMultiplier;
    const productWindowSamples = outboundProductSamples.filter(
      (sample) =>
        Number.isFinite(sample.timestampMs) &&
        sample.timestampMs >= observationStartedAt &&
        sample.timestampMs <= observationEndedAt,
    );
    const stableProductBitrateStreak = maxConsecutive(
      productWindowSamples,
      (sample) =>
        Number.isFinite(sample.bitrateBps) &&
        sample.bitrateBps >= lowerBitrateBps &&
        sample.bitrateBps <= upperBitrateBps,
    );
    const productBitrateStreakTiming = requiresActualBitrate
      ? evaluateBitrateEvidenceStreak(
          productWindowSamples,
          (sample) =>
            Number.isFinite(sample.bitrateBps) &&
            sample.bitrateBps >= lowerBitrateBps &&
            sample.bitrateBps <= upperBitrateBps,
          (sample) => sample.timestampMs,
        )
      : null;
    const checks = {
      timelineIntegrity: timelinesPass,
      success: event.success === true,
      appliedWithin5Seconds:
        Number.isFinite(applyLatencyMs) &&
        applyLatencyMs >= 0 &&
        applyLatencyMs <= BITRATE_SETTLE_WINDOW_MS,
      producerIdUnchanged: event.producerIdUnchanged === true,
      configuredForThreeConsecutiveSamples:
        stableConfiguredStreak >= BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES,
      configuredStreakIntervalsWithinCadence:
        configuredStreakTiming.adjacentIntervalsWithinCadence,
      configuredStreakSpanAtLeastMinimum:
        configuredStreakTiming.spanAtLeastMinimum,
      ...(requiresActualBitrate
        ? {
            actualProductBitrateWithinToleranceForThreeConsecutiveSamples:
              stableProductBitrateStreak >=
              BITRATE_EVIDENCE_REQUIRED_STREAK_SAMPLES,
            actualProductBitrateStreakIntervalsWithinCadence:
              productBitrateStreakTiming.adjacentIntervalsWithinCadence,
            actualProductBitrateStreakSpanAtLeastMinimum:
              productBitrateStreakTiming.spanAtLeastMinimum,
          }
        : {}),
    };

    return {
      targetBitrateBps: target,
      requiresActualBitrate,
      pass: Object.values(checks).every(Boolean),
      checks,
      applyLatencyMs: Number.isFinite(applyLatencyMs) ? applyLatencyMs : null,
      stableConfiguredSampleStreak: stableConfiguredStreak,
      configuredStreakTiming,
      stableProductBitrateSampleStreak: requiresActualBitrate
        ? stableProductBitrateStreak
        : null,
      productBitrateStreakTiming,
      productSamplesInSettleWindow: requiresActualBitrate
        ? productWindowSamples.length
        : null,
      observationWindow: {
        startedAtMs: Number.isFinite(observationStartedAt)
          ? observationStartedAt
          : null,
        endedAtMs: Number.isFinite(observationEndedAt)
          ? observationEndedAt
          : null,
        cappedAtRequestedAtPlusMs: BITRATE_SETTLE_WINDOW_MS,
      },
      acceptedActualBitrateRangeBps: requiresActualBitrate
        ? { min: lowerBitrateBps, max: upperBitrateBps }
        : null,
      event,
    };
  });

  const producerIds = results.flatMap((result) => {
    const before = result.event?.producerIdBefore;
    const after = result.event?.producerIdAfter;
    return typeof before === 'string' &&
      before.length > 0 &&
      typeof after === 'string' &&
      after.length > 0
      ? [before, after]
      : [];
  });
  const checks = {
    timelineIntegrity: timelinesPass,
    oneEventPerTarget:
      events.length === BITRATE_TARGETS_MBPS.length &&
      BITRATE_TARGETS_MBPS.every(
        (megabits) =>
          events.filter(
            (event) => event.requestedBitrateBps === megabits * 1_000_000,
          ).length === 1,
      ),
    allTargetsPass: results.every((result) => result.pass),
    oneProducerAcrossAllTargets:
      results.length === BITRATE_TARGETS_MBPS.length &&
      producerIds.length === BITRATE_TARGETS_MBPS.length * 2 &&
      new Set(producerIds).size === 1,
  };

  return {
    tolerance,
    timelineIntegrity,
    results,
    checks,
    producerIds: [...new Set(producerIds)],
    pass: Object.values(checks).every(Boolean),
  };
}
