import { clampScreenBitrate } from '@wo/media-policy';

/** User-facing quality tiers. Values are maxBitrate ceilings, not fixed rates. */
export const SCREEN_BITRATE_PRESETS = Object.freeze([
  Object.freeze({ label: '清晰', bitrateBps: 5_000_000 }),
  Object.freeze({ label: '高清', bitrateBps: 10_000_000 }),
  Object.freeze({ label: '原画', bitrateBps: 20_000_000 }),
] as const);

export const SCREEN_BITRATE_PRESETS_BPS = Object.freeze(
  SCREEN_BITRATE_PRESETS.map((preset) => preset.bitrateBps),
);

/** Default quality tier when screen share starts (高清, 10 Mbps ceiling). */
export const DEFAULT_SCREEN_BITRATE_TARGET = Object.freeze({
  mode: 'fixed' as const,
  bitrateBps: 10_000_000,
});

export type ScreenBitrateTarget =
  Readonly<{ mode: 'auto' }> | Readonly<{ mode: 'fixed'; bitrateBps: number }>;

export interface ScreenBitrateSender {
  getParameters(): RTCRtpSendParameters;
  setParameters(parameters: RTCRtpSendParameters): Promise<void>;
}

export type ScreenBitrateApplyResult = Readonly<{
  status: 'applied' | 'pending';
  target: ScreenBitrateTarget;
}>;

export interface SenderBitrateSnapshot {
  readonly desiredTarget: ScreenBitrateTarget;
  readonly lastSuccessfulTarget: ScreenBitrateTarget;
  readonly pendingTarget: ScreenBitrateTarget | null;
}

export interface SenderBitrateController {
  getSnapshot(): SenderBitrateSnapshot;
  setTarget(target: ScreenBitrateTarget): Promise<ScreenBitrateApplyResult>;
  replay(): Promise<ScreenBitrateApplyResult>;
}

export interface SenderBitrateControllerOptions {
  readonly getSender: () => ScreenBitrateSender | null;
  readonly initialTarget?: ScreenBitrateTarget;
}

const AUTO_TARGET: ScreenBitrateTarget = Object.freeze({ mode: 'auto' });

function normalizedTarget(target: ScreenBitrateTarget): ScreenBitrateTarget {
  if (target.mode === 'auto') return AUTO_TARGET;
  if (!Number.isSafeInteger(target.bitrateBps)) {
    throw new TypeError('Screen bitrate must be a safe integer');
  }
  return Object.freeze({
    mode: 'fixed',
    bitrateBps: clampScreenBitrate(target.bitrateBps),
  });
}

function fullResolutionIndex(
  encodings: readonly RTCRtpEncodingParameters[],
): number {
  const named = encodings.flatMap((encoding, index) =>
    encoding.rid === 'f' ? [index] : [],
  );
  const scaled = encodings.flatMap((encoding, index) =>
    encoding.scaleResolutionDownBy === 1 ? [index] : [],
  );
  const candidates =
    named.length > 0
      ? named
      : scaled.length > 0
        ? scaled
        : encodings.length === 1
          ? [0]
          : [];
  if (candidates.length === 0) {
    throw new Error('Missing full-resolution encoding layer');
  }
  if (candidates.length > 1) {
    throw new Error('Duplicate full-resolution encoding layer');
  }
  return candidates[0]!;
}

function withoutExplicitBitrate(
  encodings: readonly RTCRtpEncodingParameters[],
): RTCRtpEncodingParameters[] {
  const selectedIndex = fullResolutionIndex(encodings);
  return encodings.map((encoding, index) => {
    if (index !== selectedIndex) return encoding;
    const updated = { ...encoding };
    delete updated.maxBitrate;
    return updated;
  });
}

function withExplicitBitrate(
  encodings: readonly RTCRtpEncodingParameters[],
  bitrateBps: number,
): RTCRtpEncodingParameters[] {
  const selectedIndex = fullResolutionIndex(encodings);
  return encodings.map((encoding, index) =>
    index === selectedIndex
      ? { ...encoding, maxBitrate: bitrateBps }
      : encoding,
  );
}

function result(
  status: ScreenBitrateApplyResult['status'],
  target: ScreenBitrateTarget,
): ScreenBitrateApplyResult {
  return Object.freeze({ status, target });
}

export async function setScreenBitrate(
  sender: ScreenBitrateSender,
  requestedTarget: ScreenBitrateTarget,
): Promise<ScreenBitrateApplyResult> {
  const target = normalizedTarget(requestedTarget);
  const current = sender.getParameters();
  if (current.encodings.length === 0) {
    return result('pending', target);
  }
  const encodings =
    target.mode === 'fixed'
      ? withExplicitBitrate(current.encodings, target.bitrateBps)
      : withoutExplicitBitrate(current.encodings);
  const updated: RTCRtpSendParameters = { ...current, encodings };
  await sender.setParameters(updated);
  return result('applied', target);
}

interface PendingCaller {
  readonly revision: number;
  readonly resolve: (value: ScreenBitrateApplyResult) => void;
  readonly reject: (error: unknown) => void;
}

export function createSenderBitrateController(
  options: SenderBitrateControllerOptions,
): SenderBitrateController {
  let desiredTarget = normalizedTarget(options.initialTarget ?? AUTO_TARGET);
  let lastSuccessfulTarget = desiredTarget;
  let pendingTarget: ScreenBitrateTarget | null = null;
  let revision = 0;
  let running = false;
  const callers: PendingCaller[] = [];

  const snapshot = (): SenderBitrateSnapshot =>
    Object.freeze({
      desiredTarget,
      lastSuccessfulTarget,
      pendingTarget,
    });

  const settleApplied = (
    settledRevision: number,
    value: ScreenBitrateApplyResult,
  ): void => {
    for (let index = callers.length - 1; index >= 0; index -= 1) {
      const caller = callers[index]!;
      if (caller.revision <= settledRevision) {
        callers.splice(index, 1);
        caller.resolve(value);
      }
    }
  };

  const settleRejected = (settledRevision: number, error: unknown): void => {
    for (let index = callers.length - 1; index >= 0; index -= 1) {
      const caller = callers[index]!;
      if (caller.revision <= settledRevision) {
        callers.splice(index, 1);
        caller.reject(error);
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (callers.length > 0) {
        const attemptRevision = revision;
        const target = desiredTarget;
        let sender: ScreenBitrateSender | null;
        try {
          sender = options.getSender();
        } catch (error) {
          if (attemptRevision !== revision) continue;
          desiredTarget = lastSuccessfulTarget;
          pendingTarget = null;
          settleRejected(attemptRevision, error);
          continue;
        }

        if (sender === null) {
          if (attemptRevision !== revision) continue;
          pendingTarget = target;
          settleApplied(attemptRevision, result('pending', target));
          continue;
        }

        let applied: ScreenBitrateApplyResult;
        try {
          applied = await setScreenBitrate(sender, target);
        } catch (error) {
          if (attemptRevision !== revision || options.getSender() !== sender) {
            continue;
          }
          desiredTarget = lastSuccessfulTarget;
          pendingTarget = null;
          settleRejected(attemptRevision, error);
          continue;
        }

        const senderIsCurrent = options.getSender() === sender;
        if (attemptRevision !== revision) {
          if (senderIsCurrent && applied.status === 'applied') {
            lastSuccessfulTarget = target;
          }
          continue;
        }
        if (!senderIsCurrent) continue;
        if (applied.status === 'pending') {
          pendingTarget = target;
        } else {
          lastSuccessfulTarget = target;
          pendingTarget = null;
        }
        settleApplied(attemptRevision, applied);
      }
    } finally {
      running = false;
      if (callers.length > 0) void drain();
    }
  };

  const enqueue = (
    requestedTarget: ScreenBitrateTarget,
  ): Promise<ScreenBitrateApplyResult> => {
    desiredTarget = normalizedTarget(requestedTarget);
    revision += 1;
    const caller = new Promise<ScreenBitrateApplyResult>((resolve, reject) => {
      callers.push({ revision, resolve, reject });
    });
    void drain();
    return caller;
  };

  return Object.freeze({
    getSnapshot: snapshot,
    setTarget: enqueue,
    replay: () => enqueue(desiredTarget),
  });
}
