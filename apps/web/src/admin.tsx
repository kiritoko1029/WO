import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  adminOverviewSchema,
  adminDeploymentStatusSchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  type AdminOverview,
  type AdminUserSnapshot,
  type AdminDeploymentStatus,
} from '@wo/protocol';

import './web.css';
import '../../desktop/src/renderer/src/styles.css';

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

const certificateAlerts: Record<
  AdminDeploymentStatus['certificate']['alerts'][number],
  string
> = {
  LOCAL_CERTIFICATE: '本地测试证书：仅适合本机测试，浏览器可能提示不受信任。',
  STATUS_UNAVAILABLE: '证书状态暂不可用，请检查部署服务是否正常运行。',
  STATUS_STALE: '证书任务超过 48 小时没有更新，请检查证书管理服务。',
  CERTIFICATE_PENDING: '正在等待可用证书发布，请检查所选证书管理方式。',
  CERTIFICATE_EXPIRED: '证书已过期，请检查续签服务和域名解析。',
  CERTIFICATE_EXPIRING: '证书将在 21 天内到期，请确认续签任务正常。',
  CERTIFICATE_NOT_YET_VALID: '证书尚未生效，请检查服务器时间。',
  HOST_MISMATCH: '证书与访问地址或 TURN 域名不匹配，请重新检查部署设置。',
  ISSUANCE_FAILED: '首次签发失败；服务将自动重试，请检查域名解析和 80 端口。',
  RENEWAL_FAILED: '续签失败；服务将自动重试，目前保留上一份证书。',
  IMPORT_FAILED:
    '1Panel 证书导入失败；请检查网站证书目录、文件名、有效期和私钥是否匹配。',
};

function DeploymentPanel({
  status,
  busy,
  error,
  refresh,
}: {
  status: AdminDeploymentStatus | null;
  busy: boolean;
  error: string | null;
  refresh: () => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const cert = status?.certificate;
  const copyPublicUrl = async () => {
    if (status === null) return;
    try {
      await navigator.clipboard.writeText(status.publicUrl);
      setCopyFeedback('已复制连接地址');
    } catch {
      setCopyFeedback('复制失败，请手动选择地址复制');
    }
  };
  const stateLabels = {
    pending: '等待证书',
    ready: '证书已就绪',
    error: '需要关注',
    unavailable: '状态不可用',
    unmanaged: '手动管理',
  };
  return (
    <section
      className="admin-section admin-deployment"
      aria-labelledby="deployment-title"
    >
      <div className="admin-section-heading">
        <div>
          <p className="admin-kicker">Deployment</p>
          <h2 id="deployment-title">部署与证书</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={refresh}
        >
          {busy ? '检查中…' : '刷新部署状态'}
        </button>
      </div>
      {error !== null && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {status === null || cert === undefined ? (
        <p className="admin-meta" role="status">
          {busy ? '正在读取部署状态…' : '刷新后可查看部署与证书信息。'}
        </p>
      ) : (
        <>
          <div className="admin-deployment-grid">
            <article className="admin-status-card">
              <p className="admin-card-label">应用连接地址</p>
              <a
                className="admin-public-url"
                href={status.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                {status.publicUrl}
              </a>
              <p className="admin-sub">桌面客户端可使用此地址连接后端</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void copyPublicUrl()}
              >
                复制地址
              </button>
              <span className="admin-copy-feedback" role="status">
                {copyFeedback}
              </span>
              <dl className="admin-status-list">
                <div>
                  <dt>TURN 中继</dt>
                  <dd>{status.turnHost}</dd>
                </div>
                <div>
                  <dt>邮箱验证</dt>
                  <dd>
                    {status.emailVerificationRequired ? '已开启' : '未开启'}
                  </dd>
                </div>
                <div>
                  <dt>邮件服务</dt>
                  <dd>{status.smtpConfigured ? '已配置' : '未配置'}</dd>
                </div>
              </dl>
            </article>
            <article className="admin-status-card">
              <div className="admin-card-heading">
                <p className="admin-card-label">
                  {cert.mode === 'external'
                    ? 'TURN TLS / 1Panel 同步'
                    : 'HTTPS / TURN TLS'}
                </p>
                <span className={`admin-cert-state ${cert.state}`}>
                  {stateLabels[cert.state]}
                </span>
              </div>
              <strong className="admin-certificate-title">
                {cert.mode === 'local'
                  ? '本地测试证书'
                  : cert.mode === 'acme'
                    ? 'ACME 自动证书'
                    : cert.mode === 'external'
                      ? '1Panel 管理证书'
                      : '自主管理证书'}
              </strong>
              <p className="admin-sub">
                {cert.mode === 'external'
                  ? '由 1Panel 签发与续签，WO 自动导入网站证书供 TURN 加载；HTTPS 状态请在 1Panel 查看。'
                  : cert.autoRenew
                    ? '自动检查续签并发布证书，供 HTTPS 与 TURN 服务加载'
                    : '当前部署未启用自动证书状态管理'}
              </p>
              <dl className="admin-status-list">
                <div>
                  <dt>有效期</dt>
                  <dd>
                    {cert.details === null
                      ? '等待证书'
                      : `${new Date(cert.details.validTo).toLocaleDateString()} · ${cert.details.daysRemaining >= 0 ? `剩余 ${cert.details.daysRemaining} 天` : '已过期'}`}
                  </dd>
                </div>
                <div>
                  <dt>最近检查</dt>
                  <dd>
                    {cert.lastAttemptAt === null
                      ? '等待首次检查'
                      : new Date(cert.lastAttemptAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>{cert.mode === 'external' ? '最近导入' : '最近签发'}</dt>
                  <dd>
                    {cert.lastSuccessAt === null
                      ? '暂无记录'
                      : new Date(cert.lastSuccessAt).toLocaleString()}
                  </dd>
                </div>
              </dl>
            </article>
          </div>
          {cert.alerts.length > 0 && (
            <ul className="admin-deployment-alerts" aria-label="部署提醒">
              {cert.alerts.map((alert) => (
                <li key={alert}>{certificateAlerts[alert]}</li>
              ))}
            </ul>
          )}
          {cert.details !== null && (
            <details className="admin-certificate-details">
              <summary>证书详情</summary>
              <dl className="admin-status-list">
                <div>
                  <dt>颁发机构</dt>
                  <dd>{cert.details.issuer}</dd>
                </div>
                <div>
                  <dt>证书主体</dt>
                  <dd>{cert.details.subject}</dd>
                </div>
                <div>
                  <dt>域名检查</dt>
                  <dd>
                    {cert.details.matchesPublicHost &&
                    cert.details.matchesTurnHost
                      ? '应用与 TURN 域名均匹配'
                      : '存在域名不匹配'}
                  </dd>
                </div>
                <div>
                  <dt>SHA-256 指纹</dt>
                  <dd>
                    <code>{cert.details.fingerprint256}</code>
                  </dd>
                </div>
              </dl>
            </details>
          )}
          <p className="admin-meta admin-deployment-note">
            此页显示已发布证书的状态。服务会自动加载已发布证书，实际加载异常请查服务日志。
            日常状态与手动续签可使用部署脚本；更改域名或配置需由维护者迁移。
            {status.enabled &&
              ' 初始管理员可在客户端修改密码；更换该账号邮箱需要由服务器维护者迁移。'}
          </p>
        </>
      )}
    </section>
  );
}

function AdminApp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [deployment, setDeployment] = useState<AdminDeploymentStatus | null>(
    null,
  );
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const activeToken = useRef<string | null>(null);
  const refreshToken = useRef<string | null>(null);

  const loadOverview = useCallback(async (token: string) => {
    const data = await apiFetch('/v1/admin/overview', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      parse: (input) => adminOverviewSchema.parse(input),
    });
    if (activeToken.current === token) setOverview(data);
  }, []);

  const loadDeployment = useCallback(async (token: string) => {
    setDeploymentBusy(true);
    try {
      const data = await apiFetch('/v1/admin/deployment', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        parse: (input) => adminDeploymentStatusSchema.parse(input),
      });
      if (activeToken.current !== token) return;
      setDeployment(data);
      setDeploymentError(null);
    } catch {
      if (activeToken.current === token)
        setDeploymentError('部署状态暂时无法读取，请稍后刷新。');
    } finally {
      if (activeToken.current === token) setDeploymentBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    const tokenToRevoke = refreshToken.current;
    activeToken.current = null;
    refreshToken.current = null;
    setAccessToken(null);
    setOverview(null);
    setDeployment(null);
    setDeploymentError(null);
    setDeploymentBusy(false);
    setBusy(false);
    setPassword('');
    if (tokenToRevoke !== null) {
      void apiFetch('/v1/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: tokenToRevoke }),
        parse: () => null,
      }).catch(() => undefined);
    }
  }, []);

  const login = async () => {
    if (busy) return;
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
      activeToken.current = session.accessToken;
      refreshToken.current = session.refreshToken;
      setAccessToken(session.accessToken);
      setPassword('');
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
      logout();
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
      if (activeToken.current !== accessToken) return;
      setError('刷新失败，请重新登录');
      logout();
    } finally {
      setBusy(false);
    }
  }, [accessToken, loadOverview, logout]);

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
      if (activeToken.current !== accessToken) return;
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

  useEffect(() => {
    if (accessToken === null) return;
    void loadDeployment(accessToken);
    const timer = window.setInterval(
      () => void loadDeployment(accessToken),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [accessToken, loadDeployment]);

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
        <form
          className="admin-login-card"
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <h2>管理员登录</h2>
          <p>使用部署向导创建的管理员账号，查看运行状态、证书与用户连接。</p>
          <label>
            <span>邮箱</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="form-message" role="alert">
            {error}
          </div>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '登录中…' : '进入管理台'}
          </button>
        </form>
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
            <button type="button" className="secondary-button" onClick={logout}>
              退出
            </button>
          </div>
          <div className="form-message" role="alert">
            {error}
          </div>
          <p className="admin-meta">
            更新于 {new Date(overview.generatedAt).toLocaleString()}
          </p>

          <DeploymentPanel
            status={deployment}
            error={deploymentError}
            busy={deploymentBusy}
            refresh={() => void loadDeployment(accessToken)}
          />

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
