import { describe, expect, test, vi } from 'vitest';

import {
  SIGNAL_TICKET_TTL_MS,
  SignalTicketStoreError,
  createSignalTicketStore,
} from '../src/modules/signaling/signal-ticket-store.ts';

const CLAIMS = Object.freeze({
  userId: 'user-1',
  sessionId: 'session-1',
  displayName: 'Person',
  accessTokenExpiresAtSeconds: 2_000_000_000,
});

const bytes = (fill: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, () => fill);

describe('single-use signaling tickets', () => {
  test('issues 32 random bytes as canonical unpadded base64url for exactly 30 seconds', () => {
    let nowMs = 1_700_000_000_000;
    const store = createSignalTicketStore({
      now: () => nowMs,
      randomBytes: () => bytes(0xff),
    });

    const issued = store.issue(CLAIMS);

    expect(issued.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(issued.value, 'base64url')).toHaveLength(32);
    expect(Buffer.from(issued.value, 'base64url').toString('base64url')).toBe(
      issued.value,
    );
    expect(issued.expiresAtMs).toBe(nowMs + SIGNAL_TICKET_TTL_MS);
    expect(Object.isFrozen(issued)).toBe(true);

    nowMs += SIGNAL_TICKET_TTL_MS - 1;
    expect(store.consume(issued.value)).toEqual(CLAIMS);
  });

  test('expires at the exact 30-second boundary', () => {
    let nowMs = 10_000;
    const store = createSignalTicketStore({
      now: () => nowMs,
      randomBytes: () => bytes(1),
    });
    const issued = store.issue(CLAIMS);

    nowMs += SIGNAL_TICKET_TTL_MS;

    expect(store.consume(issued.value)).toBeNull();
    expect(store.stats()).toEqual({ size: 0, maxEntries: 10_000 });
  });

  test('atomically consumes a ticket only once', async () => {
    const store = createSignalTicketStore({ randomBytes: () => bytes(2) });
    const issued = store.issue(CLAIMS);

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => store.consume(issued.value)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(19);
  });

  test('does not scan or delete expired storage for a canonical cache miss', () => {
    let nowMs = 0;
    let nextByte = 40;
    const store = createSignalTicketStore({
      now: () => nowMs,
      randomBytes: () => bytes(nextByte++),
    });
    store.issue(CLAIMS);
    store.issue(CLAIMS);
    store.issue(CLAIMS);
    nowMs = SIGNAL_TICKET_TTL_MS;
    const unseenCanonicalTicket = Buffer.from(bytes(99)).toString('base64url');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');

    try {
      expect(store.consume(unseenCanonicalTicket)).toBeNull();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      deleteSpy.mockRestore();
    }
  });

  test('snapshots claims and returns an immutable consumed result', () => {
    const mutableClaims = {
      userId: 'user-1',
      sessionId: 'session-1',
      displayName: 'Original',
      accessTokenExpiresAtSeconds: 2_000_000_000,
    };
    const store = createSignalTicketStore({ randomBytes: () => bytes(3) });
    const issued = store.issue(mutableClaims);
    mutableClaims.displayName = 'Changed';

    const consumed = store.consume(issued.value);

    expect(consumed).toEqual({ ...CLAIMS, displayName: 'Original' });
    expect(Object.isFrozen(consumed)).toBe(true);
  });

  test.each([
    '',
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}=`,
    `${'a'.repeat(42)}+`,
    `${'a'.repeat(42)}/`,
    `${'a'.repeat(42)} `,
  ])('rejects a noncanonical ticket without touching storage: %j', (value) => {
    const store = createSignalTicketStore({ randomBytes: () => bytes(4) });
    const issued = store.issue(CLAIMS);

    expect(store.consume(value)).toBeNull();
    expect(store.consume(issued.value)).toEqual(CLAIMS);
  });

  test('prunes expired entries before enforcing capacity', () => {
    let nowMs = 0;
    let nextByte = 5;
    const store = createSignalTicketStore({
      maxEntries: 1,
      now: () => nowMs,
      randomBytes: () => bytes(nextByte++),
    });
    store.issue(CLAIMS);
    nowMs = SIGNAL_TICKET_TTL_MS;

    expect(() => store.issue(CLAIMS)).not.toThrow();
    expect(store.stats()).toEqual({ size: 1, maxEntries: 1 });
  });

  test('fails explicitly instead of evicting a still-valid ticket at capacity', () => {
    let nextByte = 10;
    const store = createSignalTicketStore({
      maxEntries: 1,
      randomBytes: () => bytes(nextByte++),
    });
    const first = store.issue(CLAIMS);

    expect(() => store.issue(CLAIMS)).toThrowError(
      expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
    );
    expect(store.consume(first.value)).toEqual(CLAIMS);
  });

  test('retries collisions within a bounded limit', () => {
    const values = [bytes(20), bytes(20), bytes(21)];
    const store = createSignalTicketStore({
      maxCollisionAttempts: 2,
      randomBytes: () => values.shift()!,
    });
    const first = store.issue(CLAIMS);
    const second = store.issue(CLAIMS);

    expect(second.value).not.toBe(first.value);
    expect(store.stats().size).toBe(2);
  });

  test('fails after the configured collision limit without leaking a ticket', () => {
    const store = createSignalTicketStore({
      maxCollisionAttempts: 2,
      randomBytes: () => bytes(22),
    });
    store.issue(CLAIMS);

    expect(() => store.issue(CLAIMS)).toThrowError(
      expect.objectContaining({ code: 'COLLISION_LIMIT_EXCEEDED' }),
    );
    expect(store.stats().size).toBe(1);
  });

  test('rejects a random source that does not return exactly 32 bytes', () => {
    const store = createSignalTicketStore({
      randomBytes: () => new Uint8Array(31),
    });

    expect(() => store.issue(CLAIMS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RANDOM_SOURCE' }),
    );
    expect(store.stats().size).toBe(0);
  });

  test.each([
    { ...CLAIMS, userId: '' },
    { ...CLAIMS, userId: ' user-1' },
    { ...CLAIMS, sessionId: '' },
    { ...CLAIMS, displayName: '' },
    { ...CLAIMS, accessTokenExpiresAtSeconds: 0 },
    { ...CLAIMS, accessTokenExpiresAtSeconds: 1.5 },
    {
      userId: 'user-1',
      sessionId: 'session-1',
      displayName: 'x'.repeat(101),
      accessTokenExpiresAtSeconds: 2_000_000_000,
    },
  ])('rejects invalid ticket claims', (claims) => {
    const store = createSignalTicketStore({ randomBytes: () => bytes(23) });

    expect(() => store.issue(claims)).toThrow(TypeError);
    expect(store.stats().size).toBe(0);
  });

  test('validates clock values and expiration overflow', () => {
    const invalidClock = createSignalTicketStore({
      now: () => Number.NaN,
      randomBytes: () => bytes(24),
    });
    const overflowingClock = createSignalTicketStore({
      now: () => Number.MAX_SAFE_INTEGER - SIGNAL_TICKET_TTL_MS + 1,
      randomBytes: () => bytes(25),
    });

    expect(() => invalidClock.issue(CLAIMS)).toThrow(RangeError);
    expect(() => overflowingClock.issue(CLAIMS)).toThrow(RangeError);
  });

  test('clears all hashed entries and returns frozen statistics', () => {
    let nextByte = 30;
    const store = createSignalTicketStore({
      randomBytes: () => bytes(nextByte++),
    });
    store.issue(CLAIMS);
    store.issue(CLAIMS);

    store.clear();
    const statistics = store.stats();

    expect(statistics).toEqual({ size: 0, maxEntries: 10_000 });
    expect(Object.isFrozen(statistics)).toBe(true);
    expect(store).not.toHaveProperty('logger');
    expect(SignalTicketStoreError).toBeTypeOf('function');
  });
});
