import { useState, type FormEvent } from 'react';
import { AudioLines } from 'lucide-react';

import { useAuth } from '../state/auth-store.js';

type AuthMode = 'login' | 'register';

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254;
}

export function AuthRoute() {
  const auth = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setValidationError(null);
    auth.clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
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
    } else {
      await auth.register({
        email: normalizedEmail,
        password,
        displayName: normalizedName,
      });
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-heading">
        <div className="product-lockup">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={22} />
          </span>
          <span>WO</span>
        </div>
        <h1 id="auth-heading">
          {mode === 'login' ? '登录 WO' : '创建 WO 账号'}
        </h1>
        <div className="segmented" role="tablist" aria-label="账号操作">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'active' : undefined}
            onClick={() => switchMode('login')}
          >
            登录账号
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'active' : undefined}
            onClick={() => switchMode('register')}
          >
            注册账号
          </button>
        </div>
        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === 'register' && (
            <label>
              <span>显示名称</span>
              <input
                value={displayName}
                maxLength={100}
                autoComplete="name"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          )}
          <label>
            <span>邮箱</span>
            <input
              type="email"
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
              value={password}
              maxLength={128}
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="form-message" role="alert" aria-live="polite">
            {validationError ?? auth.error}
          </div>
          <button className="primary-button" type="submit" disabled={auth.busy}>
            {auth.busy
              ? mode === 'login'
                ? '正在登录'
                : '正在创建'
              : mode === 'login'
                ? '登录'
                : '创建账号'}
          </button>
        </form>
      </section>
    </main>
  );
}
