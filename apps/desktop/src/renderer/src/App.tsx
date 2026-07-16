import { useMemo } from 'react';

import type { DesktopApi } from '../../preload/types.js';
import { createRendererDesktopApi } from './api/desktop-api.js';
import { AuthRoute } from './routes/AuthRoute.js';
import { HomeRoute } from './routes/HomeRoute.js';
import { RoomRoute } from './routes/RoomRoute.js';
import { AuthProvider, useAuth } from './state/auth-store.js';
import {
  createUnavailableRoomGateway,
  RoomProvider,
  useRoom,
  type RoomGateway,
} from './state/room-store.js';

function RoomRouter() {
  const room = useRoom();
  return room.room === null ? <HomeRoute /> : <RoomRoute />;
}

function AuthRouter({ roomGateway }: { readonly roomGateway: RoomGateway }) {
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
    <RoomProvider gateway={roomGateway} accessToken={auth.session.accessToken}>
      <RoomRouter />
    </RoomProvider>
  );
}

export function App({
  desktop,
  roomGateway,
}: {
  readonly desktop?: DesktopApi;
  readonly roomGateway?: RoomGateway;
}) {
  const api = useMemo(
    () => desktop ?? createRendererDesktopApi(window.desktop),
    [desktop],
  );
  const fallbackGateway = useMemo(createUnavailableRoomGateway, []);
  return (
    <AuthProvider api={api}>
      <AuthRouter roomGateway={roomGateway ?? fallbackGateway} />
    </AuthProvider>
  );
}
