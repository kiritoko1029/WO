// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://wo.example.cn/"}

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanJoinIntent } from '@wo/protocol';

import { App } from '../src/renderer/src/App.js';
import type {
  CallController,
  CallSnapshot,
  RealtimeRoomGateway,
} from '../src/renderer/src/state/call-store.js';
import type {
  RoomGateway,
  RoomGatewayEvent,
  RoomSnapshot,
} from '../src/renderer/src/state/room-store.js';
import type {
  DesktopApi,
  DesktopShellBridge,
  PublicAuthSession,
} from '../src/preload/types.js';
import type {
  DesktopLanApi,
  LanSessionSnapshot,
} from '../src/preload/lan-types.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'woClipboard');
  Reflect.deleteProperty(window, 'woShell');
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

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

const lanIntent: LanJoinIntent = {
  version: 1,
  mode: 'lan',
  endpoint: 'ws://192.168.1.24:43120/v1/realtime',
  roomCode: waitingRoom.roomCode,
  inviteKey: 'A'.repeat(43),
};

const idleScreenSnapshot = {
  screenState: 'idle' as const,
  screenSources: [],
  screenSelectedToken: null,
  screenSystemAudioEnabled: false,
  screenCaptureSettings: null,
  screenError: null,
  screenPermissionError: false,
  screenOwner: null,
  screenOwnerLeaseId: null,
  localScreenTrack: null,
  remoteScreenTrack: null,
  screenBitrateTarget: {
    mode: 'fixed' as const,
    bitrateBps: 10_000_000,
  },
  screenBitratePending: null,
  screenBitrateError: null,
  remoteScreenBitrateBps: null,
  screenPermission: null,
  quality: null,
};

function createDesktop(
  restored: PublicAuthSession | null = null,
): DesktopApi & {
  auth: DesktopApi['auth'] & {
    register: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    verifyEmail: ReturnType<typeof vi.fn>;
    resendVerification: ReturnType<typeof vi.fn>;
    changePassword: ReturnType<typeof vi.fn>;
    requestEmailChange: ReturnType<typeof vi.fn>;
    confirmEmailChange: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
} {
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
        .mockResolvedValue({ email: session.user.email }),
      confirmEmailChange: vi.fn().mockResolvedValue(session),
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
    capture: {
      list: vi.fn().mockResolvedValue([]),
      select: vi.fn().mockResolvedValue(undefined),
      permission: vi.fn().mockResolvedValue({
        status: 'granted',
        canOpenSettings: false,
        systemAudioMode: 'loopback',
        captureProcessElevated: false,
      }),
      openSettings: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createShellBridge(
  origin = 'https://wo.example.cn',
): DesktopShellBridge {
  return {
    backendTarget: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        value: { origin, source: 'stored', readOnly: false },
      }),
      save: vi.fn().mockResolvedValue({ ok: true, value: null }),
    },
    joinIntent: {
      consume: vi.fn().mockResolvedValue({ ok: true, value: null }),
      switchServer: vi.fn().mockResolvedValue({ ok: true, value: null }),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

function createLanApi() {
  const snapshot = (
    role: LanSessionSnapshot['role'],
    displayName: string,
    intent: LanJoinIntent,
  ): LanSessionSnapshot => ({
    role,
    user: {
      userId: (role === 'host'
        ? '00000000-0000-4000-8000-000000000011'
        : '00000000-0000-4000-8000-000000000012') as LanSessionSnapshot['user']['userId'],
      email: `${role}@lan.invalid`,
      displayName,
    },
    accessToken: `lan:${role}`,
    accessTokenExpiresAt: Date.now() + 900_000,
    joinIntent: intent,
  });
  const api = {
    host: vi.fn((displayName: string) =>
      Promise.resolve(snapshot('host', displayName, lanIntent)),
    ),
    join: vi.fn((displayName: string, intent: LanJoinIntent) =>
      Promise.resolve(snapshot('guest', displayName, intent)),
    ),
    parseInvite: vi.fn().mockResolvedValue(lanIntent),
    issueTicket: vi.fn().mockResolvedValue({
      endpoint: lanIntent.endpoint,
      ticket: 'B'.repeat(43),
      expiresInSeconds: 30,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    socket: {
      open: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => () => undefined),
    },
  } satisfies DesktopLanApi;
  return api;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function notifyingShellBridge() {
  const bridge = createShellBridge();
  let notify = (): void => undefined;
  vi.mocked(bridge.joinIntent.subscribe).mockImplementation((listener) => {
    notify = listener;
    return () => undefined;
  });
  return { bridge, notify: () => notify() };
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
  it('shows the active backend target before login and on the home screen', async () => {
    const bridge = {
      backendTarget: {
        get: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            origin: 'https://wo.example.cn',
            source: 'stored',
            readOnly: false,
          },
        }),
        save: vi.fn().mockResolvedValue({ ok: true, value: null }),
      },
      joinIntent: {
        consume: vi.fn().mockResolvedValue({ ok: true, value: null }),
        switchServer: vi.fn().mockResolvedValue({ ok: true, value: null }),
        subscribe: vi.fn(() => () => undefined),
      },
    } satisfies DesktopShellBridge;
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });

    render(<App desktop={createDesktop()} roomGateway={createRoomGateway()} />);
    await waitForAuthScreen();
    expect(await screen.findByText('https://wo.example.cn')).toBeTruthy();

    cleanup();
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
      />,
    );
    await waitForHome();
    expect(await screen.findByText('https://wo.example.cn')).toBeTruthy();
  });

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
      (screen.getByRole('button', { name: '处理中…' }) as HTMLButtonElement)
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
    expect(screen.getAllByTestId('participant-slot')).toHaveLength(1);
    expect(screen.getByText('陈晨（我）')).toBeTruthy();
    expect(screen.getByText('等待加入…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开系统设置' })).toBeNull();
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
    expect(
      screen.getAllByTestId('participant-slot').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('林远')).toBeTruthy();
  });

  it('joins an injected same-server intent once after session restore', async () => {
    const gateway = createRoomGateway();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: createShellBridge(),
    });

    render(
      <StrictMode>
        <App
          desktop={createDesktop(session)}
          roomGateway={gateway}
          initialJoinIntent={{
            version: 1,
            mode: 'server',
            serverOrigin: 'https://wo.example.cn',
            roomCode: '123456',
          }}
        />
      </StrictMode>,
    );

    await screen.findByText('语音已连接');
    expect(gateway.joinRoom).toHaveBeenCalledOnce();
    expect(gateway.joinRoom).toHaveBeenCalledWith('access-token', '123456');
  });

  it('does not lose a cold-start shell intent under StrictMode', async () => {
    const intent = {
      version: 1 as const,
      mode: 'server' as const,
      serverOrigin: 'https://wo.example.cn',
      roomCode: '123456',
    };
    const bridge = createShellBridge();
    vi.mocked(bridge.joinIntent.consume).mockResolvedValue({
      ok: true,
      value: intent,
    });
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });
    const gateway = createRoomGateway();

    render(
      <StrictMode>
        <App desktop={createDesktop(session)} roomGateway={gateway} />
      </StrictMode>,
    );

    await screen.findByText('语音已连接');
    expect(bridge.joinIntent.consume).toHaveBeenCalledOnce();
    expect(gateway.joinRoom).toHaveBeenCalledOnce();
    expect(gateway.joinRoom).toHaveBeenCalledWith('access-token', '123456');
  });

  it('waits for an explicit Web choice before joining an injected room', async () => {
    const user = userEvent.setup();
    const gateway = createRoomGateway();
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={gateway}
        initialJoinIntent={{
          version: 1,
          mode: 'server',
          serverOrigin: 'https://wo.example.cn',
          roomCode: '123456',
        }}
      />,
    );

    await waitForHome();
    expect(gateway.joinRoom).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole('link', {
          name: '在 WO 客户端打开',
        }) as HTMLAnchorElement
      ).getAttribute('href'),
    ).toBe(
      'wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.cn&room=123456',
    );

    await user.click(screen.getByRole('button', { name: '继续网页版' }));

    await waitFor(() => expect(gateway.joinRoom).toHaveBeenCalledOnce());
  });

  it('requires confirmation before switching a deep link to another server', async () => {
    const user = userEvent.setup();
    const bridge = createShellBridge();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });
    const rendered = render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
        initialJoinIntent={{
          version: 1,
          mode: 'server',
          serverOrigin: 'https://other.example.cn',
          roomCode: '123456',
        }}
      />,
    );

    expect(
      await screen.findByRole('heading', {
        name: '切换服务后加入房间？',
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(bridge.joinIntent.switchServer).not.toHaveBeenCalled();

    rendered.unmount();
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
        initialJoinIntent={{
          version: 1,
          mode: 'server',
          serverOrigin: 'https://other.example.cn',
          roomCode: '123456',
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '切换并重启' }));

    expect(bridge.joinIntent.switchServer).toHaveBeenCalledWith({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://other.example.cn',
      roomCode: '123456',
    });
  });

  it('creates a trusted-LAN host room and shares only the keyed client invite', async () => {
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    const lan = createLanApi();
    const gateway = createRoomGateway();
    render(
      <App
        desktop={createDesktop(session)}
        lanApi={lan}
        roomGateway={gateway}
      />,
    );
    await waitForHome();

    await user.click(screen.getByRole('tab', { name: '可信局域网' }));
    await user.type(screen.getByLabelText('显示名称'), '房主');
    await user.click(screen.getByRole('button', { name: '创建局域网房间' }));

    expect(await screen.findByText('等待对方加入')).toBeTruthy();
    expect(screen.getByText('可信局域网')).toBeTruthy();
    expect(screen.getByText('192.168.1.24:43120')).toBeTruthy();
    expect(lan.host).toHaveBeenCalledWith('房主');
    expect(gateway.createRoom).toHaveBeenCalledWith('lan:host');
    await user.click(screen.getByRole('button', { name: '分享房间' }));
    expect(screen.queryByRole('button', { name: '复制网页链接' })).toBeNull();
    expect(
      screen.getByText('邀请包含访问密钥，仅发送给可信设备。'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '复制客户端链接' }));
    expect(clipboard.writeText).toHaveBeenCalledWith(
      `wo://join?v=1&mode=lan&endpoint=${encodeURIComponent(
        lanIntent.endpoint,
      )}&room=${lanIntent.roomCode}&key=${lanIntent.inviteKey}`,
    );
  });

  it('joins a trusted-LAN room from a keyed deep link', async () => {
    const user = userEvent.setup();
    const lan = createLanApi();
    const gateway = createRoomGateway();
    render(
      <App
        desktop={createDesktop(session)}
        lanApi={lan}
        roomGateway={gateway}
        initialJoinIntent={lanIntent}
      />,
    );

    await user.type(screen.getByLabelText('显示名称'), '访客');
    await user.click(screen.getByRole('button', { name: '加入局域网房间' }));

    expect(await screen.findByText('语音已连接')).toBeTruthy();
    expect(lan.join).toHaveBeenCalledWith('访客', lanIntent);
    expect(gateway.joinRoom).toHaveBeenCalledWith(
      'lan:guest',
      lanIntent.roomCode,
    );
  });

  it('stops the active LAN session before showing a server deep link', async () => {
    const user = userEvent.setup();
    const lan = createLanApi();
    const gateway = createRoomGateway();
    const { bridge, notify } = notifyingShellBridge();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });
    render(
      <App
        desktop={createDesktop(session)}
        lanApi={lan}
        roomGateway={gateway}
        initialJoinIntent={lanIntent}
      />,
    );
    await user.type(screen.getByLabelText('显示名称'), '访客');
    await user.click(screen.getByRole('button', { name: '加入局域网房间' }));
    await screen.findByText('语音已连接');
    await waitFor(() =>
      expect(bridge.joinIntent.consume).toHaveBeenCalledOnce(),
    );

    const stopped = deferred();
    lan.stop.mockReturnValueOnce(stopped.promise);
    vi.mocked(bridge.joinIntent.consume).mockResolvedValueOnce({
      ok: true,
      value: {
        version: 1,
        mode: 'server',
        serverOrigin: 'https://other.example.cn',
        roomCode: '123456',
      },
    });
    notify();

    await waitFor(() => expect(lan.stop).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole('heading', { name: '切换服务后加入房间？' }),
    ).toBeNull();
    stopped.resolve();
    expect(
      await screen.findByRole('heading', {
        name: '切换服务后加入房间？',
      }),
    ).toBeTruthy();
  });

  it('stops the current LAN session before showing a replacement LAN invite', async () => {
    const user = userEvent.setup();
    const lan = createLanApi();
    const gateway = createRoomGateway();
    const { bridge, notify } = notifyingShellBridge();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });
    render(
      <App
        desktop={createDesktop(session)}
        lanApi={lan}
        roomGateway={gateway}
        initialJoinIntent={lanIntent}
      />,
    );
    await user.type(screen.getByLabelText('显示名称'), '访客');
    await user.click(screen.getByRole('button', { name: '加入局域网房间' }));
    await screen.findByText('语音已连接');
    await waitFor(() =>
      expect(bridge.joinIntent.consume).toHaveBeenCalledOnce(),
    );

    const replacement: LanJoinIntent = {
      ...lanIntent,
      roomCode: '654321',
      inviteKey: 'C'.repeat(43),
    };
    const stopped = deferred();
    lan.stop.mockReturnValueOnce(stopped.promise);
    vi.mocked(bridge.joinIntent.consume).mockResolvedValueOnce({
      ok: true,
      value: replacement,
    });
    notify();

    await waitFor(() => expect(lan.stop).toHaveBeenCalledOnce());
    expect(screen.queryByText('房间 654321')).toBeNull();
    stopped.resolve();
    expect(await screen.findByText(/房间 654321/u)).toBeTruthy();
    expect(lan.join).toHaveBeenCalledOnce();
  });

  it('offers a retry when the shell backend target cannot be read', async () => {
    const user = userEvent.setup();
    const bridge = createShellBridge();
    vi.mocked(bridge.backendTarget.get)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'IPC_UNAVAILABLE',
          message: 'Desktop service is unavailable',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          origin: 'https://wo.example.cn',
          source: 'stored',
          readOnly: false,
        },
      });
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });

    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
      />,
    );

    expect(await screen.findByText('无法读取当前服务地址')).toBeTruthy();
    const callsBeforeRetry = vi.mocked(bridge.backendTarget.get).mock.calls
      .length;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(screen.queryByText('无法读取当前服务地址')).toBeNull(),
    );
    expect(
      vi.mocked(bridge.backendTarget.get).mock.calls.length,
    ).toBeGreaterThan(callsBeforeRetry);
  });

  it('copies share links with a local-page fallback and reports failures', async () => {
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const gateway = createRoomGateway();
    render(<App desktop={createDesktop(session)} roomGateway={gateway} />);
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await user.click(await screen.findByRole('button', { name: '分享房间' }));

    const shareMenu = document.querySelector('.room-share-menu');
    expect(shareMenu).toBeTruthy();
    expect(document.querySelector('.room-header')).toBeTruthy();
    expect(document.querySelector('.call-workspace')).toBeTruthy();
    expect(document.querySelector('.room-share-error')).toBeNull();

    await user.click(screen.getByRole('button', { name: '复制网页链接' }));
    await user.click(screen.getByRole('button', { name: '复制客户端链接' }));
    expect(clipboard.writeText.mock.calls).toEqual([
      ['https://wo.example.cn/join/482731'],
      [
        'wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.cn&room=482731',
      ],
    ]);

    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: '复制网页链接' }));
    expect(
      await screen.findByText('复制失败，请允许剪贴板权限后重试'),
    ).toBeTruthy();
    expect(document.querySelector('.room-share-error')).toBeTruthy();

    Reflect.deleteProperty(navigator, 'clipboard');
    execCommand.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: '复制客户端链接' }));
    expect(execCommand).toHaveBeenLastCalledWith('copy');
    expect(
      screen.getByRole('button', { name: '已复制客户端链接' }),
    ).toBeTruthy();
  });

  it('uses the desktop clipboard bridge when the Web API is unavailable', async () => {
    const user = userEvent.setup();
    const desktopClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    const browserClipboard = {
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    };
    Object.defineProperty(window, 'woClipboard', {
      configurable: true,
      value: desktopClipboard,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: browserClipboard,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
      />,
    );
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await user.click(await screen.findByRole('button', { name: '分享房间' }));

    await user.click(screen.getByRole('button', { name: '复制网页链接' }));

    expect(desktopClipboard.writeText).toHaveBeenCalledWith(
      'https://wo.example.cn/join/482731',
    );
    expect(browserClipboard.writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '已复制网页链接' })).toBeTruthy();
  });

  it('falls back to the Web Clipboard API when the desktop bridge rejects', async () => {
    const user = userEvent.setup();
    const desktopClipboard = {
      writeText: vi.fn().mockRejectedValue(new Error('unavailable')),
    };
    const browserClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'woClipboard', {
      configurable: true,
      value: desktopClipboard,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: browserClipboard,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={createRoomGateway()}
      />,
    );
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await user.click(await screen.findByRole('button', { name: '分享房间' }));

    await user.click(screen.getByRole('button', { name: '复制网页链接' }));

    expect(desktopClipboard.writeText).toHaveBeenCalledWith(
      'https://wo.example.cn/join/482731',
    );
    expect(browserClipboard.writeText).toHaveBeenCalledWith(
      'https://wo.example.cn/join/482731',
    );
    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '已复制网页链接' })).toBeTruthy();
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

    gateway.emit({ type: 'closed', roomId: 'room-1', reason: 'ended' });

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

  it('leaves LAN locally when the vanished host makes close fail', async () => {
    const user = userEvent.setup();
    const lan = createLanApi();
    const gateway = createRoomGateway();
    gateway.leaveRoom.mockRejectedValue(
      Object.assign(new Error('host vanished'), {
        code: 'SIGNALING_UNAVAILABLE',
      }),
    );
    render(
      <App
        desktop={createDesktop(session)}
        lanApi={lan}
        roomGateway={gateway}
        initialJoinIntent={lanIntent}
      />,
    );
    await user.type(screen.getByLabelText('显示名称'), '访客');
    await user.click(screen.getByRole('button', { name: '加入局域网房间' }));
    await screen.findByText('语音已连接');

    await user.click(screen.getByRole('button', { name: '挂断' }));

    expect(
      await screen.findByRole('heading', { name: '局域网轻量房间' }),
    ).toBeTruthy();
    expect(lan.stop).toHaveBeenCalledOnce();
  });

  it('keeps a center room open when the end command fails', async () => {
    const user = userEvent.setup();
    const gateway = createRoomGateway();
    gateway.endRoom.mockRejectedValue(new Error('server unavailable'));
    render(<App desktop={createDesktop(session)} roomGateway={gateway} />);
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await screen.findByText('等待对方加入');

    await user.click(screen.getByRole('button', { name: '挂断' }));

    expect(await screen.findByText('房间操作失败，请重试')).toBeTruthy();
    expect(screen.getByRole('button', { name: '挂断' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '开始通话' })).toBeNull();
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

  it('wires real call settings, mute, output mute and ordered hangup controls', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    let cleanupPromise: Promise<void> | null = null;
    let callSnapshot: CallSnapshot = {
      status: 'connected' as const,
      error: null,
      muted: false,
      outputMuted: false,
      remoteVolume: 1,
      microphoneVolume: 1,
      inputs: [
        { deviceId: 'mic-1', label: '内置麦克风' },
        { deviceId: 'mic-2', label: 'USB 麦克风' },
      ],
      outputs: [{ deviceId: 'speaker-1', label: '内置扬声器' }],
      selectedInputId: 'mic-1',
      selectedOutputId: 'speaker-1',
      supportsOutputSelection: true,
      microphoneRetryAvailable: false,
      noiseIntensity: 'off' as const,
      rnnoiseActive: false,
      localAudioLevel: 0,
      remoteAudioLevel: 0,
      ...idleScreenSnapshot,
      screenError: '需要在系统设置中允许屏幕录制',
      screenPermissionError: true,
      screenPermission: {
        status: 'denied' as const,
        canOpenSettings: true,
        systemAudioMode: 'unsupported' as const,
        captureProcessElevated: false,
      },
    };
    const callListeners = new Set<() => void>();
    const call = {
      getSnapshot: () => callSnapshot,
      subscribe: vi.fn((listener: () => void) => {
        callListeners.add(listener);
        return () => callListeners.delete(listener);
      }),
      start: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn(),
      switchMicrophone: vi.fn().mockResolvedValue(undefined),
      setNoiseIntensity: vi.fn().mockResolvedValue(undefined),
      setOutputMuted: vi.fn(),
      setRemoteVolume: vi.fn(),
      setMicrophoneVolume: vi.fn(),
      selectOutput: vi.fn().mockResolvedValue(undefined),
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      prepareScreenShare: vi.fn().mockResolvedValue(undefined),
      selectScreenSource: vi.fn().mockResolvedValue(undefined),
      setScreenSystemAudioEnabled: vi.fn(),
      refreshScreenSources: vi.fn().mockResolvedValue(undefined),
      startScreenShare: vi.fn().mockResolvedValue(undefined),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      setScreenBitrate: vi.fn().mockResolvedValue(undefined),
      openScreenSettings: vi.fn().mockResolvedValue(undefined),
      attachPresentationVideo: vi.fn(),
      exportDiagnostics: vi.fn(() => ({ version: 1 as const, samples: [] })),
      cleanup: vi.fn(() => {
        if (cleanupPromise !== null) return cleanupPromise;
        order.push('call-cleanup');
        cleanupPromise = Promise.reject(new Error('cleanup failed'));
        return cleanupPromise;
      }),
    } satisfies CallController;
    const gateway = createRoomGateway();
    gateway.endRoom.mockImplementation(async () => {
      order.push('room-end');
    });
    render(
      <App
        desktop={createDesktop(session)}
        roomGateway={gateway}
        callController={call}
      />,
    );
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    await screen.findByText('语音已连接');

    await user.click(screen.getByRole('button', { name: '静音' }));
    await user.click(screen.getByRole('button', { name: '打开系统设置' }));
    callSnapshot = {
      ...callSnapshot,
      screenState: 'sharing',
      screenError: null,
      screenPermissionError: false,
      screenPermission: {
        status: 'denied',
        canOpenSettings: true,
        systemAudioMode: 'native-picker',
        captureProcessElevated: false,
      },
    };
    act(() => {
      for (const listener of callListeners) listener();
    });
    expect(screen.queryByRole('button', { name: '打开系统设置' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.selectOptions(screen.getByLabelText('麦克风'), 'mic-2');
    await user.selectOptions(screen.getByLabelText('扬声器'), 'speaker-1');
    expect(
      (screen.getByLabelText('麦克风音量') as HTMLInputElement).value,
    ).toBe('1');
    expect((screen.getByLabelText('对方音量') as HTMLInputElement).value).toBe(
      '1',
    );
    for (const volume of ['0', '2']) {
      fireEvent.change(screen.getByLabelText('麦克风音量'), {
        target: { value: volume },
      });
    }
    fireEvent.change(screen.getByLabelText('对方音量'), {
      target: { value: '0' },
    });
    await user.click(screen.getByRole('button', { name: '静音扬声器' }));
    await user.click(screen.getByRole('button', { name: '挂断' }));

    expect(call.start).toHaveBeenCalledOnce();
    expect(call.setMuted).toHaveBeenCalledWith(true);
    expect(call.switchMicrophone).toHaveBeenCalledWith('mic-2');
    expect(call.selectOutput).toHaveBeenCalledWith('speaker-1');
    expect(call.setMicrophoneVolume.mock.calls).toEqual([[0], [2]]);
    expect(call.setRemoteVolume.mock.calls).toEqual([[0]]);
    expect(call.setOutputMuted).toHaveBeenCalledWith(true);
    expect(call.openScreenSettings).toHaveBeenCalledOnce();
    expect(order).toEqual(['call-cleanup', 'room-end']);
  });

  it('keeps an owned realtime gateway alive through StrictMode and disposes it on real unmount', async () => {
    const user = userEvent.setup();
    const listeners = new Set<(event: RoomGatewayEvent) => void>();
    const dispose = vi.fn(() => listeners.clear());
    const gateway = {
      kind: 'realtime' as const,
      signaling: {} as RealtimeRoomGateway['signaling'],
      desktop: createDesktop(session),
      user: session.user,
      createRoom: vi.fn().mockResolvedValue(waitingRoom),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      endRoom: vi.fn(),
      markReady: vi.fn(),
      resumeRoom: vi.fn(),
      closeLocalRoom: vi.fn(),
      getCallSession: vi.fn(() => null),
      subscribe(listener: (event: RoomGatewayEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose,
      emit(event: RoomGatewayEvent) {
        for (const listener of listeners) listener(event);
      },
    } satisfies RealtimeRoomGateway & { emit(event: RoomGatewayEvent): void };
    const callSnapshot = {
      status: 'connected' as const,
      error: null,
      muted: false,
      outputMuted: false,
      remoteVolume: 1,
      microphoneVolume: 1,
      inputs: [],
      outputs: [],
      selectedInputId: '',
      selectedOutputId: '',
      supportsOutputSelection: false,
      microphoneRetryAvailable: false,
      noiseIntensity: 'off' as const,
      rnnoiseActive: false,
      localAudioLevel: 0,
      remoteAudioLevel: 0,
      ...idleScreenSnapshot,
    };
    const call = {
      getSnapshot: () => callSnapshot,
      subscribe: () => () => undefined,
      start: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn(),
      switchMicrophone: vi.fn(),
      setNoiseIntensity: vi.fn(),
      setOutputMuted: vi.fn(),
      setRemoteVolume: vi.fn(),
      setMicrophoneVolume: vi.fn(),
      selectOutput: vi.fn(),
      refreshDevices: vi.fn(),
      prepareScreenShare: vi.fn(),
      selectScreenSource: vi.fn(),
      setScreenSystemAudioEnabled: vi.fn(),
      refreshScreenSources: vi.fn(),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      setScreenBitrate: vi.fn(),
      openScreenSettings: vi.fn(),
      attachPresentationVideo: vi.fn(),
      exportDiagnostics: vi.fn(() => ({ version: 1 as const, samples: [] })),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } satisfies CallController;
    const rendered = render(
      <StrictMode>
        <App
          desktop={createDesktop(session)}
          roomGatewayFactory={() => gateway}
          callController={call}
        />
      </StrictMode>,
    );
    await waitForHome();
    await user.click(screen.getByRole('button', { name: '创建房间' }));
    gateway.emit({
      type: 'snapshot',
      room: {
        ...waitingRoom,
        connectionStatus: 'connecting',
        participants: [
          ...waitingRoom.participants,
          {
            userId: 'user-2',
            displayName: '林远',
            isSelf: false,
            online: true,
          },
        ],
      },
    });

    expect(await screen.findByText('林远')).toBeTruthy();
    expect(dispose).not.toHaveBeenCalled();
    rendered.unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
