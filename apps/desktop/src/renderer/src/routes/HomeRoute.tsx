import { useState, type FormEvent, type ReactNode } from 'react';
import { AudioLines, LogOut, Plus, Users } from 'lucide-react';

import { AccountSecurityPanel } from '../components/AccountSecurityPanel.js';
import { AppFooter } from '../components/AppFooter.js';
import { BackendTargetSettings } from '../components/BackendTargetSettings.js';
import { DownloadClient } from '../components/DownloadClient.js';
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
    if (room.busy || auth.busy) return;
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
          <span className="account-summary-name">
            {auth.session?.user.displayName}
          </span>
          <AccountSecurityPanel />
          <button
            className="glass-icon-button"
            type="button"
            title="退出登录"
            aria-label="退出登录"
            disabled={auth.busy || room.busy}
            onClick={() => void auth.logout()}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="home-content">
        <div className="home-heading">
          <p>语音与屏幕共享</p>
          <h1>开始通话</h1>
          <span className="home-subtitle">
            为两个人，留一个专注交流的空间。
          </span>
        </div>
        {modeSelector != null && (
          <fieldset
            className="connection-mode-fieldset"
            disabled={auth.busy || room.busy}
          >
            <legend className="sr-only">连接方式</legend>
            {modeSelector}
          </fieldset>
        )}
        <BackendTargetSettings />
        <div className="room-actions">
          <section className="room-action" aria-labelledby="create-room-title">
            <span className="action-icon" aria-hidden="true">
              <Plus size={22} />
            </span>
            <div>
              <h2 id="create-room-title">新房间</h2>
              <p>创建专属的双人房间，把房间码发给对方。</p>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={room.busy || auth.busy}
              onClick={() => {
                setValidationError(null);
                void room.createRoom();
              }}
            >
              {room.pendingOperation === 'create' ? '正在创建' : '创建房间'}
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
              <p>输入对方发来的 6 位房间码，即刻相聚。</p>
            </div>
            <form onSubmit={join} aria-busy={room.pendingOperation === 'join'}>
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
                disabled={room.busy || auth.busy}
                onChange={(event) =>
                  setRoomCode(
                    event.target.value.replace(/\D/gu, '').slice(0, 6),
                  )
                }
              />
              <button
                className="secondary-button"
                type="submit"
                disabled={room.busy || auth.busy}
              >
                {room.pendingOperation === 'join' ? '正在加入' : '加入房间'}
              </button>
            </form>
          </section>
        </div>
        <DownloadClient />
        <div className="home-error" role="alert" aria-live="polite">
          {validationError ?? room.error ?? auth.error}
        </div>
      </main>
      <AppFooter />
    </div>
  );
}
