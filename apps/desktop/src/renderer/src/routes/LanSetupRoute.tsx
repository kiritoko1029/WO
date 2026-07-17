import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AudioLines, Link, Plus, Wifi } from 'lucide-react';
import type { LanJoinIntent } from '@wo/protocol';

import type {
  DesktopLanApi,
  LanSessionSnapshot,
} from '../../../preload/lan-types.js';

function errorMessage(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : '';
  switch (code) {
    case 'AUTH_REQUIRED':
      return '邀请密钥无效';
    case 'INVALID_STATE':
      return '房间已满或已关闭';
    case 'REQUEST_TIMEOUT':
      return '连接房主超时';
    case 'NETWORK_ERROR':
      return '无法连接房主，请确认两台设备在同一局域网';
    case 'RATE_LIMITED':
      return '尝试过于频繁，请稍后再试';
    default:
      return '局域网房间启动失败';
  }
}

export function LanSetupRoute({
  lan,
  pendingIntent,
  modeSelector,
  onSession,
  onIntentConsumed,
}: {
  readonly lan: DesktopLanApi;
  readonly pendingIntent: LanJoinIntent | null;
  readonly modeSelector: ReactNode;
  readonly onSession: (session: LanSessionSnapshot) => void;
  readonly onIntentConsumed: () => void;
}) {
  const [action, setAction] = useState<'host' | 'join'>(
    pendingIntent === null ? 'host' : 'join',
  );
  const [displayName, setDisplayName] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pendingIntent !== null) setAction('join');
  }, [pendingIntent]);

  const run = async (
    operation: () => Promise<LanSessionSnapshot>,
  ): Promise<void> => {
    const name = displayName.trim();
    if (name.length === 0) {
      setError('请输入显示名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSession(await operation());
    } catch (operationError) {
      setError(errorMessage(operationError));
    } finally {
      setBusy(false);
    }
  };
  const create = (): void => {
    void run(() => lan.host(displayName.trim()));
  };
  const join = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const intent = pendingIntent ?? (await lan.parseInvite(invite.trim()));
      const session = await lan.join(displayName.trim(), intent);
      setInvite('');
      if (pendingIntent !== null) onIntentConsumed();
      return session;
    });
  };

  return (
    <main className="lan-shell">
      <section className="lan-panel" aria-labelledby="lan-heading">
        <div className="product-lockup">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={22} />
          </span>
          <span>WO</span>
        </div>
        {modeSelector}
        <header>
          <h1 id="lan-heading">局域网轻量房间</h1>
          <p>
            房主设备临时提供服务，仅适用于你信任的同一局域网。房主退出后房间立即关闭。
          </p>
        </header>
        <div className="segmented" role="tablist" aria-label="局域网操作">
          <button
            type="button"
            role="tab"
            aria-selected={action === 'host'}
            className={action === 'host' ? 'active' : undefined}
            onClick={() => {
              setAction('host');
              setError(null);
            }}
          >
            创建房间
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={action === 'join'}
            className={action === 'join' ? 'active' : undefined}
            onClick={() => {
              setAction('join');
              setError(null);
            }}
          >
            加入房间
          </button>
        </div>
        <label className="lan-name-field">
          <span>显示名称</span>
          <input
            value={displayName}
            maxLength={100}
            autoComplete="name"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        {action === 'host' ? (
          <button
            type="button"
            className="primary-button lan-action-button"
            disabled={busy}
            onClick={create}
          >
            <Plus size={17} />
            {busy ? '正在启动' : '创建局域网房间'}
          </button>
        ) : (
          <form className="lan-join-form" onSubmit={join}>
            {pendingIntent === null ? (
              <label>
                <span>客户端邀请链接</span>
                <input
                  type="password"
                  value={invite}
                  autoComplete="off"
                  placeholder="粘贴 wo:// 邀请"
                  onChange={(event) => setInvite(event.target.value)}
                />
              </label>
            ) : (
              <div className="lan-invite-summary">
                <Link size={17} />
                <span>
                  房间 {pendingIntent.roomCode} ·{' '}
                  {new URL(pendingIntent.endpoint).host}
                </span>
              </div>
            )}
            <button type="submit" className="primary-button" disabled={busy}>
              <Wifi size={17} />
              {busy ? '正在连接' : '加入局域网房间'}
            </button>
          </form>
        )}
        <div className="form-message" role="alert" aria-live="polite">
          {error}
        </div>
      </section>
    </main>
  );
}
