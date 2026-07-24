/**
 * Desktop RNNoise noise suppression + intensity persistence.
 *
 * Production notes (Electron asar):
 * - `@shiguredo/rnnoise-wasm` 2025.x embeds the WASM as base64 inside a single
 *   JS module (~4.8 MB). Vite bundles that module into `out/renderer/assets`,
 *   so no separate `.wasm` file or extraResources path is required.
 * - RNNoise processes fixed-size frames (typically 480 samples @ 48 kHz).
 *   ScriptProcessor buffers are powers of two, so we accumulate into a ring
 *   buffer and only call `processFrame` on complete frames.
 * - RNNoise expects float samples in 16-bit PCM range (±32768), not Web Audio
 *   unit floats (−1…1). We scale before/after each frame.
 * - On load/process failure we degrade gracefully; the voice controller then
 *   enables browser-native `noiseSuppression` so audio never goes silent.
 */

const STORAGE_KEY = 'wo-noise-intensity';

/** Web Audio / WebRTC capture rate used by the desktop voice pipeline. */
export const VOICE_SAMPLE_RATE = 48_000;

/**
 * ScriptProcessor buffer size. Powers of two only. 4096 ≈ 85 ms @ 48 kHz —
 * large enough that each callback usually yields multiple RNNoise frames.
 */
export const PROCESSOR_BUFFER_SIZE = 4096;

/** RNNoise treats samples as 16-bit PCM stored in Float32. */
export const PCM_SCALE = 32_768;

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

/** Default: RNNoise "标准" when available. */
export const DEFAULT_NOISE_INTENSITY: NoiseIntensity = 'light';

/**
 * VAD-gated residual attenuation. RNNoise already suppresses noise; these
 * gains further duck frames the model classifies as non-speech.
 * Each entry is [vadThreshold, gain] applied left-to-right.
 */
export const ATTENUATION_TABLE: Readonly<
  Record<
    Exclude<NoiseIntensity, 'off'>,
    ReadonlyArray<readonly [number, number]>
  >
> = Object.freeze({
  light: Object.freeze([
    Object.freeze([0.5, 0.55] as const),
    Object.freeze([1.0, 1.0] as const),
  ]),
  medium: Object.freeze([
    Object.freeze([0.5, 0.2] as const),
    Object.freeze([0.8, 0.55] as const),
    Object.freeze([1.0, 1.0] as const),
  ]),
  aggressive: Object.freeze([
    Object.freeze([0.4, 0.05] as const),
    Object.freeze([0.7, 0.15] as const),
    Object.freeze([1.0, 1.0] as const),
  ]),
});

export function normalizeNoiseIntensity(
  value: string | null | undefined,
): NoiseIntensity {
  return NOISE_INTENSITY_LEVELS.includes(value as NoiseIntensity)
    ? (value as NoiseIntensity)
    : DEFAULT_NOISE_INTENSITY;
}

/**
 * Whether getUserMedia should enable Chromium's built-in noise suppression.
 *
 * - `off` → false (user wants raw mic)
 * - RNNoise active → false (avoid double processing)
 * - RNNoise unavailable/failed → true (native fallback so audio stays usable)
 */
export function noiseSuppressionEnabledFor(
  intensity: NoiseIntensity,
  rnnoiseActive: boolean,
): boolean {
  if (intensity === 'off') return false;
  return !rnnoiseActive;
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

export function attenuationGainFor(
  intensity: NoiseIntensity,
  vad: number,
): number {
  if (intensity === 'off') return 1;
  const table = ATTENUATION_TABLE[intensity];
  for (const [threshold, gain] of table) {
    if (vad < threshold) return gain;
  }
  return 1;
}

/** Minimal surface of @shiguredo/rnnoise-wasm used by the suppressor. */
export interface RnnoiseDenoiseState {
  processFrame(frame: Float32Array): number;
  destroy(): void;
}

export interface RnnoiseInstance {
  readonly frameSize: number;
  createDenoiseState(): RnnoiseDenoiseState;
}

export type RnnoiseLoader = () => Promise<RnnoiseInstance>;

/**
 * Default loader: dynamic import so Vite splits the ~4.8 MB wasm-in-js bundle
 * into its own chunk, and so unit tests can inject a stub without loading WASM.
 */
export const defaultRnnoiseLoader: RnnoiseLoader = async () => {
  const mod = await import('@shiguredo/rnnoise-wasm');
  return mod.Rnnoise.load();
};

/** Process-wide cache so a failed WASM load is not retried every recapture. */
let cachedRnnoise: RnnoiseInstance | null = null;
let cachedLoadError: unknown = null;
let cachedLoadPromise: Promise<RnnoiseInstance> | null = null;

export async function loadSharedRnnoise(
  loader: RnnoiseLoader = defaultRnnoiseLoader,
): Promise<RnnoiseInstance> {
  if (cachedRnnoise !== null) return cachedRnnoise;
  if (cachedLoadError !== null) throw cachedLoadError;
  if (cachedLoadPromise === null) {
    cachedLoadPromise = loader()
      .then((instance) => {
        cachedRnnoise = instance;
        return instance;
      })
      .catch((error: unknown) => {
        cachedLoadError = error;
        cachedLoadPromise = null;
        throw error;
      });
  }
  return cachedLoadPromise;
}

/** Test-only: clear the shared RNNoise cache between cases. */
export function resetSharedRnnoiseCacheForTests(): void {
  cachedRnnoise = null;
  cachedLoadError = null;
  cachedLoadPromise = null;
}

export interface NoiseSuppressorOptions {
  readonly createAudioContext?: (sampleRate: number) => AudioContext;
  readonly loadRnnoise?: RnnoiseLoader;
  readonly processorBufferSize?: number;
}

export interface NoiseSuppressor {
  readonly intensity: NoiseIntensity;
  readonly active: boolean;
  readonly frameSize: number | null;
  /**
   * Wrap `inputTrack` with RNNoise (+ optional post-gain). Resolves to the
   * original track when intensity is `off` or RNNoise fails to load.
   */
  process(
    inputTrack: MediaStreamTrack,
    options?: { readonly gain?: number },
  ): Promise<MediaStreamTrack>;
  setIntensity(intensity: NoiseIntensity): void;
  setGain(gain: number): void;
  dispose(): void;
}

/**
 * Process a mono float (−1…1) stream through RNNoise using a residual buffer
 * so ScriptProcessor power-of-two sizes do not need to match frameSize.
 * Exported for unit tests.
 */
export function createFrameProcessor(
  frameSize: number,
  denoise: RnnoiseDenoiseState,
  getIntensity: () => NoiseIntensity,
): {
  process(input: Float32Array, output: Float32Array): void;
  reset(): void;
} {
  // Residual input samples waiting for a full frame.
  let inResidual = new Float32Array(0);
  // Denoised samples waiting to be written to the next output buffer.
  let outResidual = new Float32Array(0);
  const frame = new Float32Array(frameSize);

  const processFullFrames = (combined: Float32Array): Float32Array => {
    const frameCount = Math.floor(combined.length / frameSize);
    const produced = new Float32Array(frameCount * frameSize);
    const intensity = getIntensity();
    for (let f = 0; f < frameCount; f += 1) {
      const offset = f * frameSize;
      for (let i = 0; i < frameSize; i += 1) {
        frame[i] = (combined[offset + i] ?? 0) * PCM_SCALE;
      }
      const vad = denoise.processFrame(frame);
      const gain = attenuationGainFor(intensity, vad);
      const outOffset = f * frameSize;
      for (let i = 0; i < frameSize; i += 1) {
        produced[outOffset + i] = ((frame[i] ?? 0) / PCM_SCALE) * gain;
      }
    }
    const consumed = frameCount * frameSize;
    inResidual = combined.subarray(consumed).slice();
    return produced;
  };

  return {
    process(input, output) {
      if (getIntensity() === 'off') {
        output.set(input);
        inResidual = new Float32Array(0);
        outResidual = new Float32Array(0);
        return;
      }

      const combined = new Float32Array(inResidual.length + input.length);
      combined.set(inResidual, 0);
      combined.set(input, inResidual.length);
      const produced = processFullFrames(combined);

      const available = new Float32Array(outResidual.length + produced.length);
      available.set(outResidual, 0);
      available.set(produced, outResidual.length);

      if (available.length >= output.length) {
        output.set(available.subarray(0, output.length));
        outResidual = available.subarray(output.length).slice();
      } else {
        // Not enough denoised samples yet — pass through remaining input so
        // the track never goes silent during the warm-up frames.
        output.set(available, 0);
        const fillFrom = available.length;
        const need = output.length - fillFrom;
        const passStart = Math.max(0, input.length - need);
        output.set(input.subarray(passStart), fillFrom);
        outResidual = new Float32Array(0);
      }
    },
    reset() {
      inResidual = new Float32Array(0);
      outResidual = new Float32Array(0);
    },
  };
}

export async function createNoiseSuppressor(
  initialIntensity: NoiseIntensity = DEFAULT_NOISE_INTENSITY,
  options: NoiseSuppressorOptions = {},
): Promise<NoiseSuppressor> {
  let intensity: NoiseIntensity = initialIntensity;
  let gainValue = 1;
  let rnnoise: RnnoiseInstance | null = null;
  let denoiseState: RnnoiseDenoiseState | null = null;
  let loadFailed = false;
  /** True only while the ScriptProcessor RNNoise graph is live. */
  let graphLive = false;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let gainNode: GainNode | null = null;
  let destinationNode: MediaStreamAudioDestinationNode | null = null;
  let frameProcessor: ReturnType<typeof createFrameProcessor> | null = null;
  const loadRnnoise = options.loadRnnoise ?? defaultRnnoiseLoader;
  const processorBufferSize =
    options.processorBufferSize ?? PROCESSOR_BUFFER_SIZE;

  const ensureRnnoise = async (): Promise<boolean> => {
    if (loadFailed) return false;
    if (denoiseState !== null) return true;
    try {
      if (rnnoise === null) {
        rnnoise = await loadSharedRnnoise(loadRnnoise);
      }
      denoiseState = rnnoise.createDenoiseState();
      frameProcessor = createFrameProcessor(
        rnnoise.frameSize,
        denoiseState,
        () => intensity,
      );
      return true;
    } catch {
      loadFailed = true;
      denoiseState = null;
      frameProcessor = null;
      return false;
    }
  };

  const disconnectGraph = (): void => {
    try {
      processorNode?.disconnect();
      sourceNode?.disconnect();
      gainNode?.disconnect();
    } catch {
      // Already disconnected.
    }
    processorNode = null;
    sourceNode = null;
    gainNode = null;
    destinationNode = null;
    graphLive = false;
    if (audioContext !== null) {
      void audioContext.close().catch(() => undefined);
      audioContext = null;
    }
    frameProcessor?.reset();
  };

  return Object.freeze({
    get intensity() {
      return intensity;
    },
    get active() {
      return (
        intensity !== 'off' && denoiseState !== null && !loadFailed && graphLive
      );
    },
    get frameSize() {
      return rnnoise?.frameSize ?? null;
    },
    async process(
      inputTrack: MediaStreamTrack,
      processOptions: { readonly gain?: number } = {},
    ): Promise<MediaStreamTrack> {
      if (inputTrack.kind !== 'audio') {
        throw new TypeError('Noise suppressor requires an audio track');
      }
      gainValue =
        typeof processOptions.gain === 'number' &&
        Number.isFinite(processOptions.gain)
          ? Math.min(2, Math.max(0, processOptions.gain))
          : gainValue;

      if (intensity === 'off') {
        // Gain-only path without RNNoise.
        return buildGainOnlyTrack(
          inputTrack,
          gainValue,
          options.createAudioContext,
          (graph) => {
            audioContext = graph.context;
            sourceNode = graph.source;
            gainNode = graph.gain;
            destinationNode = graph.destination;
          },
        );
      }

      const ready = await ensureRnnoise();
      if (!ready || denoiseState === null || frameProcessor === null) {
        // Fallback: gain only; caller should enable native NS on recapture.
        return buildGainOnlyTrack(
          inputTrack,
          gainValue,
          options.createAudioContext,
          (graph) => {
            audioContext = graph.context;
            sourceNode = graph.source;
            gainNode = graph.gain;
            destinationNode = graph.destination;
          },
        );
      }

      try {
        disconnectGraph();
        const createCtx =
          options.createAudioContext ??
          ((sampleRate: number) => new AudioContext({ sampleRate }));
        audioContext = createCtx(VOICE_SAMPLE_RATE);
        if (audioContext.state === 'suspended') {
          await audioContext.resume().catch(() => undefined);
        }
        sourceNode = audioContext.createMediaStreamSource(
          new MediaStream([inputTrack]),
        );
        processorNode = audioContext.createScriptProcessor(
          processorBufferSize,
          1,
          1,
        );
        gainNode = audioContext.createGain();
        gainNode.gain.value = gainValue;
        destinationNode = audioContext.createMediaStreamDestination();

        const processor = frameProcessor;
        processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
          const input = event.inputBuffer.getChannelData(0);
          const output = event.outputBuffer.getChannelData(0);
          try {
            processor.process(input, output);
          } catch {
            // Never silence the call on a bad frame.
            output.set(input);
          }
        };

        sourceNode.connect(processorNode);
        processorNode.connect(gainNode);
        gainNode.connect(destinationNode);

        const tracks = destinationNode.stream.getAudioTracks();
        const outbound = tracks[0];
        if (outbound === undefined) {
          disconnectGraph();
          return inputTrack;
        }
        graphLive = true;
        return outbound;
      } catch {
        disconnectGraph();
        // Graph construction failed (common in unit tests / restricted
        // environments). Fall back to the raw track so the call continues.
        return inputTrack;
      }
    },
    setIntensity(next: NoiseIntensity): void {
      intensity = next;
      if (next === 'off') {
        frameProcessor?.reset();
      }
    },
    setGain(next: number): void {
      gainValue = Math.min(2, Math.max(0, next));
      if (gainNode !== null) {
        gainNode.gain.value = gainValue;
      }
    },
    dispose(): void {
      disconnectGraph();
      try {
        denoiseState?.destroy();
      } catch {
        // Ignore double-destroy.
      }
      denoiseState = null;
      frameProcessor = null;
      // Keep rnnoise module cached for reuse within the process; only the
      // denoise state is freed.
    },
  });
}

async function buildGainOnlyTrack(
  inputTrack: MediaStreamTrack,
  gainValue: number,
  createAudioContext: ((sampleRate: number) => AudioContext) | undefined,
  register: (graph: {
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
  }) => void,
): Promise<MediaStreamTrack> {
  try {
    const createCtx =
      createAudioContext ??
      ((sampleRate: number) => new AudioContext({ sampleRate }));
    const context = createCtx(VOICE_SAMPLE_RATE);
    if (context.state === 'suspended') {
      await context.resume().catch(() => undefined);
    }
    const source = context.createMediaStreamSource(
      new MediaStream([inputTrack]),
    );
    const gain = context.createGain();
    gain.gain.value = gainValue;
    const destination = context.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(destination);
    register({ context, source, gain, destination });
    return destination.stream.getAudioTracks()[0] ?? inputTrack;
  } catch {
    return inputTrack;
  }
}
