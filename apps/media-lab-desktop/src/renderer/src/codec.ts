export type LabCodec = 'VP8' | 'H264' | 'VP9';

export const DEFAULT_LAB_CODEC: LabCodec = 'H264';

export interface CodecCapability {
  readonly kind?: string;
  readonly mimeType: string;
  readonly [key: string]: unknown;
}

export interface CodecCapabilities {
  readonly codecs?: readonly CodecCapability[];
}

export function selectVideoCodec<T extends CodecCapability>(
  capabilities: { readonly codecs?: readonly T[] },
  codec: LabCodec,
): T {
  const mimeType = `video/${codec}`.toLowerCase();
  const capability = capabilities.codecs?.find(
    (candidate) =>
      candidate.kind === 'video' &&
      candidate.mimeType.toLowerCase() === mimeType,
  );
  if (!capability) {
    throw new Error(`${codec} is not available in Device RTP capabilities`);
  }
  return capability;
}
