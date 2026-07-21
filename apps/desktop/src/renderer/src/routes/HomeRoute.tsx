import { useState, type FormEvent, type ReactNode } from 'react';
import { AudioLines, LogOut, Plus, Users } from 'lucide-react';

import { AccountSecurityPanel } from '../components/AccountSecurityPanel.js';
import { BackendTargetSettings } from '../components/BackendTargetSettings.js';
import { useAuth } from '../state/auth-store.js';
import { useRoom } from '../state/room-store.js';

export function HomeRoute({
  modeSelector,
}: {
  readonly modeSelector?: ReactNode;
}) {
  const auth = useAuth();
  const room = useRoom();
  const [roomCode, setRoomCode] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/u.test(roomCode)) {
      setValidationError('请输入 6 位房间码');
      return;
    }
    setValidationError(null);
    await room.joinRoom(roomCode);
  };

  return (
    <div className="home-shell">
      <header className="app-header">
        <div className="product-lockup compact">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={14} />
          </span>
          <span>WO</span>
        </div>
        <div className="account-summary">
          <span>{auth.session?.user.displayName}</span>
          <AccountSecurityPanel />
          <button
            className="icon-button subtle"
            type="button"
            title="退出登录"
            aria-label="退出登录"
            disabled={auth.busy}
            onClick={() => void auth.logout()}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="home-content">
        <div className="home-heading">
          <p>语音与屏幕共享</p>
          <h1>开始通话</h1>
        </div>
        {modeSelector}
        <BackendTargetSettings />
        <div className="room-actions">
          <section className="room-action" aria-labelledby="create-room-title">
            <span className="action-icon" aria-hidden="true">
              <Plus size={22} />
            </span>
            <div>
              <h2 id="create-room-title">新房间</h2>
              <p>创建临时房间码</p>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={room.busy}
              onClick={() => void room.createRoom()}
            >
              {room.busy ? '正在创建' : '创建房间'}
            </button>
          </section>
          <section
            className="room-action join-action"
            aria-labelledby="join-room-title"
          >
            <span className="action-icon teal" aria-hidden="true">
              <Users size={22} />
            </span>
            <div>
              <h2 id="join-room-title">加入房间</h2>
              <p>输入对方发来的房间码</p>
            </div>
            <form onSubmit={join}>
              <label className="sr-only" htmlFor="room-code">
                房间码
              </label>
              <input
                id="room-code"
                className="room-code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                value={roomCode}
                onChange={(event) =>
                  setRoomCode(
                    event.target.value.replace(/\D/gu, '').slice(0, 6),
                  )
                }
              />
              <button
                className="secondary-button"
                type="submit"
                disabled={room.busy}
              >
                加入房间
              </button>
            </form>
          </section>
        </div>
        <div className="home-error" role="alert" aria-live="polite">
          {validationError ?? room.error ?? auth.error}
        </div>
      </main>
    </div>
  );
}
