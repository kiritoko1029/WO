import { useEffect, useRef } from 'react';
import { AppWindow, LoaderCircle, Monitor, RefreshCw, X } from 'lucide-react';

// Matches the placeholder data URL emitted by the main process for sources
// whose thumbnail could not be rendered (minimized/off-screen windows).
const PLACEHOLDER_THUMBNAIL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** How often to re-list OS windows/screens while the picker is open. */
const SOURCE_REFRESH_MS = 2_000;

import type {
  CaptureSourceSummary,
  SystemAudioMode,
} from '../../../preload/types.js';
import type { ScreenShareState } from '../media/screen-controller.js';

export function SourcePicker({
  sources,
  selectedToken,
  systemAudioEnabled,
  systemAudioMode,
  state,
  onSelect,
  onSystemAudioEnabledChange,
  onStart,
  onCancel,
  onRefresh,
}: {
  readonly sources: readonly CaptureSourceSummary[];
  readonly selectedToken: string | null;
  readonly systemAudioEnabled: boolean;
  readonly systemAudioMode: SystemAudioMode;
  readonly state: ScreenShareState;
  readonly onSelect: (token: string) => void;
  readonly onSystemAudioEnabledChange: (enabled: boolean) => void;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
}) {
  const loading = state === 'acquiring';
  const starting = state === 'capturing';
  const picking = state === 'picking';
  const nativePicker = systemAudioMode === 'native-picker';
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // While the user is browsing sources, re-list periodically so newly opened
  // or closed windows appear without re-opening the picker.
  useEffect(() => {
    if (!picking || nativePicker) return;
    const timer = window.setInterval(() => {
      onRefreshRef.current();
    }, SOURCE_REFRESH_MS);
    const onFocus = (): void => {
      onRefreshRef.current();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [nativePicker, picking]);

  return (
    <div className="source-picker-backdrop">
      <section
        className="source-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-picker-title"
        aria-busy={loading || starting}
      >
        <header className="source-picker-header">
          <div>
            <h2 id="source-picker-title">选择共享内容</h2>
            <p>{nativePicker ? '系统选择器' : '屏幕或应用窗口'}</p>
          </div>
          <div className="source-picker-header-actions">
            {!nativePicker && (
              <button
                className="source-picker-refresh"
                type="button"
                title="刷新列表"
                aria-label="刷新可共享内容列表"
                disabled={loading || starting}
                onClick={onRefresh}
              >
                <RefreshCw size={17} />
              </button>
            )}
            <button
              className="source-picker-close"
              type="button"
              title="取消共享"
              aria-label="取消共享"
              onClick={onCancel}
            >
              <X size={19} />
            </button>
          </div>
        </header>

        <div className="source-picker-body">
          {nativePicker ? (
            <div className="source-picker-status" role="status">
              <Monitor size={30} />
              <span>准备选择共享内容</span>
            </div>
          ) : loading ? (
            <div className="source-picker-status" role="status">
              <LoaderCircle className="source-spinner" size={28} />
              <span>正在读取可共享内容</span>
            </div>
          ) : sources.length === 0 ? (
            <div className="source-picker-status" role="status">
              <Monitor size={30} />
              <span>没有可共享的屏幕或窗口</span>
              <button
                className="source-refresh-empty"
                type="button"
                onClick={onRefresh}
              >
                刷新列表
              </button>
            </div>
          ) : (
            <div className="source-grid" aria-label="可共享内容">
              {sources.map((source) => {
                const selected = source.token === selectedToken;
                const kindLabel = source.kind === 'screen' ? '屏幕' : '窗口';
                const KindIcon = source.kind === 'screen' ? Monitor : AppWindow;
                const hasPlaceholder =
                  source.thumbnailDataUrl === PLACEHOLDER_THUMBNAIL;
                return (
                  <button
                    className={`source-tile${selected ? ' selected' : ''}`}
                    key={source.token}
                    type="button"
                    aria-label={`${source.name}，${kindLabel}`}
                    aria-pressed={selected}
                    disabled={starting}
                    onClick={() => onSelect(source.token)}
                  >
                    <span className="source-thumbnail">
                      {hasPlaceholder ? (
                        <span className="source-thumbnail-placeholder">
                          <KindIcon size={32} />
                        </span>
                      ) : (
                        <img
                          src={source.thumbnailDataUrl}
                          alt=""
                          draggable={false}
                        />
                      )}
                    </span>
                    <span className="source-meta">
                      <KindIcon size={15} />
                      <span className="source-name">{source.name}</span>
                      <span className="source-kind">{kindLabel}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="source-picker-footer">
          {systemAudioMode !== 'unsupported' && (
            <label className="source-audio-option">
              <input
                type="checkbox"
                checked={systemAudioEnabled}
                disabled={!picking || starting}
                onChange={(event) =>
                  onSystemAudioEnabledChange(event.currentTarget.checked)
                }
              />
              <span>
                <strong>共享系统音频</strong>
                <small>让对方听到设备播放的声音</small>
              </span>
            </label>
          )}
          <div className="source-picker-footer-actions">
            <button
              className="source-cancel-button"
              type="button"
              onClick={onCancel}
            >
              取消
            </button>
            <button
              className="source-start-button"
              type="button"
              disabled={
                (!nativePicker && selectedToken === null) || loading || starting
              }
              onClick={onStart}
            >
              {starting ? '正在启动' : nativePicker ? '继续' : '开始共享'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
