import { Gauge, MonitorUp } from 'lucide-react';

import {
  SCREEN_BITRATE_PRESETS_BPS,
  type ScreenBitrateTarget,
} from '../media/sender-bitrate.js';
import type { ScreenCaptureSettings } from '../media/screen-controller.js';

const BITRATE_OPTIONS: readonly Readonly<{
  label: string;
  target: ScreenBitrateTarget;
}>[] = Object.freeze([
  { label: '自动', target: Object.freeze({ mode: 'auto' }) },
  ...SCREEN_BITRATE_PRESETS_BPS.map((bitrateBps) => ({
    label: `${bitrateBps / 1_000_000} Mbps`,
    target: Object.freeze({ mode: 'fixed' as const, bitrateBps }),
  })),
]);

function selectedTarget(
  current: ScreenBitrateTarget,
  candidate: ScreenBitrateTarget,
): boolean {
  return (
    current.mode === candidate.mode &&
    (current.mode === 'auto' ||
      (candidate.mode === 'fixed' &&
        current.bitrateBps === candidate.bitrateBps))
  );
}

function metric(value: number | null, suffix: string): string {
  if (value === null) return `-- ${suffix}`;
  return `${Math.round(value)} ${suffix}`;
}

export function ScreenShareToolbar({
  settings,
  target,
  pending,
  error,
  onTargetChange,
}: {
  readonly settings: ScreenCaptureSettings | null;
  readonly target: ScreenBitrateTarget;
  readonly pending: ScreenBitrateTarget | null;
  readonly error: string | null;
  readonly onTargetChange: (target: ScreenBitrateTarget) => void;
}) {
  return (
    <div className="screen-share-controls" aria-label="屏幕共享状态">
      <div className="capture-quality" aria-label="实际捕获质量">
        <MonitorUp size={16} />
        <span>
          {settings?.width ?? '--'} x {settings?.height ?? '--'}
        </span>
        <span>{metric(settings?.frameRate ?? null, 'fps')}</span>
      </div>
      <span className="screen-control-separator" aria-hidden="true" />
      <div className="bitrate-control">
        <span className="bitrate-label">
          <Gauge size={15} />
          目标码率
        </span>
        <div
          className="bitrate-options"
          role="group"
          aria-label="目标码率"
          aria-busy={pending !== null}
        >
          {BITRATE_OPTIONS.map((option) => (
            <button
              className={
                selectedTarget(target, option.target) ? 'selected' : ''
              }
              key={option.label}
              type="button"
              aria-label={option.label}
              aria-pressed={selectedTarget(target, option.target)}
              onClick={() => onTargetChange(option.target)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {error !== null && (
        <span className="bitrate-error" role="status">
          {error}
        </span>
      )}
    </div>
  );
}
