import { useState, type FormEvent, type ReactNode } from 'react';
import { AudioLines } from 'lucide-react';

import { AppFooter } from '../components/AppFooter.js';
import { BackendTargetSettings } from '../components/BackendTargetSettings.js';
import { WelcomePanel } from '../components/WelcomePanel.js';
import { useAuth } from '../state/auth-store.js';

type AuthMode = 'login' | 'register' | 'verify';

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254;
}

export function AuthRoute({
  modeSelector,
}: {
  readonly modeSelector?: ReactNode;
}) {
  const auth = useAuth();
  const [selectedMode, setMode] = useState<AuthMode>('login');
  const mode = auth.pendingVerificationEmail === null ? selectedMode : 'verify';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const switchMode = (next: AuthMode) => {
    if (auth.busy) return;
    setMode(next);
    setValidationError(null);
    auth.clearError();
    if (next !== 'verify') auth.clearPendingVerification();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (auth.busy) return;
    const normalizedEmail = (auth.pendingVerificationEmail ?? email)
      .trim()
      .toLowerCase();
    if (mode === 'verify') {
      if (!/^\d{6}$/u.test(code.trim())) {
        setValidationError('请输入 6 位数字验证码');
        return;
      }
      setValidationError(null);
      await auth.verifyEmail({ email: normalizedEmail, code: code.trim() });
      return;
    }
    if (!validEmail(normalizedEmail)) {
      setValidationError('请输入有效的邮箱地址');
      return;
    }
    if (password.length < 10 || password.length > 128) {
      setValidationError('密码需为 10 到 128 个字符');
      return;
    }
    const normalizedName = displayName.trim();
    if (mode === 'register' && normalizedName.length === 0) {
      setValidationError('请输入显示名称');
      return;
    }
    setValidationError(null);
    if (mode === 'login') {
      await auth.login({ email: normalizedEmail, password });
      return;
    }
    await auth.register({
      email: normalizedEmail,
      password,
      displayName: normalizedName,
    });
  };

  const heading =
    mode === 'login'
      ? '登录 WO'
      : mode === 'register'
        ? '创建 WO 账号'
        : '验证邮箱';

  return (
    <main className="auth-shell">
      <WelcomePanel />
      <section className="auth-panel" aria-labelledby="auth-heading">
        <div className="product-lockup">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={15} />
          </span>
          <span>WO</span>
        </div>
        <h1 id="auth-heading">{heading}</h1>
        <p className="auth-subtitle">
          {mode === 'login'
            ? '与你在意的人，连上同一个时刻。'
            : mode === 'register'
              ? '一个账号，开启属于你们的语音与共享空间。'
              : '完成邮箱验证，即可开始通话。'}
        </p>
        {modeSelector != null && (
          <fieldset className="connection-mode-fieldset" disabled={auth.busy}>
            <legend className="sr-only">连接方式</legend>
            {modeSelector}
          </fieldset>
        )}
        {mode !== 'verify' && (
          <div className="segmented" role="tablist" aria-label="账号操作">
            <button
              type="button"
              role="tab"
              disabled={auth.busy}
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : undefined}
              onClick={() => switchMode('login')}
            >
              登录账号
            </button>
            <button
              type="button"
              role="tab"
              disabled={auth.busy}
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'active' : undefined}
              onClick={() => switchMode('register')}
            >
              注册账号
            </button>
          </div>
        )}
        <form
          className="auth-form"
          onSubmit={(event) => void submit(event)}
          aria-busy={auth.busy}
          noValidate
        >
          {mode === 'register' && (
            <label>
              <span>显示名称</span>
              <input
                value={displayName}
                disabled={auth.busy}
                maxLength={100}
                autoComplete="name"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          )}
          {mode !== 'verify' && (
            <>
              <label>
                <span>邮箱</span>
                <input
                  type="email"
                  disabled={auth.busy}
                  value={email}
                  maxLength={254}
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                <span>密码</span>
                <input
                  type="password"
                  disabled={auth.busy}
                  value={password}
                  maxLength={128}
                  autoComplete={
                    mode === 'login' ? 'current-password' : 'new-password'
                  }
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          )}
          {mode === 'verify' && (
            <>
              <p className="auth-hint">
                请查收邮箱中的验证码：{' '}
                <strong>{auth.pendingVerificationEmail ?? email}</strong>
              </p>
              <label>
                <span>验证码</span>
                <input
                  value={code}
                  disabled={auth.busy}
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            </>
          )}
          <div className="form-message" role="alert" aria-live="polite">
            {validationError ?? auth.error}
          </div>
          <button className="primary-button" type="submit" disabled={auth.busy}>
            {auth.busy
              ? '处理中…'
              : mode === 'login'
                ? '登录'
                : mode === 'register'
                  ? '创建账号'
                  : '完成验证'}
          </button>
          {mode === 'verify' && (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={auth.busy}
                onClick={() =>
                  void auth.resendVerification({
                    email: (auth.pendingVerificationEmail ?? email)
                      .trim()
                      .toLowerCase(),
                  })
                }
              >
                重新发送验证码
              </button>
              <button
                className="text-button"
                type="button"
                disabled={auth.busy}
                onClick={() => switchMode('login')}
              >
                返回登录
              </button>
            </>
          )}
        </form>
        <BackendTargetSettings />
      </section>
      <AppFooter />
    </main>
  );
}
