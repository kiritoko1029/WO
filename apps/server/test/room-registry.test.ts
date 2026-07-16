import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  RoomDomainError,
  type RoomDomainErrorCode,
  type RoomRegistry,
} from '../src/modules/rooms/room-types.ts';
import { createRoomRegistry } from '../src/modules/rooms/room-registry.ts';

const ROOM_CODE_TTL_MS = 10 * 60 * 1_000;
const RECONNECT_GRACE_MS = 2 * 60 * 1_000;

function expectRoomError(
  operation: () => unknown,
  code: RoomDomainErrorCode,
): RoomDomainError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RoomDomainError);
    expect((error as RoomDomainError).code).toBe(code);
    return error as RoomDomainError;
  }
  throw new Error(`Expected RoomDomainError(${code})`);
}

interface HarnessOptions {
  readonly codeValues?: number[];
  readonly roomCodeTtlMs?: number;
  readonly reconnectGraceMs?: number;
  readonly maxCodeAttempts?: number;
  readonly requestCacheMaxEntries?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const codeValues = [...(options.codeValues ?? [])];
  let fallbackCode = 0;
  let uuidCount = 0;
  const asyncIntents: unknown[] = [];
  const registry = createRoomRegistry({
    now: options.now ?? Date.now,
    randomInt: () => codeValues.shift() ?? fallbackCode++,
    randomUUID: () => `generated-id-${++uuidCount}`,
    setTimer:
      options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer:
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
    onAsyncIntent: (intent) => asyncIntents.push(intent),
    roomCodeTtlMs: options.roomCodeTtlMs,
    reconnectGraceMs: options.reconnectGraceMs,
    maxCodeAttempts: options.maxCodeAttempts,
    requestCacheMaxEntries: options.requestCacheMaxEntries,
  });
  return {
    registry,
    asyncIntents,
    getUuidCount: () => uuidCount,
  };
}

function createRoom(
  registry: RoomRegistry,
  overrides: Partial<{
    userId: string;
    displayName: string;
    connectionId: string;
    requestId: string;
  }> = {},
) {
  return registry.create({
    userId: 'creator',
    displayName: 'Creator',
    connectionId: 'creator-connection-1',
    requestId: 'create-request-1',
    ...overrides,
  });
}

function joinRoom(
  registry: RoomRegistry,
  roomCode: string,
  overrides: Partial<{
    userId: string;
    displayName: string;
    connectionId: string;
    requestId: string;
  }> = {},
) {
  return registry.join({
    roomCode,
    userId: 'joiner',
    displayName: 'Joiner',
    connectionId: 'joiner-connection-1',
    requestId: 'join-request-1',
    ...overrides,
  });
}

function createJoinedRoom(registry: RoomRegistry) {
  const created = createRoom(registry).data;
  const joined = joinRoom(registry, created.roomCode).data;
  return { created, joined, roomId: created.room.id };
}

function readScreenLease(
  registry: RoomRegistry,
  roomId: string,
  userId: string,
  connection: {
    readonly connectionId: string;
    readonly connectionEpoch: number;
  },
) {
  return registry.getScreenLease({
    roomId,
    userId,
    connectionId: connection.connectionId,
    connectionEpoch: connection.connectionEpoch,
  });
}

function markBothReady(
  registry: RoomRegistry,
  fixture: ReturnType<typeof createJoinedRoom>,
) {
  registry.bindReady({
    roomId: fixture.roomId,
    userId: 'creator',
    connectionId: fixture.created.connection.connectionId,
    connectionEpoch: fixture.created.connection.connectionEpoch,
    requestId: 'creator-ready-1',
  });
  registry.bindReady({
    roomId: fixture.roomId,
    userId: 'joiner',
    connectionId: fixture.joined.connection.connectionId,
    connectionEpoch: fixture.joined.connection.connectionEpoch,
    requestId: 'joiner-ready-1',
  });
}

function connectRoom(
  registry: RoomRegistry,
  fixture: ReturnType<typeof createJoinedRoom>,
) {
  markBothReady(registry, fixture);
  registry.beginNegotiation({
    roomId: fixture.roomId,
    userId: 'creator',
    connectionId: fixture.created.connection.connectionId,
    connectionEpoch: fixture.created.connection.connectionEpoch,
    negotiationId: 'initial-negotiation',
    requestId: 'begin-negotiation-1',
  });
  registry.completeNegotiation({
    roomId: fixture.roomId,
    userId: 'joiner',
    connectionId: fixture.joined.connection.connectionId,
    connectionEpoch: fixture.joined.connection.connectionEpoch,
    negotiationId: 'initial-negotiation',
    requestId: 'complete-negotiation-1',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('room creation and joining', () => {
  test('retries code collisions without replacing the existing room', () => {
    const { registry } = createHarness({ codeValues: [42, 42, 43] });

    const first = createRoom(registry).data;
    const second = createRoom(registry, {
      userId: 'creator-2',
      connectionId: 'creator-2-connection',
      requestId: 'create-request-2',
    }).data;

    expect(first.roomCode).toBe('000042');
    expect(second.roomCode).toBe('000043');
    expect(second.room.id).not.toBe(first.room.id);
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: first.room.id,
        userId: 'creator',
      }).creatorUserId,
    ).toBe('creator');
  });

  test('bounds collision retries and preserves the prior code owner', () => {
    const { registry } = createHarness({
      codeValues: [42, 42, 42],
      maxCodeAttempts: 2,
    });
    const first = createRoom(registry).data;

    expectRoomError(
      () =>
        createRoom(registry, {
          userId: 'creator-2',
          connectionId: 'creator-2-connection',
          requestId: 'create-request-2',
        }),
      'ROOM_CODE_EXHAUSTED',
    );

    expect(registry.getStats()).toEqual({
      rooms: 1,
      codes: 1,
      idempotencyEntries: 1,
      timers: 1,
    });
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: first.room.id,
        userId: 'creator',
      }).creatorUserId,
    ).toBe('creator');
  });

  test('uses the exact configured code TTL and destroys an unjoined room', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;

    vi.advanceTimersByTime(ROOM_CODE_TTL_MS - 1);
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: created.room.id,
        userId: 'creator',
      }).codeExpiresAtMs,
    ).toBe(ROOM_CODE_TTL_MS);

    vi.advanceTimersByTime(1);
    expectRoomError(
      () =>
        registry.getMemberSnapshotForBroadcast({
          roomId: created.room.id,
          userId: 'creator',
        }),
      'ROOM_CLOSED',
    );
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });

  test('reschedules code expiry when wall time moves backward', () => {
    const { registry } = createHarness();
    createRoom(registry);

    vi.setSystemTime(-2);
    vi.advanceTimersByTime(ROOM_CODE_TTL_MS);
    expect(registry.getStats()).toEqual({
      rooms: 1,
      codes: 1,
      idempotencyEntries: 1,
      timers: 1,
    });

    vi.setSystemTime(ROOM_CODE_TTL_MS - 3);
    vi.advanceTimersByTime(2);
    expect(registry.getStats()).toEqual({
      rooms: 1,
      codes: 1,
      idempotencyEntries: 1,
      timers: 1,
    });

    vi.advanceTimersByTime(1);
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });

  test('binds one different joiner and immediately consumes the public code', () => {
    const { registry } = createHarness({ codeValues: [42] });
    const created = createRoom(registry).data;

    expectRoomError(
      () =>
        joinRoom(registry, created.roomCode, {
          userId: 'creator',
          connectionId: 'creator-second-connection',
        }),
      'ROOM_CODE_INVALID',
    );

    const joined = joinRoom(registry, created.roomCode).data;
    expect(joined.room.joinerUserId).toBe('joiner');
    expect(joined.room.code).toBeNull();
    expect(joined.room.codeExpiresAtMs).toBeNull();
    expect(joined.room.state).toBe('negotiating');
    expect(registry.getStats()).toMatchObject({ codes: 0, timers: 0 });

    for (const code of [created.roomCode, '999999']) {
      const error = expectRoomError(
        () =>
          joinRoom(registry, code, {
            userId: 'third-user',
            connectionId: `third-${code}`,
            requestId: `third-${code}`,
          }),
        'ROOM_CODE_INVALID',
      );
      expect(error.message).toBe('Room code is invalid');
    }
  });

  test('does not distinguish expired, consumed, and nonexistent codes', () => {
    const expiredHarness = createHarness({ codeValues: [1] });
    const expired = createRoom(expiredHarness.registry).data;
    vi.advanceTimersByTime(ROOM_CODE_TTL_MS);

    const consumedHarness = createHarness({ codeValues: [2] });
    const consumed = createRoom(consumedHarness.registry).data;
    joinRoom(consumedHarness.registry, consumed.roomCode);

    const errors = [
      expectRoomError(
        () => joinRoom(expiredHarness.registry, expired.roomCode),
        'ROOM_CODE_INVALID',
      ),
      expectRoomError(
        () =>
          joinRoom(consumedHarness.registry, consumed.roomCode, {
            userId: 'third-user',
            requestId: 'third-consumed',
          }),
        'ROOM_CODE_INVALID',
      ),
      expectRoomError(
        () =>
          joinRoom(consumedHarness.registry, '999999', {
            userId: 'fourth-user',
            connectionId: 'fourth-connection',
            requestId: 'fourth-nonexistent',
          }),
        'ROOM_CODE_INVALID',
      ),
    ];

    expect(new Set(errors.map(({ message }) => message))).toEqual(
      new Set(['Room code is invalid']),
    );
  });

  test('joining an offline creator cancels waiting-room grace', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;
    registry.disconnect({
      roomId: created.room.id,
      userId: 'creator',
      connectionId: created.connection.connectionId,
      connectionEpoch: created.connection.connectionEpoch,
    });
    expect(registry.getStats().timers).toBe(2);

    const joined = joinRoom(registry, created.roomCode).data;

    expect(joined.room).toMatchObject({
      state: 'reconnecting',
      closeAtMs: null,
    });
    expect(registry.getStats().timers).toBe(0);
  });

  test('keeps the offline creator display name in the join snapshot', () => {
    const { registry } = createHarness();
    const created = createRoom(registry, {
      displayName: 'Creator One',
    }).data;
    registry.disconnect({
      roomId: created.room.id,
      userId: 'creator',
      connectionId: created.connection.connectionId,
      connectionEpoch: created.connection.connectionEpoch,
    });

    const joined = joinRoom(registry, created.roomCode, {
      displayName: 'Joiner Two',
    }).data;

    expect(joined.room.members).toEqual([
      expect.objectContaining({
        userId: 'creator',
        displayName: 'Creator One',
        online: false,
      }),
      expect.objectContaining({
        userId: 'joiner',
        displayName: 'Joiner Two',
        online: true,
      }),
    ]);
  });

  test.each(['', ' padded ', 'x'.repeat(101)])(
    'rejects non-canonical display name %j',
    (displayName) => {
      const { registry } = createHarness();

      expect(() => createRoom(registry, { displayName })).toThrow(TypeError);
      expect(registry.getStats()).toEqual({
        rooms: 0,
        codes: 0,
        idempotencyEntries: 0,
        timers: 0,
      });
    },
  );
});

describe('connection epochs, replacement, and room lifetime', () => {
  test('rejects a replaced connection from current-only room and lease reads', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;
    const resumed = registry.resume({
      roomId: created.room.id,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    registry.setScreenLease({
      roomId: created.room.id,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });
    const staleInput = {
      roomId: created.room.id,
      userId: 'creator',
      connectionId: created.connection.connectionId,
      connectionEpoch: created.connection.connectionEpoch,
    };

    expectRoomError(
      () => registry.getCurrentConnectionSnapshot(staleInput),
      'STALE_CONNECTION',
    );
    expectRoomError(
      () => registry.getScreenLease(staleInput),
      'STALE_CONNECTION',
    );
    expect(
      registry.getCurrentConnectionSnapshot({
        roomId: created.room.id,
        userId: 'creator',
        connectionId: resumed.connection.connectionId,
        connectionEpoch: resumed.connection.connectionEpoch,
      }).screenLease?.leaseId,
    ).toBe('lease-1');
  });

  test('returns replacement closure as data without invoking an external handle', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;
    const externalClose = vi.fn();
    const resumeInput = {
      roomId: created.room.id,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
      connection: { close: externalClose },
    } as unknown as Parameters<RoomRegistry['resume']>[0];

    const resumed = registry.resume(resumeInput);

    expect(externalClose).not.toHaveBeenCalled();
    expect(resumed.intents).toContainEqual({
      type: 'connection.replaced',
      roomId: created.room.id,
      userId: 'creator',
      replacedConnectionId: created.connection.connectionId,
      replacedConnectionEpoch: created.connection.connectionEpoch,
      closeCode: 4409,
      reason: 'SESSION_REPLACED',
    });
    expect(
      registry.getCurrentConnectionSnapshot({
        roomId: created.room.id,
        userId: 'creator',
        connectionId: resumed.data.connection.connectionId,
        connectionEpoch: resumed.data.connection.connectionEpoch,
      }).members[0],
    ).toMatchObject({
      online: true,
      connectionId: resumed.data.connection.connectionId,
      currentEpoch: resumed.data.connection.connectionEpoch,
    });
    expect(JSON.stringify(resumed)).not.toContain('function');
  });

  test('lets only bound accounts resume and advances only their epoch', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    const oldCreatorEpoch = fixture.created.connection.connectionEpoch;
    const joinerEpoch = fixture.joined.connection.connectionEpoch;

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;

    expect(resumed.connection.connectionEpoch).toBeGreaterThan(oldCreatorEpoch);
    const snapshot = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'joiner',
    });
    expect(
      snapshot.members.find(({ userId }) => userId === 'joiner')?.currentEpoch,
    ).toBe(joinerEpoch);
    expectRoomError(
      () =>
        registry.resume({
          roomId: fixture.roomId,
          userId: 'third-user',
          displayName: 'Third User',
          connectionId: 'third-connection',
          requestId: 'third-resume',
        }),
      'NOT_ROOM_MEMBER',
    );
    expectRoomError(
      () =>
        registry.resume({
          roomId: 'missing-room',
          userId: 'creator',
          displayName: 'Creator',
          connectionId: 'creator-connection-3',
          requestId: 'missing-resume',
        }),
      'ROOM_CLOSED',
    );
  });

  test('refreshes the bound member display name on resume', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator Renamed',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;

    expect(
      resumed.room.members.find(({ userId }) => userId === 'creator')
        ?.displayName,
    ).toBe('Creator Renamed');
  });

  test('a delayed old close cannot disconnect its replacement or start grace', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;
    const resumed = registry.resume({
      roomId: created.room.id,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;

    expectRoomError(
      () =>
        registry.disconnect({
          roomId: created.room.id,
          userId: 'creator',
          connectionId: created.connection.connectionId,
          connectionEpoch: created.connection.connectionEpoch,
        }),
      'STALE_CONNECTION',
    );
    const snapshot = registry.getMemberSnapshotForBroadcast({
      roomId: created.room.id,
      userId: 'creator',
    });
    expect(snapshot.members[0]).toMatchObject({
      online: true,
      connectionId: resumed.connection.connectionId,
      currentEpoch: resumed.connection.connectionEpoch,
    });
    expect(snapshot.closeAtMs).toBeNull();
    expect(registry.getStats().timers).toBe(1);
  });

  test('keeps a room resumable with one peer online and gates cleanup on both offline', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);

    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'joiner',
      }),
    ).toMatchObject({ state: 'reconnecting', closeAtMs: null });
    expect(registry.getStats().timers).toBe(0);

    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'joiner',
      connectionId: fixture.joined.connection.connectionId,
      connectionEpoch: fixture.joined.connection.connectionEpoch,
    });
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }).closeAtMs,
    ).toBe(RECONNECT_GRACE_MS);
    expect(registry.getStats().timers).toBe(1);

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expectRoomError(
      () =>
        registry.getMemberSnapshotForBroadcast({
          roomId: fixture.roomId,
          userId: 'creator',
        }),
      'ROOM_CLOSED',
    );
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });

  test('resume before grace expiry cancels cleanup', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'joiner',
      connectionId: fixture.joined.connection.connectionId,
      connectionEpoch: fixture.joined.connection.connectionEpoch,
    });

    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    });
    vi.advanceTimersByTime(1);

    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }),
    ).toMatchObject({ state: 'reconnecting', closeAtMs: null });
    expect(registry.getStats().timers).toBe(0);
  });

  test('reschedules grace through repeated early callbacks and expires once', () => {
    const { registry, asyncIntents } = createHarness();
    const fixture = createJoinedRoom(registry);
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'joiner',
      connectionId: fixture.joined.connection.connectionId,
      connectionEpoch: fixture.joined.connection.connectionEpoch,
    });

    vi.setSystemTime(-2);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }).closeAtMs,
    ).toBe(RECONNECT_GRACE_MS);
    expect(registry.getStats().timers).toBe(1);

    vi.setSystemTime(RECONNECT_GRACE_MS - 3);
    vi.advanceTimersByTime(2);
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'joiner',
      }).closeAtMs,
    ).toBe(RECONNECT_GRACE_MS);
    expect(registry.getStats().timers).toBe(1);

    vi.advanceTimersByTime(1);
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
    expect(
      asyncIntents.filter(
        (intent) => (intent as { type?: string }).type === 'room.closed',
      ),
    ).toEqual([
      {
        type: 'room.closed',
        roomId: fixture.roomId,
        reason: 'expired',
      },
    ]);
  });

  test('enforces grace synchronously before a delayed timer callback', () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const { registry, asyncIntents } = createHarness({
      now: () => now,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
    });
    const fixture = createJoinedRoom(registry);
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'joiner',
      connectionId: fixture.joined.connection.connectionId,
      connectionEpoch: fixture.joined.connection.connectionEpoch,
    });
    const delayedGraceCallback = callbacks.at(-1)!;
    now = RECONNECT_GRACE_MS;

    expectRoomError(
      () =>
        registry.resume({
          roomId: fixture.roomId,
          userId: 'creator',
          displayName: 'Creator',
          connectionId: 'creator-connection-2',
          requestId: 'creator-resume-1',
        }),
      'ROOM_CLOSED',
    );
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });

    delayedGraceCallback();
    expect(
      asyncIntents.filter(
        (intent) => (intent as { type?: string }).type === 'room.closed',
      ),
    ).toHaveLength(1);
  });

  test.each(['creator', 'joiner'] as const)(
    '%s explicit leave closes and cleans the entire temporary room',
    (leavingUser) => {
      const { registry } = createHarness();
      const fixture = createJoinedRoom(registry);
      const own = leavingUser === 'creator' ? fixture.created : fixture.joined;

      const result = registry.leave({
        roomId: fixture.roomId,
        userId: leavingUser,
        connectionId: own.connection.connectionId,
        connectionEpoch: own.connection.connectionEpoch,
      });

      expect(result.data.room).toMatchObject({
        id: fixture.roomId,
        state: 'closed',
      });
      expect(registry.getStats()).toEqual({
        rooms: 0,
        codes: 0,
        idempotencyEntries: 0,
        timers: 0,
      });
      // Task 10's per-connection ACK cache handles wire retries; the domain keeps no tombstone.
      expectRoomError(
        () =>
          registry.leave({
            roomId: fixture.roomId,
            userId: leavingUser,
            connectionId: own.connection.connectionId,
            connectionEpoch: own.connection.connectionEpoch,
          }),
        'ROOM_CLOSED',
      );
    },
  );

  test('only the creator can end and cleanup is immediate and idempotent internally', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    expectRoomError(
      () =>
        registry.end({
          roomId: fixture.roomId,
          userId: 'joiner',
          connectionId: fixture.joined.connection.connectionId,
          connectionEpoch: fixture.joined.connection.connectionEpoch,
        }),
      'FORBIDDEN',
    );

    const ended = registry.end({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });
    expect(ended.data.room).toEqual({
      id: fixture.roomId,
      state: 'closed',
      reason: 'ended',
    });
    registry.clear();
    registry.clear();
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
    expectRoomError(
      () =>
        registry.end({
          roomId: fixture.roomId,
          userId: 'creator',
          connectionId: fixture.created.connection.connectionId,
          connectionEpoch: fixture.created.connection.connectionEpoch,
        }),
      'ROOM_CLOSED',
    );
  });

  test('a fresh registry has no rooms after service restart', () => {
    const first = createHarness();
    const created = createRoom(first.registry).data;
    const restarted = createHarness();

    expectRoomError(
      () =>
        restarted.registry.resume({
          roomId: created.room.id,
          userId: 'creator',
          displayName: 'Creator',
          connectionId: 'creator-after-restart',
          requestId: 'resume-after-restart',
        }),
      'ROOM_CLOSED',
    );
    expect(restarted.registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });
});

describe('idempotency and immutable snapshots', () => {
  test('replays a duplicate create without allocating or emitting again', () => {
    const { registry, getUuidCount } = createHarness({ codeValues: [42] });
    const input = {
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-1',
      requestId: 'create-request-1',
    };

    const first = registry.create(input);
    const duplicate = registry.create(input);

    expect(duplicate).toEqual({
      data: first.data,
      intents: [],
      replayed: true,
    });
    expect(getUuidCount()).toBe(1);
    expect(registry.getStats()).toMatchObject({
      rooms: 1,
      codes: 1,
      idempotencyEntries: 1,
    });
  });

  test('replays a duplicate join without repeating mutation or broadcast intent', () => {
    const { registry } = createHarness();
    const created = createRoom(registry).data;
    const input = {
      roomCode: created.roomCode,
      userId: 'joiner',
      displayName: 'Joiner',
      connectionId: 'joiner-connection-1',
      requestId: 'join-request-1',
    };

    const first = registry.join(input);
    const duplicate = registry.join(input);

    expect(first.intents.map(({ type }) => type)).toContain('peer.joined');
    expect(duplicate).toEqual({
      data: first.data,
      intents: [],
      replayed: true,
    });
    expect(duplicate.data.connection.connectionEpoch).toBe(
      first.data.connection.connectionEpoch,
    );
  });

  test('rejects reuse of one request ID for different input', () => {
    const { registry } = createHarness();
    createRoom(registry);

    expectRoomError(
      () =>
        createRoom(registry, {
          connectionId: 'creator-connection-2',
        }),
      'INVALID_STATE',
    );
  });

  test('rejects reuse of a create request ID with a different display name', () => {
    const { registry } = createHarness();
    createRoom(registry, { displayName: 'Creator One' });

    expectRoomError(
      () => createRoom(registry, { displayName: 'Creator Two' }),
      'INVALID_STATE',
    );
  });

  test('bounds the request cache', () => {
    const { registry } = createHarness({ requestCacheMaxEntries: 2 });
    const fixture = createJoinedRoom(registry);
    registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      requestId: 'creator-ready-1',
    });

    expect(registry.getStats().idempotencyEntries).toBe(2);
  });

  test('returns deeply immutable snapshots without maps, dates, or handles', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    const snapshot = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    });
    const originalJoiner = snapshot.joinerUserId;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.members)).toBe(true);
    expect(Object.isFrozen(snapshot.members[0]!)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('"handle"');
    expect(JSON.stringify(snapshot)).not.toContain('"timer"');
    expect(JSON.stringify(snapshot)).not.toContain('Map');
    expect(() => {
      (snapshot as { joinerUserId: string | null }).joinerUserId = 'attacker';
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.members as unknown as Array<unknown>).push({});
    }).toThrow(TypeError);

    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }).joinerUserId,
    ).toBe(originalJoiner);
  });
});

describe('negotiation epochs and reset delivery', () => {
  test('stays negotiating while initially connected peers become ready', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);

    const firstReady = registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      requestId: 'creator-ready-1',
    });
    expect(firstReady.data.room.state).toBe('negotiating');

    const bothReady = registry.bindReady({
      roomId: fixture.roomId,
      userId: 'joiner',
      connectionId: fixture.joined.connection.connectionId,
      connectionEpoch: fixture.joined.connection.connectionEpoch,
      requestId: 'joiner-ready-1',
    });
    expect(bothReady.data.room.state).toBe('negotiating');
  });

  test('snapshots both epochs and validates only a current active negotiation', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);

    const begun = registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });
    expect(begun.data.negotiation).toMatchObject({
      negotiationId: 'negotiation-1',
      offererUserId: 'creator',
      status: 'active',
    });
    expect(begun.data.negotiation.expectedEpochs).toEqual([
      {
        userId: 'creator',
        connectionEpoch: fixture.created.connection.connectionEpoch,
      },
      {
        userId: 'joiner',
        connectionEpoch: fixture.joined.connection.connectionEpoch,
      },
    ]);
    expect(
      registry.validateNegotiation({
        roomId: fixture.roomId,
        userId: 'joiner',
        connectionId: fixture.joined.connection.connectionId,
        connectionEpoch: fixture.joined.connection.connectionEpoch,
        negotiationId: 'negotiation-1',
      }).negotiationId,
    ).toBe('negotiation-1');
    expectRoomError(
      () =>
        registry.validateNegotiation({
          roomId: fixture.roomId,
          userId: 'joiner',
          connectionId: fixture.joined.connection.connectionId,
          connectionEpoch: fixture.joined.connection.connectionEpoch,
          negotiationId: 'wrong-negotiation',
        }),
      'STALE_NEGOTIATION',
    );
  });

  test('completes an active negotiation and enters connected state', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);

    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }),
    ).toMatchObject({
      state: 'connected',
      activeNegotiation: {
        negotiationId: 'initial-negotiation',
        status: 'completed',
      },
    });
  });

  test('validates candidate-style signaling after the answer completes', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);

    expect(
      registry.validateNegotiation({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: fixture.created.connection.connectionId,
        connectionEpoch: fixture.created.connection.connectionEpoch,
        negotiationId: 'initial-negotiation',
      }).status,
    ).toBe('completed');
  });

  test('rejects a second completion request for an already completed answer', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);

    expectRoomError(
      () =>
        registry.completeNegotiation({
          roomId: fixture.roomId,
          userId: 'joiner',
          connectionId: fixture.joined.connection.connectionId,
          connectionEpoch: fixture.joined.connection.connectionEpoch,
          negotiationId: 'initial-negotiation',
          requestId: 'complete-negotiation-2',
        }),
      'INVALID_STATE',
    );
  });

  test('keeps completed negotiation usable across a stable socket replacement', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
      requestId: 'creator-ready-2',
    });

    const snapshot = registry.getCurrentConnectionSnapshot({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
    });
    expect(snapshot.pendingNegotiationReset).toBeNull();
    expect(snapshot.activeNegotiation?.status).toBe('completed');
    expect(
      registry.validateNegotiation({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: resumed.connection.connectionId,
        connectionEpoch: resumed.connection.connectionEpoch,
        negotiationId: 'initial-negotiation',
      }).status,
    ).toBe('completed');
  });

  test('explicit reset abandons completed negotiation and admits its new ID', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);
    const reset = registry.resetNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      reason: 'signaling_reset',
      requestId: 'reset-completed-1',
    }).data.reset;
    expect(
      registry.getCurrentConnectionSnapshot({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: fixture.created.connection.connectionId,
        connectionEpoch: fixture.created.connection.connectionEpoch,
      }).activeNegotiation?.status,
    ).toBe('abandoned');
    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: fixture.created.connection.connectionId,
        connectionEpoch: fixture.created.connection.connectionEpoch,
      }),
    ).toEqual(reset);

    expect(
      registry.beginNegotiation({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: fixture.created.connection.connectionId,
        connectionEpoch: fixture.created.connection.connectionEpoch,
        negotiationId: reset.negotiationId,
        requestId: 'begin-reset-completed-1',
      }).data.negotiation,
    ).toMatchObject({
      negotiationId: reset.negotiationId,
      status: 'active',
    });
  });

  test('stable connected socket replacement does not reset healthy WebRTC', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    connectRoom(registry, fixture);

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
      requestId: 'creator-ready-2',
    });

    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: resumed.connection.connectionId,
        connectionEpoch: resumed.connection.connectionEpoch,
      }),
    ).toBeNull();
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }).state,
    ).toBe('connected');
  });

  test('replacement during negotiation abandons but never rewrites the old snapshot', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });
    const oldExpectedEpochs = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    }).activeNegotiation?.expectedEpochs;

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    const snapshot = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'joiner',
    });

    expect(snapshot.activeNegotiation).toMatchObject({
      negotiationId: 'negotiation-1',
      status: 'abandoned',
      expectedEpochs: oldExpectedEpochs,
    });
    expect(snapshot.pendingNegotiationReset).toMatchObject({
      generation: 1,
      reason: 'peer_resumed',
    });
    expect(snapshot.pendingNegotiationReset?.negotiationId).not.toBe(
      'negotiation-1',
    );
    expect(
      snapshot.members.find(({ userId }) => userId === 'joiner')?.currentEpoch,
    ).toBe(fixture.joined.connection.connectionEpoch);
    expectRoomError(
      () =>
        registry.validateNegotiation({
          roomId: fixture.roomId,
          userId: 'creator',
          connectionId: resumed.connection.connectionId,
          connectionEpoch: resumed.connection.connectionEpoch,
          negotiationId: 'negotiation-1',
        }),
      'STALE_NEGOTIATION',
    );
  });

  test('coalesces one pending reset while both incomplete negotiation sockets are replaced', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });
    const expectedEpochs = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    }).activeNegotiation!.expectedEpochs;

    const resumedCreator = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    const firstReset = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    }).pendingNegotiationReset!;
    const resumedJoiner = registry.resume({
      roomId: fixture.roomId,
      userId: 'joiner',
      displayName: 'Joiner',
      connectionId: 'joiner-connection-2',
      requestId: 'joiner-resume-1',
    }).data;
    const afterBothReplaced = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    });

    expect(afterBothReplaced.pendingNegotiationReset).toEqual(firstReset);
    expect(afterBothReplaced.activeNegotiation).toMatchObject({
      negotiationId: 'negotiation-1',
      status: 'abandoned',
      expectedEpochs,
    });
    expect(resumedJoiner.connection.connectionEpoch).toBeGreaterThan(
      fixture.joined.connection.connectionEpoch,
    );

    for (const [userId, session, requestId] of [
      ['creator', resumedCreator, 'creator-ready-2'],
      ['joiner', resumedJoiner, 'joiner-ready-2'],
    ] as const) {
      registry.bindReady({
        roomId: fixture.roomId,
        userId,
        connectionId: session.connection.connectionId,
        connectionEpoch: session.connection.connectionEpoch,
        requestId,
      });
    }
    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: resumedCreator.connection.connectionId,
        connectionEpoch: resumedCreator.connection.connectionEpoch,
      }),
    ).toEqual(firstReset);
    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'joiner',
        connectionId: resumedJoiner.connection.connectionId,
        connectionEpoch: resumedJoiner.connection.connectionEpoch,
      }),
    ).toBeNull();
  });

  test('creates a new reset when another replacement follows reset consumption', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });
    const resumedCreator = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;
    registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumedCreator.connection.connectionId,
      connectionEpoch: resumedCreator.connection.connectionEpoch,
      requestId: 'creator-ready-2',
    });
    const consumed = registry.takePendingNegotiationReset({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumedCreator.connection.connectionId,
      connectionEpoch: resumedCreator.connection.connectionEpoch,
    })!;

    registry.resume({
      roomId: fixture.roomId,
      userId: 'joiner',
      displayName: 'Joiner',
      connectionId: 'joiner-connection-2',
      requestId: 'joiner-resume-1',
    });
    const nextReset = registry.getMemberSnapshotForBroadcast({
      roomId: fixture.roomId,
      userId: 'creator',
    }).pendingNegotiationReset!;

    expect(nextReset.generation).toBe(consumed.generation + 1);
    expect(nextReset.negotiationId).not.toBe(consumed.negotiationId);
  });

  test('delivers the latest pending reset once when both replacement sockets are ready', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });
    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    }).data;

    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'joiner',
        connectionId: fixture.joined.connection.connectionId,
        connectionEpoch: fixture.joined.connection.connectionEpoch,
      }),
    ).toBeNull();
    registry.bindReady({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
      requestId: 'creator-ready-2',
    });
    const reset = registry.takePendingNegotiationReset({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
    });
    expect(reset).toMatchObject({ generation: 1, reason: 'peer_resumed' });
    expect(
      registry.takePendingNegotiationReset({
        roomId: fixture.roomId,
        userId: 'joiner',
        connectionId: fixture.joined.connection.connectionId,
        connectionEpoch: fixture.joined.connection.connectionEpoch,
      }),
    ).toBeNull();

    expectRoomError(
      () =>
        registry.beginNegotiation({
          roomId: fixture.roomId,
          userId: 'creator',
          connectionId: resumed.connection.connectionId,
          connectionEpoch: resumed.connection.connectionEpoch,
          negotiationId: 'invented-reset-id',
          requestId: 'bad-reset-begin',
        }),
      'STALE_NEGOTIATION',
    );
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
      negotiationId: reset!.negotiationId,
      requestId: 'reset-begin',
    });
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }).pendingNegotiationReset,
    ).toBeNull();
  });

  test('explicit signaling reset creates a fresh generation without SDP storage', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    markBothReady(registry, fixture);
    registry.beginNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      negotiationId: 'negotiation-1',
      requestId: 'begin-negotiation-1',
    });

    registry.resetNegotiation({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
      reason: 'signaling_reset',
      requestId: 'reset-negotiation-1',
    });
    const serialized = JSON.stringify(
      registry.getMemberSnapshotForBroadcast({
        roomId: fixture.roomId,
        userId: 'creator',
      }),
    );
    expect(serialized).not.toContain('sdp');
    expect(serialized).not.toContain('candidate');
    expect(serialized).toContain('signaling_reset');
  });
});

describe('connection-bound screen leases', () => {
  test('acquires, renews, authorizes, and explicitly releases one lease', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;

    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });
    expect(
      readScreenLease(
        registry,
        fixture.roomId,
        'joiner',
        fixture.joined.connection,
      ),
    ).toEqual({
      ownerUserId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
    });
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 20_000,
      requestId: 'lease-renew-1',
    });
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator)
        ?.expiresAtMs,
    ).toBe(20_000);

    registry.releaseScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      requestId: 'lease-release-1',
    });
    expect(
      readScreenLease(
        registry,
        fixture.roomId,
        'joiner',
        fixture.joined.connection,
      ),
    ).toBeNull();
  });

  test('rejects another owner and stale release without changing the lease', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;
    const joiner = fixture.joined.connection;
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });

    expectRoomError(
      () =>
        registry.setScreenLease({
          roomId: fixture.roomId,
          userId: 'joiner',
          connectionId: joiner.connectionId,
          connectionEpoch: joiner.connectionEpoch,
          leaseId: 'lease-2',
          expiresAtMs: 15_000,
          requestId: 'lease-set-2',
        }),
      'SCREEN_SHARE_BUSY',
    );
    expectRoomError(
      () =>
        registry.releaseScreenLease({
          roomId: fixture.roomId,
          userId: 'creator',
          connectionId: creator.connectionId,
          connectionEpoch: creator.connectionEpoch,
          leaseId: 'wrong-lease',
          requestId: 'lease-release-wrong',
        }),
      'LEASE_LOST',
    );
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator)?.leaseId,
    ).toBe('lease-1');
  });

  test('replacement releases only the replaced connection lease', () => {
    const { registry } = createHarness();
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });

    const resumed = registry.resume({
      roomId: fixture.roomId,
      userId: 'creator',
      displayName: 'Creator',
      connectionId: 'creator-connection-2',
      requestId: 'creator-resume-1',
    });

    expect(resumed.intents).toContainEqual({
      type: 'screen.ownerChanged',
      roomId: fixture.roomId,
      ownerUserId: null,
      leaseId: null,
    });
    expect(
      readScreenLease(
        registry,
        fixture.roomId,
        'joiner',
        fixture.joined.connection,
      ),
    ).toBeNull();
  });

  test('expires a lease exactly once and clears its timer', () => {
    const { registry, asyncIntents } = createHarness();
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });
    vi.advanceTimersByTime(14_999);
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).toBeNull();
    expect(asyncIntents).toContainEqual({
      type: 'screen.ownerChanged',
      roomId: fixture.roomId,
      ownerUserId: null,
      leaseId: null,
    });
    expect(registry.getStats().timers).toBe(0);
  });

  test('reschedules lease expiry through repeated early callbacks', () => {
    const { registry, asyncIntents } = createHarness();
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });

    vi.setSystemTime(-2);
    vi.advanceTimersByTime(15_000);
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).not.toBeNull();
    expect(registry.getStats().timers).toBe(1);

    vi.setSystemTime(14_997);
    vi.advanceTimersByTime(2);
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).not.toBeNull();
    expect(registry.getStats().timers).toBe(1);

    vi.advanceTimersByTime(1);
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).toBeNull();
    expect(registry.getStats().timers).toBe(0);
    expect(
      asyncIntents.filter(
        (intent) =>
          (intent as { type?: string }).type === 'screen.ownerChanged',
      ),
    ).toEqual([
      {
        type: 'screen.ownerChanged',
        roomId: fixture.roomId,
        ownerUserId: null,
        leaseId: null,
      },
    ]);
  });
});

describe('timer dependency failures', () => {
  test('rolls back room creation when its initial timer cannot be scheduled', () => {
    const { registry } = createHarness({
      setTimer: () => {
        throw new Error('timer failed');
      },
    });

    expect(() => createRoom(registry)).toThrow('timer failed');
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });

  test('continues cancellation bookkeeping when clearTimer throws', () => {
    const { registry } = createHarness({
      clearTimer: () => {
        throw new Error('clear failed');
      },
    });
    const created = createRoom(registry).data;

    const joined = joinRoom(registry, created.roomCode).data;

    expect(joined.room.state).toBe('negotiating');
    expect(registry.getStats().timers).toBe(0);
    vi.advanceTimersByTime(ROOM_CODE_TTL_MS);
    expect(
      registry.getMemberSnapshotForBroadcast({
        roomId: created.room.id,
        userId: 'joiner',
      }).joinerUserId,
    ).toBe('joiner');
  });

  test('removes a room if an early code-expiry reschedule fails', () => {
    let scheduleCount = 0;
    const { registry, asyncIntents } = createHarness({
      setTimer: (callback, delayMs) => {
        scheduleCount += 1;
        if (scheduleCount === 2) {
          throw new Error('timer failed');
        }
        return setTimeout(callback, delayMs);
      },
    });
    createRoom(registry);
    vi.setSystemTime(-1);

    expect(() => vi.advanceTimersByTime(ROOM_CODE_TTL_MS)).not.toThrow();
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
    expect(
      asyncIntents.filter(
        (intent) => (intent as { type?: string }).type === 'room.closed',
      ),
    ).toHaveLength(1);
  });

  test('does not retain an initial lease when scheduling fails', () => {
    let scheduleCount = 0;
    const { registry } = createHarness({
      setTimer: (callback, delayMs) => {
        scheduleCount += 1;
        if (scheduleCount === 2) {
          throw new Error('timer failed');
        }
        return setTimeout(callback, delayMs);
      },
    });
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;

    expect(() =>
      registry.setScreenLease({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: creator.connectionId,
        connectionEpoch: creator.connectionEpoch,
        leaseId: 'lease-1',
        expiresAtMs: 15_000,
        requestId: 'lease-set-1',
      }),
    ).toThrow('timer failed');
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator),
    ).toBeNull();
    expect(registry.getStats().timers).toBe(0);
  });

  test('preserves the old lease and timer when renewal scheduling fails', () => {
    let scheduleCount = 0;
    const { registry } = createHarness({
      setTimer: (callback, delayMs) => {
        scheduleCount += 1;
        if (scheduleCount === 3) {
          throw new Error('timer failed');
        }
        return setTimeout(callback, delayMs);
      },
    });
    const fixture = createJoinedRoom(registry);
    const creator = fixture.created.connection;
    registry.setScreenLease({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: creator.connectionId,
      connectionEpoch: creator.connectionEpoch,
      leaseId: 'lease-1',
      expiresAtMs: 15_000,
      requestId: 'lease-set-1',
    });

    expect(() =>
      registry.setScreenLease({
        roomId: fixture.roomId,
        userId: 'creator',
        connectionId: creator.connectionId,
        connectionEpoch: creator.connectionEpoch,
        leaseId: 'lease-1',
        expiresAtMs: 20_000,
        requestId: 'lease-renew-1',
      }),
    ).toThrow('timer failed');
    expect(
      readScreenLease(registry, fixture.roomId, 'creator', creator)
        ?.expiresAtMs,
    ).toBe(15_000);
    expect(registry.getStats().timers).toBe(1);
  });

  test('cleans an empty room if its grace timer cannot be scheduled', () => {
    let scheduleCount = 0;
    const { registry } = createHarness({
      setTimer: (callback, delayMs) => {
        scheduleCount += 1;
        if (scheduleCount === 2) {
          throw new Error('timer failed');
        }
        return setTimeout(callback, delayMs);
      },
    });
    const fixture = createJoinedRoom(registry);
    registry.disconnect({
      roomId: fixture.roomId,
      userId: 'creator',
      connectionId: fixture.created.connection.connectionId,
      connectionEpoch: fixture.created.connection.connectionEpoch,
    });

    expect(() =>
      registry.disconnect({
        roomId: fixture.roomId,
        userId: 'joiner',
        connectionId: fixture.joined.connection.connectionId,
        connectionEpoch: fixture.joined.connection.connectionEpoch,
      }),
    ).toThrow('timer failed');
    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
  });
});

describe('bulk cleanup', () => {
  test('expires 1000 rooms without leaking indices, cache entries, or timers', () => {
    const { registry } = createHarness({ requestCacheMaxEntries: 2_000 });

    for (let index = 0; index < 1_000; index += 1) {
      createRoom(registry, {
        userId: `creator-${index}`,
        connectionId: `connection-${index}`,
        requestId: `request-${index}`,
      });
    }
    expect(registry.getStats()).toEqual({
      rooms: 1_000,
      codes: 1_000,
      idempotencyEntries: 1_000,
      timers: 1_000,
    });
    expect(vi.getTimerCount()).toBe(1_000);

    vi.advanceTimersByTime(ROOM_CODE_TTL_MS);

    expect(registry.getStats()).toEqual({
      rooms: 0,
      codes: 0,
      idempotencyEntries: 0,
      timers: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
