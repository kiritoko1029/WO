import { useState } from 'react';
import { Mic, MicOff, MonitorUp, PhoneOff, Settings } from 'lucide-react';

export function CallToolbar({
  busy,
  onHangup,
  onMutedChange,
}: {
  readonly busy: boolean;
  readonly onHangup: () => void;
  readonly onMutedChange: (muted: boolean) => void;
}) {
  const [muted, setMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    onMutedChange(next);
  };

  return (
    <div className="toolbar-wrap">
      {settingsOpen && (
        <div className="settings-popover" role="dialog" aria-label="通话设置">
          <strong>通话设置</strong>
          <span>默认麦克风与扬声器</span>
        </div>
      )}
      <nav className="call-toolbar" aria-label="通话控制">
        <button
          className={`tool-button${muted ? ' active' : ''}`}
          type="button"
          title={muted ? '取消静音' : '静音'}
          aria-label={muted ? '取消静音' : '静音'}
          onClick={toggleMuted}
        >
          {muted ? <MicOff size={21} /> : <Mic size={21} />}
        </button>
        <button
          className="tool-button"
          type="button"
          title="共享屏幕"
          aria-label="共享屏幕"
          disabled
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
