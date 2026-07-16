// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/renderer/src/App.js';
import type {
  RoomGateway,
  RoomGatewayEvent,
  RoomSnapshot,
} from '../src/renderer/src/state/room-store.js';
import type { DesktopApi, PublicAuthSession } from '../src/preload/types.js';

afterEach(cleanup);

const session: PublicAuthSession = {
  user: {
    userId: 'user-1' as PublicAuthSession['user']['userId'],
    email: 'person@example.cn',
    displayName: '陈晨',
  },
  accessToken: 'access-token',
  accessTokenExpiresAt: Date.now() + 900_000,
};

const waitingRoom: RoomSnapshot = {
  roomId: 'room-1',
  roomCode: '482731',
  role: 'creator',
  connectionStatus: 'waiting',
  participants: [
    { userId: 'user-1', displayName: '陈晨', isSelf: true, online: true },
  ],
};

function createDesktop(
  restored: PublicAuthSession | null = null,
): DesktopApi & {
  auth: DesktopApi['auth'] & {
    register: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
} {
  return {
    auth: {
      register: vi.fn().mockResolvedValue(session),
      login: vi.fn().mockResolvedValue(session),
      refresh:
        restored === null
          ? vi
              .fn()
              .mockRejectedValue(
                Object.assign(new Error('auth'), { code: 'AUTH_REQUIRED' }),
              )
          : vi.fn().mockResolvedValue(restored),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    realtime: { issueTicket: vi.fn() },
  };
}

function createRoomGateway(): RoomGateway & {
  createRoom: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  leaveRoom: ReturnType<typeof vi.fn>;
  endRoom: ReturnType<typeof vi.fn>;
  emit(event: RoomGatewayEvent): void;
} {
  const listeners = new Set<(event: RoomGatewayEvent) => void>();
  return {
    createRoom: vi.fn().mockResolvedValue(waitingRoom),
    joinRoom: vi.fn().mockResolvedValue({
      ...waitingRoom,
      role: 'joiner',
      connectionStatus: 'connected',
      participants: [
        waitingRoom.participants[0],
        {
          userId: 'user-2',
          displayName: '林远',
          isSelf: false,
          online: true,
        },
      ],
    }),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    endRoom: vi.fn().mockResolvedValue(undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function waitForAuthScreen(): Promise<void> {
  await screen.findByRole('heading', { name: '登录 WO' });
}

async function waitForHome(): Promise<void> {
  await screen.findByRole('heading', { name: '开始通话' });
}

describe('desktop account and room workflow', () => {
  it('validates login, shows loading, and reports a login error', async () => {
    const user = userEvent.setup();
    const desktop = createDesktop();
    let rejectLogin: ((error: Error) => void) | undefined;
    desktop.auth.login.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLogin = reject;
      }),
    );
    render(<App desktop={desktop} roomGateway={createRoomGateway()} />);
    await waitForAuthScreen();

    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByText('请输入有效的邮箱地址')).toBeTruthy();
    await user.type(screen.getByLabelText('邮箱'), 'person@example.cn');
    await user.type(screen.getByLabelText('密码'), 'long-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(
      (screen.getByRole('button', { name: '正在登录' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rejectLogin?.(
      Object.assign(new Error('invalid'), { code: 'INVALID_CREDENTIALS' }),
    );
    expect(await screen.findByText('邮箱或密码不正确')).toBeTruthy();
  });

  it.each([
    ['INVALID_CREDENTIALS', '邮箱或密码不正确'],
    ['RATE_LIMITED', '操作过于频繁，请稍后再试'],
    ['NETWORK_ERROR', '无法连接服务器，请检查网络'],
  ])(
    'maps serialized auth code %s to a recoverable UI error',
    async (code, message) => {
      const user = userEvent.setup();
      const desktop = createDesktop();
      desktop.auth.login.mockRejectedValue(
        Object.assign(new Error('safe IPC error'), { code }),
      );
      render(<App desktop={desktop} roomGateway={createRoomGateway()} />);
      await waitForAuthScreen();

      await user.type(screen.getByLabelText('邮箱'), 'person@example.cn');
      await user.type(screen.getByLabelText('密码'), 'long-password');
      await user.click(screen.getByRole('button', { name: '登录' }));

      expect(await screen.findByText(message)).toBeTruthy();
    },
  );

  it('registers with display-name validation and opens the home surface', async () => {
    const user = userEvent.setup();
    const desktop = createDesktop();
    render(<App desktop={desktop} roomGateway={createRoomGateway()} />);
    await waitForAuthScreen();

    await user.click(screen.getByRole('tab', { name: '注册账号' }));
    await user.type(screen.getByLabelText('邮箱'), 'new@example.cn');
    await user.type(screen.getByLabelText('密码'), 'long-password');
    await user.click(screen.getByRole('button', { name: '创建账号' }));
    expect(screen.getByText('请输入显示名称')).toBeTruthy();

    await user.type(screen.getByLabelText('显示名称'), '新用户');
    await user.click(screen.getByRole('button', { name: '创建账号' }));

    await waitForHome();
    expect(desktop.auth.register).toHaveBeenCalledWith({
      email: 'new@example.cn',
      password: 'long-password',
      displayName: '新用户',
    });
  });

  it('creates a room, shows the waiting state, and keeps two participant slots', async () => {
    const user = userEvent.setup();
    const desktop = createDesktop(session);
    const gateway = createRoomGateway();
    render(<App desktop={desktop} roomGateway={gateway} />);
    await waitForHome();

    await user.click(screen.getByRole('button', { name: '创建房间' }));

    expect(await screen.findByText('等待对方加入')).toBeTruthy();
    expect(screen.getByText('482731')).toBeTruthy();
    expect(screen.getAllByTestId('participant-slot')).toHaveLength(2);
    expect(screen.getByText('陈晨（我）')).toBeTruthy();
    expect(screen.getByText('等待加入')).toBeTruthy();
    expect(gateway.createRoom).toHaveBeenCalledWith('access-token');
  });

  it('accepts only a six-digit room code and joins a connected room', async () => {
    const user = userEvent.setup();
    const desktop = createDesktop(session);
    const gateway = createRoomGateway();
    render(<App desktop={desktop} roomGateway={gateway} />);
    await waitForHome();

    const input = screen.getByLabelText('房间码');
    await user.type(input, '12a34567');
    expect((input as HTMLInputElement).value).toBe('123456');
    await user.click(screen.getByRole('button', { name: '加入房间' }));

    expect(await screen.findByText('语音已连接')).toBeTruthy();
    expect(gateway.joinRoom).toHaveBeenCalledWith('access-token', '123456');
    expect(screen.getAllByTestId('participant-slot')).toHaveLength(2);
    expect(screen.getByText('林远')).toBeTruthy();
  });

  it.each([
    ['ROOM_FULL', '房间已满'],
    ['ROOM_CODE_EXPIRED', '房间码已过期'],
    ['ROOM_CODE_INVALID', '房间码无效'],
  ])('shows a recoverable join error for %s', async (code, message) => {
    const user = userEvent.setup();
    const gateway = createRoomGateway();
    gateway.joinRoom.mockRejectedValue(
      Object.assign(new Error('join'), { code }),
    );
    render(<App desktop={createDesktop(session)} roomGateway={gateway} />);
    await waitForHome();

    await user.type(screen.getByLabelText('房间码'), '123456');
    await user.click(screen.getByRole('button', { name: '加入房间' }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '开始通话' })).toBeTruthy();
  });

  it('returns home when the server closes the current room', async () => {
    const user = userEvent.setup();
    const gateway = createRoomGateway();
    render(<App desktop={createDesktop(session)} roomGateway={gateway} />);
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await screen.findByText('等待对方加入');

    gateway.emit({ type: 'closed', roomId: 'room-1' });

    await waitForHome();
    expect(screen.getByText('房间已关闭')).toBeTruthy();
  });

  it('hangs up through the creator end command and returns home', async () => {
    const user = userEvent.setup();
    const gateway = createRoomGateway();
    render(<App desktop={createDesktop(session)} roomGateway={gateway} />);
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await screen.findByText('等待对方加入');

    await user.click(screen.getByRole('button', { name: '挂断' }));

    await waitForHome();
    expect(gateway.endRoom).toHaveBeenCalledWith('room-1');
  });

  it('logs out locally and returns to auth', async () => {
    const user = userEvent.setup();
    const desktop = createDesktop(session);
    render(<App desktop={desktop} roomGateway={createRoomGateway()} />);
    await waitForHome();

    await user.click(screen.getByRole('button', { name: '退出登录' }));

    await waitForAuthScreen();
    expect(desktop.auth.logout).toHaveBeenCalledOnce();
  });
});
