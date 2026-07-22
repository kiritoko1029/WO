import { useState } from 'react';
import {
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { VoiceDevice } from '../media/voice-controller.js';
import {
  NOISE_INTENSITY_LEVELS,
  NOISE_INTENSITY_LABELS,
  type NoiseIntensity,
} from '../media/noise-suppressor.js';
import type { ScreenShareState } from '../media/screen-controller.js';

export function CallToolbar({
  busy,
  muted,
  outputMuted,
  inputs,
  outputs,
  selectedInputId,
  selectedOutputId,
  supportsOutputSelection,
  retryAvailable,
  noiseIntensity,
  remoteVolume,
  screenState,
  screenDisabled,
  screenOwnerName,
  onHangup,
  onMutedChange,
  onInputChange,
  onOutputChange,
  onOutputMutedChange,
  onRemoteVolumeChange,
  onNoiseIntensityChange,
  onRetry,
  onScreenShare,
}: {
  readonly busy: boolean;
  readonly muted: boolean;
  readonly outputMuted: boolean;
  readonly inputs: readonly VoiceDevice[];
  readonly outputs: readonly VoiceDevice[];
  readonly selectedInputId: string;
  readonly selectedOutputId: string;
  readonly supportsOutputSelection: boolean;
  readonly retryAvailable: boolean;
  readonly noiseIntensity: NoiseIntensity;
  readonly remoteVolume: number;
  readonly screenState: ScreenShareState;
  readonly screenDisabled: boolean;
  readonly screenOwnerName: string | null;
  readonly onHangup: () => void;
  readonly onMutedChange: (muted: boolean) => void;
  readonly onInputChange: (deviceId: string) => void;
  readonly onOutputChange: (deviceId: string) => void;
  readonly onOutputMutedChange: (muted: boolean) => void;
  readonly onRemoteVolumeChange: (volume: number) => void;
  readonly onNoiseIntensityChange: (intensity: NoiseIntensity) => void;
  readonly onRetry: () => void;
  readonly onScreenShare: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleMuted = () => {
    if (retryAvailable) {
      onRetry();
      return;
    }
    onMutedChange(!muted);
  };
  const screenActive =
    screenState === 'acquiring' ||
    screenState === 'picking' ||
    screenState === 'capturing' ||
    screenState === 'sharing';
  const screenLabel = screenDisabled
    ? `${screenOwnerName ?? '对方'}正在共享`
    : screenActive
      ? '停止共享'
      : '共享屏幕';

  return (
    <div className="toolbar-wrap">
      {settingsOpen && (
        <div className="settings-popover" role="dialog" aria-label="通话设置">
          <strong>通话设置</strong>
          <label>
            <span>麦克风</span>
            <select
              aria-label="麦克风"
              value={selectedInputId}
              disabled={inputs.length === 0}
              onChange={(event) => onInputChange(event.target.value)}
            >
              <option value="">系统默认</option>
              {inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>扬声器</span>
            <select
              aria-label="扬声器"
              value={selectedOutputId}
              disabled={!supportsOutputSelection || outputs.length === 0}
              onChange={(event) => onOutputChange(event.target.value)}
            >
              <option value="">系统默认</option>
              {outputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>降噪</span>
            <select
              aria-label="麦克风降噪"
              value={noiseIntensity}
              onChange={(event) =>
                onNoiseIntensityChange(
                  event.target.value as NoiseIntensity,
                )
              }
            >
              {NOISE_INTENSITY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {NOISE_INTENSITY_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
          <label className="volume-slider-label">
            <span>音量</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              aria-label="对方音量"
              value={remoteVolume}
              onChange={(event) =>
                onRemoteVolumeChange(Number(event.target.value))
              }
            />
          </label>
          <button
            className="output-mute-button"
            type="button"
            aria-label={outputMuted ? '恢复扬声器' : '静音扬声器'}
            onClick={() => onOutputMutedChange(!outputMuted)}
          >
            {outputMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            <span>{outputMuted ? '恢复扬声器' : '静音扬声器'}</span>
          </button>
        </div>
      )}
      <nav className="call-toolbar" aria-label="通话控制">
        <button
          className={`tool-button${muted ? ' active' : ''}`}
          type="button"
          title={retryAvailable ? '重试麦克风' : muted ? '取消静音' : '静音'}
          aria-label={
            retryAvailable ? '重试麦克风' : muted ? '取消静音' : '静音'
          }
          onClick={toggleMuted}
        >
          {retryAvailable || muted ? <MicOff size={21} /> : <Mic size={21} />}
        </button>
        <button
          className={`tool-button${screenActive ? ' active' : ''}`}
          type="button"
          title={screenLabel}
          aria-label={screenLabel}
          disabled={busy || screenDisabled}
          onClick={onScreenShare}
        >
          <MonitorUp size={21} />
        </button>
        <button
          className={`tool-button${settingsOpen ? ' active' : ''}`}
          type="button"
          title="设置"
          aria-label="设置"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings size={21} />
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          className="tool-button danger"
          type="button"
          title="挂断"
          aria-label="挂断"
          disabled={busy}
          onClick={onHangup}
        >
          <PhoneOff size={21} />
        </button>
      </nav>
    </div>
  );
}
