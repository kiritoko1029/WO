import { AppWindow, LoaderCircle, Monitor, X } from 'lucide-react';

import type { CaptureSourceSummary } from '../../../preload/types.js';
import type { ScreenShareState } from '../media/screen-controller.js';

export function SourcePicker({
  sources,
  selectedToken,
  state,
  onSelect,
  onStart,
  onCancel,
}: {
  readonly sources: readonly CaptureSourceSummary[];
  readonly selectedToken: string | null;
  readonly state: ScreenShareState;
  readonly onSelect: (token: string) => void;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}) {
  const loading = state === 'acquiring';
  const starting = state === 'capturing';

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
            <p>屏幕或应用窗口</p>
          </div>
          <button
            className="source-picker-close"
            type="button"
            title="取消共享"
            aria-label="取消共享"
            onClick={onCancel}
          >
            <X size={19} />
          </button>
        </header>

        <div className="source-picker-body">
          {loading ? (
            <div className="source-picker-status" role="status">
              <LoaderCircle className="source-spinner" size={28} />
              <span>正在读取可共享内容</span>
            </div>
          ) : sources.length === 0 ? (
            <div className="source-picker-status" role="status">
              <Monitor size={30} />
              <span>没有可共享的屏幕或窗口</span>
            </div>
          ) : (
            <div className="source-grid" aria-label="可共享内容">
              {sources.map((source) => {
                const selected = source.token === selectedToken;
                const kindLabel = source.kind === 'screen' ? '屏幕' : '窗口';
                const KindIcon = source.kind === 'screen' ? Monitor : AppWindow;
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
                      <img
                        src={source.thumbnailDataUrl}
                        alt=""
                        draggable={false}
                      />
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
            disabled={selectedToken === null || loading || starting}
            onClick={onStart}
          >
            {starting ? '正在启动' : '开始共享'}
          </button>
        </footer>
      </section>
    </div>
  );
}
