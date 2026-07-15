import {
  clampScreenBitrate,
  updateEncodingBitrate,
  type ScreenEncoding,
} from '@wo/media-policy';

export interface SenderParameters {
  readonly encodings: readonly ScreenEncoding[];
  readonly [key: string]: unknown;
}

export interface BitrateSender {
  getParameters(): SenderParameters;
  setParameters(parameters: SenderParameters): Promise<void>;
}

export interface BitrateProducer {
  readonly id: string;
  readonly rtpSender?: BitrateSender;
}

export interface BitrateChangeError {
  readonly code:
    | 'INVALID_BITRATE'
    | 'PRODUCER_UNAVAILABLE'
    | 'RTP_SENDER_UNAVAILABLE'
    | 'BITRATE_UPDATE_FAILED'
    | 'BITRATE_ROLLBACK_FAILED'
    | 'PRODUCER_ID_CHANGED';
  readonly message: string;
}

export interface BitrateChangeEvent {
  readonly requestedBitrateBps: number;
  readonly clampedBitrateBps: number | null;
  readonly requestedAt: string;
  readonly appliedAt: string | null;
  readonly success: boolean;
  readonly error: BitrateChangeError | null;
  readonly producerIdBefore: string | null;
  readonly producerIdAfter: string | null;
  readonly producerIdUnchanged: boolean;
}

function safeBitrateError(
  error: unknown,
  invalidRequestedBitrate: boolean,
): BitrateChangeError {
  if (error instanceof AggregateError) {
    return {
      code: 'BITRATE_ROLLBACK_FAILED',
      message: 'The bitrate update and rollback both failed',
    };
  }
  if (invalidRequestedBitrate) {
    return {
      code: 'INVALID_BITRATE',
      message: 'The requested bitrate is not a finite number',
    };
  }
  const message = error instanceof Error ? error.message : '';
  if (message === 'Producer has no RTP sender') {
    return {
      code: 'RTP_SENDER_UNAVAILABLE',
      message: 'The Producer has no RTP sender',
    };
  }
  if (message === 'Producer ID changed during bitrate update') {
    return {
      code: 'PRODUCER_ID_CHANGED',
      message: 'The Producer identity changed during the bitrate update',
    };
  }
  return {
    code: 'BITRATE_UPDATE_FAILED',
    message: 'The sender rejected the bitrate update',
  };
}

export async function applyProducerBitrate(
  producer: BitrateProducer,
  bitrateBps: number,
): Promise<{ producerId: string; bitrateBps: number }> {
  const sender = producer.rtpSender;
  if (!sender) throw new Error('Producer has no RTP sender');

  const producerId = producer.id;
  const current = sender.getParameters();
  const originalEncodings = current.encodings.map((encoding) => ({
    ...encoding,
  }));
  const rollback = { ...current, encodings: originalEncodings };
  const updated = {
    ...current,
    encodings: updateEncodingBitrate(current.encodings, bitrateBps),
  };

  try {
    await sender.setParameters(updated);
  } catch (error) {
    try {
      await sender.setParameters(rollback);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Bitrate update and rollback both failed',
        { cause: rollbackError },
      );
    }
    throw error;
  }

  if (producer.id !== producerId) {
    await sender.setParameters(rollback);
    throw new Error('Producer ID changed during bitrate update');
  }
  return { producerId, bitrateBps: clampScreenBitrate(bitrateBps) };
}

export async function applyProducerBitrateWithEvent(
  producer: BitrateProducer | null,
  requestedBitrateBps: number,
  now: () => string = () => new Date().toISOString(),
): Promise<BitrateChangeEvent> {
  const requestedAt = now();
  const producerIdBefore = producer?.id ?? null;
  let clampedBitrateBps: number | null = null;

  try {
    clampedBitrateBps = clampScreenBitrate(requestedBitrateBps);
    if (!producer) {
      return {
        requestedBitrateBps,
        clampedBitrateBps,
        requestedAt,
        appliedAt: null,
        success: false,
        error: {
          code: 'PRODUCER_UNAVAILABLE',
          message: 'No Producer exists for this bitrate target',
        },
        producerIdBefore: null,
        producerIdAfter: null,
        producerIdUnchanged: false,
      };
    }
    await applyProducerBitrate(producer, requestedBitrateBps);
    const producerIdAfter = producer.id;
    return {
      requestedBitrateBps,
      clampedBitrateBps,
      requestedAt,
      appliedAt: now(),
      success: true,
      error: null,
      producerIdBefore,
      producerIdAfter,
      producerIdUnchanged: producerIdAfter === producerIdBefore,
    };
  } catch (error) {
    const producerIdAfter = producer?.id ?? null;
    return {
      requestedBitrateBps,
      clampedBitrateBps,
      requestedAt,
      appliedAt: null,
      success: false,
      error: safeBitrateError(error, clampedBitrateBps === null),
      producerIdBefore,
      producerIdAfter,
      producerIdUnchanged:
        producerIdBefore !== null && producerIdAfter === producerIdBefore,
    };
  }
}
