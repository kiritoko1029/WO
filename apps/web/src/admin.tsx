import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  adminOverviewSchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  type AdminOverview,
  type AdminUserSnapshot,
} from '@wo/protocol';

import './web.css';
import '../../desktop/src/renderer/src/styles.css';

const REFRESH_TOKEN_KEY = 'wo.web.refresh-token.v1';

function apiOrigin(): string {
  return window.location.origin;
}

async function apiFetch<T>(
  path: string,
  init: RequestInit & { parse: (input: unknown) => T },
): Promise<T> {
  const response = await fetch(`${apiOrigin()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error?: { code?: unknown } }).error?.code === 'string'
        ? (body as { error: { code: string } }).error.code
        : 'REQUEST_FAILED';
    throw Object.assign(new Error(code), { code, status: response.status });
  }
  return init.parse(body);
}

function AdminApp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const loadOverview = useCallback(async (token: string) => {
    const data = await apiFetch('/v1/admin/overview', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      parse: (input) => adminOverviewSchema.parse(input),
    });
    setOverview(data);
  }, []);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = authLoginBodySchema.parse({
        email: email.trim().toLowerCase(),
        password,
      });
      const session = await apiFetch('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
        parse: (input) => authLoginResponseSchema.parse(input),
      });
      window.sessionStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
      setAccessToken(session.accessToken);
      await loadOverview(session.accessToken);
    } catch (loginError) {
      const code =
        typeof loginError === 'object' &&
        loginError !== null &&
        'code' in loginError &&
        typeof loginError.code === 'string'
          ? loginError.code
          : 'LOGIN_FAILED';
      setError(
        code === 'INVALID_STATE'
          ? '当前账号不是超级管理员'
          : code === 'INVALID_CREDENTIALS'
            ? '邮箱或密码错误'
            : '登录失败，请检查权限与网络',
      );
      setAccessToken(null);
      setOverview(null);
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    if (accessToken === null) return;
    setBusy(true);
    setError(null);
    try {
      await loadOverview(accessToken);
    } catch {
      setError('刷新失败，请重新登录');
      setAccessToken(null);
      setOverview(null);
    } finally {
      setBusy(false);
    }
  }, [accessToken, loadOverview]);

  const setDisabled = async (user: AdminUserSnapshot, disabled: boolean) => {
    if (accessToken === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/v1/admin/users/${user.userId}/disabled`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ disabled }),
        parse: () => null,
      });
      await loadOverview(accessToken);
    } catch {
      setError(disabled ? '禁用失败' : '启用失败');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // Auto-refresh every 10s while logged in.
    if (accessToken === null) return;
    const timer = window.setInterval(() => {
      void loadOverview(accessToken).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [accessToken, loadOverview]);

  const filteredUsers = useMemo(() => {
    if (overview === null) return [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return overview.users;
    return overview.users.filter(
      (user) =>
        user.email.includes(needle) ||
        user.displayName.toLowerCase().includes(needle) ||
        user.userId.includes(needle),
    );
  }, [filter, overview]);

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">WO Console</p>
          <h1>超级管理员</h1>
        </div>
        {overview !== null && (
          <div className="admin-totals">
            <span>用户 {overview.totals.users}</span>
            <span>在线会话 {overview.totals.activeSessions}</span>
            <span>信令连接 {overview.totals.signalingConnections}</span>
            <span>房间 {overview.totals.rooms}</span>
          </div>
        )}
      </header>

      {accessToken === null || overview === null ? (
        <section className="admin-login-card">
          <h2>管理员登录</h2>
          <p>请使用 .env 中 SUPER_ADMIN_EMAILS 配置的邮箱登录。</p>
          <label>
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="form-message" role="alert">
            {error}
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void login()}
          >
            {busy ? '登录中…' : '进入管理台'}
          </button>
        </section>
      ) : (
        <main className="admin-main">
          <div className="admin-toolbar">
            <input
              className="admin-filter"
              placeholder="搜索邮箱 / 名称 / 用户 ID"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setAccessToken(null);
                setOverview(null);
              }}
            >
              退出
            </button>
          </div>
          <div className="form-message" role="alert">
            {error}
          </div>
          <p className="admin-meta">
            更新于 {new Date(overview.generatedAt).toLocaleString()}
          </p>

          <section className="admin-section">
            <h2>用户与连接状态</h2>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>状态</th>
                    <th>会话</th>
                    <th>信令连接</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((user) => (
                    <tr key={user.userId}>
                      <td>
                        <div className="admin-user-cell">
                          <strong>{user.displayName}</strong>
                          <span>{user.email}</span>
                          <code>{user.userId}</code>
                        </div>
                      </td>
                      <td>
                        <div className="admin-badges">
                          {user.isSuperAdmin && (
                            <span className="badge admin">超管</span>
                          )}
                          <span
                            className={`badge ${user.verified ? 'ok' : 'warn'}`}
                          >
                            {user.verified ? '已验证' : '未验证'}
                          </span>
                          <span
                            className={`badge ${user.disabled ? 'danger' : 'ok'}`}
                          >
                            {user.disabled ? '已禁用' : '正常'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div>
                          <strong>{user.activeSessions}</strong>
                          <div className="admin-sub">
                            {user.latestSessionAt
                              ? new Date(user.latestSessionAt).toLocaleString()
                              : '无活跃会话'}
                          </div>
                        </div>
                      </td>
                      <td>
                        {user.signalingConnections.length === 0 ? (
                          <span className="admin-sub">未连接信令</span>
                        ) : (
                          <ul className="admin-connection-list">
                            {user.signalingConnections.map((connection) => (
                              <li key={connection.connectionId}>
                                <span className={`dot ${connection.state}`} />
                                {connection.state}
                                {connection.roomId
                                  ? ` · 房间 ${connection.roomId.slice(0, 8)}`
                                  : ' · 未进房'}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        {!user.isSuperAdmin && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() =>
                              void setDisabled(user, !user.disabled)
                            }
                          >
                            {user.disabled ? '启用' : '禁用'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-section">
            <h2>房间</h2>
            {overview.rooms.length === 0 ? (
              <p className="admin-sub">当前没有活跃房间</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>房间 ID</th>
                      <th>状态</th>
                      <th>成员</th>
                      <th>在线</th>
                      <th>共享</th>
                      <th>房间码</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.rooms.map((room) => (
                      <tr key={room.roomId}>
                        <td>
                          <code>{room.roomId}</code>
                        </td>
                        <td>{room.state}</td>
                        <td>{room.memberCount}</td>
                        <td>{room.onlineCount}</td>
                        <td>{room.hasScreenShare ? '是' : '否'}</td>
                        <td>{room.roomCode ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('Web root is missing');
createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
