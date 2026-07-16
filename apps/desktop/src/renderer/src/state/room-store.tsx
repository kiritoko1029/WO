import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface RoomParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly isSelf: boolean;
  readonly online: boolean;
}

export interface RoomSnapshot {
  readonly roomId: string;
  readonly roomCode: string;
  readonly role: 'creator' | 'joiner';
  readonly connectionStatus: 'waiting' | 'connected' | 'reconnecting';
  readonly participants: readonly RoomParticipant[];
}

export type RoomGatewayEvent =
  | { readonly type: 'snapshot'; readonly room: RoomSnapshot }
  | { readonly type: 'closed'; readonly roomId: string };

export interface RoomGateway {
  createRoom(accessToken: string): Promise<RoomSnapshot>;
  joinRoom(accessToken: string, roomCode: string): Promise<RoomSnapshot>;
  leaveRoom(roomId: string): Promise<void>;
  endRoom(roomId: string): Promise<void>;
  subscribe(listener: (event: RoomGatewayEvent) => void): () => void;
}

interface RoomState {
  readonly room: RoomSnapshot | null;
  readonly busy: boolean;
  readonly error: string | null;
  createRoom(): Promise<boolean>;
  joinRoom(roomCode: string): Promise<boolean>;
  closeRoom(): Promise<boolean>;
  clearError(): void;
}

const RoomContext = createContext<RoomState | null>(null);

function codeOf(error: unknown): string | null {
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

function roomErrorMessage(error: unknown): string {
  switch (codeOf(error)) {
    case 'ROOM_FULL':
      return '房间已满';
    case 'ROOM_CODE_EXPIRED':
      return '房间码已过期';
    case 'ROOM_CODE_INVALID':
      return '房间码无效';
    case 'RATE_LIMITED':
      return '操作过于频繁，请稍后再试';
    case 'NETWORK_ERROR':
    case 'SIGNALING_UNAVAILABLE':
      return '实时服务暂不可用';
    default:
      return '房间操作失败，请重试';
  }
}

export function RoomProvider({
  gateway,
  accessToken,
  children,
}: {
  readonly gateway: RoomGateway;
  readonly accessToken: string;
  readonly children: ReactNode;
}) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      gateway.subscribe((event) => {
        if (event.type === 'snapshot') {
          setRoom((current) =>
            current?.roomId === event.room.roomId ? event.room : current,
          );
          return;
        }
        setRoom((current) => {
          if (current?.roomId !== event.roomId) return current;
          setError('房间已关闭');
          return null;
        });
      }),
    [gateway],
  );

  const runRoom = useCallback(
    async (operation: () => Promise<RoomSnapshot>) => {
      setBusy(true);
      setError(null);
      try {
        setRoom(await operation());
        return true;
      } catch (operationError) {
        setError(roomErrorMessage(operationError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const value = useMemo<RoomState>(
    () => ({
      room,
      busy,
      error,
      createRoom: () => runRoom(() => gateway.createRoom(accessToken)),
      joinRoom: (roomCode) =>
        runRoom(() => gateway.joinRoom(accessToken, roomCode)),
      closeRoom: async () => {
        if (room === null) return true;
        setBusy(true);
        setError(null);
        try {
          if (room.role === 'creator') {
            await gateway.endRoom(room.roomId);
          } else {
            await gateway.leaveRoom(room.roomId);
          }
          setRoom(null);
          return true;
        } catch (operationError) {
          setError(roomErrorMessage(operationError));
          return false;
        } finally {
          setBusy(false);
        }
      },
      clearError: () => setError(null),
    }),
    [accessToken, busy, error, gateway, room, runRoom],
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom(): RoomState {
  const value = useContext(RoomContext);
  if (value === null) throw new Error('RoomProvider is missing');
  return value;
}

export function createUnavailableRoomGateway(): RoomGateway {
  const unavailable = () =>
    Promise.reject(
      Object.assign(new Error('Realtime client is not connected'), {
        code: 'SIGNALING_UNAVAILABLE',
      }),
    );
  return Object.freeze({
    createRoom: unavailable,
    joinRoom: unavailable,
    leaveRoom: async () => undefined,
    endRoom: async () => undefined,
    subscribe: () => () => undefined,
  });
}
