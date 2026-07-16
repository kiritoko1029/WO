import { describe, expect, test } from 'vitest';

import {
  createStatsBuffer,
  type QualityDiagnosticInput,
} from '../src/renderer/src/media/stats-buffer.js';

function sample(
  timestampMs: number,
  overrides: Partial<QualityDiagnosticInput> = {},
): QualityDiagnosticInput {
  return {
    timestampMs,
    negotiationGeneration: 2,
    path: { candidateType: 'relay', protocol: 'udp' },
    capture: { width: 1_920, height: 1_080, frameRate: 60 },
    targetBitrateBps: 4_000_000,
    outbound: {
      bitrateBps: 3_800_000,
      fps: 59,
      width: 1_920,
      height: 1_080,
      lossPercent: 0.2,
      rttMs: 28,
      jitterMs: 4,
      codec: 'video/H264',
      nackCount: 2,
      pliCount: 1,
      freezeCount: null,
    },
    inbound: null,
    presentationFps: null,
    ...overrides,
  };
}

describe('bounded privacy-safe stats buffer', () => {
  test('keeps only the newest samples in chronological order', () => {
    const buffer = createStatsBuffer({ capacity: 3 });

    for (const timestampMs of [1_000, 2_000, 3_000, 4_000]) {
      buffer.append(sample(timestampMs));
    }

    expect(buffer.values().map((value) => value.timestampMs)).toEqual([
      2_000, 3_000, 4_000,
    ]);
    expect(buffer.size).toBe(3);
  });

  test('constructs an allowlisted export and drops private or arbitrary fields', () => {
    const buffer = createStatsBuffer({ capacity: 2 });
    const hostile = {
      ...sample(1_000),
      email: 'person@example.cn',
      token: 'access-secret',
      sdp: 'v=0 private',
      sourceName: 'Payroll window',
      path: {
        candidateType: 'relay',
        protocol: 'udp',
        address: '192.168.1.20',
        relatedAddress: '10.0.0.8',
      },
      capture: {
        width: 1_920,
        height: 1_080,
        frameRate: 60,
        sourceName: 'Payroll window',
      },
      outbound: {
        ...sample(1_000).outbound,
        candidate: 'candidate: private',
      },
    } as unknown as QualityDiagnosticInput;

    buffer.append(hostile);
    const exported = buffer.exportSnapshot();
    const serialized = JSON.stringify(exported);

    expect(exported).toEqual({
      version: 1,
      samples: [sample(1_000)],
    });
    expect(serialized).not.toMatch(
      /person@example|access-secret|v=0|Payroll|192\.168|10\.0|candidate:/,
    );
    expect(Object.isFrozen(exported)).toBe(true);
    expect(Object.isFrozen(exported.samples)).toBe(true);
    expect(Object.isFrozen(exported.samples[0]?.outbound)).toBe(true);
  });

  test('clears all retained diagnostics on a generation reset', () => {
    const buffer = createStatsBuffer({ capacity: 4 });
    buffer.append(sample(1_000));
    buffer.append(sample(2_000));

    buffer.reset();

    expect(buffer.size).toBe(0);
    expect(buffer.values()).toEqual([]);
  });

  test.each([
    ['capacity', () => createStatsBuffer({ capacity: 0 })],
    [
      'timestamp',
      () => createStatsBuffer().append(sample(Number.POSITIVE_INFINITY)),
    ],
    [
      'generation',
      () =>
        createStatsBuffer().append(
          sample(1_000, { negotiationGeneration: -1 }),
        ),
    ],
    [
      'path',
      () =>
        createStatsBuffer().append(
          sample(1_000, {
            path: {
              candidateType: '192.168.1.20' as 'relay',
              protocol: 'udp',
            },
          }),
        ),
    ],
    [
      'codec',
      () =>
        createStatsBuffer().append(
          sample(1_000, {
            outbound: {
              ...sample(1_000).outbound!,
              codec: 'video/H264\nsecret',
            },
          }),
        ),
    ],
    [
      'metric',
      () =>
        createStatsBuffer().append(
          sample(1_000, {
            presentationFps: Number.NaN,
          }),
        ),
    ],
  ] as const)('rejects invalid %s values', (_label, operation) => {
    expect(operation).toThrow();
  });
});
