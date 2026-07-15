import { describe, expect, test } from 'vitest';

describe('screen encoding policy', () => {
  test('builds ordered 720p30 and 1080p60 layers', async () => {
    const policy = await import('../src/screen-encoding.js');

    expect(policy.buildScreenEncodings(6_000_000)).toEqual([
      {
        rid: 'q',
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1.5,
      },
      {
        rid: 'f',
        active: true,
        maxBitrate: 6_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ]);
  });

  test.each([
    [100_000, 1_000_000],
    [15_000_000, 10_000_000],
  ])('clamps %i bps to %i bps', async (target, expected) => {
    const { buildScreenEncodings } = await import('../src/screen-encoding.js');

    expect(buildScreenEncodings(target)[1]?.maxBitrate).toBe(expected);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-finite build target %s',
    async (target) => {
      const { buildScreenEncodings } =
        await import('../src/screen-encoding.js');

      expect(() => buildScreenEncodings(target)).toThrow(/finite/i);
    },
  );

  test('updates only the f layer without mutating input or changing RID order', async () => {
    const { updateEncodingBitrate } = await import('../src/screen-encoding.js');
    const q = {
      rid: 'q',
      active: true,
      maxBitrate: 2_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1.5,
    } as const;
    const f = {
      rid: 'f',
      maxBitrate: 4_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
      active: true,
    } as const;
    const input = [q, f];

    const updated = updateEncodingBitrate(input, 8_000_000);

    expect(updated).toEqual([q, { ...f, maxBitrate: 8_000_000 }]);
    expect(updated).not.toBe(input);
    expect(updated[0]).toBe(q);
    expect(updated[1]).not.toBe(f);
    expect(input[1]?.maxBitrate).toBe(4_000_000);
    expect(updated.map(({ rid }) => rid)).toEqual(['q', 'f']);
  });

  test.each([
    [[{ rid: 'q', maxBitrate: 2_000_000 }], /missing.*f/i],
    [
      [
        { rid: 'f', maxBitrate: 2_000_000 },
        { rid: 'f', maxBitrate: 4_000_000 },
      ],
      /duplicate.*f/i,
    ],
  ])('rejects malformed encoding sets', async (encodings, message) => {
    const { updateEncodingBitrate } = await import('../src/screen-encoding.js');

    expect(() => updateEncodingBitrate(encodings, 6_000_000)).toThrow(message);
  });

  test.each([
    [0, 1_000_000],
    [999_999, 1_000_000],
    [10_000_001, 10_000_000],
    [20_000_000, 10_000_000],
  ])('clamps finite hot-update target %i to %i', async (target, expected) => {
    const { updateEncodingBitrate } = await import('../src/screen-encoding.js');
    const input = [
      { rid: 'q', maxBitrate: 2_000_000 },
      { rid: 'f', maxBitrate: 4_000_000 },
    ] as const;

    const updated = updateEncodingBitrate(input, target);

    expect(updated[1]?.maxBitrate).toBe(expected);
    expect(input[1].maxBitrate).toBe(4_000_000);
    expect(updated.map(({ rid }) => rid)).toEqual(['q', 'f']);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite hot-update target %s',
    async (target) => {
      const { updateEncodingBitrate } =
        await import('../src/screen-encoding.js');

      expect(() =>
        updateEncodingBitrate(
          [
            { rid: 'q', maxBitrate: 2_000_000 },
            { rid: 'f', maxBitrate: 4_000_000 },
          ],
          target,
        ),
      ).toThrow(/finite/i);
    },
  );
});
