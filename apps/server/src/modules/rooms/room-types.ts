export type RoomDomainErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_STATE'
  | 'LEASE_LOST'
  | 'NOT_ROOM_MEMBER'
  | 'ROOM_CLOSED'
  | 'ROOM_CODE_EXHAUSTED'
  | 'ROOM_CODE_INVALID'
  | 'ROOM_FULL'
  | 'SCREEN_SHARE_BUSY'
  | 'STALE_CONNECTION'
  | 'STALE_NEGOTIATION';

const roomDomainErrorMessages: Record<RoomDomainErrorCode, string> = {
  FORBIDDEN: 'Operation is not permitted',
  INVALID_STATE: 'Room state does not allow this operation',
  LEASE_LOST: 'Screen-share lease is no longer owned by this connection',
  NOT_ROOM_MEMBER: 'User is not a member of this room',
  ROOM_CLOSED: 'Room is closed',
  ROOM_CODE_EXHAUSTED: 'Unable to allocate a room code',
  ROOM_CODE_INVALID: 'Room code is invalid',
  ROOM_FULL: 'Room is full',
  SCREEN_SHARE_BUSY: 'Screen sharing is already owned',
  STALE_CONNECTION: 'Connection is no longer current',
  STALE_NEGOTIATION: 'Negotiation is no longer current',
};

export class RoomDomainError extends Error {
  readonly code: RoomDomainErrorCode;

  constructor(code: RoomDomainErrorCode) {
    super(roomDomainErrorMessages[code]);
    this.name = 'RoomDomainError';
    this.code = code;
  }
}

export type RoomActiveState =
  'waiting' | 'negotiating' | 'connected' | 'reconnecting';
export type RoomClosedReason = 'ended' | 'creator_left' | 'expired';
export type RoomRole = 'creator' | 'joiner';
export type NegotiationResetReason = 'peer_resumed' | 'signaling_reset';

export interface RoomConnectionIdentity {
  readonly connectionId: string;
  readonly connectionEpoch: number;
}

export interface RoomMemberSnapshot {
  readonly userId: string;
  readonly displayName: string;
  readonly role: RoomRole;
  readonly online: boolean;
  readonly ready: boolean;
  readonly connectionId: string | null;
  readonly currentEpoch: number;
}

export interface NegotiationExpectedEpoch {
  readonly userId: string;
  readonly connectionEpoch: number;
}

export interface RoomNegotiationSnapshot {
  readonly negotiationId: string;
  readonly offererUserId: string;
  readonly expectedEpochs: readonly NegotiationExpectedEpoch[];
  readonly status: 'active' | 'completed' | 'abandoned';
}

export interface PendingNegotiationResetSnapshot {
  readonly generation: number;
  readonly negotiationId: string;
  readonly reason: NegotiationResetReason;
}

export interface ScreenLeaseSnapshot {
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly leaseId: string;
  readonly expiresAtMs: number;
}

export interface RoomSnapshot {
  readonly id: string;
  readonly creatorUserId: string;
  readonly joinerUserId: string | null;
  readonly code: string | null;
  readonly codeExpiresAtMs: number | null;
  readonly state: RoomActiveState;
  readonly members: readonly RoomMemberSnapshot[];
  readonly activeNegotiation: RoomNegotiationSnapshot | null;
  readonly pendingNegotiationReset: PendingNegotiationResetSnapshot | null;
  readonly screenLease: ScreenLeaseSnapshot | null;
  readonly closeAtMs: number | null;
}

export interface ClosedRoomSnapshot {
  readonly id: string;
  readonly state: 'closed';
  readonly reason: RoomClosedReason;
}

export interface RoomSessionData {
  readonly room: RoomSnapshot;
  readonly role: RoomRole;
  readonly connection: RoomConnectionIdentity;
}

export interface CreatedRoomSessionData extends RoomSessionData {
  readonly role: 'creator';
  readonly roomCode: string;
}

export type RoomIntent =
  | Readonly<{
      type: 'peer.joined';
      roomId: string;
      userId: string;
    }>
  | Readonly<{
      type: 'peer.ready';
      roomId: string;
      userId: string;
    }>
  | Readonly<{
      type: 'peer.left';
      roomId: string;
      userId: string;
      reason: 'disconnected' | 'left' | 'replaced';
    }>
  | Readonly<{
      type: 'room.closed';
      roomId: string;
      reason: RoomClosedReason;
    }>
  | Readonly<{
      type: 'webrtc.negotiationReset';
      roomId: string;
      negotiationId: string;
      generation: number;
      reason: NegotiationResetReason;
    }>
  | Readonly<{
      type: 'screen.ownerChanged';
      roomId: string;
      ownerUserId: string | null;
      leaseId: string | null;
    }>
  | Readonly<{
      type: 'connection.replaced';
      roomId: string;
      userId: string;
      replacedConnectionId: string;
      replacedConnectionEpoch: number;
      closeCode: 4409;
      reason: 'SESSION_REPLACED';
    }>;

export interface RoomMutationResult<Data> {
  readonly data: Data;
  readonly intents: readonly RoomIntent[];
  readonly replayed: boolean;
}

interface NewConnectionInput {
  readonly userId: string;
  readonly displayName: string;
  readonly connectionId: string;
  readonly requestId: string;
}

export interface CurrentConnectionInput {
  readonly roomId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
}

export type CreateRoomInput = NewConnectionInput;

export interface JoinRoomInput extends NewConnectionInput {
  readonly roomCode: string;
}

export interface ResumeRoomInput extends NewConnectionInput {
  readonly roomId: string;
}

export interface ReadyRoomInput extends CurrentConnectionInput {
  readonly requestId: string;
}

export type DisconnectRoomInput = CurrentConnectionInput;

export type LeaveRoomInput = CurrentConnectionInput;

export type EndRoomInput = CurrentConnectionInput;

export interface MemberRoomInput {
  readonly roomId: string;
  readonly userId: string;
}

export interface BeginNegotiationInput extends CurrentConnectionInput {
  readonly negotiationId: string;
  readonly requestId: string;
}

export interface ValidateNegotiationInput extends CurrentConnectionInput {
  readonly negotiationId: string;
}

export interface CompleteNegotiationInput extends ValidateNegotiationInput {
  readonly requestId: string;
}

export interface ResetNegotiationInput extends CurrentConnectionInput {
  readonly reason: NegotiationResetReason;
  readonly requestId: string;
}

export interface SetScreenLeaseInput extends CurrentConnectionInput {
  readonly leaseId: string;
  readonly expiresAtMs: number;
  readonly requestId: string;
}

export interface ReleaseScreenLeaseInput extends CurrentConnectionInput {
  readonly leaseId: string;
  readonly requestId: string;
}

export interface RoomRegistryStats {
  readonly rooms: number;
  readonly codes: number;
  readonly idempotencyEntries: number;
  readonly timers: number;
}

export interface RoomRegistryDependencies {
  readonly now?: () => number;
  readonly randomInt?: (maxExclusive: number) => number;
  readonly randomUUID?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly onAsyncIntent?: (intent: RoomIntent) => void;
  readonly roomCodeTtlMs?: number;
  readonly reconnectGraceMs?: number;
  readonly maxCodeAttempts?: number;
  readonly requestCacheMaxEntries?: number;
}

export interface RoomRegistry {
  create(input: CreateRoomInput): RoomMutationResult<CreatedRoomSessionData>;
  join(input: JoinRoomInput): RoomMutationResult<RoomSessionData>;
  resume(input: ResumeRoomInput): RoomMutationResult<RoomSessionData>;
  bindReady(
    input: ReadyRoomInput,
  ): RoomMutationResult<Readonly<{ room: RoomSnapshot }>>;
  disconnect(
    input: DisconnectRoomInput,
  ): RoomMutationResult<Readonly<{ room: RoomSnapshot }>>;
  /** Terminal calls are not replay-cached here; Task 10 owns per-connection ACK replay. */
  leave(
    input: LeaveRoomInput,
  ): RoomMutationResult<Readonly<{ room: ClosedRoomSnapshot }>>;
  /** Terminal calls are not replay-cached here; Task 10 owns per-connection ACK replay. */
  end(
    input: EndRoomInput,
  ): RoomMutationResult<Readonly<{ room: ClosedRoomSnapshot }>>;
  getCurrentConnectionSnapshot(input: CurrentConnectionInput): RoomSnapshot;
  /** Internal broadcast lookup after the gateway has already authenticated a current socket. */
  getMemberSnapshotForBroadcast(input: MemberRoomInput): RoomSnapshot;
  beginNegotiation(
    input: BeginNegotiationInput,
  ): RoomMutationResult<Readonly<{ negotiation: RoomNegotiationSnapshot }>>;
  validateNegotiation(input: ValidateNegotiationInput): RoomNegotiationSnapshot;
  completeNegotiation(
    input: CompleteNegotiationInput,
  ): RoomMutationResult<Readonly<{ room: RoomSnapshot }>>;
  resetNegotiation(input: ResetNegotiationInput): RoomMutationResult<
    Readonly<{
      room: RoomSnapshot;
      reset: PendingNegotiationResetSnapshot;
    }>
  >;
  takePendingNegotiationReset(
    input: CurrentConnectionInput,
  ): PendingNegotiationResetSnapshot | null;
  getScreenLease(input: CurrentConnectionInput): ScreenLeaseSnapshot | null;
  setScreenLease(
    input: SetScreenLeaseInput,
  ): RoomMutationResult<Readonly<{ lease: ScreenLeaseSnapshot }>>;
  releaseScreenLease(
    input: ReleaseScreenLeaseInput,
  ): RoomMutationResult<Readonly<{ lease: null }>>;
  getStats(): RoomRegistryStats;
  clear(): void;
}
