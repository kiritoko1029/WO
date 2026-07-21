import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  createJoinProtocolUrl,
  type JoinIntent,
  type LanJoinIntent,
  type PublicAuthUser,
  type ServerJoinIntent,
} from '@wo/protocol';
import type { DesktopApi } from '../../preload/types.js';
import type {
  DesktopLanApi,
  LanSessionSnapshot,
} from '../../preload/lan-types.js';
import { createRendererDesktopApi } from './api/desktop-api.js';
import { createLanDesktopApi } from './api/lan-desktop-api.js';
import { createRendererLanApi } from './api/lan-api.js';
import { createRendererShellConfigApi } from './api/shell-config-api.js';
import {
  ConnectionModeSelector,
  type ConnectionMode,
} from './components/ConnectionModeSelector.js';
import { ThemeFab } from './components/ThemeFab.js';
import { createLanIpcWebSocket } from './media/lan-signaling-socket.js';
import { createSignalingClient } from './media/signaling-client.js';
import { AuthRoute } from './routes/AuthRoute.js';
import { HomeRoute } from './routes/HomeRoute.js';
import { LanSetupRoute } from './routes/LanSetupRoute.js';
import { RoomRoute } from './routes/RoomRoute.js';
import { AuthProvider, useAuth } from './state/auth-store.js';
import { RoomProvider, useRoom, type RoomGateway } from './state/room-store.js';
import {
  CallProvider,
  createRealtimeRoomGateway,
  type CallController,
  type RealtimeRoomGateway,
} from './state/call-store.js';

export type RoomGatewayFactory = (
  desktop: DesktopApi,
  user: PublicAuthUser,
) => RealtimeRoomGateway;

function RoomRouter({
  gateway,
  callController,
  joinIntent,
  lanSession,
  serverOrigin,
  modeSelector,
  onJoinIntentConsumed,
  onLanExit,
}: {
  readonly gateway: RoomGateway;
  readonly callController?: CallController;
  readonly joinIntent: ServerJoinIntent | null;
  readonly lanSession?: LanSessionSnapshot;
  readonly serverOrigin: string | null;
  readonly modeSelector?: ReactNode;
  readonly onJoinIntentConsumed: () => void;
  readonly onLanExit?: () => void | Promise<void>;
}) {
  const room = useRoom();
  const consumedJoinIntent = useRef<string | null>(null);
  const hadLanRoom = useRef(false);
  const exitingLan = useRef(false);
  const [retry, setRetry] = useState(0);
  const roomAction =
    lanSession === undefined
      ? joinIntent === null
        ? null
        : {
            key: createJoinProtocolUrl(joinIntent),
            type: 'join' as const,
            roomCode: joinIntent.roomCode,
          }
      : {
          key: `${lanSession.role}:${createJoinProtocolUrl(
            lanSession.joinIntent,
          )}`,
          type:
            lanSession.role === 'host'
              ? ('create' as const)
              : ('join' as const),
          roomCode: lanSession.joinIntent.roomCode,
        };
  useEffect(() => {
    if (roomAction === null || room.room !== null || room.busy) return;
    if (consumedJoinIntent.current === roomAction.key) return;
    consumedJoinIntent.current = roomAction.key;
    if (lanSession === undefined) onJoinIntentConsumed();
    void (roomAction.type === 'create'
      ? room.createRoom()
      : room.joinRoom(roomAction.roomCode));
  }, [lanSession, onJoinIntentConsumed, retry, room, roomAction]);
  useEffect(() => {
    if (lanSession === undefined) return;
    if (room.room !== null) {
      hadLanRoom.current = true;
      return;
    }
    if (
      hadLanRoom.current &&
      !room.busy &&
      !exitingLan.current &&
      onLanExit !== undefined
    ) {
      exitingLan.current = true;
      void onLanExit();
    }
  }, [lanSession, onLanExit, room.busy, room.room]);
  const exitLan = (): void => {
    if (exitingLan.current || onLanExit === undefined) return;
    exitingLan.current = true;
    void onLanExit();
  };
  if (room.room === null && lanSession !== undefined) {
    return (
      <main className="lan-connecting-shell">
        <section>
          <h1>
            {lanSession.role === 'host'
              ? '正在创建局域网房间'
              : `正在加入房间 ${lanSession.joinIntent.roomCode}`}
          </h1>
          <p>
            房主地址 {new URL(lanSession.joinIntent.endpoint).host}
            ，请保持两台设备位于同一可信局域网。
          </p>
          <div role="alert">{room.error}</div>
          {room.error !== null && (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                consumedJoinIntent.current = null;
                room.clearError();
                setRetry((value) => value + 1);
              }}
            >
              重试
            </button>
          )}
          <button type="button" className="secondary-button" onClick={exitLan}>
            返回局域网入口
          </button>
        </section>
      </main>
    );
  }
  return room.room === null ? (
    <HomeRoute modeSelector={modeSelector} />
  ) : (
    <CallProvider
      room={room.room}
      gateway={gateway}
      controller={callController}
    >
      <RoomRoute
        serverOrigin={serverOrigin}
        joinIntent={lanSession?.joinIntent}
        onRoomClosed={lanSession === undefined ? undefined : exitLan}
      />
    </CallProvider>
  );
}

function AuthenticatedRouter({
  desktop,
  roomGateway,
  callController,
  roomGatewayFactory,
  joinIntent,
  lanSession,
  serverOrigin,
  modeSelector,
  onJoinIntentConsumed,
  onLanExit,
}: {
  readonly desktop: DesktopApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
  readonly joinIntent: ServerJoinIntent | null;
  readonly lanSession?: LanSessionSnapshot;
  readonly serverOrigin: string | null;
  readonly modeSelector?: ReactNode;
  readonly onJoinIntentConsumed: () => void;
  readonly onLanExit?: () => void | Promise<void>;
}) {
  const auth = useAuth();
  const session = auth.session!;
  const realtimeGateway = useMemo(
    () =>
      roomGatewayFactory?.(desktop, session.user) ??
      createRealtimeRoomGateway({ desktop, user: session.user }),
    [desktop, roomGatewayFactory, session.user.userId],
  );
  const gateway = roomGateway ?? realtimeGateway;
  const ownerMounts = useRef(0);
  useEffect(() => {
    if (roomGateway !== undefined) return;
    ownerMounts.current += 1;
    return () => {
      ownerMounts.current -= 1;
      queueMicrotask(() => {
        if (ownerMounts.current === 0) realtimeGateway.dispose();
      });
    };
  }, [realtimeGateway, roomGateway]);
  return (
    <RoomProvider gateway={gateway} accessToken={session.accessToken}>
      <RoomRouter
        gateway={gateway}
        callController={callController}
        joinIntent={joinIntent}
        lanSession={lanSession}
        serverOrigin={serverOrigin}
        modeSelector={modeSelector}
        onJoinIntentConsumed={onJoinIntentConsumed}
        onLanExit={onLanExit}
      />
    </RoomProvider>
  );
}

function AuthRouter({
  desktop,
  roomGateway,
  callController,
  roomGatewayFactory,
  joinIntent,
  lanSession,
  serverOrigin,
  modeSelector,
  onJoinIntentConsumed,
  onLanExit,
}: {
  readonly desktop: DesktopApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
  readonly joinIntent: ServerJoinIntent | null;
  readonly lanSession?: LanSessionSnapshot;
  readonly serverOrigin: string | null;
  readonly modeSelector?: ReactNode;
  readonly onJoinIntentConsumed: () => void;
  readonly onLanExit?: () => void | Promise<void>;
}) {
  const auth = useAuth();
  if (auth.status === 'restoring') {
    return (
      <main className="startup-shell" aria-label="正在恢复会话">
        <div className="startup-spinner" />
      </main>
    );
  }
  if (auth.status === 'anonymous' || auth.session === null) {
    return <AuthRoute modeSelector={modeSelector} />;
  }
  return (
    <AuthenticatedRouter
      desktop={desktop}
      roomGateway={roomGateway}
      callController={callController}
      roomGatewayFactory={roomGatewayFactory}
      joinIntent={joinIntent}
      lanSession={lanSession}
      serverOrigin={serverOrigin}
      modeSelector={modeSelector}
      onJoinIntentConsumed={onJoinIntentConsumed}
      onLanExit={onLanExit}
    />
  );
}

export function App({
  desktop,
  lanApi,
  roomGateway,
  callController,
  roomGatewayFactory,
  initialJoinIntent,
}: {
  readonly desktop?: DesktopApi;
  readonly lanApi?: DesktopLanApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
  readonly initialJoinIntent?: JoinIntent | null;
}) {
  const api = useMemo(
    () => desktop ?? createRendererDesktopApi(window.desktop),
    [desktop],
  );
  const shellApi = useMemo(
    () =>
      window.woShell === undefined
        ? null
        : createRendererShellConfigApi(window.woShell),
    [],
  );
  const lan = useMemo(
    () =>
      lanApi ??
      (window.woLan === undefined ? null : createRendererLanApi(window.woLan)),
    [lanApi],
  );
  const initialServerOrigin =
    window.location.protocol === 'https:' ? window.location.origin : null;
  const [activeServerOrigin, setActiveServerOrigin] = useState<string | null>(
    initialServerOrigin,
  );
  const [pendingJoinIntent, setPendingJoinIntent] = useState<JoinIntent | null>(
    initialJoinIntent ?? null,
  );
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(
    initialJoinIntent?.mode === 'lan' && lan !== null ? 'lan' : 'server',
  );
  const [lanSession, setLanSession] = useState<LanSessionSnapshot | null>(null);
  const [switchingServer, setSwitchingServer] = useState(false);
  const [switchServerError, setSwitchServerError] = useState<string | null>(
    null,
  );
  const [webJoinPromptOpen, setWebJoinPromptOpen] = useState(true);
  const [shellLoadError, setShellLoadError] = useState<string | null>(null);
  const [shellRetry, setShellRetry] = useState(0);
  const lanDesktop = useMemo(
    () =>
      lan === null || lanSession === null
        ? null
        : createLanDesktopApi(lan, lanSession, api.capture),
    [api.capture, lan, lanSession],
  );
  const lanRoomGatewayFactory = useMemo<RoomGatewayFactory | undefined>(() => {
    if (lan === null || lanSession === null) return undefined;
    const activeLan = lan;
    const intent = lanSession.joinIntent;
    return (desktopApi, user) =>
      createRealtimeRoomGateway({
        desktop: desktopApi,
        user,
        signaling: createSignalingClient({
          desktop: desktopApi,
          lanIntent: intent,
          createWebSocket: (endpoint, protocols) =>
            createLanIpcWebSocket(activeLan, endpoint, protocols),
        }),
      });
  }, [lan, lanSession]);

  useEffect(() => {
    if (shellApi === null) return;
    let cancelled = false;
    let transition = Promise.resolve();
    setShellLoadError(null);
    const consume = () => {
      transition = transition
        .then(async () => {
          const intent = await shellApi.joinIntent.consume();
          if (intent === null || cancelled) return;
          if (lan !== null) await lan.stop();
          if (cancelled) return;
          setLanSession(null);
          setPendingJoinIntent(intent);
          setConnectionMode(
            intent.mode === 'lan' && lan !== null ? 'lan' : 'server',
          );
        })
        .catch(() => {
          if (!cancelled) setShellLoadError('无法读取房间邀请');
        });
    };
    const unsubscribe = shellApi.joinIntent.subscribe(consume);
    void shellApi.backendTarget
      .get()
      .then((target) => setActiveServerOrigin(target.origin))
      .catch(() => setShellLoadError('无法读取当前服务地址'));
    consume();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [lan, shellApi, shellRetry]);

  const serverJoinIntent =
    pendingJoinIntent?.mode === 'server' ? pendingJoinIntent : null;
  const needsServerSwitch =
    serverJoinIntent !== null &&
    activeServerOrigin !== null &&
    serverJoinIntent.serverOrigin !== activeServerOrigin;
  const awaitingWebChoice =
    shellApi === null && webJoinPromptOpen && serverJoinIntent !== null;
  const consumableJoinIntent =
    needsServerSwitch ||
    activeServerOrigin === null ||
    awaitingWebChoice ||
    shellLoadError !== null
      ? null
      : serverJoinIntent;
  const confirmServerSwitch = async (): Promise<void> => {
    if (shellApi === null || serverJoinIntent === null) return;
    setSwitchingServer(true);
    setSwitchServerError(null);
    try {
      await shellApi.joinIntent.switchServer(serverJoinIntent);
    } catch (error) {
      setSwitchServerError(
        typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'INVALID_STATE'
          ? '当前服务由环境变量管理，无法从链接切换'
          : '服务切换失败，请重试',
      );
      setSwitchingServer(false);
    }
  };
  const leaveLan = async (): Promise<void> => {
    if (lan !== null) await lan.stop().catch(() => undefined);
    setLanSession(null);
  };
  const changeConnectionMode = (mode: ConnectionMode): void => {
    if (mode === connectionMode) return;
    if (mode === 'server') {
      void leaveLan().then(() => {
        setPendingJoinIntent((intent) =>
          intent?.mode === 'lan' ? null : intent,
        );
        setConnectionMode('server');
      });
      return;
    }
    setConnectionMode('lan');
  };
  const serverModeSelector =
    lan === null ? undefined : (
      <ConnectionModeSelector mode="server" onChange={changeConnectionMode} />
    );
  const lanModeSelector =
    lan === null ? undefined : (
      <ConnectionModeSelector mode="lan" onChange={changeConnectionMode} />
    );
  const lanJoinIntent: LanJoinIntent | null =
    pendingJoinIntent?.mode === 'lan' ? pendingJoinIntent : null;

  return (
    <>
      {connectionMode === 'lan' && lan !== null ? (
        lanSession === null || lanDesktop === null ? (
          <LanSetupRoute
            lan={lan}
            pendingIntent={lanJoinIntent}
            modeSelector={lanModeSelector}
            onSession={setLanSession}
            onIntentConsumed={() => setPendingJoinIntent(null)}
          />
        ) : (
          <AuthProvider key={lanSession.accessToken} api={lanDesktop}>
            <AuthRouter
              desktop={lanDesktop}
              roomGateway={roomGateway}
              callController={callController}
              roomGatewayFactory={roomGatewayFactory ?? lanRoomGatewayFactory}
              joinIntent={null}
              lanSession={lanSession}
              serverOrigin={null}
              onJoinIntentConsumed={() => undefined}
              onLanExit={leaveLan}
            />
          </AuthProvider>
        )
      ) : (
        <AuthProvider api={api}>
          <AuthRouter
            desktop={api}
            roomGateway={roomGateway}
            callController={callController}
            roomGatewayFactory={roomGatewayFactory}
            joinIntent={consumableJoinIntent}
            serverOrigin={activeServerOrigin}
            modeSelector={serverModeSelector}
            onJoinIntentConsumed={() => setPendingJoinIntent(null)}
          />
        </AuthProvider>
      )}
      {shellLoadError !== null && (
        <aside className="shell-load-error" role="alert">
          <span>{shellLoadError}</span>
          <button
            type="button"
            onClick={() => setShellRetry((value) => value + 1)}
          >
            重试
          </button>
        </aside>
      )}
      {connectionMode === 'server' &&
        shellApi === null &&
        webJoinPromptOpen &&
        serverJoinIntent !== null && (
          <aside className="web-join-prompt" aria-label="房间邀请">
            <div>
              <strong>房间 {serverJoinIntent.roomCode}</strong>
              <span>可继续使用网页版，或唤起桌面客户端。</span>
            </div>
            <a href={createJoinProtocolUrl(serverJoinIntent)}>
              在 WO 客户端打开
            </a>
            <button type="button" onClick={() => setWebJoinPromptOpen(false)}>
              继续网页版
            </button>
          </aside>
        )}
      {connectionMode === 'server' &&
        needsServerSwitch &&
        serverJoinIntent !== null &&
        activeServerOrigin !== null && (
          <div className="join-intent-backdrop">
            <section
              className="join-intent-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="join-intent-title"
            >
              <header>
                <h2 id="join-intent-title">切换服务后加入房间？</h2>
                <p>
                  链接指向{' '}
                  <strong>{new URL(serverJoinIntent.serverOrigin).host}</strong>
                </p>
              </header>
              <p>
                当前服务为 {new URL(activeServerOrigin).host}
                。切换后需要在目标服务重新登录。
              </p>
              <div className="join-intent-error" role="alert">
                {switchServerError}
              </div>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={switchingServer}
                  onClick={() => {
                    setPendingJoinIntent(null);
                    setSwitchServerError(null);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={switchingServer || shellApi === null}
                  onClick={() => void confirmServerSwitch()}
                >
                  {switchingServer ? '正在切换' : '切换并重启'}
                </button>
              </footer>
            </section>
          </div>
        )}
      <ThemeFab />
    </>
  );
}
