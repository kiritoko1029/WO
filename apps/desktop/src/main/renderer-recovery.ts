const RECOVERABLE_RENDERER_GONE_REASONS = new Set([
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

interface RendererGoneDetails {
  readonly reason: string;
  readonly exitCode: number;
}

export interface RendererRecoveryOptions {
  readonly clearCaptureSources: () => void;
  readonly canReloadRenderer: () => boolean;
  readonly isWindowDestroyed: () => boolean;
  readonly reloadRenderer: () => Promise<void>;
  readonly logError?: (...values: readonly unknown[]) => void;
}

export interface RendererRecoveryController {
  rendererGone(details: RendererGoneDetails): void;
  rendererUnresponsive(): void;
}

export function createRendererRecovery(
  options: RendererRecoveryOptions,
): RendererRecoveryController {
  const logError =
    options.logError ??
    ((...values: readonly unknown[]) => console.error(...values));
  let reloadFlight: Promise<void> | null = null;
  let reloadFailed = false;

  const rendererGone = (details: RendererGoneDetails): void => {
    try {
      options.clearCaptureSources();
    } catch (error) {
      logError('[main] Failed to clear renderer capture sources:', error);
    }
    logError(
      '[main] Renderer process gone:',
      `reason=${details.reason}`,
      `exitCode=${details.exitCode}`,
    );
    if (
      !RECOVERABLE_RENDERER_GONE_REASONS.has(details.reason) ||
      !options.canReloadRenderer() ||
      options.isWindowDestroyed() ||
      reloadFlight !== null ||
      reloadFailed
    ) {
      return;
    }

    reloadFlight = Promise.resolve()
      .then(() => options.reloadRenderer())
      .then(
        () => {
          reloadFlight = null;
        },
        (error: unknown) => {
          reloadFailed = true;
          logError('[main] Renderer reload failed:', error);
        },
      );
  };

  const rendererUnresponsive = (): void => {
    logError('[main] Renderer became unresponsive');
  };

  return Object.freeze({ rendererGone, rendererUnresponsive });
}
