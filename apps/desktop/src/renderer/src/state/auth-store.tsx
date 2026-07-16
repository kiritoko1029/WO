import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { AuthLoginBody, AuthRegisterBody } from '@wo/protocol';

import type { DesktopApi, PublicAuthSession } from '../../../preload/types.js';

type AuthStatus = 'restoring' | 'anonymous' | 'authenticated';

interface AuthState {
  readonly status: AuthStatus;
  readonly session: PublicAuthSession | null;
  readonly busy: boolean;
  readonly error: string | null;
  register(input: AuthRegisterBody): Promise<boolean>;
  login(input: AuthLoginBody): Promise<boolean>;
  logout(): Promise<boolean>;
  clearError(): void;
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
      return '该邮箱已注册';
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

  const runAuth = useCallback(
    async (operation: () => Promise<PublicAuthSession>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        setSession(next);
        setStatus('authenticated');
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
      register: (input) => runAuth(() => api.auth.register(input)),
      login: (input) => runAuth(() => api.auth.login(input)),
      logout: async () => {
        setBusy(true);
        setError(null);
        try {
          await api.auth.logout();
          setSession(null);
          setStatus('anonymous');
          return true;
        } catch (operationError) {
          setError(authErrorMessage(operationError));
          return false;
        } finally {
          setBusy(false);
        }
      },
      clearError: () => setError(null),
    }),
    [api, busy, error, runAuth, session, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('AuthProvider is missing');
  return value;
}
