import { Rnnoise, type DenoiseState } from '@shiguredo/rnnoise-wasm';

/**
 * RNNoise AI noise suppression for the microphone track.
 *
 * Architecture: a main-thread AudioContext graph using ScriptProcessorNode.
 * RNNoise processes 960-sample frames at 16 kHz (60 ms). The processor node
 * runs at the context rate (48 kHz); we down-sample input, denoise, and
 * up-sample output with linear interpolation inside the audio callback.
 *
 * ScriptProcessorNode is deprecated but remains the most compatible way to
 * run WASM audio processing without COOP/COEP headers (required for
 * AudioWorklet + SharedArrayBuffer). Each frame takes ~0.1 ms of CPU, far
 * below the 60 ms budget, so main-thread blocking is imperceptible.
 *
 * Intensity levels map to how aggressively non-speech is attenuated:
 * - light:      attenuate by 50% when VAD < 0.5
 * - medium:     attenuate by 85% when VAD < 0.5, 50% when VAD < 0.8
 * - aggressive: near-full suppression when VAD < 0.7
 */

const RNNOISE_FRAME_SIZE = 960; // 16 kHz × 60 ms
const RNNOISE_SAMPLE_RATE = 16_000;
/** WebRTC / AudioContext operates at 48 kHz. */
const CONTEXT_SAMPLE_RATE = 48_000;
/** Down-sample ratio: 48000 / 16000 = 3. */
const RESAMPLE_RATIO = CONTEXT_SAMPLE_RATE / RNNOISE_SAMPLE_RATE;
/**
 * ScriptProcessor buffer size. Must be a power of two ≥ 256. We pick 2048
 * (≈42 ms at 48 kHz) so each callback yields enough 48 kHz samples to fill
 * at least one 960-sample RNNoise frame after down-sampling.
 */
const PROCESSOR_BUFFER_SIZE = 2048;
const STORAGE_KEY = 'wo-noise-intensity';

export const NOISE_INTENSITY_LEVELS = Object.freeze([
  'off',
  'light',
  'medium',
  'aggressive',
] as const);

export type NoiseIntensity = (typeof NOISE_INTENSITY_LEVELS)[number];

export const NOISE_INTENSITY_LABELS: Readonly<Record<NoiseIntensity, string>> =
  Object.freeze({
    off: '关闭',
    light: '标准',
    medium: '强效',
    aggressive: '极致',
  });

export const DEFAULT_NOISE_INTENSITY: NoiseIntensity = 'off';

/**
 * VAD-gated attenuation table per intensity level.
 * Each entry is [threshold, gain] pairs applied left-to-right: if the RNNoise
 * VAD probability for a frame is below `threshold`, multiply the output by
 * `gain`. Higher intensity = lower thresholds survive + stronger attenuation.
 */
const ATTENUATION_TABLE: Record<
  Exclude<NoiseIntensity, 'off'>,
  ReadonlyArray<readonly [number, number]>
> = {
  light: [
    [0.5, 0.5],
    [1.0, 1.0],
  ],
  medium: [
    [0.5, 0.15],
    [0.8, 0.5],
    [1.0, 1.0],
  ],
  aggressive: [
    [0.4, 0.02],
    [0.7, 0.1],
    [1.0, 1.0],
  ],
};

export function normalizeNoiseIntensity(
  value: string | null | undefined,
): NoiseIntensity {
  return NOISE_INTENSITY_LEVELS.includes(value as NoiseIntensity)
    ? (value as NoiseIntensity)
    : DEFAULT_NOISE_INTENSITY;
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readNoiseIntensity(
  storage: Pick<Storage, 'getItem'> | null = safeLocalStorage(),
): NoiseIntensity {
  if (storage === null) return DEFAULT_NOISE_INTENSITY;
  try {
    return normalizeNoiseIntensity(storage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_NOISE_INTENSITY;
  }
}

export function writeNoiseIntensity(
  intensity: NoiseIntensity,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, intensity);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/** Linear-interpolation down-sample 48 kHz → 16 kHz (in-place into `out`). */
function downSample(input: Float32Array, out: Float32Array): void {
  const outLen = out.length;
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i * RESAMPLE_RATIO;
    const index = Math.floor(srcPos);
    const fraction = srcPos - index;
    const sample0 = input[index] ?? 0;
    const sample1 = input[index + 1] ?? sample0;
    out[i] = sample0 + (sample1 - sample0) * fraction;
  }
}

/** Linear-interpolation up-sample 16 kHz → 48 kHz (in-place into `out`). */
function upSample(input: Float32Array, out: Float32Array): void {
  const inLen = input.length;
  const outLen = out.length;
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i / RESAMPLE_RATIO;
    const index = Math.floor(srcPos);
    const fraction = srcPos - index;
    const sample0 = input[index] ?? 0;
    const sample1 = input[index + 1] ?? sample0;
    out[i] = sample0 + (sample1 - sample0) * fraction;
  }
}

export interface NoiseSuppressorOptions {
  readonly createAudioContext?: (sampleRate: number) => AudioContext;
}

export interface NoiseSuppressor {
  readonly intensity: NoiseIntensity;
  /**
   * Build a processing graph around `inputTrack` and return the denoised
   * track. Resolves to the original track if intensity is 'off' or the WASM
   * module fails to load (graceful degradation).
   */
  process(inputTrack: MediaStreamTrack): Promise<MediaStreamTrack>;
  /** Update the intensity at runtime without rebuilding the graph. */
  setIntensity(intensity: NoiseIntensity): void;
  /** Tear down the processing graph and release the AudioContext. */
  dispose(): void;
}

export async function createNoiseSuppressor(
  initialIntensity: NoiseIntensity = DEFAULT_NOISE_INTENSITY,
  options: NoiseSuppressorOptions = {},
): Promise<NoiseSuppressor> {
  let intensity: NoiseIntensity = initialIntensity;
  let rnnoise: Rnnoise | null = null;
  let denoiseState: DenoiseState | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let destinationNode: MediaStreamAudioDestinationNode | null = null;

  // Down-sampled input buffer reused across callbacks.
  const downBuffer = new Float32Array(RNNOISE_FRAME_SIZE);

  /**
   * Apply RNNoise to a chunk of 48 kHz mono samples. The chunk length is a
   * multiple of RNNOISE_FRAME_SIZE × RESAMPLE_RATIO so we always have a full
   * 960-sample frame after down-sampling.
   */
  const denoiseChunk = (chunk: Float32Array, output: Float32Array): void => {
    if (denoiseState === null) {
      output.set(chunk);
      return;
    }
    const table = ATTENUATION_TABLE[intensity as Exclude<NoiseIntensity, 'off'>];
    const frame48kLen = RNNOISE_FRAME_SIZE * RESAMPLE_RATIO; // 2880
    const frameCount = Math.floor(chunk.length / frame48kLen);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const offset48k = frame * frame48kLen;
      // Down-sample 2880 → 960 samples.
      downSample(
        chunk.subarray(offset48k, offset48k + frame48kLen),
        downBuffer,
      );
      const vad = denoiseState.processFrame(downBuffer);
      // Determine attenuation gain from VAD probability.
      let gain = 1;
      if (table !== undefined) {
        for (const [threshold, tableGain] of table) {
          if (vad < threshold) {
            gain = tableGain;
            break;
          }
        }
      }
      // Up-sample 960 → 2880 samples back to 48 kHz.
      const outOffset = offset48k;
      upSample(downBuffer, output.subarray(outOffset, outOffset + frame48kLen));
      // Apply gain.
      if (gain !== 1) {
        const segment = output.subarray(outOffset, outOffset + frame48kLen);
        for (let i = 0; i < segment.length; i += 1) {
          segment[i]! *= gain;
        }
      }
    }
    // Pass through any trailing samples that don't fill a complete frame.
    const processedLen = frameCount * frame48kLen;
    if (chunk.length > processedLen) {
      output.set(chunk.subarray(processedLen), processedLen);
    }
  };

  return Object.freeze({
    get intensity() {
      return intensity;
    },
    async process(inputTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
      if (intensity === 'off') return inputTrack;
      // Lazily load the WASM module. If it fails (e.g. blocked CSP, old
      // browser), fall back to the unprocessed track so calls still work.
      if (rnnoise === null) {
        try {
          rnnoise = await Rnnoise.load();
          denoiseState = rnnoise.createDenoiseState();
        } catch {
          return inputTrack;
        }
      }
      const createCtx =
        options.createAudioContext ??
        ((sampleRate: number) => new AudioContext({ sampleRate }));
      audioContext = createCtx(CONTEXT_SAMPLE_RATE);
      sourceNode = audioContext.createMediaStreamSource(
        new MediaStream([inputTrack]),
      );
      processorNode = audioContext.createScriptProcessor(
        PROCESSOR_BUFFER_SIZE,
        1,
        1,
      );
      destinationNode = audioContext.createMediaStreamDestination();
      processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        if (intensity === 'off') {
          output.set(input);
          return;
        }
        denoiseChunk(input, output);
      };
      sourceNode.connect(processorNode);
      processorNode.connect(destinationNode);
      const processedTracks = destinationNode.stream.getAudioTracks();
      return processedTracks[0] ?? inputTrack;
    },
    setIntensity(next: NoiseIntensity): void {
      intensity = next;
    },
    dispose(): void {
      try {
        processorNode?.disconnect();
        sourceNode?.disconnect();
      } catch {
        // Nodes may already be disconnected.
      }
      processorNode = null;
      sourceNode = null;
      destinationNode = null;
      denoiseState?.destroy();
      denoiseState = null;
      rnnoise = null;
      if (audioContext !== null) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
    },
  });
}
