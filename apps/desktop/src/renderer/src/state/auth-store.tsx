import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  AuthChangePasswordBody,
  AuthConfirmEmailChangeBody,
  AuthLoginBody,
  AuthRegisterBody,
  AuthRequestEmailChangeBody,
  AuthResendVerificationBody,
  AuthVerifyEmailBody,
} from '@wo/protocol';

import type {
  AuthRegisterResult,
  DesktopApi,
  PublicAuthSession,
} from '../../../preload/types.js';

type AuthStatus = 'restoring' | 'anonymous' | 'authenticated';

interface AuthState {
  readonly status: AuthStatus;
  readonly session: PublicAuthSession | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly pendingVerificationEmail: string | null;
  register(input: AuthRegisterBody): Promise<AuthRegisterResult | null>;
  login(input: AuthLoginBody): Promise<boolean>;
  verifyEmail(input: AuthVerifyEmailBody): Promise<boolean>;
  resendVerification(input: AuthResendVerificationBody): Promise<boolean>;
  changePassword(input: AuthChangePasswordBody): Promise<boolean>;
  requestEmailChange(input: AuthRequestEmailChangeBody): Promise<string | null>;
  confirmEmailChange(input: AuthConfirmEmailChangeBody): Promise<boolean>;
  logout(): Promise<boolean>;
  clearError(): void;
  clearPendingVerification(): void;
}

const AuthContext = createContext<AuthState | null>(null);

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

function authErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'INVALID_CREDENTIALS':
      return '邮箱或密码不正确';
    case 'INVALID_STATE':
      return '该邮箱不可用或已注册';
    case 'EMAIL_DOMAIN_NOT_ALLOWED':
      return '该邮箱域名不在白名单内';
    case 'EMAIL_NOT_VERIFIED':
      return '请先完成邮箱验证';
    case 'INVALID_VERIFICATION_CODE':
      return '验证码无效或已过期';
    case 'SERVICE_UNAVAILABLE':
      return '邮件发送失败，请稍后重试';
    case 'RATE_LIMITED':
      return '操作过于频繁，请稍后再试';
    case 'NETWORK_ERROR':
    case 'REQUEST_TIMEOUT':
      return '无法连接服务器，请检查网络';
    default:
      return '操作失败，请重试';
  }
}

export function AuthProvider({
  api,
  children,
}: {
  readonly api: DesktopApi;
  readonly children: ReactNode;
}) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [session, setSession] = useState<PublicAuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<
    string | null
  >(null);

  useEffect(() => {
    let active = true;
    void api.auth.refresh().then(
      (restored) => {
        if (!active) return;
        setSession(restored);
        setStatus('authenticated');
      },
      () => {
        if (!active) return;
        setSession(null);
        setStatus('anonymous');
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const runSession = useCallback(
    async (operation: () => Promise<PublicAuthSession>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        setSession(next);
        setStatus('authenticated');
        setPendingVerificationEmail(null);
        return true;
      } catch (operationError) {
        setError(authErrorMessage(operationError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      busy,
      error,
      pendingVerificationEmail,
      register: async (input) => {
        setBusy(true);
        setError(null);
        try {
          const result = await api.auth.register(input);
          if (result.kind === 'session') {
            setSession(result.session);
            setStatus('authenticated');
            setPendingVerificationEmail(null);
          } else {
            setPendingVerificationEmail(result.email);
          }
          return result;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return null;
        } finally {
          setBusy(false);
        }
      },
      login: (input) => runSession(() => api.auth.login(input)),
      verifyEmail: (input) => runSession(() => api.auth.verifyEmail(input)),
      resendVerification: async (input) => {
        setBusy(true);
        setError(null);
        try {
          const result = await api.auth.resendVerification(input);
          setPendingVerificationEmail(result.email);
          return true;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return false;
        } finally {
          setBusy(false);
        }
      },
      changePassword: async (input) => {
        setBusy(true);
        setError(null);
        try {
          await api.auth.changePassword(input);
          return true;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return false;
        } finally {
          setBusy(false);
        }
      },
      requestEmailChange: async (input) => {
        setBusy(true);
        setError(null);
        try {
          const result = await api.auth.requestEmailChange(input);
          return result.email;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return null;
        } finally {
          setBusy(false);
        }
      },
      confirmEmailChange: (input) =>
        runSession(() => api.auth.confirmEmailChange(input)),
      logout: async () => {
        setBusy(true);
        setError(null);
        try {
          await api.auth.logout();
          setSession(null);
          setStatus('anonymous');
          setPendingVerificationEmail(null);
          return true;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return false;
        } finally {
          setBusy(false);
        }
      },
      clearError: () => setError(null),
      clearPendingVerification: () => setPendingVerificationEmail(null),
    }),
    [api, busy, error, pendingVerificationEmail, runSession, session, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}
