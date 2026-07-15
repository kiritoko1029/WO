export const MIN_SCREEN_BITRATE_BPS = 1_000_000;
export const MAX_SCREEN_BITRATE_BPS = 10_000_000;

export interface ScreenEncoding {
  readonly rid: string;
  readonly maxBitrate?: number;
  readonly maxFramerate?: number;
  readonly scaleResolutionDownBy?: number;
  readonly active?: boolean;
  readonly [key: string]: unknown;
}

function requireFiniteBitrate(targetBitrateBps: number): void {
  if (!Number.isFinite(targetBitrateBps)) {
    throw new TypeError('Screen bitrate target must be finite');
  }
}

export function clampScreenBitrate(targetBitrateBps: number): number {
  requireFiniteBitrate(targetBitrateBps);
  return Math.min(
    MAX_SCREEN_BITRATE_BPS,
    Math.max(MIN_SCREEN_BITRATE_BPS, targetBitrateBps),
  );
}

export function buildScreenEncodings(
  targetBitrateBps: number,
): readonly ScreenEncoding[] {
  const fullBitrate = clampScreenBitrate(targetBitrateBps);

  return [
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
      maxBitrate: fullBitrate,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
    },
  ];
}

export function updateEncodingBitrate<T extends ScreenEncoding>(
  encodings: readonly T[],
  targetBitrateBps: number,
): readonly T[] {
  const clampedBitrateBps = clampScreenBitrate(targetBitrateBps);

  const fullLayerIndexes = encodings.flatMap((encoding, index) =>
    encoding.rid === 'f' ? [index] : [],
  );
  if (fullLayerIndexes.length === 0) {
    throw new Error('Missing f encoding layer');
  }
  if (fullLayerIndexes.length > 1) {
    throw new Error('Duplicate f encoding layer');
  }

  const fullLayerIndex = fullLayerIndexes[0]!;
  return encodings.map((encoding, index) =>
    index === fullLayerIndex
      ? ({ ...encoding, maxBitrate: clampedBitrateBps } as T)
      : encoding,
  );
}
