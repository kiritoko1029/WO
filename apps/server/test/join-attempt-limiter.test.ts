import { describe, expect, test } from 'vitest';

import { createJoinAttemptLimiter } from '../src/modules/rooms/join-attempt-limiter.ts';

describe('room join attempt limiter', () => {
  test('limits a trusted user and normalized IP within a fixed window', () => {
    let now = 1_000;
    const limiter = createJoinAttemptLimiter({
      now: () => now,
      maxAttempts: 2,
      windowMs: 5_000,
      maxKeys: 10,
    });
    const input = {
      userId: 'user-1',
      remoteIp: '2001:0db8:0:0:0:0:0:1',
      requestId: 'request-1',
    };

    expect(limiter.consume(input)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(
      limiter.consume({
        ...input,
        remoteIp: '2001:db8::1',
        requestId: 'request-2',
      }),
    ).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(limiter.consume({ ...input, requestId: 'request-3' })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 5_000,
    });

    now += 5_000;
    expect(limiter.consume({ ...input, requestId: 'request-4' })).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  test('treats IPv4-mapped IPv6 as the same address as IPv4', () => {
    const limiter = createJoinAttemptLimiter({
      now: () => 0,
      maxAttempts: 1,
      windowMs: 1_000,
      maxKeys: 10,
    });

    expect(
      limiter.consume({
        userId: 'user-1',
        remoteIp: '::ffff:192.0.2.1',
        requestId: 'request-1',
      }).allowed,
    ).toBe(true);
    expect(
      limiter.consume({
        userId: 'user-1',
        remoteIp: '192.0.2.1',
        requestId: 'request-2',
      }).allowed,
    ).toBe(false);
  });

  test('keeps users independent even when they share an IP', () => {
    const limiter = createJoinAttemptLimiter({
      now: () => 0,
      maxAttempts: 1,
      windowMs: 1_000,
      maxKeys: 10,
    });

    expect(
      limiter.consume({
        userId: 'user-1',
        remoteIp: '192.0.2.1',
        requestId: 'request-1',
      }).allowed,
    ).toBe(true);
    expect(
      limiter.consume({
        userId: 'user-2',
        remoteIp: '192.0.2.1',
        requestId: 'request-2',
      }).allowed,
    ).toBe(true);
  });

  test('prunes expired keys and evicts the least recently used live key', () => {
    let now = 0;
    const limiter = createJoinAttemptLimiter({
      now: () => now,
      maxAttempts: 1,
      windowMs: 100,
      maxKeys: 2,
    });
    const consume = (userId: string, requestId: string) =>
      limiter.consume({ userId, remoteIp: '192.0.2.1', requestId });

    consume('user-1', 'request-1');
    now = 10;
    consume('user-2', 'request-2');
    consume('user-1', 'request-3');
    now = 20;
    consume('user-3', 'request-4');

    expect(limiter.getStats()).toEqual({ keys: 2 });
    expect(consume('user-2', 'request-5').allowed).toBe(true);
    expect(limiter.getStats()).toEqual({ keys: 2 });

    now = 200;
    consume('user-4', 'request-6');
    expect(limiter.getStats()).toEqual({ keys: 1 });
  });

  test('logs only anonymous identity and request metadata on denial', () => {
    const events: unknown[] = [];
    const limiter = createJoinAttemptLimiter({
      now: () => 0,
      maxAttempts: 1,
      windowMs: 1_000,
      maxKeys: 10,
      anonymizeUserId: () => 'anon-1',
      onLimited: (event) => events.push(event),
    });
    const input = {
      userId: 'raw-user-id',
      remoteIp: '203.0.113.7',
      requestId: 'request-2',
    };

    limiter.consume({ ...input, requestId: 'request-1' });
    limiter.consume(input);

    expect(events).toEqual([
      {
        anonymousUserId: 'anon-1',
        requestId: 'request-2',
        retryAfterMs: 1_000,
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(input.userId);
    expect(serialized).not.toContain(input.remoteIp);
  });

  test.each(['', 'not-an-ip', '192.168.001.1', '2001:db8::1::2'])(
    'rejects invalid remote IP %j',
    (remoteIp) => {
      const limiter = createJoinAttemptLimiter({
        now: () => 0,
        maxAttempts: 1,
        windowMs: 1_000,
        maxKeys: 10,
      });

      expect(() =>
        limiter.consume({
          userId: 'user-1',
          remoteIp,
          requestId: 'request-1',
        }),
      ).toThrow(TypeError);
    },
  );
});
