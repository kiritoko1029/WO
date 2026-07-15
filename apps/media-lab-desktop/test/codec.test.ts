import { describe, expect, test } from 'vitest';

describe('codec capability selection', () => {
  test('returns the selected video codec capability', async () => {
    const { selectVideoCodec } = await import('../src/renderer/src/codec.js');
    const h264 = {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90_000,
      parameters: { 'packetization-mode': 1 },
    };
    const capabilities = {
      codecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48_000 },
        h264,
      ],
    };

    expect(selectVideoCodec(capabilities, 'H264')).toBe(h264);
  });

  test('rejects a codec not present in loaded Device capabilities', async () => {
    const { selectVideoCodec } = await import('../src/renderer/src/codec.js');

    expect(() =>
      selectVideoCodec(
        {
          codecs: [{ kind: 'video', mimeType: 'video/VP8', clockRate: 90_000 }],
        },
        'VP9',
      ),
    ).toThrow(/vp9.*not available/i);
  });
});
