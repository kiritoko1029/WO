/**
 * Browser stub for @shiguredo/rnnoise-wasm.
 *
 * RNNoise is desktop-only (large WASM bundle + Electron packaging). Web uses
 * Chromium's built-in noiseSuppression via getUserMedia constraints instead.
 * This module is aliased in vite.config so the browser build never pulls the
 * ~4.8 MB desktop WASM chunk.
 */

export class Rnnoise {
  readonly frameSize = 480;

  static async load(): Promise<Rnnoise> {
    throw new Error('RNNoise is not available in the web client');
  }

  createDenoiseState(): never {
    throw new Error('RNNoise is not available in the web client');
  }
}

export class DenoiseState {
  processFrame(_frame: Float32Array): number {
    throw new Error('RNNoise is not available in the web client');
  }

  destroy(): void {
    // no-op
  }
}
