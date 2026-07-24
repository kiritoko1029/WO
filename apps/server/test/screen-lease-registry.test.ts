import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRoomRegistry } from '../src/modules/rooms/room-registry.ts';
import { createScreenLeaseRegistry } from '../src/modules/screen/screen-lease-registry.ts';

function createHarness(
  options: { readonly requestCacheMaxEntries?: number } = {},
) {
  let uuid = 0;
  const asyncIntents: unknown[] = [];
  const roomRegistry = createRoomRegistry({
    now: () => Date.now(),
    randomInt: () => 123_456,
    randomUUID: () => `generated-${++uuid}`,
    screenLeaseTtlMs: 15_000,
    screenBitrateRange: { min: 1_000_000, max: 20_000_000 },
    requestCacheMaxEntries: options.requestCacheMaxEntries,
    onAsyncIntent: (intent) => asyncIntents.push(intent),
  });
  const created = roomRegistry.create({
    userId: 'creator',
    displayName: 'Creator',
    connectionId: 'creator-connection',
    requestId: 'create-room',
  }).data;
  const joined = roomRegistry.join({
    userId: 'joiner',
    displayName: 'Joiner',
    connectionId: 'joiner-connection',
    roomCode: created.roomCode,
    requestId: 'join-room',
  }).data;
  const leases = createScreenLeaseRegistry({ roomRegistry });
  return {
    roomRegistry,
    leases,
    asyncIntents,
    roomId: created.room.id,
    creator: {
      roomId: created.room.id,
      userId: 'creator',
      connectionId: created.connection.connectionId,
      connectionEpoch: created.connection.connectionEpoch,
    },
    joiner: {
      roomId: created.room.id,
      userId: 'joiner',
      connectionId: joined.connection.connectionId,
      connectionEpoch: joined.connection.connectionEpoch,
    },
  } as const;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => vi.useRealTimers());

describe('authoritative screen lease registry', () => {
  test('allows exactly one winner when both bound peers acquire concurrently', async () => {
    const { leases, creator, joiner } = createHarness();

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        leases.acquire({ ...creator, requestId: 'creator-acquire' }),
      ),
      Promise.resolve().then(() =>
        leases.acquire({ ...joiner, requestId: 'joiner-acquire' }),
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { code: 'SCREEN_SHARE_BUSY' },
    });
  });

  test('keeps a busy acquire request terminal after the holder releases', () => {
    const { leases, creator, joiner } = createHarness({
      requestCacheMaxEntries: 1,
    });
    const lease = leases.acquire({ ...creator, requestId: 'holder-acquire' })
      .data.lease;
    const busyInput = { ...joiner, requestId: 'busy-acquire' };
    expect(() => leases.acquire(busyInput)).toThrow(
      expect.objectContaining({ code: 'SCREEN_SHARE_BUSY' }),
    );
    leases.release({
      ...creator,
      requestId: 'holder-release',
      leaseId: lease.leaseId,
    });

    expect(() => leases.acquire(busyInput)).toThrow(
      expect.objectContaining({ code: 'SCREEN_SHARE_BUSY' }),
    );
    expect(leases.current(joiner)).toBeNull();
  });

  test('generates lease identity and expiry inside an idempotent room mutation', () => {
    const { leases, creator } = createHarness();

    const first = leases.acquire({ ...creator, requestId: 'acquire' });
    const replay = leases.acquire({ ...creator, requestId: 'acquire' });

    expect(first.data.lease).toMatchObject({
      ownerUserId: 'creator',
      leaseId: 'generated-2',
      expiresAtMs: 15_000,
      targetBitrateBps: 10_000_000,
    });
    expect(replay.data).toEqual(first.data);
    expect(replay.replayed).toBe(true);
  });

  test('renews only the exact current holder lease for another 15 seconds', () => {
    const { leases, creator, joiner } = createHarness();
    const acquired = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;
    vi.advanceTimersByTime(5_000);

    const renewed = leases.renew({
      ...creator,
      requestId: 'renew',
      leaseId: acquired.leaseId,
    });

    expect(renewed.data.lease.expiresAtMs).toBe(20_000);
    expect(() =>
      leases.renew({
        ...joiner,
        requestId: 'wrong-holder',
        leaseId: acquired.leaseId,
      }),
    ).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    expect(() =>
      leases.renew({
        ...creator,
        requestId: 'wrong-id',
        leaseId: 'wrong-lease',
      }),
    ).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
  });

  test('does not extend the lease twice when the same renew request is replayed', () => {
    const { leases, creator } = createHarness();
    const lease = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;
    vi.advanceTimersByTime(5_000);
    const renewed = leases.renew({
      ...creator,
      requestId: 'renew',
      leaseId: lease.leaseId,
    });
    vi.advanceTimersByTime(2_000);

    const replay = leases.renew({
      ...creator,
      requestId: 'renew',
      leaseId: lease.leaseId,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.data.lease.expiresAtMs).toBe(renewed.data.lease.expiresAtMs);
  });

  test('releases only the exact lease and permits reacquisition', () => {
    const { leases, creator, joiner } = createHarness();
    const acquired = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;

    expect(() =>
      leases.release({
        ...creator,
        requestId: 'wrong-release',
        leaseId: 'wrong-lease',
      }),
    ).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    const released = leases.release({
      ...creator,
      requestId: 'release',
      leaseId: acquired.leaseId,
    });
    expect(released.data).toEqual({ lease: null });
    expect(
      leases.acquire({ ...joiner, requestId: 'reacquire' }).data.lease
        .ownerUserId,
    ).toBe('joiner');
  });

  test('expires at 15 seconds, terminalizes lease requests, and reacquires', () => {
    const { leases, creator, joiner, roomRegistry, asyncIntents } =
      createHarness();
    const baselineEntries = roomRegistry.getStats().idempotencyEntries;
    leases.acquire({ ...creator, requestId: 'acquire' });
    expect(roomRegistry.getStats().idempotencyEntries).toBe(
      baselineEntries + 1,
    );

    vi.advanceTimersByTime(14_999);
    expect(leases.current(creator)).not.toBeNull();
    vi.advanceTimersByTime(1);

    expect(leases.current(joiner)).toBeNull();
    expect(roomRegistry.getStats().idempotencyEntries).toBe(
      baselineEntries + 1,
    );
    expect(asyncIntents).toContainEqual({
      type: 'screen.ownerChanged',
      roomId: creator.roomId,
      ownerUserId: null,
      leaseId: null,
    });
    expect(
      leases.acquire({ ...joiner, requestId: 'reacquire' }).data.lease
        .ownerUserId,
    ).toBe('joiner');
  });

  test.each(['acquire', 'renew', 'bitrate'] as const)(
    'turns a successful %s request into LEASE_LOST after expiry',
    (operation) => {
      const { leases, creator } = createHarness();
      const acquireInput = { ...creator, requestId: 'acquire' };
      const lease = leases.acquire(acquireInput).data.lease;
      const renewInput = {
        ...creator,
        requestId: 'renew',
        leaseId: lease.leaseId,
      };
      const bitrateInput = {
        ...creator,
        requestId: 'bitrate',
        leaseId: lease.leaseId,
        bitrateBps: 8_000_000,
      };
      if (operation === 'renew') leases.renew(renewInput);
      if (operation === 'bitrate') leases.setBitrate(bitrateInput);
      vi.advanceTimersByTime(15_000);

      expect(() => {
        if (operation === 'acquire') leases.acquire(acquireInput);
        if (operation === 'renew') leases.renew(renewInput);
        if (operation === 'bitrate') leases.setBitrate(bitrateInput);
      }).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    },
  );

  test('replays release success without releasing a subsequently acquired lease', () => {
    const { leases, creator, joiner } = createHarness();
    const lease = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;
    const releaseInput = {
      ...creator,
      requestId: 'release',
      leaseId: lease.leaseId,
    };
    leases.release(releaseInput);
    const next = leases.acquire({ ...joiner, requestId: 'next-acquire' }).data
      .lease;

    const replay = leases.release(releaseInput);

    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual({ lease: null });
    expect(leases.current(joiner)?.leaseId).toBe(next.leaseId);
  });

  test('never reuses an acquire request ID after global idempotency eviction', () => {
    const { leases, creator, joiner } = createHarness({
      requestCacheMaxEntries: 1,
    });
    const oldAcquire = { ...creator, requestId: 'old-acquire' };
    const oldLease = leases.acquire(oldAcquire).data.lease;
    leases.release({
      ...creator,
      requestId: 'old-release',
      leaseId: oldLease.leaseId,
    });
    const nextLease = leases.acquire({
      ...joiner,
      requestId: 'next-acquire',
    }).data.lease;
    leases.release({
      ...joiner,
      requestId: 'next-release',
      leaseId: nextLease.leaseId,
    });

    expect(() => leases.acquire(oldAcquire)).toThrow(
      expect.objectContaining({ code: 'LEASE_LOST' }),
    );
  });

  test('rejects an acquire request ID replayed from a replacement connection', () => {
    const { leases, creator, roomRegistry } = createHarness({
      requestCacheMaxEntries: 1,
    });
    leases.acquire({ ...creator, requestId: 'connection-bound-acquire' });
    const resumed = roomRegistry.resume({
      roomId: creator.roomId,
      userId: creator.userId,
      displayName: 'Creator',
      connectionId: 'creator-replacement',
      requestId: 'resume-after-acquire',
    }).data;

    expect(() =>
      leases.acquire({
        roomId: creator.roomId,
        userId: creator.userId,
        connectionId: resumed.connection.connectionId,
        connectionEpoch: resumed.connection.connectionEpoch,
        requestId: 'connection-bound-acquire',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  test('clamps bitrate to the configured range and preserves it across renewal', () => {
    const { leases, creator } = createHarness();
    const lease = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;

    const updated = leases.setBitrate({
      ...creator,
      requestId: 'bitrate',
      leaseId: lease.leaseId,
      bitrateBps: 30_000_000,
    });
    vi.advanceTimersByTime(5_000);
    const renewed = leases.renew({
      ...creator,
      requestId: 'renew',
      leaseId: lease.leaseId,
    });

    expect(updated.data.bitrateBps).toBe(20_000_000);
    expect(renewed.data.lease.targetBitrateBps).toBe(20_000_000);
  });

  test('rejects a stale connection epoch and releases on replacement', () => {
    const { leases, creator, roomRegistry } = createHarness();
    const lease = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;
    const resumed = roomRegistry.resume({
      roomId: creator.roomId,
      userId: creator.userId,
      displayName: 'Creator',
      connectionId: 'creator-replacement',
      requestId: 'resume',
    }).data;

    expect(() =>
      leases.renew({
        ...creator,
        requestId: 'stale-renew',
        leaseId: lease.leaseId,
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_CONNECTION' }));
    expect(
      leases.current({
        roomId: creator.roomId,
        userId: creator.userId,
        connectionId: resumed.connection.connectionId,
        connectionEpoch: resumed.connection.connectionEpoch,
      }),
    ).toBeNull();
  });

  test('preserves a disconnected holder lease across resume and renews it on the new epoch', () => {
    const { leases, creator, roomRegistry } = createHarness();
    const lease = leases.acquire({ ...creator, requestId: 'acquire' }).data
      .lease;

    const disconnected = roomRegistry.disconnect(creator);
    expect(disconnected.intents).not.toContainEqual(
      expect.objectContaining({ type: 'screen.ownerChanged' }),
    );
    expect(disconnected.data.room.screenLease).toMatchObject({
      leaseId: lease.leaseId,
      ownerUserId: creator.userId,
    });

    const resumed = roomRegistry.resume({
      roomId: creator.roomId,
      userId: creator.userId,
      displayName: 'Creator',
      connectionId: 'creator-resumed',
      requestId: 'resume',
    }).data;
    const rebound = {
      roomId: creator.roomId,
      userId: creator.userId,
      connectionId: resumed.connection.connectionId,
      connectionEpoch: resumed.connection.connectionEpoch,
    };

    expect(leases.current(rebound)?.leaseId).toBe(lease.leaseId);
    expect(() =>
      leases.renew({
        ...creator,
        requestId: 'stale-renew',
        leaseId: lease.leaseId,
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_CONNECTION' }));
    expect(
      leases.renew({
        ...rebound,
        requestId: 'resumed-renew',
        leaseId: lease.leaseId,
      }).data.lease,
    ).toMatchObject({
      leaseId: lease.leaseId,
      ownerUserId: creator.userId,
      expiresAtMs: 15_000,
    });
  });

  test('lets a disconnected lease expire exactly once without a resume', () => {
    const { leases, creator, roomRegistry, asyncIntents } = createHarness();
    leases.acquire({ ...creator, requestId: 'acquire' });
    roomRegistry.disconnect(creator);

    vi.advanceTimersByTime(15_000);

    expect(
      asyncIntents.filter(
        (intent) =>
          (intent as { type?: string }).type === 'screen.ownerChanged',
      ),
    ).toEqual([
      {
        type: 'screen.ownerChanged',
        roomId: creator.roomId,
        ownerUserId: null,
        leaseId: null,
      },
    ]);
  });

  test('preserves on disconnect but releases on room end', () => {
    const first = createHarness();
    first.leases.acquire({ ...first.creator, requestId: 'acquire' });
    const disconnected = first.roomRegistry.disconnect(first.creator);
    expect(disconnected.intents).not.toContainEqual(
      expect.objectContaining({ type: 'screen.ownerChanged' }),
    );

    const second = createHarness();
    second.leases.acquire({ ...second.creator, requestId: 'acquire' });
    const ended = second.roomRegistry.end(second.creator);
    expect(ended.intents).toContainEqual({
      type: 'screen.ownerChanged',
      roomId: second.roomId,
      ownerUserId: null,
      leaseId: null,
    });
  });
});
