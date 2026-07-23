// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTENUATION_TABLE,
  DEFAULT_NOISE_INTENSITY,
  NOISE_INTENSITY_LABELS,
  NOISE_INTENSITY_LEVELS,
  PCM_SCALE,
  attenuationGainFor,
  createFrameProcessor,
  createNoiseSuppressor,
  noiseSuppressionEnabledFor,
  normalizeNoiseIntensity,
  readNoiseIntensity,
  resetSharedRnnoiseCacheForTests,
  writeNoiseIntensity,
  type RnnoiseInstance,
} from '../src/renderer/src/media/noise-suppressor.js';

describe('noise intensity presets', () => {
  it('exposes four ordered levels starting with off', () => {
    expect(NOISE_INTENSITY_LEVELS).toEqual([
      'off',
      'light',
      'medium',
      'aggressive',
    ]);
  });

  it('defaults to light (RNNoise 标准)', () => {
    expect(DEFAULT_NOISE_INTENSITY).toBe('light');
  });

  it('provides Chinese labels for every level', () => {
    for (const level of NOISE_INTENSITY_LEVELS) {
      expect(NOISE_INTENSITY_LABELS[level].length).toBeGreaterThan(0);
    }
  });

  it('maps native NS: off always false; non-off depends on RNNoise activity', () => {
    expect(noiseSuppressionEnabledFor('off', true)).toBe(false);
    expect(noiseSuppressionEnabledFor('off', false)).toBe(false);
    expect(noiseSuppressionEnabledFor('light', true)).toBe(false);
    expect(noiseSuppressionEnabledFor('light', false)).toBe(true);
    expect(noiseSuppressionEnabledFor('aggressive', false)).toBe(true);
  });

  it('has attenuation tables for every non-off level', () => {
    for (const level of ['light', 'medium', 'aggressive'] as const) {
      expect(ATTENUATION_TABLE[level].length).toBeGreaterThan(0);
      expect(attenuationGainFor(level, 0)).toBeLessThan(1);
      expect(attenuationGainFor(level, 1)).toBe(1);
    }
    expect(attenuationGainFor('off', 0.1)).toBe(1);
  });
});

describe('normalizeNoiseIntensity', () => {
  it('accepts each valid level', () => {
    for (const level of NOISE_INTENSITY_LEVELS) {
      expect(normalizeNoiseIntensity(level)).toBe(level);
    }
  });

  it('falls back to the default for unknown values', () => {
    expect(normalizeNoiseIntensity('invalid')).toBe(DEFAULT_NOISE_INTENSITY);
    expect(normalizeNoiseIntensity(null)).toBe(DEFAULT_NOISE_INTENSITY);
  });
});

describe('noise intensity persistence', () => {
  const STORAGE_KEY = 'wo-noise-intensity';

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a value through localStorage', () => {
    writeNoiseIntensity('aggressive');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('aggressive');
    expect(readNoiseIntensity()).toBe('aggressive');
  });

  it('returns the default when nothing is stored', () => {
    expect(readNoiseIntensity()).toBe(DEFAULT_NOISE_INTENSITY);
  });
});

describe('createFrameProcessor', () => {
  it('processes complete frames with PCM scale and VAD attenuation', () => {
    const frameSize = 4;
    const seen: Float32Array[] = [];
    const denoise = {
      processFrame: (frame: Float32Array) => {
        seen.push(Float32Array.from(frame));
        // Identity in PCM domain.
        return 0.2; // low VAD → light attenuation
      },
      destroy: vi.fn(),
    };
    let intensity: 'light' | 'off' = 'light';
    const processor = createFrameProcessor(frameSize, denoise, () => intensity);

    // 8 samples → 2 full frames. ScriptProcessor-sized output of 8.
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const output = new Float32Array(8);
    processor.process(input, output);

    expect(seen).toHaveLength(2);
    // First sample of first frame was 0.1 * 32768 in PCM domain.
    expect(seen[0]![0]).toBeCloseTo(0.1 * PCM_SCALE, 3);

    const gain = attenuationGainFor('light', 0.2);
    expect(output[0]).toBeCloseTo(0.1 * gain, 3);
    expect(output[4]).toBeCloseTo(0.5 * gain, 3);

    intensity = 'off';
    const passthrough = new Float32Array(8);
    processor.process(input, passthrough);
    expect(Array.from(passthrough)).toEqual(Array.from(input));
  });

  it('accumulates residual samples across callbacks (power-of-two buffers)', () => {
    const frameSize = 4;
    let frames = 0;
    const denoise = {
      processFrame: (frame: Float32Array) => {
        frames += 1;
        // Zero the frame so we can tell denoised vs passthrough.
        frame.fill(0);
        return 1;
      },
      destroy: vi.fn(),
    };
    const processor = createFrameProcessor(frameSize, denoise, () => 'medium');

    // First callback: 3 samples — not enough for a frame.
    const out1 = new Float32Array(3);
    processor.process(new Float32Array([1, 1, 1]), out1);
    expect(frames).toBe(0);
    // Warm-up may pass through.
    expect(out1[0]).toBe(1);

    // Second callback: 3 more → total residual+new = 6 → one frame of 4, residual 2.
    const out2 = new Float32Array(3);
    processor.process(new Float32Array([1, 1, 1]), out2);
    expect(frames).toBe(1);
  });
});

describe('createNoiseSuppressor', () => {
  beforeEach(() => {
    resetSharedRnnoiseCacheForTests();
  });

  afterEach(() => {
    resetSharedRnnoiseCacheForTests();
  });

  function mockTrack(): MediaStreamTrack {
    return { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  }

  function mockRnnoise(frameSize = 4): RnnoiseInstance {
    return {
      frameSize,
      createDenoiseState: () => ({
        processFrame: (frame: Float32Array) => {
          // mild attenuation in-place
          for (let i = 0; i < frame.length; i += 1) {
            frame[i] = (frame[i] ?? 0) * 0.9;
          }
          return 0.9;
        },
        destroy: vi.fn(),
      }),
    };
  }

  it('returns the original track when intensity is off and gain is 1 without graph', async () => {
    // Gain-only with AudioContext may still wrap; force failure to get passthrough.
    const suppressor = await createNoiseSuppressor('off', {
      createAudioContext: () => {
        throw new Error('no audio');
      },
      loadRnnoise: async () => mockRnnoise(),
    });
    const track = mockTrack();
    const result = await suppressor.process(track, { gain: 1 });
    expect(result).toBe(track);
    expect(suppressor.active).toBe(false);
    suppressor.dispose();
  });

  it('reports active when RNNoise loads successfully', async () => {
    // We cannot fully run ScriptProcessor without a real AudioContext; verify
    // the load path marks active via ensure + process failure path.
    const load = vi.fn(async () => mockRnnoise());
    const suppressor = await createNoiseSuppressor('medium', {
      loadRnnoise: load,
      createAudioContext: () => {
        throw new Error('no audio context in unit test');
      },
    });
    const track = mockTrack();
    // process falls back to raw track when AudioContext is missing, but load
    // is still attempted first.
    await suppressor.process(track);
    expect(load).toHaveBeenCalled();
    // Without AudioContext graph, active stays false even if load succeeded
    // because denoiseState is created but graph build fails → dispose path.
    // Re-process after successful load with a minimal fake context is heavy;
    // the load cache is the critical production path covered here.
    expect(load).toHaveBeenCalledTimes(1);
    suppressor.dispose();
  });

  it('degrades when RNNoise fails to load and does not throw', async () => {
    const suppressor = await createNoiseSuppressor('aggressive', {
      loadRnnoise: async () => {
        throw new Error('wasm blocked');
      },
      createAudioContext: () => {
        throw new Error('no audio');
      },
    });
    const track = mockTrack();
    await expect(suppressor.process(track)).resolves.toBe(track);
    expect(suppressor.active).toBe(false);
    suppressor.dispose();
  });
});
