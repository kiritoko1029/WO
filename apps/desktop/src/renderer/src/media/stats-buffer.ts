export type PublicCandidateType =
  'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export type PublicTransportProtocol = 'udp' | 'tcp' | 'tls' | 'unknown';

export interface PublicConnectionPath {
  readonly candidateType: PublicCandidateType;
  readonly protocol: PublicTransportProtocol;
}

export interface PublicCaptureMetrics {
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
}

export interface PublicMediaMetrics {
  readonly bitrateBps: number | null;
  readonly fps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly lossPercent: number | null;
  readonly rttMs: number | null;
  readonly jitterMs: number | null;
  readonly codec: string | null;
  readonly nackCount: number | null;
  readonly pliCount: number | null;
  readonly freezeCount: number | null;
}

export interface QualityDiagnosticInput {
  readonly timestampMs: number;
  readonly negotiationGeneration: number;
  readonly path: PublicConnectionPath;
  readonly capture: PublicCaptureMetrics | null;
  readonly targetBitrateBps: number | null;
  readonly outbound: PublicMediaMetrics | null;
  readonly inbound: PublicMediaMetrics | null;
  readonly presentationFps: number | null;
}

export type QualityDiagnosticSample = Readonly<QualityDiagnosticInput>;

export interface StatsExportSnapshot {
  readonly version: 1;
  readonly samples: readonly QualityDiagnosticSample[];
}

export interface StatsBuffer {
  readonly size: number;
  append(input: QualityDiagnosticInput): QualityDiagnosticSample;
  values(): readonly QualityDiagnosticSample[];
  exportSnapshot(): StatsExportSnapshot;
  reset(): void;
}

export interface StatsBufferOptions {
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 120;
const MAX_CAPACITY = 3_600;
const CANDIDATE_TYPES = new Set<PublicCandidateType>([
  'host',
  'srflx',
  'prflx',
  'relay',
  'unknown',
]);
const TRANSPORT_PROTOCOLS = new Set<PublicTransportProtocol>([
  'udp',
  'tcp',
  'tls',
  'unknown',
]);
const CODEC = /^(?:audio|video)\/[A-Za-z0-9][A-Za-z0-9.+-]{0,62}$/u;

function finiteNumber(
  value: number | null,
  name: string,
  options: Readonly<{
    maximum: number;
    integer?: boolean;
    minimum?: number;
  }>,
): number | null {
  if (value === null) return null;
  const minimum = options.minimum ?? 0;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > options.maximum ||
    (options.integer === true && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function sanitizePath(input: PublicConnectionPath): PublicConnectionPath {
  if (
    typeof input !== 'object' ||
    input === null ||
    !CANDIDATE_TYPES.has(input.candidateType) ||
    !TRANSPORT_PROTOCOLS.has(input.protocol)
  ) {
    throw new TypeError('Invalid public connection path');
  }
  return Object.freeze({
    candidateType: input.candidateType,
    protocol: input.protocol,
  });
}

function sanitizeCapture(
  input: PublicCaptureMetrics | null,
): PublicCaptureMetrics | null {
  if (input === null) return null;
  if (typeof input !== 'object') throw new TypeError('Invalid capture metrics');
  return Object.freeze({
    width: finiteNumber(input.width, 'capture width', {
      maximum: 32_768,
      integer: true,
    }),
    height: finiteNumber(input.height, 'capture height', {
      maximum: 32_768,
      integer: true,
    }),
    frameRate: finiteNumber(input.frameRate, 'capture frame rate', {
      maximum: 1_000,
    }),
  });
}

function sanitizeCodec(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !CODEC.test(value)) {
    throw new TypeError('Invalid codec');
  }
  return value;
}

function sanitizeMedia(
  input: PublicMediaMetrics | null,
): PublicMediaMetrics | null {
  if (input === null) return null;
  if (typeof input !== 'object') throw new TypeError('Invalid media metrics');
  return Object.freeze({
    bitrateBps: finiteNumber(input.bitrateBps, 'bitrate', {
      maximum: 1_000_000_000,
    }),
    fps: finiteNumber(input.fps, 'media frame rate', { maximum: 1_000 }),
    width: finiteNumber(input.width, 'media width', {
      maximum: 32_768,
      integer: true,
    }),
    height: finiteNumber(input.height, 'media height', {
      maximum: 32_768,
      integer: true,
    }),
    lossPercent: finiteNumber(input.lossPercent, 'loss percentage', {
      maximum: 100,
    }),
    rttMs: finiteNumber(input.rttMs, 'round trip time', {
      maximum: 3_600_000,
    }),
    jitterMs: finiteNumber(input.jitterMs, 'jitter', {
      maximum: 3_600_000,
    }),
    codec: sanitizeCodec(input.codec),
    nackCount: finiteNumber(input.nackCount, 'NACK count', {
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    }),
    pliCount: finiteNumber(input.pliCount, 'PLI count', {
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    }),
    freezeCount: finiteNumber(input.freezeCount, 'freeze count', {
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    }),
  });
}

function sanitizeSample(
  input: QualityDiagnosticInput,
): QualityDiagnosticSample {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Invalid quality diagnostic sample');
  }
  const timestampMs = finiteNumber(input.timestampMs, 'stats timestamp', {
    maximum: Number.MAX_SAFE_INTEGER,
  });
  const generation = finiteNumber(
    input.negotiationGeneration,
    'negotiation generation',
    { maximum: Number.MAX_SAFE_INTEGER, integer: true },
  );
  if (timestampMs === null || generation === null) {
    throw new TypeError('Required stats fields cannot be null');
  }
  return Object.freeze({
    timestampMs,
    negotiationGeneration: generation,
    path: sanitizePath(input.path),
    capture: sanitizeCapture(input.capture),
    targetBitrateBps: finiteNumber(input.targetBitrateBps, 'target bitrate', {
      minimum: 1_000_000,
      maximum: 20_000_000,
      integer: true,
    }),
    outbound: sanitizeMedia(input.outbound),
    inbound: sanitizeMedia(input.inbound),
    presentationFps: finiteNumber(
      input.presentationFps,
      'presentation frame rate',
      { maximum: 1_000 },
    ),
  });
}

export function createStatsBuffer(
  options: StatsBufferOptions = {},
): StatsBuffer {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CAPACITY
  ) {
    throw new RangeError('Stats buffer capacity is out of range');
  }
  const entries = new Array<QualityDiagnosticSample | undefined>(capacity);
  let nextIndex = 0;
  let count = 0;

  const values = (): readonly QualityDiagnosticSample[] => {
    const output: QualityDiagnosticSample[] = [];
    const firstIndex = count === capacity ? nextIndex : 0;
    for (let offset = 0; offset < count; offset += 1) {
      output.push(entries[(firstIndex + offset) % capacity]!);
    }
    return Object.freeze(output);
  };

  const buffer: StatsBuffer = {
    get size() {
      return count;
    },
    append(input) {
      const sanitized = sanitizeSample(input);
      entries[nextIndex] = sanitized;
      nextIndex = (nextIndex + 1) % capacity;
      count = Math.min(count + 1, capacity);
      return sanitized;
    },
    values,
    exportSnapshot: () =>
      Object.freeze({ version: 1 as const, samples: values() }),
    reset() {
      entries.fill(undefined);
      nextIndex = 0;
      count = 0;
    },
  };
  return Object.freeze(buffer);
}
