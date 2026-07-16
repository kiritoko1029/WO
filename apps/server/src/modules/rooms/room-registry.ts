import {
  randomInt as nodeRandomInt,
  randomUUID as nodeRandomUUID,
} from 'node:crypto';

import { generateRoomCode } from './room-code.ts';
import {
  RoomDomainError,
  type BeginIceRestartInput,
  type BeginNegotiationInput,
  type AnswerRelayInput,
  type ClosedRoomSnapshot,
  type CompleteNegotiationInput,
  type ConfirmAnswerRelayInput,
  type ConfirmPendingNegotiationResetInput,
  type CreateRoomInput,
  type CreatedRoomSessionData,
  type DisconnectRoomInput,
  type EndRoomInput,
  type JoinRoomInput,
  type LeaveRoomInput,
  type MemberRoomInput,
  type NegotiationResetReason,
  type OfferRelayInput,
  type PendingNegotiationResetSnapshot,
  type ReadyRoomInput,
  type RelayRequestInput,
  type ReleaseScreenLeaseInput,
  type ResetNegotiationInput,
  type ResumeRoomInput,
  type RoomActiveState,
  type RoomClosedReason,
  type RoomConnectionIdentity,
  type RoomIntent,
  type RoomMemberSnapshot,
  type RoomMutationResult,
  type RoomNegotiationSnapshot,
  type RoomRegistry,
  type RoomRegistryDependencies,
  type RoomRegistryStats,
  type RoomRole,
  type RoomSessionData,
  type RoomSnapshot,
  type ScreenLeaseSnapshot,
  type SetScreenLeaseInput,
  type ValidateNegotiationInput,
} from './room-types.ts';

const DEFAULT_ROOM_CODE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_RECONNECT_GRACE_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_CODE_ATTEMPTS = 32;
const DEFAULT_REQUEST_CACHE_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_ROOMS = 10_000;
const REPLACED_CLOSE_CODE = 4409;
const REPLACED_CLOSE_REASON = 'SESSION_REPLACED';

interface ManagedTimer {
  handle: unknown;
  active: boolean;
}

interface PeerConnectionState {
  readonly connectionId: string;
  readonly connectionEpoch: number;
  ready: boolean;
}

interface RoomMemberState {
  readonly userId: string;
  readonly role: RoomRole;
  displayName: string;
}

interface NegotiationRequestIdentity {
  readonly userId: string;
  readonly requestId: string;
  readonly signature: string;
}

interface OfferRequestIdentity extends NegotiationRequestIdentity {
  readonly operation: OfferRelayInput['operation'];
}

interface RoomNegotiationState {
  readonly generation: number;
  readonly negotiationId: string;
  readonly offererUserId: string;
  readonly expectedConnectionEpochByUserId: Map<string, number>;
  status: 'active' | 'completed' | 'abandoned';
  offerState: 'awaiting' | 'queued';
  answerState: 'awaiting' | 'queued' | 'applied';
  offerRelayIdentity: OfferRequestIdentity | null;
  answerRelayIdentity: NegotiationRequestIdentity | null;
  answerAppliedIdentity: NegotiationRequestIdentity | null;
}

interface PendingNegotiationResetState extends PendingNegotiationResetSnapshot {
  consumed: boolean;
}

interface ScreenLeaseState extends ScreenLeaseSnapshot {
  timer: ManagedTimer | null;
}

interface TemporaryRoom {
  readonly id: string;
  readonly originalCode: string;
  readonly creatorUserId: string;
  joinerUserId: string | null;
  code: string | null;
  codeExpiresAtMs: number | null;
  state: RoomActiveState;
  readonly membersByUserId: Map<string, RoomMemberState>;
  readonly connectionsByUserId: Map<string, PeerConnectionState>;
  nextConnectionEpoch: number;
  readonly currentConnectionEpochByUserId: Map<string, number>;
  activeNegotiation: RoomNegotiationState | null;
  negotiationGeneration: number;
  pendingNegotiationReset: PendingNegotiationResetState | null;
  resetGeneration: number;
  screenLease: ScreenLeaseState | null;
  closeAtMs: number | null;
  codeTimer: ManagedTimer | null;
  graceTimer: ManagedTimer | null;
  readonly requestCacheKeys: Set<string>;
  hasConnected: boolean;
}

interface IdempotencyEntry {
  readonly operation: string;
  readonly signature: string;
  readonly roomId: string;
  readonly data: unknown;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertIdentifier(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${name} must be a non-empty bounded identifier`);
  }
}

function assertRequestDigest(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError('requestDigest must be a SHA-256 base64url digest');
  }
}

function assertDisplayName(value: string): void {
  if (value.length < 1 || value.length > 100 || value.trim() !== value) {
    throw new TypeError(
      'displayName must be canonical and 1 to 100 characters',
    );
  }
}

function assertConnectionEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('connectionEpoch must be a non-negative safe integer');
  }
}

function operationTime(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new RangeError('Room registry clock must return a finite number');
  }
  return value;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function frozenIntent(intent: RoomIntent): RoomIntent {
  return Object.freeze(intent);
}

function mutationResult<Data>(
  data: Data,
  intents: readonly RoomIntent[] = [],
  replayed = false,
): RoomMutationResult<Data> {
  return Object.freeze({
    data,
    intents: Object.freeze(intents.map(frozenIntent)),
    replayed,
  });
}

function connectionIdentity(
  connection: PeerConnectionState,
): RoomConnectionIdentity {
  return frozen({
    connectionId: connection.connectionId,
    connectionEpoch: connection.connectionEpoch,
  });
}

export function createRoomRegistry(
  dependencies: RoomRegistryDependencies = {},
): RoomRegistry {
  const now = dependencies.now ?? Date.now;
  const randomInt = dependencies.randomInt ?? nodeRandomInt;
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const setTimer =
    dependencies.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
  const clearTimer =
    dependencies.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const roomCodeTtlMs = positiveSafeInteger(
    dependencies.roomCodeTtlMs ?? DEFAULT_ROOM_CODE_TTL_MS,
    'roomCodeTtlMs',
  );
  const reconnectGraceMs = positiveSafeInteger(
    dependencies.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
    'reconnectGraceMs',
  );
  const maxCodeAttempts = positiveSafeInteger(
    dependencies.maxCodeAttempts ?? DEFAULT_MAX_CODE_ATTEMPTS,
    'maxCodeAttempts',
  );
  const requestCacheMaxEntries = positiveSafeInteger(
    dependencies.requestCacheMaxEntries ?? DEFAULT_REQUEST_CACHE_MAX_ENTRIES,
    'requestCacheMaxEntries',
  );
  const maxRooms = positiveSafeInteger(
    dependencies.maxRooms ?? DEFAULT_MAX_ROOMS,
    'maxRooms',
  );
  const maxNegotiationGeneration = positiveSafeInteger(
    dependencies.maxNegotiationGeneration ?? Number.MAX_SAFE_INTEGER,
    'maxNegotiationGeneration',
  );

  const roomsById = new Map<string, TemporaryRoom>();
  const roomIdByCode = new Map<string, string>();
  const reservedRoomCodes = new Set<string>();
  const consumedRoomIdByJoinerCode = new Map<string, string>();
  const idempotencyCache = new Map<string, IdempotencyEntry>();
  let timerCount = 0;

  const emitAsyncIntent = (intent: RoomIntent): void => {
    try {
      dependencies.onAsyncIntent?.(frozenIntent(intent));
    } catch {
      // Observability and delivery hooks cannot corrupt domain cleanup.
    }
  };

  const scheduleTimer = (
    delayMs: number,
    callback: () => void,
  ): ManagedTimer => {
    const timer: ManagedTimer = { handle: undefined, active: true };
    timerCount += 1;
    try {
      timer.handle = setTimer(
        () => {
          if (!timer.active) {
            return;
          }
          timer.active = false;
          timerCount -= 1;
          callback();
        },
        Math.max(0, delayMs),
      );
    } catch (error) {
      timer.active = false;
      timerCount -= 1;
      throw error;
    }
    return timer;
  };

  const cancelTimer = (timer: ManagedTimer | null): void => {
    if (timer === null || !timer.active) {
      return;
    }
    timer.active = false;
    timerCount -= 1;
    try {
      clearTimer(timer.handle);
    } catch {
      // The inactive guard still makes a delayed callback harmless.
    }
  };

  const removeIdempotencyEntry = (key: string): void => {
    const entry = idempotencyCache.get(key);
    if (entry === undefined) {
      return;
    }
    idempotencyCache.delete(key);
    roomsById.get(entry.roomId)?.requestCacheKeys.delete(key);
  };

  const cleanupRoom = (
    room: TemporaryRoom,
    reason: RoomClosedReason,
  ): readonly RoomIntent[] => {
    if (roomsById.get(room.id) !== room) {
      return [];
    }
    cancelTimer(room.codeTimer);
    room.codeTimer = null;
    cancelTimer(room.graceTimer);
    room.graceTimer = null;
    reservedRoomCodes.delete(room.originalCode);
    if (room.joinerUserId !== null) {
      consumedRoomIdByJoinerCode.delete(
        JSON.stringify([room.joinerUserId, room.originalCode]),
      );
    }
    if (room.code !== null) {
      roomIdByCode.delete(room.code);
      room.code = null;
      room.codeExpiresAtMs = null;
    }

    const intents: RoomIntent[] = [];
    if (room.screenLease !== null) {
      cancelTimer(room.screenLease.timer);
      room.screenLease = null;
      intents.push({
        type: 'screen.ownerChanged',
        roomId: room.id,
        ownerUserId: null,
        leaseId: null,
      });
    }
    roomsById.delete(room.id);
    for (const key of [...room.requestCacheKeys]) {
      removeIdempotencyEntry(key);
    }
    room.requestCacheKeys.clear();
    intents.push({ type: 'room.closed', roomId: room.id, reason });
    return intents;
  };

  const cleanupRoomAsynchronously = (
    room: TemporaryRoom,
    reason: RoomClosedReason,
  ): void => {
    for (const intent of cleanupRoom(room, reason)) {
      emitAsyncIntent(intent);
    }
  };

  const expireGraceIfDue = (room: TemporaryRoom): boolean => {
    if (
      room.closeAtMs === null ||
      room.connectionsByUserId.size > 0 ||
      operationTime(now) < room.closeAtMs
    ) {
      return false;
    }
    cleanupRoomAsynchronously(room, 'expired');
    return true;
  };

  const requireRoom = (roomId: string): TemporaryRoom => {
    assertIdentifier(roomId, 'roomId');
    const room = roomsById.get(roomId);
    if (room === undefined) {
      throw new RoomDomainError('ROOM_CLOSED');
    }
    if (expireGraceIfDue(room)) {
      throw new RoomDomainError('ROOM_CLOSED');
    }
    return room;
  };

  const requireMembership = (
    room: TemporaryRoom,
    userId: string,
  ): RoomMemberState => {
    assertIdentifier(userId, 'userId');
    const member = room.membersByUserId.get(userId);
    if (member === undefined) {
      throw new RoomDomainError('NOT_ROOM_MEMBER');
    }
    return member;
  };

  const requireCurrentConnection = (
    room: TemporaryRoom,
    input: {
      readonly userId: string;
      readonly connectionId: string;
      readonly connectionEpoch: number;
    },
  ): PeerConnectionState => {
    requireMembership(room, input.userId);
    assertIdentifier(input.connectionId, 'connectionId');
    assertConnectionEpoch(input.connectionEpoch);
    const connection = room.connectionsByUserId.get(input.userId);
    if (
      connection === undefined ||
      connection.connectionId !== input.connectionId ||
      connection.connectionEpoch !== input.connectionEpoch
    ) {
      throw new RoomDomainError('STALE_CONNECTION');
    }
    return connection;
  };

  const snapshotNegotiation = (
    negotiation: RoomNegotiationState,
    room: TemporaryRoom,
  ): RoomNegotiationSnapshot => {
    const expectedEpochs = [...room.membersByUserId.keys()].map((userId) =>
      frozen({
        userId,
        connectionEpoch:
          negotiation.expectedConnectionEpochByUserId.get(userId) ?? -1,
      }),
    );
    return frozen({
      generation: negotiation.generation,
      negotiationId: negotiation.negotiationId,
      offererUserId: negotiation.offererUserId,
      expectedEpochs: Object.freeze(expectedEpochs),
      status: negotiation.status,
      offerState: negotiation.offerState,
      answerState: negotiation.answerState,
    });
  };

  const snapshotPendingReset = (
    reset: PendingNegotiationResetState | null,
  ): PendingNegotiationResetSnapshot | null => {
    if (reset === null || reset.consumed) {
      return null;
    }
    return frozen({
      generation: reset.generation,
      negotiationId: reset.negotiationId,
      reason: reset.reason,
    });
  };

  const snapshotLease = (
    lease: ScreenLeaseState | null,
  ): ScreenLeaseSnapshot | null => {
    if (lease === null) {
      return null;
    }
    return frozen({
      ownerUserId: lease.ownerUserId,
      connectionId: lease.connectionId,
      connectionEpoch: lease.connectionEpoch,
      leaseId: lease.leaseId,
      expiresAtMs: lease.expiresAtMs,
    });
  };

  const snapshotRoom = (room: TemporaryRoom): RoomSnapshot => {
    const members: RoomMemberSnapshot[] = [];
    for (const member of room.membersByUserId.values()) {
      const connection = room.connectionsByUserId.get(member.userId);
      members.push(
        frozen({
          userId: member.userId,
          displayName: member.displayName,
          role: member.role,
          online: connection !== undefined,
          ready: connection?.ready ?? false,
          connectionId: connection?.connectionId ?? null,
          currentEpoch:
            room.currentConnectionEpochByUserId.get(member.userId) ?? 0,
        }),
      );
    }
    return frozen({
      id: room.id,
      creatorUserId: room.creatorUserId,
      joinerUserId: room.joinerUserId,
      code: room.code,
      codeExpiresAtMs: room.codeExpiresAtMs,
      state: room.state,
      members: Object.freeze(members),
      activeNegotiation:
        room.activeNegotiation === null
          ? null
          : snapshotNegotiation(room.activeNegotiation, room),
      pendingNegotiationReset: snapshotPendingReset(
        room.pendingNegotiationReset,
      ),
      screenLease: snapshotLease(room.screenLease),
      closeAtMs: room.closeAtMs,
    });
  };

  const closedRoomSnapshot = (
    roomId: string,
    reason: RoomClosedReason,
  ): ClosedRoomSnapshot => frozen({ id: roomId, state: 'closed', reason });

  const allocateConnection = (
    room: TemporaryRoom,
    userId: string,
    connectionId: string,
  ): PeerConnectionState => {
    assertIdentifier(connectionId, 'connectionId');
    if (room.nextConnectionEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new RoomDomainError('INVALID_STATE');
    }
    room.nextConnectionEpoch += 1;
    const connection: PeerConnectionState = {
      connectionId,
      connectionEpoch: room.nextConnectionEpoch,
      ready: false,
    };
    room.connectionsByUserId.set(userId, connection);
    room.currentConnectionEpochByUserId.set(userId, connection.connectionEpoch);
    return connection;
  };

  const allMembersOnlineAndReady = (room: TemporaryRoom): boolean =>
    room.joinerUserId !== null &&
    [...room.membersByUserId.keys()].every(
      (userId) => room.connectionsByUserId.get(userId)?.ready === true,
    );

  const nextNegotiationGeneration = (room: TemporaryRoom): number => {
    if (room.negotiationGeneration >= maxNegotiationGeneration) {
      throw new RoomDomainError('INVALID_STATE');
    }
    room.negotiationGeneration += 1;
    return room.negotiationGeneration;
  };

  const createPendingReset = (
    room: TemporaryRoom,
    reason: NegotiationResetReason,
  ): PendingNegotiationResetState => {
    if (room.resetGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RoomDomainError('INVALID_STATE');
    }
    room.resetGeneration += 1;
    const negotiationId = randomUUID();
    assertIdentifier(negotiationId, 'negotiationId');
    const reset: PendingNegotiationResetState = {
      generation: room.resetGeneration,
      negotiationId,
      reason,
      consumed: false,
    };
    room.pendingNegotiationReset = reset;
    return reset;
  };

  const invalidateIncompleteNegotiation = (
    room: TemporaryRoom,
    reason: NegotiationResetReason,
  ): PendingNegotiationResetState | null => {
    if (
      room.activeNegotiation === null ||
      room.activeNegotiation.status === 'completed'
    ) {
      return null;
    }
    if (room.activeNegotiation.status === 'active') {
      room.activeNegotiation.status = 'abandoned';
    }
    if (
      room.pendingNegotiationReset !== null &&
      !room.pendingNegotiationReset.consumed
    ) {
      return room.pendingNegotiationReset;
    }
    return createPendingReset(room, reason);
  };

  const releaseLeaseForConnection = (
    room: TemporaryRoom,
    userId: string,
    connectionId: string,
    connectionEpoch: number,
  ): RoomIntent | null => {
    const lease = room.screenLease;
    if (
      lease === null ||
      lease.ownerUserId !== userId ||
      lease.connectionId !== connectionId ||
      lease.connectionEpoch !== connectionEpoch
    ) {
      return null;
    }
    cancelTimer(lease.timer);
    room.screenLease = null;
    return {
      type: 'screen.ownerChanged',
      roomId: room.id,
      ownerUserId: null,
      leaseId: null,
    };
  };

  const cancelGrace = (room: TemporaryRoom): void => {
    cancelTimer(room.graceTimer);
    room.graceTimer = null;
    room.closeAtMs = null;
  };

  const scheduleGraceExpiry = (room: TemporaryRoom): void => {
    const closeAtMs = room.closeAtMs;
    if (closeAtMs === null || room.connectionsByUserId.size > 0) {
      return;
    }
    room.graceTimer = scheduleTimer(
      Math.max(0, closeAtMs - operationTime(now)),
      () => {
        room.graceTimer = null;
        if (
          roomsById.get(room.id) !== room ||
          room.connectionsByUserId.size > 0 ||
          room.closeAtMs === null
        ) {
          return;
        }
        if (operationTime(now) < room.closeAtMs) {
          try {
            scheduleGraceExpiry(room);
          } catch {
            room.closeAtMs = null;
            cleanupRoomAsynchronously(room, 'expired');
          }
          return;
        }
        room.closeAtMs = null;
        cleanupRoomAsynchronously(room, 'expired');
      },
    );
  };

  const scheduleGraceIfEmpty = (room: TemporaryRoom): void => {
    if (room.connectionsByUserId.size > 0 || room.graceTimer !== null) {
      return;
    }
    const currentTime = operationTime(now);
    room.closeAtMs = currentTime + reconnectGraceMs;
    try {
      scheduleGraceExpiry(room);
    } catch (error) {
      room.closeAtMs = null;
      cleanupRoomAsynchronously(room, 'expired');
      throw error;
    }
  };

  const idempotencyKey = (userId: string, requestId: string): string =>
    JSON.stringify([userId, requestId]);

  const removeUserIdempotencyEntries = (
    room: TemporaryRoom,
    userId: string,
  ): void => {
    for (const key of [...room.requestCacheKeys]) {
      const decoded = JSON.parse(key) as [string, string];
      if (decoded[0] === userId) {
        removeIdempotencyEntry(key);
      }
    }
  };

  const addIdempotencyEntry = (key: string, entry: IdempotencyEntry): void => {
    while (idempotencyCache.size >= requestCacheMaxEntries) {
      const oldestKey = idempotencyCache.keys().next().value as
        string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      removeIdempotencyEntry(oldestKey);
    }
    idempotencyCache.set(key, entry);
    roomsById.get(entry.roomId)?.requestCacheKeys.add(key);
  };

  const withIdempotency = <Data>(input: {
    readonly userId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly signature: string;
    readonly mutate: () => RoomMutationResult<Data>;
    readonly roomIdFromData: (data: Data) => string;
  }): RoomMutationResult<Data> => {
    assertIdentifier(input.userId, 'userId');
    assertIdentifier(input.requestId, 'requestId');
    const key = idempotencyKey(input.userId, input.requestId);
    const cached = idempotencyCache.get(key);
    if (cached !== undefined) {
      if (
        cached.operation !== input.operation ||
        cached.signature !== input.signature
      ) {
        throw new RoomDomainError('INVALID_STATE');
      }
      idempotencyCache.delete(key);
      idempotencyCache.set(key, cached);
      return mutationResult(cached.data as Data, [], true);
    }

    const result = input.mutate();
    const roomId = input.roomIdFromData(result.data);
    if (roomsById.has(roomId)) {
      addIdempotencyEntry(key, {
        operation: input.operation,
        signature: input.signature,
        roomId,
        data: result.data,
      });
    }
    return result;
  };

  const inspectIdempotencyRequest = (input: {
    readonly userId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly signature: string;
  }): Readonly<{ key: string; cached: IdempotencyEntry | null }> => {
    assertIdentifier(input.userId, 'userId');
    assertIdentifier(input.requestId, 'requestId');
    const key = idempotencyKey(input.userId, input.requestId);
    const cached = idempotencyCache.get(key) ?? null;
    if (
      cached !== null &&
      (cached.operation !== input.operation ||
        cached.signature !== input.signature)
    ) {
      throw new RoomDomainError('INVALID_STATE');
    }
    return frozen({ key, cached });
  };

  const inspectRelayRequest = (input: {
    readonly userId: string;
    readonly requestId: string;
    readonly requestDigest: string;
    readonly operation: string;
  }): Readonly<{ key: string; cached: IdempotencyEntry | null }> => {
    assertRequestDigest(input.requestDigest);
    return inspectIdempotencyRequest({
      ...input,
      signature: input.requestDigest,
    });
  };

  const relayOperation = (operation: RelayRequestInput['operation']): string =>
    `relay.${operation}`;
  const answerRelayOperation = 'relay.webrtc.answer';

  const roomSessionData = (
    room: TemporaryRoom,
    userId: string,
    connection: PeerConnectionState,
  ): RoomSessionData =>
    frozen({
      room: snapshotRoom(room),
      role: room.membersByUserId.get(userId)!.role,
      connection: connectionIdentity(connection),
    });

  const reconnectMember = (
    room: TemporaryRoom,
    input: Readonly<{
      userId: string;
      displayName: string;
      connectionId: string;
    }>,
  ): RoomMutationResult<RoomSessionData> => {
    const member = requireMembership(room, input.userId);
    assertDisplayName(input.displayName);
    assertIdentifier(input.connectionId, 'connectionId');
    const previous = room.connectionsByUserId.get(input.userId);
    if (previous?.connectionId === input.connectionId) {
      throw new RoomDomainError('INVALID_STATE');
    }
    const intents: RoomIntent[] = [];
    if (previous !== undefined) {
      const leaseIntent = releaseLeaseForConnection(
        room,
        input.userId,
        previous.connectionId,
        previous.connectionEpoch,
      );
      if (leaseIntent !== null) {
        intents.push(leaseIntent);
      }
    }
    const connection = allocateConnection(
      room,
      input.userId,
      input.connectionId,
    );
    cancelGrace(room);
    if (room.activeNegotiation?.status === 'completed') {
      room.activeNegotiation.expectedConnectionEpochByUserId.set(
        input.userId,
        connection.connectionEpoch,
      );
    } else {
      invalidateIncompleteNegotiation(room, 'peer_resumed');
    }
    room.state = room.joinerUserId === null ? 'waiting' : 'reconnecting';
    if (previous !== undefined) {
      intents.push({
        type: 'connection.replaced',
        roomId: room.id,
        userId: input.userId,
        replacedConnectionId: previous.connectionId,
        replacedConnectionEpoch: previous.connectionEpoch,
        closeCode: REPLACED_CLOSE_CODE,
        reason: REPLACED_CLOSE_REASON,
      });
    }
    member.displayName = input.displayName;
    return mutationResult(
      roomSessionData(room, input.userId, connection),
      intents,
    );
  };

  const expireScreenLease = (
    room: TemporaryRoom,
    lease: ScreenLeaseState,
  ): void => {
    if (roomsById.get(room.id) !== room || room.screenLease !== lease) {
      return;
    }
    cancelTimer(lease.timer);
    lease.timer = null;
    room.screenLease = null;
    emitAsyncIntent({
      type: 'screen.ownerChanged',
      roomId: room.id,
      ownerUserId: null,
      leaseId: null,
    });
  };

  const scheduleLeaseExpiry = (
    room: TemporaryRoom,
    lease: ScreenLeaseState,
  ): void => {
    lease.timer = scheduleTimer(
      Math.max(0, lease.expiresAtMs - operationTime(now)),
      () => {
        lease.timer = null;
        if (roomsById.get(room.id) !== room || room.screenLease !== lease) {
          return;
        }
        if (lease.expiresAtMs > operationTime(now)) {
          try {
            scheduleLeaseExpiry(room, lease);
          } catch {
            expireScreenLease(room, lease);
          }
          return;
        }
        expireScreenLease(room, lease);
      },
    );
  };

  const expireLeaseIfDue = (room: TemporaryRoom): void => {
    const lease = room.screenLease;
    if (lease === null || lease.expiresAtMs > operationTime(now)) {
      return;
    }
    expireScreenLease(room, lease);
  };

  const scheduleCodeExpiry = (room: TemporaryRoom): void => {
    const expiresAtMs = room.codeExpiresAtMs;
    if (room.code === null || expiresAtMs === null) {
      return;
    }
    room.codeTimer = scheduleTimer(
      Math.max(0, expiresAtMs - operationTime(now)),
      () => {
        room.codeTimer = null;
        if (
          roomsById.get(room.id) !== room ||
          room.code === null ||
          room.codeExpiresAtMs === null
        ) {
          return;
        }
        if (operationTime(now) < room.codeExpiresAtMs) {
          try {
            scheduleCodeExpiry(room);
          } catch {
            cleanupRoomAsynchronously(room, 'expired');
          }
          return;
        }
        cleanupRoomAsynchronously(room, 'expired');
      },
    );
  };

  const registry: RoomRegistry = {
    create(input: CreateRoomInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'create',
        signature: JSON.stringify([input.connectionId, input.displayName]),
        roomIdFromData: ({ room }) => room.id,
        mutate: () => {
          assertIdentifier(input.connectionId, 'connectionId');
          assertDisplayName(input.displayName);
          if (roomsById.size >= maxRooms) {
            throw new RoomDomainError('CAPACITY_EXCEEDED');
          }
          let code: string | null = null;
          for (let attempt = 0; attempt < maxCodeAttempts; attempt += 1) {
            const candidate = generateRoomCode({ randomInt });
            if (!reservedRoomCodes.has(candidate)) {
              code = candidate;
              break;
            }
          }
          if (code === null) {
            throw new RoomDomainError('ROOM_CODE_EXHAUSTED');
          }

          const id = randomUUID();
          assertIdentifier(id, 'roomId');
          if (roomsById.has(id)) {
            throw new RoomDomainError('INVALID_STATE');
          }
          const createdAtMs = operationTime(now);
          const room: TemporaryRoom = {
            id,
            originalCode: code,
            creatorUserId: input.userId,
            joinerUserId: null,
            code,
            codeExpiresAtMs: createdAtMs + roomCodeTtlMs,
            state: 'waiting',
            membersByUserId: new Map([
              [
                input.userId,
                {
                  userId: input.userId,
                  displayName: input.displayName,
                  role: 'creator' as const,
                },
              ],
            ]),
            connectionsByUserId: new Map(),
            nextConnectionEpoch: 0,
            currentConnectionEpochByUserId: new Map(),
            activeNegotiation: null,
            negotiationGeneration: 0,
            pendingNegotiationReset: null,
            resetGeneration: 0,
            screenLease: null,
            closeAtMs: null,
            codeTimer: null,
            graceTimer: null,
            requestCacheKeys: new Set(),
            hasConnected: false,
          };
          const connection = allocateConnection(
            room,
            input.userId,
            input.connectionId,
          );
          roomsById.set(id, room);
          roomIdByCode.set(code, id);
          reservedRoomCodes.add(code);
          try {
            scheduleCodeExpiry(room);
          } catch (error) {
            roomsById.delete(id);
            roomIdByCode.delete(code);
            reservedRoomCodes.delete(code);
            throw error;
          }
          const data: CreatedRoomSessionData = frozen({
            room: snapshotRoom(room),
            role: 'creator',
            connection: connectionIdentity(connection),
            roomCode: code,
          });
          return mutationResult(data);
        },
      });
    },

    join(input: JoinRoomInput) {
      const recoveryRoomId = consumedRoomIdByJoinerCode.get(
        JSON.stringify([input.userId, input.roomCode]),
      );
      const recoveryRoom =
        recoveryRoomId === undefined
          ? undefined
          : roomsById.get(recoveryRoomId);
      if (
        recoveryRoom !== undefined &&
        recoveryRoom?.connectionsByUserId.get(input.userId)?.connectionId !==
          input.connectionId
      ) {
        const key = idempotencyKey(input.userId, input.requestId);
        if (idempotencyCache.get(key)?.operation === 'join') {
          removeIdempotencyEntry(key);
        }
      }
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'join',
        signature: JSON.stringify([
          input.roomCode,
          input.connectionId,
          input.displayName,
        ]),
        roomIdFromData: ({ room }) => room.id,
        mutate: () => {
          assertIdentifier(input.connectionId, 'connectionId');
          assertDisplayName(input.displayName);
          const recoveryRoomId = consumedRoomIdByJoinerCode.get(
            JSON.stringify([input.userId, input.roomCode]),
          );
          if (recoveryRoomId !== undefined) {
            const recoveryRoom = roomsById.get(recoveryRoomId);
            if (
              recoveryRoom === undefined ||
              expireGraceIfDue(recoveryRoom) ||
              recoveryRoom.joinerUserId !== input.userId ||
              recoveryRoom.originalCode !== input.roomCode
            ) {
              consumedRoomIdByJoinerCode.delete(
                JSON.stringify([input.userId, input.roomCode]),
              );
              throw new RoomDomainError('ROOM_CODE_INVALID');
            }
            return reconnectMember(recoveryRoom, input);
          }
          const roomId = /^\d{6}$/u.test(input.roomCode)
            ? roomIdByCode.get(input.roomCode)
            : undefined;
          const room = roomId === undefined ? undefined : roomsById.get(roomId);
          const graceExpired = room !== undefined && expireGraceIfDue(room);
          if (
            room === undefined ||
            graceExpired ||
            room.code !== input.roomCode ||
            room.codeExpiresAtMs === null ||
            room.codeExpiresAtMs <= operationTime(now) ||
            room.joinerUserId !== null ||
            room.creatorUserId === input.userId
          ) {
            if (
              room !== undefined &&
              room.codeExpiresAtMs !== null &&
              room.codeExpiresAtMs <= operationTime(now)
            ) {
              cleanupRoomAsynchronously(room, 'expired');
            }
            throw new RoomDomainError('ROOM_CODE_INVALID');
          }

          room.joinerUserId = input.userId;
          consumedRoomIdByJoinerCode.set(
            JSON.stringify([input.userId, input.roomCode]),
            room.id,
          );
          room.membersByUserId.set(input.userId, {
            userId: input.userId,
            displayName: input.displayName,
            role: 'joiner',
          });
          const connection = allocateConnection(
            room,
            input.userId,
            input.connectionId,
          );
          roomIdByCode.delete(input.roomCode);
          room.code = null;
          room.codeExpiresAtMs = null;
          cancelTimer(room.codeTimer);
          room.codeTimer = null;
          cancelGrace(room);
          room.state =
            room.connectionsByUserId.size === room.membersByUserId.size
              ? 'negotiating'
              : 'reconnecting';
          return mutationResult(
            roomSessionData(room, input.userId, connection),
            [{ type: 'peer.joined', roomId: room.id, userId: input.userId }],
          );
        },
      });
    },

    resume(input: ResumeRoomInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'resume',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.displayName,
        ]),
        roomIdFromData: ({ room }) => room.id,
        mutate: () => {
          const room = requireRoom(input.roomId);
          return reconnectMember(room, input);
        },
      });
    },

    bindReady(input: ReadyRoomInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'ready',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
        ]),
        roomIdFromData: ({ room }) => room.id,
        mutate: () => {
          const room = requireRoom(input.roomId);
          const connection = requireCurrentConnection(room, input);
          const changed = !connection.ready;
          connection.ready = true;
          if (room.joinerUserId === null) {
            room.state = 'waiting';
          } else if (
            room.connectionsByUserId.size < room.membersByUserId.size
          ) {
            room.state = 'reconnecting';
          } else if (allMembersOnlineAndReady(room)) {
            room.state =
              room.hasConnected &&
              (room.activeNegotiation === null ||
                room.activeNegotiation.status === 'completed') &&
              room.pendingNegotiationReset === null
                ? 'connected'
                : 'negotiating';
          } else {
            room.state =
              room.hasConnected ||
              room.activeNegotiation?.status === 'abandoned' ||
              room.pendingNegotiationReset !== null
                ? 'reconnecting'
                : 'negotiating';
          }
          return mutationResult(
            frozen({ room: snapshotRoom(room) }),
            changed
              ? [
                  {
                    type: 'peer.ready',
                    roomId: room.id,
                    userId: input.userId,
                  },
                ]
              : [],
          );
        },
      });
    },

    disconnect(input: DisconnectRoomInput) {
      const room = requireRoom(input.roomId);
      const connection = requireCurrentConnection(room, input);
      const intents: RoomIntent[] = [];
      const leaseIntent = releaseLeaseForConnection(
        room,
        input.userId,
        connection.connectionId,
        connection.connectionEpoch,
      );
      if (leaseIntent !== null) {
        intents.push(leaseIntent);
      }
      room.connectionsByUserId.delete(input.userId);
      removeUserIdempotencyEntries(room, input.userId);
      invalidateIncompleteNegotiation(room, 'signaling_reset');
      room.state = room.joinerUserId === null ? 'waiting' : 'reconnecting';
      intents.push({
        type: 'peer.left',
        roomId: room.id,
        userId: input.userId,
        reason: 'disconnected',
      });
      scheduleGraceIfEmpty(room);
      return mutationResult(frozen({ room: snapshotRoom(room) }), intents);
    },

    abortSessionSetup(input) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      cleanupRoomAsynchronously(room, 'signaling_error');
    },

    leave(input: LeaveRoomInput) {
      const room = requireRoom(input.roomId);
      const member = requireMembership(room, input.userId);
      requireCurrentConnection(room, input);
      const reason: RoomClosedReason =
        member.role === 'creator' ? 'creator_left' : 'ended';
      const intents: RoomIntent[] = [
        {
          type: 'peer.left',
          roomId: room.id,
          userId: input.userId,
          reason: 'left',
        },
        ...cleanupRoom(room, reason),
      ];
      return mutationResult(
        frozen({ room: closedRoomSnapshot(room.id, reason) }),
        intents,
      );
    },

    end(input: EndRoomInput) {
      const room = requireRoom(input.roomId);
      const member = requireMembership(room, input.userId);
      requireCurrentConnection(room, input);
      if (member.role !== 'creator') {
        throw new RoomDomainError('FORBIDDEN');
      }
      const intents = cleanupRoom(room, 'ended');
      return mutationResult(
        frozen({ room: closedRoomSnapshot(room.id, 'ended') }),
        intents,
      );
    },

    getCurrentConnectionSnapshot(input) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      expireLeaseIfDue(room);
      return snapshotRoom(room);
    },

    getMemberSnapshotForBroadcast(input: MemberRoomInput) {
      const room = requireRoom(input.roomId);
      requireMembership(room, input.userId);
      expireLeaseIfDue(room);
      return snapshotRoom(room);
    },

    beginNegotiation(input: BeginNegotiationInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'negotiation.begin',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
          input.negotiationId,
        ]),
        roomIdFromData: () => input.roomId,
        mutate: () => {
          const room = requireRoom(input.roomId);
          requireCurrentConnection(room, input);
          assertIdentifier(input.negotiationId, 'negotiationId');
          if (!allMembersOnlineAndReady(room)) {
            throw new RoomDomainError('INVALID_STATE');
          }

          const existing = room.activeNegotiation;
          const existingOffer = existing?.offerRelayIdentity;
          if (
            existing !== null &&
            existingOffer?.userId === input.userId &&
            existingOffer.requestId === input.requestId
          ) {
            if (
              existingOffer.operation !== 'webrtc.offer' ||
              existing.negotiationId !== input.negotiationId
            ) {
              throw new RoomDomainError('INVALID_STATE');
            }
            return mutationResult(
              frozen({ negotiation: snapshotNegotiation(existing, room) }),
              [],
              true,
            );
          }

          const pending = room.pendingNegotiationReset;
          if (room.activeNegotiation !== null || pending !== null) {
            if (
              pending === null ||
              !pending.consumed ||
              pending.negotiationId !== input.negotiationId
            ) {
              throw new RoomDomainError('STALE_NEGOTIATION');
            }
          }
          const expectedConnectionEpochByUserId = new Map<string, number>();
          for (const userId of room.membersByUserId.keys()) {
            const epoch = room.currentConnectionEpochByUserId.get(userId);
            if (epoch === undefined) {
              throw new RoomDomainError('INVALID_STATE');
            }
            expectedConnectionEpochByUserId.set(userId, epoch);
          }
          room.activeNegotiation = {
            generation: nextNegotiationGeneration(room),
            negotiationId: input.negotiationId,
            offererUserId: input.userId,
            expectedConnectionEpochByUserId,
            status: 'active',
            offerState: 'awaiting',
            answerState: 'awaiting',
            offerRelayIdentity: null,
            answerRelayIdentity: null,
            answerAppliedIdentity: null,
          };
          room.pendingNegotiationReset = null;
          room.state = 'negotiating';
          return mutationResult(
            frozen({
              negotiation: snapshotNegotiation(room.activeNegotiation, room),
            }),
          );
        },
      });
    },

    beginIceRestart(input: BeginIceRestartInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'negotiation.iceRestart',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
          input.negotiationId,
        ]),
        roomIdFromData: () => input.roomId,
        mutate: () => {
          const room = requireRoom(input.roomId);
          const member = requireMembership(room, input.userId);
          requireCurrentConnection(room, input);
          assertIdentifier(input.negotiationId, 'negotiationId');
          if (member.role !== 'creator') {
            throw new RoomDomainError('FORBIDDEN');
          }
          if (!allMembersOnlineAndReady(room)) {
            throw new RoomDomainError('INVALID_STATE');
          }
          const previous = room.activeNegotiation;
          const existingOffer = previous?.offerRelayIdentity;
          if (
            previous !== null &&
            existingOffer?.userId === input.userId &&
            existingOffer.requestId === input.requestId
          ) {
            if (
              existingOffer.operation !== 'webrtc.iceRestart' ||
              previous.negotiationId !== input.negotiationId
            ) {
              throw new RoomDomainError('INVALID_STATE');
            }
            return mutationResult(
              frozen({ negotiation: snapshotNegotiation(previous, room) }),
              [],
              true,
            );
          }
          if (
            previous === null ||
            previous.status !== 'completed' ||
            previous.negotiationId === input.negotiationId ||
            room.pendingNegotiationReset !== null
          ) {
            throw new RoomDomainError('STALE_NEGOTIATION');
          }

          const expectedConnectionEpochByUserId = new Map<string, number>();
          for (const userId of room.membersByUserId.keys()) {
            const epoch = room.currentConnectionEpochByUserId.get(userId);
            if (epoch === undefined) {
              throw new RoomDomainError('INVALID_STATE');
            }
            expectedConnectionEpochByUserId.set(userId, epoch);
          }
          room.activeNegotiation = {
            generation: nextNegotiationGeneration(room),
            negotiationId: input.negotiationId,
            offererUserId: input.userId,
            expectedConnectionEpochByUserId,
            status: 'active',
            offerState: 'awaiting',
            answerState: 'awaiting',
            offerRelayIdentity: null,
            answerRelayIdentity: null,
            answerAppliedIdentity: null,
          };
          room.state = 'negotiating';
          return mutationResult(
            frozen({
              negotiation: snapshotNegotiation(room.activeNegotiation, room),
            }),
          );
        },
      });
    },

    validateNegotiation(input: ValidateNegotiationInput) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const negotiation = room.activeNegotiation;
      if (
        negotiation === null ||
        negotiation.status === 'abandoned' ||
        negotiation.negotiationId !== input.negotiationId
      ) {
        throw new RoomDomainError('STALE_NEGOTIATION');
      }
      for (const [
        userId,
        expectedEpoch,
      ] of negotiation.expectedConnectionEpochByUserId) {
        if (room.currentConnectionEpochByUserId.get(userId) !== expectedEpoch) {
          throw new RoomDomainError('STALE_NEGOTIATION');
        }
      }
      return snapshotNegotiation(negotiation, room);
    },

    prepareOfferRelay(input: OfferRelayInput) {
      positiveSafeInteger(input.negotiationGeneration, 'negotiationGeneration');
      assertRequestDigest(input.requestDigest);
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const negotiation = room.activeNegotiation;
      if (
        negotiation === null ||
        negotiation.negotiationId !== input.negotiationId ||
        negotiation.generation !== input.negotiationGeneration ||
        negotiation.status === 'abandoned'
      ) {
        throw new RoomDomainError('STALE_NEGOTIATION');
      }
      registry.validateNegotiation(input);
      if (negotiation.offererUserId !== input.userId) {
        throw new RoomDomainError('FORBIDDEN');
      }
      const identity = negotiation.offerRelayIdentity;
      if (identity !== null) {
        if (
          identity.userId !== input.userId ||
          identity.requestId !== input.requestId ||
          identity.signature !== input.requestDigest ||
          identity.operation !== input.operation
        ) {
          throw new RoomDomainError('INVALID_STATE');
        }
        return frozen({ replayed: negotiation.offerState === 'queued' });
      }
      if (
        negotiation.status !== 'active' ||
        negotiation.offerState !== 'awaiting'
      ) {
        throw new RoomDomainError('INVALID_STATE');
      }
      negotiation.offerRelayIdentity = frozen({
        userId: input.userId,
        requestId: input.requestId,
        signature: input.requestDigest,
        operation: input.operation,
      });
      return frozen({ replayed: false });
    },

    confirmOfferRelay(input: OfferRelayInput) {
      positiveSafeInteger(input.negotiationGeneration, 'negotiationGeneration');
      assertRequestDigest(input.requestDigest);
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const negotiation = room.activeNegotiation;
      if (
        negotiation === null ||
        negotiation.negotiationId !== input.negotiationId ||
        negotiation.generation !== input.negotiationGeneration ||
        negotiation.status === 'abandoned'
      ) {
        throw new RoomDomainError('STALE_NEGOTIATION');
      }
      const identity = negotiation.offerRelayIdentity;
      if (
        identity === null ||
        identity.userId !== input.userId ||
        identity.requestId !== input.requestId ||
        identity.signature !== input.requestDigest ||
        identity.operation !== input.operation
      ) {
        throw new RoomDomainError('INVALID_STATE');
      }
      if (negotiation.offerState === 'queued') {
        return false;
      }
      if (negotiation.status !== 'active') {
        throw new RoomDomainError('INVALID_STATE');
      }
      negotiation.offerState = 'queued';
      return true;
    },

    prepareRelay(input: RelayRequestInput) {
      const inspected = inspectRelayRequest({
        ...input,
        operation: relayOperation(input.operation),
      });
      if (inspected.cached !== null) {
        return frozen({ replayed: true });
      }
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      return frozen({ replayed: false });
    },

    confirmRelay(input: RelayRequestInput) {
      const operation = relayOperation(input.operation);
      const inspected = inspectRelayRequest({ ...input, operation });
      if (inspected.cached !== null) {
        return false;
      }
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      addIdempotencyEntry(inspected.key, {
        operation,
        signature: input.requestDigest,
        roomId: room.id,
        data: frozen({}),
      });
      return true;
    },

    prepareAnswerRelay(input: AnswerRelayInput) {
      const inspected = inspectRelayRequest({
        ...input,
        operation: answerRelayOperation,
      });
      if (inspected.cached !== null) {
        const data = inspected.cached.data as Readonly<{
          negotiationGeneration: number;
        }>;
        return frozen({
          replayed: true,
          negotiationGeneration: data.negotiationGeneration,
        });
      }
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const localIdentity = room.activeNegotiation?.answerRelayIdentity;
      if (
        localIdentity?.userId === input.userId &&
        localIdentity.requestId === input.requestId
      ) {
        if (localIdentity.signature !== input.requestDigest) {
          throw new RoomDomainError('INVALID_STATE');
        }
        return frozen({
          replayed: true,
          negotiationGeneration: room.activeNegotiation!.generation,
        });
      }
      const negotiation = registry.validateNegotiation(input);
      if (
        negotiation.status !== 'active' ||
        negotiation.offerState !== 'queued' ||
        negotiation.answerState !== 'awaiting' ||
        negotiation.offererUserId === input.userId
      ) {
        throw new RoomDomainError('INVALID_STATE');
      }
      return frozen({
        replayed: false,
        negotiationGeneration: negotiation.generation,
      });
    },

    confirmAnswerRelay(input: ConfirmAnswerRelayInput) {
      positiveSafeInteger(input.negotiationGeneration, 'negotiationGeneration');
      const inspected = inspectRelayRequest({
        ...input,
        operation: answerRelayOperation,
      });
      if (inspected.cached !== null) {
        return false;
      }
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const negotiation = room.activeNegotiation;
      const localIdentity = negotiation?.answerRelayIdentity;
      if (
        localIdentity?.userId === input.userId &&
        localIdentity.requestId === input.requestId
      ) {
        if (localIdentity.signature !== input.requestDigest) {
          throw new RoomDomainError('INVALID_STATE');
        }
        return false;
      }
      if (
        negotiation === null ||
        negotiation.negotiationId !== input.negotiationId ||
        negotiation.generation !== input.negotiationGeneration
      ) {
        throw new RoomDomainError('STALE_NEGOTIATION');
      }
      if (
        negotiation.status !== 'active' ||
        negotiation.offerState !== 'queued' ||
        negotiation.answerState !== 'awaiting' ||
        negotiation.offererUserId === input.userId
      ) {
        throw new RoomDomainError('INVALID_STATE');
      }
      addIdempotencyEntry(inspected.key, {
        operation: answerRelayOperation,
        signature: input.requestDigest,
        roomId: room.id,
        data: frozen({
          negotiationGeneration: input.negotiationGeneration,
        }),
      });
      negotiation.answerRelayIdentity = frozen({
        userId: input.userId,
        requestId: input.requestId,
        signature: input.requestDigest,
      });
      negotiation.answerState = 'queued';
      return true;
    },

    completeNegotiation(input: CompleteNegotiationInput) {
      const operation = 'negotiation.complete';
      const signature = JSON.stringify([
        input.roomId,
        input.connectionId,
        input.connectionEpoch,
        input.negotiationId,
      ]);
      const inspected = inspectIdempotencyRequest({
        userId: input.userId,
        requestId: input.requestId,
        operation,
        signature,
      });
      if (inspected.cached !== null) {
        return mutationResult(
          inspected.cached.data as Readonly<{ room: RoomSnapshot }>,
          [],
          true,
        );
      }

      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const negotiation = room.activeNegotiation;
      const localIdentity = negotiation?.answerAppliedIdentity;
      if (
        localIdentity?.userId === input.userId &&
        localIdentity.requestId === input.requestId
      ) {
        if (localIdentity.signature !== signature) {
          throw new RoomDomainError('INVALID_STATE');
        }
        return mutationResult(frozen({ room: snapshotRoom(room) }), [], true);
      }

      const validated = registry.validateNegotiation(input);
      if (validated.status !== 'active') {
        throw new RoomDomainError('INVALID_STATE');
      }
      if (validated.answerState !== 'queued') {
        throw new RoomDomainError('INVALID_STATE');
      }
      if (validated.offererUserId !== input.userId) {
        throw new RoomDomainError('FORBIDDEN');
      }
      negotiation!.answerAppliedIdentity = frozen({
        userId: input.userId,
        requestId: input.requestId,
        signature,
      });
      negotiation!.status = 'completed';
      negotiation!.answerState = 'applied';
      room.pendingNegotiationReset = null;
      room.hasConnected = true;
      room.state = allMembersOnlineAndReady(room)
        ? 'connected'
        : 'reconnecting';
      const data = frozen({ room: snapshotRoom(room) });
      addIdempotencyEntry(inspected.key, {
        operation,
        signature,
        roomId: room.id,
        data,
      });
      return mutationResult(data);
    },

    markNegotiationDeliveryFailed(input) {
      const room = requireRoom(input.roomId);
      assertIdentifier(input.negotiationId, 'negotiationId');
      const negotiation = room.activeNegotiation;
      if (
        negotiation === null ||
        negotiation.negotiationId !== input.negotiationId ||
        negotiation.generation !== input.negotiationGeneration ||
        negotiation.status !== 'active'
      ) {
        return null;
      }

      negotiation.status = 'abandoned';
      const pending =
        room.pendingNegotiationReset !== null &&
        !room.pendingNegotiationReset.consumed
          ? room.pendingNegotiationReset
          : createPendingReset(room, 'signaling_reset');
      room.state = allMembersOnlineAndReady(room)
        ? 'negotiating'
        : 'reconnecting';
      return snapshotPendingReset(pending);
    },

    resetNegotiation(input: ResetNegotiationInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'negotiation.reset',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
          input.reason,
        ]),
        roomIdFromData: ({ room }) => room.id,
        mutate: () => {
          const room = requireRoom(input.roomId);
          requireCurrentConnection(room, input);
          if (room.activeNegotiation !== null) {
            room.activeNegotiation.status = 'abandoned';
          }
          const reset = createPendingReset(room, input.reason);
          room.state = allMembersOnlineAndReady(room)
            ? 'negotiating'
            : 'reconnecting';
          return mutationResult(
            frozen({
              room: snapshotRoom(room),
              reset: frozen({
                generation: reset.generation,
                negotiationId: reset.negotiationId,
                reason: reset.reason,
              }),
            }),
          );
        },
      });
    },

    peekPendingNegotiationReset(input) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      const reset = room.pendingNegotiationReset;
      if (reset === null || reset.consumed || !allMembersOnlineAndReady(room)) {
        return null;
      }
      return frozen({
        generation: reset.generation,
        negotiationId: reset.negotiationId,
        reason: reset.reason,
      });
    },

    confirmPendingNegotiationReset(input: ConfirmPendingNegotiationResetInput) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      assertIdentifier(input.negotiationId, 'negotiationId');
      const reset = room.pendingNegotiationReset;
      if (
        reset === null ||
        reset.consumed ||
        reset.generation !== input.generation ||
        reset.negotiationId !== input.negotiationId ||
        !allMembersOnlineAndReady(room)
      ) {
        return false;
      }
      reset.consumed = true;
      return true;
    },

    takePendingNegotiationReset(input) {
      const reset = registry.peekPendingNegotiationReset(input);
      if (reset === null) {
        return null;
      }
      return registry.confirmPendingNegotiationReset({ ...input, ...reset })
        ? reset
        : null;
    },

    getScreenLease(input) {
      const room = requireRoom(input.roomId);
      requireCurrentConnection(room, input);
      expireLeaseIfDue(room);
      return snapshotLease(room.screenLease);
    },

    setScreenLease(input: SetScreenLeaseInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'screen.set',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
          input.leaseId,
          input.expiresAtMs,
        ]),
        roomIdFromData: () => input.roomId,
        mutate: () => {
          const room = requireRoom(input.roomId);
          requireCurrentConnection(room, input);
          assertIdentifier(input.leaseId, 'leaseId');
          const currentTime = operationTime(now);
          if (
            !Number.isSafeInteger(input.expiresAtMs) ||
            input.expiresAtMs <= currentTime
          ) {
            throw new RoomDomainError('INVALID_STATE');
          }
          expireLeaseIfDue(room);
          const previous = room.screenLease;
          const isRenewal =
            previous !== null &&
            previous.ownerUserId === input.userId &&
            previous.connectionId === input.connectionId &&
            previous.connectionEpoch === input.connectionEpoch;
          if (previous !== null && !isRenewal) {
            throw new RoomDomainError('SCREEN_SHARE_BUSY');
          }
          if (previous !== null && previous.leaseId !== input.leaseId) {
            throw new RoomDomainError('LEASE_LOST');
          }
          const lease: ScreenLeaseState = {
            ownerUserId: input.userId,
            connectionId: input.connectionId,
            connectionEpoch: input.connectionEpoch,
            leaseId: input.leaseId,
            expiresAtMs: input.expiresAtMs,
            timer: null,
          };
          scheduleLeaseExpiry(room, lease);
          if (previous !== null) {
            cancelTimer(previous.timer);
          }
          room.screenLease = lease;
          return mutationResult(
            frozen({ lease: snapshotLease(lease)! }),
            isRenewal
              ? []
              : [
                  {
                    type: 'screen.ownerChanged',
                    roomId: room.id,
                    ownerUserId: input.userId,
                    leaseId: input.leaseId,
                  },
                ],
          );
        },
      });
    },

    releaseScreenLease(input: ReleaseScreenLeaseInput) {
      return withIdempotency({
        userId: input.userId,
        requestId: input.requestId,
        operation: 'screen.release',
        signature: JSON.stringify([
          input.roomId,
          input.connectionId,
          input.connectionEpoch,
          input.leaseId,
        ]),
        roomIdFromData: () => input.roomId,
        mutate: () => {
          const room = requireRoom(input.roomId);
          requireCurrentConnection(room, input);
          expireLeaseIfDue(room);
          const lease = room.screenLease;
          if (
            lease === null ||
            lease.ownerUserId !== input.userId ||
            lease.connectionId !== input.connectionId ||
            lease.connectionEpoch !== input.connectionEpoch ||
            lease.leaseId !== input.leaseId
          ) {
            throw new RoomDomainError('LEASE_LOST');
          }
          cancelTimer(lease.timer);
          room.screenLease = null;
          return mutationResult(frozen({ lease: null }), [
            {
              type: 'screen.ownerChanged',
              roomId: room.id,
              ownerUserId: null,
              leaseId: null,
            },
          ]);
        },
      });
    },

    getStats(): RoomRegistryStats {
      return frozen({
        rooms: roomsById.size,
        codes: roomIdByCode.size,
        idempotencyEntries: idempotencyCache.size,
        timers: timerCount,
      });
    },

    clear() {
      for (const room of [...roomsById.values()]) {
        cleanupRoom(room, 'expired');
      }
      roomIdByCode.clear();
      reservedRoomCodes.clear();
      consumedRoomIdByJoinerCode.clear();
      idempotencyCache.clear();
    },
  };

  return registry;
}
