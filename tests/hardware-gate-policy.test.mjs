import { describe, expect, test } from 'vitest';

import {
  BITRATE_TARGETS_MBPS,
  evaluateBitrateGate,
  evaluateCodecGate,
  evaluatePresentedFps,
  evaluateRollingFps,
} from '../docs/poc/hardware-gate-policy.mjs';

const startedAt = Date.parse('2026-07-15T12:00:00.000Z');

function buildEvidence(actual8Mbps = 8_000_000) {
  const events = [];
  const harnessSamples = [];
  const productSamples = [];

  BITRATE_TARGETS_MBPS.forEach((megabits, index) => {
    const target = megabits * 1_000_000;
    const requestedAtMs = startedAt + index * 10_000;
    const appliedAtMs = requestedAtMs + 50;
    events.push({
      requestedBitrateBps: target,
      requestedAt: new Date(requestedAtMs).toISOString(),
      appliedAt: new Date(appliedAtMs).toISOString(),
      success: true,
      producerIdBefore: 'producer-1',
      producerIdAfter: 'producer-1',
      producerIdUnchanged: true,
    });
    for (const offset of [500, 1_500, 2_500]) {
      harnessSamples.push({
        capturedAt: new Date(appliedAtMs + offset).toISOString(),
        senderMaxBitrates: [target],
      });
      productSamples.push({
        direction: 'outbound',
        timestampMs: appliedAtMs + offset,
        bitrateBps: target === 8_000_000 ? actual8Mbps : 250_000,
      });
    }
  });

  return { events, harnessSamples, productSamples };
}

function buildPassingRoleEvidence(role = 'receiver') {
  const measurement = {
    startedAtMs: startedAt,
    endedAtMs: startedAt + 6_000,
    expectedOneSecondSamples: 6,
  };
  const productSamples = Array.from({ length: 6 }, (_, second) => ({
    timestampMs: startedAt + second * 1_000,
    direction: role === 'publisher' ? 'outbound' : 'inbound',
    bitrateBps: 8_000_000,
    fps: 60,
    width: 1_920,
    height: 1_080,
    framesEncoded: second * 60,
    framesDecoded: second * 60,
    qualityLimitationReason: 'none',
  }));
  const harnessSamples = Array.from({ length: 6 }, (_, second) => ({
    capturedAt: new Date(startedAt + second * 1_000).toISOString(),
    videoSignal: {
      error: null,
      brightnessMean: 80,
      blackPixelRatio: 0,
      meanAbsoluteDelta: 10,
      changedPixelRatio: 0.5,
      totalVideoFrames: second * 60,
      droppedVideoFrames: 0,
    },
  }));

  return {
    role,
    measurement,
    productExport: { schemaVersion: 1, role, samples: productSamples },
    productSamples,
    harnessSamples,
  };
}

function passingExperimentChecks(overrides = {}) {
  return {
    formalDurationRequested: true,
    measuredDurationReached: true,
    sourceTypeWindow: true,
    validatesWindowDesktopSharePathOnly: true,
    publisherCapture1920x1080: true,
    machine: true,
    publisher: true,
    receiver: true,
    bitrateChanges: true,
    codecPath: true,
    ...overrides,
  };
}

describe('hardware bitrate gate', () => {
  test('checks configured sender limits for every target and actual bitrate only at 8 Mbps', () => {
    const evidence = buildEvidence();

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: evidence.productSamples },
      evidence.harnessSamples,
    );

    expect(result.pass).toBe(true);
    expect(result.tolerance.evidenceCadence).toEqual({
      requiredSampleCount: 3,
      nominalIntervalMs: 1_000,
      minimumAdjacentIntervalMs: 750,
      maximumAdjacentIntervalMs: 2_000,
      minimumStreakSpanMs: 1_500,
    });
    expect(result.results.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: true,
          requiresActualBitrate: false,
          acceptedActualBitrateRangeBps: null,
        }),
      ]),
    );
    expect(result.results[3]).toMatchObject({
      targetBitrateBps: 8_000_000,
      pass: true,
      requiresActualBitrate: true,
      checks: {
        configuredStreakIntervalsWithinCadence: true,
        configuredStreakSpanAtLeastMinimum: true,
        actualProductBitrateWithinToleranceForThreeConsecutiveSamples: true,
        actualProductBitrateStreakIntervalsWithinCadence: true,
        actualProductBitrateStreakSpanAtLeastMinimum: true,
      },
      configuredStreakTiming: {
        adjacentIntervalsMs: [1_000, 1_000],
        spanMs: 2_000,
        pass: true,
      },
      productBitrateStreakTiming: {
        adjacentIntervalsMs: [1_000, 1_000],
        spanMs: 2_000,
        pass: true,
      },
    });
  });

  test('rejects three configured samples compressed into a two-millisecond burst', () => {
    const evidence = buildEvidence();
    const qualityConfiguredSamples = evidence.harnessSamples.slice(-3);
    const firstTimestampMs = Date.parse(qualityConfiguredSamples[0].capturedAt);
    qualityConfiguredSamples[1].capturedAt = new Date(
      firstTimestampMs + 1,
    ).toISOString();
    qualityConfiguredSamples[2].capturedAt = new Date(
      firstTimestampMs + 2,
    ).toISOString();

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: evidence.productSamples },
      evidence.harnessSamples,
    );

    expect(result.pass).toBe(false);
    expect(result.results[3]).toMatchObject({
      pass: false,
      stableConfiguredSampleStreak: 3,
      checks: {
        configuredForThreeConsecutiveSamples: true,
        configuredStreakIntervalsWithinCadence: false,
        configuredStreakSpanAtLeastMinimum: false,
      },
      configuredStreakTiming: {
        adjacentIntervalsMs: [1, 1],
        spanMs: 2,
        pass: false,
      },
    });
  });

  test('rejects three actual product samples compressed into a two-millisecond burst', () => {
    const evidence = buildEvidence();
    const qualityProductSamples = evidence.productSamples.slice(-3);
    const firstTimestampMs = qualityProductSamples[0].timestampMs;
    qualityProductSamples[1].timestampMs = firstTimestampMs + 1;
    qualityProductSamples[2].timestampMs = firstTimestampMs + 2;

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: evidence.productSamples },
      evidence.harnessSamples,
    );

    expect(result.pass).toBe(false);
    expect(result.results[3]).toMatchObject({
      pass: false,
      stableProductBitrateSampleStreak: 3,
      checks: {
        actualProductBitrateWithinToleranceForThreeConsecutiveSamples: true,
        actualProductBitrateStreakIntervalsWithinCadence: false,
        actualProductBitrateStreakSpanAtLeastMinimum: false,
      },
      productBitrateStreakTiming: {
        adjacentIntervalsMs: [1, 1],
        spanMs: 2,
        pass: false,
      },
    });
  });

  test('fails when the 8 Mbps actual outbound bitrate never enters tolerance', () => {
    const evidence = buildEvidence(4_000_000);

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: evidence.productSamples },
      evidence.harnessSamples,
    );

    expect(result.pass).toBe(false);
    expect(result.results[3]).toMatchObject({
      pass: false,
      stableProductBitrateSampleStreak: 0,
      checks: {
        actualProductBitrateWithinToleranceForThreeConsecutiveSamples: false,
      },
    });
  });

  test('fails when each bitrate event belongs to a different Producer', () => {
    const evidence = buildEvidence();
    evidence.events.forEach((event, index) => {
      event.producerIdBefore = `producer-${index}`;
      event.producerIdAfter = `producer-${index}`;
    });

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: evidence.productSamples },
      evidence.harnessSamples,
    );

    expect(result.pass).toBe(false);
    expect(result.checks).toMatchObject({
      oneProducerAcrossAllTargets: false,
    });
  });

  test.each([
    ['duplicate', 'DUPLICATE_TIMESTAMP'],
    ['out-of-order', 'OUT_OF_ORDER_TIMESTAMP'],
  ])(
    'fails closed when configured and product samples contain %s timestamps',
    (variant, reasonCode) => {
      const evidence = buildEvidence();
      if (variant === 'duplicate') {
        evidence.harnessSamples[1].capturedAt =
          evidence.harnessSamples[0].capturedAt;
        evidence.productSamples[1].timestampMs =
          evidence.productSamples[0].timestampMs;
      } else {
        [evidence.harnessSamples[0], evidence.harnessSamples[1]] = [
          evidence.harnessSamples[1],
          evidence.harnessSamples[0],
        ];
        [evidence.productSamples[0], evidence.productSamples[1]] = [
          evidence.productSamples[1],
          evidence.productSamples[0],
        ];
      }

      const result = evaluateBitrateGate(
        { events: evidence.events, samples: evidence.productSamples },
        evidence.harnessSamples,
      );

      expect(result.pass).toBe(false);
      expect(result.timelineIntegrity.configuredSamples).toMatchObject({
        pass: false,
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: reasonCode }),
        ]),
      });
      expect(result.timelineIntegrity.productSamples).toMatchObject({
        pass: false,
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: reasonCode }),
        ]),
      });
    },
  );

  test('reports empty sample timelines instead of relying on zero streaks', () => {
    const evidence = buildEvidence();

    const result = evaluateBitrateGate(
      { events: evidence.events, samples: [] },
      [],
    );

    expect(result.pass).toBe(false);
    expect(result.timelineIntegrity.configuredSamples.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EMPTY_SERIES' }),
      ]),
    );
    expect(result.timelineIntegrity.productSamples.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EMPTY_SERIES' }),
      ]),
    );
  });
});

describe('hardware fps gate', () => {
  test('removes one-second boundary aliasing with a two-sample rolling window', () => {
    const samples = [
      { timestampMs: 0, direction: 'inbound', framesDecoded: 100, fps: 57 },
      { timestampMs: 1_000, direction: 'inbound', framesDecoded: 152, fps: 52 },
      { timestampMs: 2_000, direction: 'inbound', framesDecoded: 214, fps: 62 },
      { timestampMs: 3_000, direction: 'inbound', framesDecoded: 265, fps: 51 },
      { timestampMs: 4_000, direction: 'inbound', framesDecoded: 327, fps: 62 },
    ];

    expect(evaluateRollingFps(samples, 'inbound', 55)).toMatchObject({
      windowSampleSpan: 2,
      validWindowCount: 3,
      passingWindowCount: 3,
      passRatio: 1,
      minimumFps: 56.5,
    });
  });

  test('still rejects a sustained frame-rate deficit', () => {
    const samples = [0, 1, 2, 3].map((second) => ({
      timestampMs: second * 1_000,
      direction: 'outbound',
      framesEncoded: second * 50,
      fps: 50,
    }));

    expect(evaluateRollingFps(samples, 'outbound', 55)).toMatchObject({
      validWindowCount: 2,
      passingWindowCount: 0,
      passRatio: 0,
      minimumFps: 50,
    });
  });

  test('reports insufficient frame-counter coverage instead of passing sparse evidence', () => {
    const samples = Array.from({ length: 45 }, (_, second) => ({
      timestampMs: second * 1_000,
      direction: 'inbound',
      framesDecoded: second < 3 ? second * 60 : null,
      fps: 60,
    }));

    expect(evaluateRollingFps(samples, 'inbound', 55)).toMatchObject({
      directedSampleCount: 45,
      counterSampleCount: 3,
      counterCoverageRatio: 0.0667,
      validWindowCount: 1,
    });
  });

  test('does not bridge missing evidence with an oversized rolling window', () => {
    const samples = [
      { timestampMs: 0, direction: 'inbound', framesDecoded: 0 },
      { timestampMs: 1_000, direction: 'inbound', framesDecoded: 60 },
      { timestampMs: 10_000, direction: 'inbound', framesDecoded: 600 },
    ];

    expect(evaluateRollingFps(samples, 'inbound', 55)).toMatchObject({
      validWindowCount: 0,
      rejectedGapWindowCount: 1,
    });
  });

  test('records counter resets and exposes insufficient valid-window coverage', () => {
    const samples = Array.from({ length: 45 }, (_, second) => ({
      timestampMs: second * 1_000,
      direction: 'outbound',
      framesEncoded: (second % 3) * 60,
    }));

    expect(evaluateRollingFps(samples, 'outbound', 55)).toMatchObject({
      counterCoverageRatio: 1,
      expectedWindowCount: 43,
      counterResetWindowCount: 28,
      validWindowCount: 15,
      validWindowCoverageRatio: 0.3488,
    });
  });

  test.each([
    [
      'duplicate',
      [0, 1_000, 1_000, 2_000, 3_000],
      [0, 60, 120, 180, 240],
      'DUPLICATE_TIMESTAMP',
    ],
    [
      'out-of-order',
      [0, 2_000, 1_000, 3_000, 4_000],
      [0, 120, 60, 180, 240],
      'OUT_OF_ORDER_TIMESTAMP',
    ],
  ])(
    'fails closed instead of sorting a %s frame-counter timeline',
    (_variant, timestamps, counters, reasonCode) => {
      const samples = timestamps.map((timestampMs, index) => ({
        timestampMs,
        direction: 'inbound',
        framesDecoded: counters[index],
      }));

      expect(evaluateRollingFps(samples, 'inbound', 55)).toMatchObject({
        validWindowCount: 0,
        passingWindowCount: 0,
        passRatio: 0,
        timelineIntegrity: {
          pass: false,
          reasons: expect.arrayContaining([
            expect.objectContaining({ code: reasonCode }),
          ]),
        },
      });
    },
  );

  test.each([
    ['empty', [], 'EMPTY_SERIES'],
    [
      'single-sample',
      [{ timestampMs: 0, direction: 'inbound', framesDecoded: 0 }],
      'INSUFFICIENT_SAMPLES',
    ],
  ])(
    'does not evaluate an %s frame-counter timeline',
    (_name, samples, code) => {
      expect(evaluateRollingFps(samples, 'inbound', 55)).toMatchObject({
        validWindowCount: 0,
        passRatio: 0,
        timelineIntegrity: {
          pass: false,
          reasons: expect.arrayContaining([expect.objectContaining({ code })]),
        },
      });
    },
  );
});

describe('legacy whole-desktop hardware certification scope', () => {
  test('rejects a same-host window-only run as certification evidence', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateLegacyDesktopCertificationScope =
      policy.evaluateLegacyDesktopCertificationScope;

    const result =
      typeof evaluateLegacyDesktopCertificationScope === 'function'
        ? evaluateLegacyDesktopCertificationScope({
            separatePhysicalDevices: false,
            sourceType: 'window',
            validatesWholeMonitor: false,
          })
        : null;

    expect(result).toMatchObject({
      checks: {
        separatePhysicalDevices: false,
        wholeMonitorSource: false,
      },
      pass: false,
    });
  });

  test('accepts only separate physical devices with a monitor source', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateLegacyDesktopCertificationScope =
      policy.evaluateLegacyDesktopCertificationScope;

    const result =
      typeof evaluateLegacyDesktopCertificationScope === 'function'
        ? evaluateLegacyDesktopCertificationScope({
            separatePhysicalDevices: true,
            sourceType: 'monitor',
            validatesWholeMonitor: true,
          })
        : null;

    expect(result).toMatchObject({
      checks: {
        separatePhysicalDevices: true,
        wholeMonitorSource: true,
      },
      pass: true,
    });
  });
});

describe('time-series integrity contract', () => {
  test.each([
    [
      'duplicate timestamps',
      [{ timestampMs: 0 }, { timestampMs: 1_000 }, { timestampMs: 1_000 }],
      { minimumSamples: 2 },
      'DUPLICATE_TIMESTAMP',
    ],
    [
      'out-of-order timestamps',
      [{ timestampMs: 0 }, { timestampMs: 2_000 }, { timestampMs: 1_000 }],
      { minimumSamples: 2 },
      'OUT_OF_ORDER_TIMESTAMP',
    ],
    [
      'an invalid timestamp',
      [{ timestampMs: 0 }, { timestampMs: Number.NaN }],
      { minimumSamples: 2 },
      'INVALID_TIMESTAMP',
    ],
    ['an empty series', [], { minimumSamples: 2 }, 'EMPTY_SERIES'],
    [
      'a single sample',
      [{ timestampMs: 1_000 }],
      { minimumSamples: 2 },
      'INSUFFICIENT_SAMPLES',
    ],
    [
      'an invalid measurement end',
      [{ timestampMs: 0 }, { timestampMs: 1_000 }],
      { minimumSamples: 2, measurementEndMs: Number.NaN },
      'INVALID_MEASUREMENT_END',
    ],
    [
      'a measurement end equal to the last sample',
      [{ timestampMs: 0 }, { timestampMs: 1_000 }],
      { minimumSamples: 2, measurementEndMs: 1_000 },
      'MEASUREMENT_END_NOT_AFTER_LAST_SAMPLE',
    ],
    [
      'a measurement end before the first sample',
      [{ timestampMs: 1_000 }, { timestampMs: 2_000 }],
      { minimumSamples: 2, measurementEndMs: 500 },
      'MEASUREMENT_END_NOT_AFTER_LAST_SAMPLE',
    ],
  ])(
    'rejects %s without reordering it',
    async (_name, samples, options, code) => {
      const policy = await import('../docs/poc/hardware-gate-policy.mjs');
      const evaluateTimeSeriesIntegrity = policy.evaluateTimeSeriesIntegrity;
      const result =
        typeof evaluateTimeSeriesIntegrity === 'function'
          ? evaluateTimeSeriesIntegrity(
              samples,
              (sample) => sample.timestampMs,
              options,
            )
          : null;

      expect(result).toMatchObject({
        pass: false,
        reasons: expect.arrayContaining([expect.objectContaining({ code })]),
      });
    },
  );

  test('accepts a strictly increasing series that ends before measurement end', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateTimeSeriesIntegrity = policy.evaluateTimeSeriesIntegrity;
    const result =
      typeof evaluateTimeSeriesIntegrity === 'function'
        ? evaluateTimeSeriesIntegrity(
            [{ timestampMs: 0 }, { timestampMs: 1_000 }],
            (sample) => sample.timestampMs,
            { minimumSamples: 2, measurementEndMs: 2_000 },
          )
        : null;

    expect(result).toMatchObject({ pass: true, reasons: [] });
  });
});

describe('hardware sustained-condition gate', () => {
  test('measures an irregular bad streak through the recovery sample timestamp', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateMaximumSustainedDurationMs =
      policy.evaluateMaximumSustainedDurationMs;
    const samples = [
      { timestampMs: 0, bad: true },
      { timestampMs: 1_900, bad: true },
      { timestampMs: 3_900, bad: false },
    ];

    const result =
      typeof evaluateMaximumSustainedDurationMs === 'function'
        ? evaluateMaximumSustainedDurationMs(
            samples,
            (sample) => sample.bad,
            (sample) => sample.timestampMs,
            4_000,
          )
        : null;

    expect(result).toMatchObject({
      pass: true,
      maximumDurationMs: 3_900,
      timelineIntegrity: { pass: true, reasons: [] },
    });
  });

  test('extends an open bad streak to the measurement end', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateMaximumSustainedDurationMs =
      policy.evaluateMaximumSustainedDurationMs;
    const samples = [
      { timestampMs: 1_000, bad: false },
      { timestampMs: 2_000, bad: true },
      { timestampMs: 3_800, bad: true },
    ];

    const result =
      typeof evaluateMaximumSustainedDurationMs === 'function'
        ? evaluateMaximumSustainedDurationMs(
            samples,
            (sample) => sample.bad,
            (sample) => sample.timestampMs,
            7_500,
          )
        : null;

    expect(result).toMatchObject({
      pass: true,
      maximumDurationMs: 5_500,
      timelineIntegrity: { pass: true, reasons: [] },
    });
  });

  test.each([
    [
      'duplicate timestamps',
      [
        { timestampMs: 0, bad: true },
        { timestampMs: 1_000, bad: true },
        { timestampMs: 1_000, bad: false },
      ],
      2_000,
      'DUPLICATE_TIMESTAMP',
    ],
    [
      'out-of-order timestamps',
      [
        { timestampMs: 0, bad: true },
        { timestampMs: 2_000, bad: true },
        { timestampMs: 1_000, bad: false },
      ],
      3_000,
      'OUT_OF_ORDER_TIMESTAMP',
    ],
    ['an empty series', [], 2_000, 'EMPTY_SERIES'],
    [
      'a single sample',
      [{ timestampMs: 0, bad: false }],
      2_000,
      'INSUFFICIENT_SAMPLES',
    ],
    [
      'an invalid measurement end',
      [
        { timestampMs: 0, bad: true },
        { timestampMs: 1_000, bad: true },
      ],
      Number.NaN,
      'INVALID_MEASUREMENT_END',
    ],
    [
      'a measurement end at the last sample',
      [
        { timestampMs: 0, bad: true },
        { timestampMs: 1_000, bad: true },
      ],
      1_000,
      'MEASUREMENT_END_NOT_AFTER_LAST_SAMPLE',
    ],
  ])('fails closed for %s', async (_name, samples, measurementEndMs, code) => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateMaximumSustainedDurationMs =
      policy.evaluateMaximumSustainedDurationMs;
    const result =
      typeof evaluateMaximumSustainedDurationMs === 'function'
        ? evaluateMaximumSustainedDurationMs(
            samples,
            (sample) => sample.bad,
            (sample) => sample.timestampMs,
            measurementEndMs,
          )
        : null;

    expect(result).toMatchObject({
      pass: false,
      maximumDurationMs: null,
      timelineIntegrity: {
        pass: false,
        reasons: expect.arrayContaining([expect.objectContaining({ code })]),
      },
    });
  });
});

describe('hardware role and final gate aggregation', () => {
  test('passes a complete role timeline', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateHardwareRoleGate = policy.evaluateHardwareRoleGate;
    const evidence = buildPassingRoleEvidence();
    const result =
      typeof evaluateHardwareRoleGate === 'function'
        ? evaluateHardwareRoleGate(
            evidence.role,
            evidence.productExport,
            evidence.harnessSamples,
            evidence.measurement,
          )
        : null;

    expect(result).toMatchObject({
      role: 'receiver',
      pass: true,
      checks: {
        productTimelineIntegrity: true,
        harnessTimelineIntegrity: true,
        noBlackOutputOver2Seconds: true,
        noFrozenOutputOver2Seconds: true,
        noCpuOrBandwidthLimitOver5Seconds: true,
      },
    });
  });

  test.each([
    ['black', 'noBlackOutputOver2Seconds'],
    ['freeze', 'noFrozenOutputOver2Seconds'],
    ['quality-limitation', 'noCpuOrBandwidthLimitOver5Seconds'],
  ])(
    'lets a %s duration failure control the final status',
    async (kind, check) => {
      const policy = await import('../docs/poc/hardware-gate-policy.mjs');
      const evaluateHardwareRoleGate = policy.evaluateHardwareRoleGate;
      const evaluateLegacyHardwareGate = policy.evaluateLegacyHardwareGate;
      const evidence = buildPassingRoleEvidence();
      if (kind === 'black') {
        for (const sample of evidence.harnessSamples.slice(0, 3)) {
          sample.videoSignal.brightnessMean = 0;
          sample.videoSignal.blackPixelRatio = 1;
        }
      } else if (kind === 'freeze') {
        for (const sample of evidence.harnessSamples.slice(0, 3)) {
          sample.videoSignal.meanAbsoluteDelta = 0;
          sample.videoSignal.changedPixelRatio = 0;
        }
      } else {
        for (const sample of evidence.productSamples) {
          sample.qualityLimitationReason = 'cpu';
        }
      }

      const roleGate =
        typeof evaluateHardwareRoleGate === 'function'
          ? evaluateHardwareRoleGate(
              evidence.role,
              evidence.productExport,
              evidence.harnessSamples,
              evidence.measurement,
            )
          : null;
      const finalGate =
        typeof evaluateLegacyHardwareGate === 'function' && roleGate
          ? evaluateLegacyHardwareGate({
              formal: true,
              preflight: false,
              experimentChecks: passingExperimentChecks({
                receiver: roleGate.pass,
              }),
              certificationScopeGate: { pass: true },
            })
          : null;

      expect(roleGate).toMatchObject({
        pass: false,
        checks: { [check]: false },
      });
      expect(finalGate).toMatchObject({
        status: 'GATE_FAILED',
        hardwarePass: false,
      });
    },
  );

  test('propagates a malformed role timeline into the final status', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateHardwareRoleGate = policy.evaluateHardwareRoleGate;
    const evaluateLegacyHardwareGate = policy.evaluateLegacyHardwareGate;
    const evidence = buildPassingRoleEvidence();
    evidence.harnessSamples[2].capturedAt =
      evidence.harnessSamples[1].capturedAt;
    const roleGate =
      typeof evaluateHardwareRoleGate === 'function'
        ? evaluateHardwareRoleGate(
            evidence.role,
            evidence.productExport,
            evidence.harnessSamples,
            evidence.measurement,
          )
        : null;
    const finalGate =
      typeof evaluateLegacyHardwareGate === 'function' && roleGate
        ? evaluateLegacyHardwareGate({
            formal: true,
            preflight: false,
            experimentChecks: passingExperimentChecks({
              receiver: roleGate.pass,
            }),
            certificationScopeGate: { pass: true },
          })
        : null;

    expect(roleGate).toMatchObject({
      pass: false,
      checks: { harnessTimelineIntegrity: false },
      evidence: {
        harnessTimelineIntegrity: {
          reasons: expect.arrayContaining([
            expect.objectContaining({ code: 'DUPLICATE_TIMESTAMP' }),
          ]),
        },
      },
    });
    expect(finalGate).toMatchObject({
      status: 'GATE_FAILED',
      hardwarePass: false,
    });
  });

  test('returns an experiment pass when media passes but certification scope does not', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateLegacyHardwareGate = policy.evaluateLegacyHardwareGate;
    const result =
      typeof evaluateLegacyHardwareGate === 'function'
        ? evaluateLegacyHardwareGate({
            formal: true,
            preflight: false,
            experimentChecks: passingExperimentChecks(),
            certificationScopeGate: { pass: false },
          })
        : null;

    expect(result).toMatchObject({
      status: 'EXPERIMENT_PASS',
      experimentPass: true,
      hardwarePass: false,
      gateChecks: { certificationScope: false },
    });
  });

  test('returns a hardware pass only for complete formal evidence and scope', async () => {
    const policy = await import('../docs/poc/hardware-gate-policy.mjs');
    const evaluateLegacyHardwareGate = policy.evaluateLegacyHardwareGate;
    const result =
      typeof evaluateLegacyHardwareGate === 'function'
        ? evaluateLegacyHardwareGate({
            formal: true,
            preflight: false,
            experimentChecks: passingExperimentChecks(),
            certificationScopeGate: { pass: true },
          })
        : null;

    expect(result).toMatchObject({
      status: 'HARDWARE_PASS',
      experimentPass: true,
      hardwarePass: true,
      gateChecks: { certificationScope: true },
    });
  });
});

describe('hardware presentation gate', () => {
  test('subtracts dropped frames from total frames before evaluating receiver fps', () => {
    const samples = [0, 1, 2, 3, 4].map((second) => ({
      capturedAt: new Date(startedAt + second * 1_000).toISOString(),
      videoSignal: {
        totalVideoFrames: second * 60,
        droppedVideoFrames: second * 30,
      },
    }));

    expect(evaluatePresentedFps(samples, 55)).toMatchObject({
      validWindowCount: 3,
      passingWindowCount: 0,
      passRatio: 0,
      minimumFps: 30,
    });
  });
});

describe('hardware codec gate', () => {
  test('requires the negotiated H264 profile and a power-efficient encoder', () => {
    const result = evaluateCodecGate(
      [
        {
          codecEvidence: {
            mimeType: 'video/H264',
            sdpFmtpLine:
              'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
            encoderImplementation:
              'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)',
            powerEfficientEncoder: true,
          },
        },
      ],
      { mimeType: 'video/H264', profileLevelId: '42001f' },
      [
        {
          codec: 'video/H264',
          codecImplementation:
            'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)',
        },
      ],
    );

    expect(result.pass).toBe(true);
    expect(result.checks).toEqual({
      hasCodecEvidence: true,
      expectedMimeTypeThroughout: true,
      expectedProfileLevelIdThroughout: true,
      encoderImplementationReportedThroughout: true,
      oneEncoderImplementationThroughout: true,
      powerEfficientEncoderThroughout: true,
      hasQualityProductCodecEvidence: true,
      expectedQualityMimeTypeThroughout: true,
      qualityEncoderImplementationReportedThroughout: true,
      qualityEncoderImplementationMatchesRawEvidence: true,
    });
  });

  test('rejects a different profile or a software encoder', () => {
    const result = evaluateCodecGate(
      [
        {
          codecEvidence: {
            mimeType: 'video/H264',
            sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f',
            encoderImplementation:
              'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)',
            powerEfficientEncoder: false,
          },
        },
      ],
      { mimeType: 'video/H264', profileLevelId: '42001f' },
      [
        {
          codec: 'video/H264',
          codecImplementation: 'OpenH264VideoEncoder',
        },
      ],
    );

    expect(result.pass).toBe(false);
    expect(result.checks).toMatchObject({
      expectedProfileLevelIdThroughout: false,
      powerEfficientEncoderThroughout: false,
      qualityEncoderImplementationMatchesRawEvidence: false,
    });
  });

  test('rejects switching between two power-efficient encoder implementations', () => {
    const codecEvidence = (encoderImplementation) => ({
      codecEvidence: {
        mimeType: 'video/H264',
        sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f',
        encoderImplementation,
        powerEfficientEncoder: true,
      },
    });
    const result = evaluateCodecGate(
      [codecEvidence('HardwareEncoder-A'), codecEvidence('HardwareEncoder-B')],
      { mimeType: 'video/H264', profileLevelId: '42001f' },
      [
        {
          codec: 'video/H264',
          codecImplementation: 'HardwareEncoder-A',
        },
        {
          codec: 'video/H264',
          codecImplementation: 'HardwareEncoder-B',
        },
      ],
    );

    expect(result.pass).toBe(false);
    expect(result.checks).toMatchObject({
      oneEncoderImplementationThroughout: false,
      qualityEncoderImplementationMatchesRawEvidence: false,
    });
  });
});
