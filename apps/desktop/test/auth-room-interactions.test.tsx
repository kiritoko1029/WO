// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi, PublicAuthSession } from '../src/preload/types.js';
import { ConnectionModeSelector } from '../src/renderer/src/components/ConnectionModeSelector.js';
import { AuthRoute } from '../src/renderer/src/routes/AuthRoute.js';
import { HomeRoute } from '../src/renderer/src/routes/HomeRoute.js';
import { AuthProvider, useAuth } from '../src/renderer/src/state/auth-store.js';
import {
  RoomProvider,
  useRoom,
  type RoomGateway,
  type RoomSnapshot,
} from '../src/renderer/src/state/room-store.js';

afterEach(cleanup);

const session: PublicAuthSession = {
  user: {
    userId: 'user-1' as PublicAuthSession['user']['userId'],
    email: 'person@example.cn',
    displayName: '陈晨',
  },
  accessToken: 'access-token',
  accessTokenExpiresAt: Date.now() + 60_000,
};

const credentials = { email: session.user.email, password: 'long-password' };

const waitingRoom: RoomSnapshot = {
  roomId: 'room-1',
  roomCode: '482731',
  role: 'creator',
  connectionStatus: 'waiting',
  participants: [
    { userId: 'user-1', displayName: '陈晨', isSelf: true, online: true },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createApi(): DesktopApi {
  return {
    auth: {
      register: vi.fn().mockResolvedValue({ kind: 'session', session }),
      login: vi.fn().mockResolvedValue(session),
      verifyEmail: vi.fn().mockResolvedValue(session),
      resendVerification: vi
        .fn()
        .mockResolvedValue({ email: session.user.email }),
      changePassword: vi.fn().mockResolvedValue(undefined),
      requestEmailChange: vi
        .fn()
        .mockResolvedValue({ email: 'next@example.cn' }),
      confirmEmailChange: vi.fn().mockResolvedValue(session),
      refresh: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    realtime: { issueTicket: vi.fn() },
    capture: {
      list: vi.fn(),
      select: vi.fn(),
      permission: vi.fn(),
      openSettings: vi.fn(),
    },
  };
}

function createGateway(): RoomGateway {
  return {
    createRoom: vi.fn().mockResolvedValue(waitingRoom),
    joinRoom: vi.fn().mockResolvedValue({ ...waitingRoom, role: 'joiner' }),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    endRoom: vi.fn().mockResolvedValue(undefined),
    subscribe: () => () => undefined,
  };
}

type Auth = ReturnType<typeof useAuth>;

const authOperations = [
  {
    method: 'login',
    start: (auth: Auth) => auth.login(credentials),
    value: session,
  },
  {
    method: 'register',
    start: (auth: Auth) =>
      auth.register({ ...credentials, displayName: '陈晨' }),
    value: { kind: 'session', session },
  },
  {
    method: 'verifyEmail',
    start: (auth: Auth) =>
      auth.verifyEmail({ email: credentials.email, code: '123456' }),
    value: session,
  },
  {
    method: 'resendVerification',
    start: (auth: Auth) =>
      auth.resendVerification({ email: credentials.email }),
    value: { email: credentials.email },
  },
  {
    method: 'changePassword',
    start: (auth: Auth) =>
      auth.changePassword({
        currentPassword: 'long-password',
        newPassword: 'new-long-password',
      }),
    value: undefined,
  },
  {
    method: 'requestEmailChange',
    start: (auth: Auth) =>
      auth.requestEmailChange({
        newEmail: 'next@example.cn',
        password: 'long-password',
      }),
    value: { email: 'next@example.cn' },
  },
  {
    method: 'confirmEmailChange',
    start: (auth: Auth) =>
      auth.confirmEmailChange({ newEmail: 'next@example.cn', code: '123456' }),
    value: session,
  },
  {
    method: 'logout',
    start: (auth: Auth) => auth.logout(),
    value: undefined,
  },
] satisfies readonly {
  method: keyof DesktopApi['auth'];
  start(auth: Auth): Promise<unknown>;
  value: unknown;
}[];

describe('auth operation ownership', () => {
  it.each(authOperations)(
    'ignores overlapping $method and conflicting operations before a rerender',
    async ({ method, start, value }) => {
      const api = createApi();
      const pending = deferred<never>();
      vi.mocked(api.auth[method]).mockReturnValueOnce(pending.promise);
      const { result } = renderHook(useAuth, {
        wrapper: ({ children }) => (
          <AuthProvider api={api}>{children}</AuthProvider>
        ),
      });
      await waitFor(() => expect(result.current.status).toBe('authenticated'));
      const beforeRender = result.current;
      let first!: Promise<unknown>;
      let duplicate!: Promise<unknown>;
      let conflicting!: Promise<unknown>;
      act(() => {
        first = start(beforeRender);
        duplicate = start(beforeRender);
        conflicting =
          method === 'logout'
            ? beforeRender.login(credentials)
            : beforeRender.logout();
      });
      expect(api.auth[method]).toHaveBeenCalledTimes(1);
      expect(
        api.auth[method === 'logout' ? 'login' : 'logout'],
      ).not.toHaveBeenCalled();
      expect(result.current.busy).toBe(true);
      expect(await duplicate).toBeFalsy();
      expect(await conflicting).toBe(false);
      expect(result.current.busy).toBe(true);
      await act(async () => {
        pending.resolve(value as never);
        await first;
      });
      expect(result.current.busy).toBe(false);
    },
  );

  it('releases the guard after a rejected request so a retry can succeed', async () => {
    const api = createApi();
    vi.mocked(api.auth.login).mockRejectedValueOnce({ code: 'NETWORK_ERROR' });
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => (
        <AuthProvider api={api}>{children}</AuthProvider>
      ),
    });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    await act(async () => {
      expect(await result.current.login(credentials)).toBe(false);
    });
    expect(result.current.error).toBe('无法连接服务器，请检查网络');
    await act(async () => {
      expect(await result.current.login(credentials)).toBe(true);
    });
    expect(result.current.error).toBeNull();
    expect(api.auth.login).toHaveBeenCalledTimes(2);
  });
});

describe('auth verification interaction', () => {
  it('opens verification on the first unverified login and resends once while holding the operation', async () => {
    const api = createApi();
    const pendingResend = deferred<{ email: string }>();
    vi.mocked(api.auth.login).mockRejectedValue({ code: 'EMAIL_NOT_VERIFIED' });
    vi.mocked(api.auth.resendVerification).mockReturnValueOnce(
      pendingResend.promise,
    );
    render(
      <AuthProvider api={api}>
        <AuthRoute />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'PERSON@example.cn' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: credentials.password },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(
      await screen.findByRole('heading', { name: '验证邮箱' }),
    ).toBeTruthy();
    expect(api.auth.login).toHaveBeenCalledWith(credentials);
    expect(api.auth.resendVerification).toHaveBeenCalledTimes(1);
    expect(api.auth.resendVerification).toHaveBeenCalledWith({
      email: credentials.email,
    });
    expect(
      (screen.getByRole('button', { name: '返回登录' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    expect(api.auth.resendVerification).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingResend.resolve({ email: credentials.email });
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '完成验证' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('验证码'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: '完成验证' }));
    await waitFor(() =>
      expect(api.auth.verifyEmail).toHaveBeenCalledWith({
        email: credentials.email,
        code: '123456',
      }),
    );
  });

  it('keeps verification available after delivery fails and permits an explicit resend', async () => {
    const api = createApi();
    vi.mocked(api.auth.login).mockRejectedValue({ code: 'EMAIL_NOT_VERIFIED' });
    vi.mocked(api.auth.resendVerification).mockRejectedValueOnce({
      code: 'SERVICE_UNAVAILABLE',
    });
    render(
      <AuthProvider api={api}>
        <AuthRoute />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: credentials.email },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: credentials.password },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('邮件发送失败，请稍后重试')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '验证邮箱' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重新发送验证码' }));
    expect(api.auth.resendVerification).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('邮件发送失败，请稍后重试')).toBeNull();
    await user.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByRole('heading', { name: '登录 WO' })).toBeTruthy();
  });

  it('prevents auth mode changes until a pending login has settled', async () => {
    const api = createApi();
    const user = userEvent.setup();
    const changeConnectionMode = vi.fn();
    const pending = deferred<PublicAuthSession>();
    vi.mocked(api.auth.login).mockReturnValueOnce(pending.promise);
    render(
      <AuthProvider api={api}>
        <AuthRoute
          modeSelector={
            <ConnectionModeSelector
              mode="server"
              onChange={changeConnectionMode}
            />
          }
        />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: credentials.email },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: credentials.password },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    const registerTab = screen.getByRole('tab', {
      name: '注册账号',
    }) as HTMLButtonElement;
    expect(registerTab.disabled).toBe(true);
    fireEvent.click(registerTab);
    await user.click(screen.getByRole('tab', { name: '可信局域网' }));
    expect(changeConnectionMode).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '登录 WO' })).toBeTruthy();
    await act(async () => {
      pending.reject({ code: 'INVALID_CREDENTIALS' });
    });
    expect(registerTab.disabled).toBe(false);
    await user.click(screen.getByRole('tab', { name: '可信局域网' }));
    expect(changeConnectionMode).toHaveBeenCalledExactlyOnceWith('lan');
    fireEvent.click(registerTab);
    expect(screen.getByRole('heading', { name: '创建 WO 账号' })).toBeTruthy();
  });
});

describe('room operation ownership', () => {
  it.each(['create', 'join'] as const)(
    'keeps %s exclusive against same-turn duplicate and conflicting actions, then permits retry',
    async (kind) => {
      const gateway = createGateway();
      const pending = deferred<RoomSnapshot>();
      const method = kind === 'create' ? 'createRoom' : 'joinRoom';
      const otherMethod = kind === 'create' ? 'joinRoom' : 'createRoom';
      vi.mocked(gateway[method]).mockReturnValueOnce(pending.promise);
      const { result } = renderHook(useRoom, {
        wrapper: ({ children }) => (
          <RoomProvider gateway={gateway} accessToken={session.accessToken}>
            {children}
          </RoomProvider>
        ),
      });
      const beforeRender = result.current;
      const start = () =>
        kind === 'create'
          ? beforeRender.createRoom()
          : beforeRender.joinRoom(waitingRoom.roomCode);
      let first!: Promise<boolean>;
      let duplicate!: Promise<boolean>;
      let conflicting!: Promise<boolean>;
      let close!: Promise<boolean>;
      act(() => {
        first = start();
        duplicate = start();
        conflicting =
          kind === 'create'
            ? beforeRender.joinRoom(waitingRoom.roomCode)
            : beforeRender.createRoom();
        close = beforeRender.closeRoom();
      });
      expect(gateway[method]).toHaveBeenCalledTimes(1);
      expect(gateway[otherMethod]).not.toHaveBeenCalled();
      expect(await duplicate).toBe(false);
      expect(await conflicting).toBe(false);
      expect(await close).toBe(false);
      expect(result.current.pendingOperation).toBe(kind);
      expect(result.current.busy).toBe(true);
      await act(async () => {
        pending.reject({ code: 'NETWORK_ERROR' });
        expect(await first).toBe(false);
      });
      expect(result.current.busy).toBe(false);
      expect(result.current.error).toBe('实时服务暂不可用');
      await act(async () => {
        expect(await start()).toBe(true);
      });
      expect(result.current.room?.roomCode).toBe(waitingRoom.roomCode);
      expect(result.current.error).toBeNull();
      expect(gateway[method]).toHaveBeenCalledTimes(2);
    },
  );

  it('sends one room close and keeps its pending state until the gateway settles', async () => {
    const gateway = createGateway();
    const pending = deferred<void>();
    vi.mocked(gateway.endRoom).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useRoom, {
      wrapper: ({ children }) => (
        <RoomProvider gateway={gateway} accessToken={session.accessToken}>
          {children}
        </RoomProvider>
      ),
    });
    await act(async () => {
      await result.current.createRoom();
    });
    const beforeRender = result.current;
    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = beforeRender.closeRoom();
      duplicate = beforeRender.closeRoom();
    });
    expect(await duplicate).toBe(false);
    expect(gateway.endRoom).toHaveBeenCalledTimes(1);
    expect(result.current.pendingOperation).toBe('close');
    await act(async () => {
      pending.resolve();
      await first;
    });
    expect(result.current.room).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it.each(['create', 'join'] as const)(
    'announces only the active %s action on Home',
    async (kind) => {
      const api = createApi();
      const user = userEvent.setup();
      const changeConnectionMode = vi.fn();
      const gateway = createGateway();
      const pending = deferred<RoomSnapshot>();
      vi.mocked(
        gateway[kind === 'create' ? 'createRoom' : 'joinRoom'],
      ).mockReturnValueOnce(pending.promise);
      render(
        <AuthProvider api={api}>
          <RoomProvider gateway={gateway} accessToken={session.accessToken}>
            <HomeRoute
              modeSelector={
                <ConnectionModeSelector
                  mode="server"
                  onChange={changeConnectionMode}
                />
              }
            />
          </RoomProvider>
        </AuthProvider>,
      );
      await screen.findByText(session.user.displayName);
      if (kind === 'join') {
        fireEvent.change(screen.getByLabelText('房间码'), {
          target: { value: waitingRoom.roomCode },
        });
      }
      fireEvent.click(
        screen.getByRole('button', {
          name: kind === 'create' ? '创建房间' : '加入房间',
        }),
      );
      const active = screen.getByRole('button', {
        name: kind === 'create' ? '正在创建' : '正在加入',
      }) as HTMLButtonElement;
      const idle = screen.getByRole('button', {
        name: kind === 'create' ? '加入房间' : '创建房间',
      }) as HTMLButtonElement;
      expect(active.disabled).toBe(true);
      expect(idle.disabled).toBe(true);
      await user.click(screen.getByRole('tab', { name: '可信局域网' }));
      expect(changeConnectionMode).not.toHaveBeenCalled();
      expect(
        (screen.getByRole('button', { name: '退出登录' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await act(async () => {
        pending.reject({ code: 'ROOM_FULL' });
      });
      expect(await screen.findByText('房间已满')).toBeTruthy();
      await user.click(screen.getByRole('tab', { name: '可信局域网' }));
      expect(changeConnectionMode).toHaveBeenCalledExactlyOnceWith('lan');
      expect(
        (screen.getByRole('button', { name: '创建房间' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(
        (screen.getByRole('button', { name: '加入房间' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    },
  );
});
