import { useEffect, useMemo, useRef } from 'react';

import type { DesktopApi } from '../../preload/types.js';
import { createRendererDesktopApi } from './api/desktop-api.js';
import { AuthRoute } from './routes/AuthRoute.js';
import { HomeRoute } from './routes/HomeRoute.js';
import { RoomRoute } from './routes/RoomRoute.js';
import { AuthProvider, useAuth } from './state/auth-store.js';
import { RoomProvider, useRoom, type RoomGateway } from './state/room-store.js';
import {
  CallProvider,
  createRealtimeRoomGateway,
  type CallController,
  type RealtimeRoomGateway,
} from './state/call-store.js';
import type { PublicAuthUser } from '@wo/protocol';

export type RoomGatewayFactory = (
  desktop: DesktopApi,
  user: PublicAuthUser,
) => RealtimeRoomGateway;

function RoomRouter({
  gateway,
  callController,
}: {
  readonly gateway: RoomGateway;
  readonly callController?: CallController;
}) {
  const room = useRoom();
  return room.room === null ? (
    <HomeRoute />
  ) : (
    <CallProvider
      room={room.room}
      gateway={gateway}
      controller={callController}
    >
      <RoomRoute />
    </CallProvider>
  );
}

function AuthenticatedRouter({
  desktop,
  roomGateway,
  callController,
  roomGatewayFactory,
}: {
  readonly desktop: DesktopApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
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
      <RoomRouter gateway={gateway} callController={callController} />
    </RoomProvider>
  );
}

function AuthRouter({
  desktop,
  roomGateway,
  callController,
  roomGatewayFactory,
}: {
  readonly desktop: DesktopApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
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
    return <AuthRoute />;
  }
  return (
    <AuthenticatedRouter
      desktop={desktop}
      roomGateway={roomGateway}
      callController={callController}
      roomGatewayFactory={roomGatewayFactory}
    />
  );
}

export function App({
  desktop,
  roomGateway,
  callController,
  roomGatewayFactory,
}: {
  readonly desktop?: DesktopApi;
  readonly roomGateway?: RoomGateway;
  readonly callController?: CallController;
  readonly roomGatewayFactory?: RoomGatewayFactory;
}) {
  const api = useMemo(
    () => desktop ?? createRendererDesktopApi(window.desktop),
    [desktop],
  );
  return (
    <AuthProvider api={api}>
      <AuthRouter
        desktop={api}
        roomGateway={roomGateway}
        callController={callController}
        roomGatewayFactory={roomGatewayFactory}
      />
    </AuthProvider>
  );
}
