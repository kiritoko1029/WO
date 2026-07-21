import { useState } from 'react';
import { Activity, Gauge } from 'lucide-react';

import {
  SCREEN_BITRATE_PRESETS,
  type ScreenBitrateTarget,
} from '../media/sender-bitrate.js';
import type { QualityDiagnosticSample } from '../media/stats-buffer.js';
import type { ScreenCaptureSettings } from '../media/screen-controller.js';

function selectedPresetValue(target: ScreenBitrateTarget): number {
  if (target.mode === 'fixed') {
    const exact = SCREEN_BITRATE_PRESETS.find(
      (preset) => preset.bitrateBps === target.bitrateBps,
    );
    if (exact !== undefined) return exact.bitrateBps;
  }
  // Fall back to 高清 when target is auto or an unexpected value.
  return SCREEN_BITRATE_PRESETS[1]!.bitrateBps;
}

function formatBitrate(value: number | null): string {
  if (value === null) return '-- Mbps';
  return `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function formatMetric(value: number | null, suffix: string): string {
  if (value === null) return `-- ${suffix}`;
  return `${Math.round(value)} ${suffix}`;
}

function formatResolution(
  settings: ScreenCaptureSettings | null,
  sample: QualityDiagnosticSample | null,
): string {
  const width = settings?.width ?? sample?.capture?.width ?? null;
  const height = settings?.height ?? sample?.capture?.height ?? null;
  if (width === null || height === null) return '--';
  return `${width} x ${height}`;
}

function formatFrameRate(
  settings: ScreenCaptureSettings | null,
  sample: QualityDiagnosticSample | null,
): string {
  const fps =
    settings?.frameRate ??
    sample?.outbound?.fps ??
    sample?.capture?.frameRate ??
    null;
  return formatMetric(fps, 'fps');
}

function realBitrateBps(sample: QualityDiagnosticSample | null): number | null {
  return sample?.outbound?.bitrateBps ?? sample?.inbound?.bitrateBps ?? null;
}

function latencyMs(sample: QualityDiagnosticSample | null): number | null {
  return sample?.outbound?.rttMs ?? sample?.inbound?.rttMs ?? null;
}

export function ScreenShareToolbar({
  settings,
  target,
  pending,
  error,
  quality,
  onTargetChange,
}: {
  readonly settings: ScreenCaptureSettings | null;
  readonly target: ScreenBitrateTarget;
  readonly pending: ScreenBitrateTarget | null;
  readonly error: string | null;
  readonly quality: QualityDiagnosticSample | null;
  readonly onTargetChange: (target: ScreenBitrateTarget) => void;
}) {
  const [statsOpen, setStatsOpen] = useState(false);
  const selected = selectedPresetValue(target);

  return (
    <div className="screen-share-controls" aria-label="屏幕共享状态">
      <div className="bitrate-control">
        <label className="bitrate-label" htmlFor="screenBitrateSelect">
          <Gauge size={15} />
          码率上限
        </label>
        <select
          id="screenBitrateSelect"
          className="bitrate-select"
          aria-label="码率上限"
          aria-busy={pending !== null}
          disabled={pending !== null}
          value={selected}
          onChange={(event) => {
            const bitrateBps = Number(event.target.value);
            onTargetChange({ mode: 'fixed', bitrateBps });
          }}
        >
          {SCREEN_BITRATE_PRESETS.map((preset) => (
            <option key={preset.bitrateBps} value={preset.bitrateBps}>
              {preset.label} {preset.bitrateBps / 1_000_000}M
            </option>
          ))}
        </select>
      </div>
      <span className="screen-control-separator" aria-hidden="true" />
      <div className="transmission-stats-control">
        <button
          type="button"
          className="transmission-stats-toggle"
          aria-label="传输信息"
          aria-expanded={statsOpen}
          title="传输信息"
          onClick={() => setStatsOpen((open) => !open)}
        >
          <Activity size={15} />
          传输信息
        </button>
        {statsOpen && (
          <div className="transmission-stats" aria-label="传输信息详情">
            <div>
              <span>分辨率</span>
              <strong>{formatResolution(settings, quality)}</strong>
            </div>
            <div>
              <span>帧率</span>
              <strong>{formatFrameRate(settings, quality)}</strong>
            </div>
            <div>
              <span>真实码率</span>
              <strong>{formatBitrate(realBitrateBps(quality))}</strong>
            </div>
            <div>
              <span>连接延迟</span>
              <strong>{formatMetric(latencyMs(quality), 'ms')}</strong>
            </div>
          </div>
        )}
      </div>
      {error !== null && (
        <span className="bitrate-error" role="status">
          {error}
        </span>
      )}
    </div>
  );
}
