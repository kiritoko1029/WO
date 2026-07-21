import { useState, type FormEvent } from 'react';

import { useAuth } from '../state/auth-store.js';

type PanelMode = 'menu' | 'password' | 'email-request' | 'email-confirm';

export function AccountSecurityPanel() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PanelMode>('menu');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (auth.session === null) return null;

  const reset = () => {
    setMode('menu');
    setCurrentPassword('');
    setNewPassword('');
    setPasswordConfirm('');
    setEmailPassword('');
    setNewEmail('');
    setEmailCode('');
    setPendingEmail(null);
    setLocalError(null);
    setSuccess(null);
    auth.clearError();
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 10 || newPassword.length > 128) {
      setLocalError('新密码需为 10 到 128 个字符');
      return;
    }
    if (newPassword !== passwordConfirm) {
      setLocalError('两次输入的新密码不一致');
      return;
    }
    setLocalError(null);
    const ok = await auth.changePassword({
      currentPassword,
      newPassword,
    });
    if (ok) {
      setSuccess('密码已更新');
      setMode('menu');
      setCurrentPassword('');
      setNewPassword('');
      setPasswordConfirm('');
    }
  };

  const submitEmailRequest = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = newEmail.trim().toLowerCase();
    if (!normalized.includes('@')) {
      setLocalError('请输入有效邮箱');
      return;
    }
    setLocalError(null);
    const email = await auth.requestEmailChange({
      newEmail: normalized,
      password: emailPassword,
    });
    if (email !== null) {
      setPendingEmail(email);
      setMode('email-confirm');
      setSuccess('验证码已发送到新邮箱');
    }
  };

  const submitEmailConfirm = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingEmail === null || !/^\d{6}$/u.test(emailCode.trim())) {
      setLocalError('请输入 6 位验证码');
      return;
    }
    setLocalError(null);
    const ok = await auth.confirmEmailChange({
      newEmail: pendingEmail,
      code: emailCode.trim(),
    });
    if (ok) {
      setSuccess('邮箱已更新');
      reset();
      setSuccess('邮箱已更新');
    }
  };

  return (
    <div className="account-security">
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setOpen((value) => !value);
          if (open) reset();
        }}
      >
        账号安全
      </button>
      {open && (
        <div className="account-security-panel" role="dialog" aria-label="账号安全">
          <header>
            <strong>账号安全</strong>
            <button type="button" onClick={() => { setOpen(false); reset(); }}>
              关闭
            </button>
          </header>
          <p className="account-security-email">{auth.session.user.email}</p>
          {(localError ?? auth.error ?? success) !== null && (
            <div className="form-message" role="status">
              {localError ?? auth.error ?? success}
            </div>
          )}
          {mode === 'menu' && (
            <div className="account-security-actions">
              <button type="button" onClick={() => setMode('password')}>
                修改密码
              </button>
              <button type="button" onClick={() => setMode('email-request')}>
                换绑邮箱
              </button>
            </div>
          )}
          {mode === 'password' && (
            <form className="auth-form" onSubmit={(event) => void submitPassword(event)}>
              <label>
                <span>当前密码</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
              <label>
                <span>新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label>
                <span>确认新密码</span>
                <input
                  type="password"
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit" disabled={auth.busy}>
                保存密码
              </button>
              <button type="button" className="secondary-button" onClick={() => setMode('menu')}>
                返回
              </button>
            </form>
          )}
          {mode === 'email-request' && (
            <form
              className="auth-form"
              onSubmit={(event) => void submitEmailRequest(event)}
            >
              <label>
                <span>当前密码</span>
                <input
                  type="password"
                  value={emailPassword}
                  onChange={(event) => setEmailPassword(event.target.value)}
                />
              </label>
              <label>
                <span>新邮箱</span>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit" disabled={auth.busy}>
                发送验证码
              </button>
              <button type="button" className="secondary-button" onClick={() => setMode('menu')}>
                返回
              </button>
            </form>
          )}
          {mode === 'email-confirm' && (
            <form
              className="auth-form"
              onSubmit={(event) => void submitEmailConfirm(event)}
            >
              <p className="auth-hint">
                验证码已发送至 <strong>{pendingEmail}</strong>
              </p>
              <label>
                <span>验证码</span>
                <input
                  value={emailCode}
                  maxLength={6}
                  inputMode="numeric"
                  onChange={(event) => setEmailCode(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit" disabled={auth.busy}>
                确认换绑
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setMode('email-request')}
              >
                返回
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
