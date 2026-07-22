// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_NOISE_INTENSITY,
  NOISE_INTENSITY_LABELS,
  NOISE_INTENSITY_LEVELS,
  normalizeNoiseIntensity,
  readNoiseIntensity,
  writeNoiseIntensity,
  type NoiseIntensity,
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

  it('defaults to off for backward compatibility', () => {
    expect(DEFAULT_NOISE_INTENSITY).toBe('off');
  });

  it('provides Chinese labels for every level', () => {
    for (const level of NOISE_INTENSITY_LEVELS) {
      expect(NOISE_INTENSITY_LABELS[level].length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeNoiseIntensity', () => {
  it('accepts each valid level', () => {
    for (const level of NOISE_INTENSITY_LEVELS) {
      expect(normalizeNoiseIntensity(level)).toBe(level);
    }
  });

  it('falls back to off for unknown values', () => {
    expect(normalizeNoiseIntensity('invalid')).toBe('off');
    expect(normalizeNoiseIntensity(null)).toBe('off');
    expect(normalizeNoiseIntensity(undefined)).toBe('off');
    expect(normalizeNoiseIntensity('')).toBe('off');
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

  it('normalises a corrupted stored value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'garbage');
    expect(readNoiseIntensity()).toBe('off');
  });

  it('does not throw when storage is unavailable', () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readNoiseIntensity(brokenStorage as never)).toBe('off');
    expect(() =>
      writeNoiseIntensity('medium', brokenStorage as never),
    ).not.toThrow();
  });
});

describe('createNoiseSuppressor', () => {
  it('returns the original track when intensity is off', async () => {
    const { createNoiseSuppressor } = await import(
      '../src/renderer/src/media/noise-suppressor.js'
    );
    const suppressor = await createNoiseSuppressor('off');
    const track = { kind: 'audio' } as MediaStreamTrack;
    const result = await suppressor.process(track);
    expect(result).toBe(track);
    suppressor.dispose();
  });

  it('updates intensity without rebuilding the graph', async () => {
    const { createNoiseSuppressor } = await import(
      '../src/renderer/src/media/noise-suppressor.js'
    );
    const suppressor = await createNoiseSuppressor('light');
    expect(suppressor.intensity).toBe('light');
    suppressor.setIntensity('aggressive' as NoiseIntensity);
    expect(suppressor.intensity).toBe('aggressive');
    suppressor.dispose();
  });

  it('gracefully falls back when WASM loading fails', async () => {
    // Mock the WASM module to reject, simulating a blocked environment.
    vi.mock('@shiguredo/rnnoise-wasm', () => ({
      Rnnoise: {
        load: vi.fn().mockRejectedValue(new Error('wasm blocked')),
      },
    }));
    const { createNoiseSuppressor } = await import(
      '../src/renderer/src/media/noise-suppressor.js'
    );
    const suppressor = await createNoiseSuppressor('medium');
    const track = { kind: 'audio' } as MediaStreamTrack;
    // Should fall back to the original track instead of throwing.
    const result = await suppressor.process(track);
    expect(result).toBe(track);
    suppressor.dispose();
    vi.restoreAllMocks();
  });
});
