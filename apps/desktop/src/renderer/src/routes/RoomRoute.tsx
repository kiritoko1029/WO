import { useState } from 'react';
import { AudioLines, Monitor } from 'lucide-react';

import { CallToolbar } from '../components/CallToolbar.js';
import { ParticipantSlots } from '../components/ParticipantSlots.js';
import { useRoom } from '../state/room-store.js';

const statusText = {
  waiting: '等待对方加入',
  connected: '语音已连接',
  reconnecting: '正在重新连接',
} as const;

export function RoomRoute() {
  const { room, busy, error, closeRoom } = useRoom();
  const [muted, setMuted] = useState(false);
  if (room === null) return null;

  return (
    <div className="room-shell">
      <header className="room-header">
        <div className="product-lockup compact">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={19} />
          </span>
          <span>WO</span>
        </div>
        <div className="room-identity">
          <span className={`connection-dot ${room.connectionStatus}`} />
          <strong>{statusText[room.connectionStatus]}</strong>
          <span className="room-code-label">房间码</span>
          <code>{room.roomCode}</code>
        </div>
      </header>
      <main className="call-workspace">
        <ParticipantSlots participants={room.participants} muted={muted} />
        <section className="screen-stage" aria-label="共享屏幕">
          <div className="screen-empty">
            <Monitor size={42} strokeWidth={1.4} />
            <h2>等待屏幕共享</h2>
          </div>
        </section>
        <div className="room-error" role="alert" aria-live="polite">
          {error}
        </div>
      </main>
      <CallToolbar
        busy={busy}
        onMutedChange={setMuted}
        onHangup={() => void closeRoom()}
      />
    </div>
  );
}
