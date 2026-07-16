import { createHmac } from 'node:crypto';

import { iceConfigurationDataSchema } from '@wo/protocol';
import { describe, expect, test } from 'vitest';

import { createIceConfiguration } from '../src/modules/turn/ice-servers.ts';
import { createTurnCredentials } from '../src/modules/turn/credentials.ts';

const TURN_INPUT = Object.freeze({
  roomId: 'room-1',
  userId: 'user-1',
  connectionEpoch: 3,
  nowSeconds: 1_700_000_000,
  ttlSeconds: 600,
  secret: 'test-turn-secret',
});

describe('coturn REST credentials', () => {
  test('creates an exact expiring coturn REST username and HMAC-SHA1 credential', () => {
    const result = createTurnCredentials(TURN_INPUT);

    expect(result.username).toMatch(/^1700000600:[A-Za-z0-9_-]{22}$/u);
    expect(result.username).not.toContain(TURN_INPUT.roomId);
    expect(result.username).not.toContain(TURN_INPUT.userId);
    expect(result.credential).toBe(
      createHmac('sha1', TURN_INPUT.secret)
        .update(result.username)
        .digest('base64'),
    );
    expect(result.expiresAtSeconds).toBe(1_700_000_600);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('uses unambiguous structured identity input and the connection epoch', () => {
    const first = createTurnCredentials({
      ...TURN_INPUT,
      roomId: 'ab',
      userId: 'c',
    });
    const ambiguousConcatenation = createTurnCredentials({
      ...TURN_INPUT,
      roomId: 'a',
      userId: 'bc',
    });
    const nextEpoch = createTurnCredentials({
      ...TURN_INPUT,
      connectionEpoch: TURN_INPUT.connectionEpoch + 1,
    });

    expect(first.username.split(':')[1]).not.toBe(
      ambiguousConcatenation.username.split(':')[1],
    );
    expect(first.username.split(':')[1]).not.toBe(
      nextEpoch.username.split(':')[1],
    );
    expect(createTurnCredentials(TURN_INPUT)).toEqual(
      createTurnCredentials(TURN_INPUT),
    );
  });

  test.each([
    ['negative now', { nowSeconds: -1 }],
    ['fractional now', { nowSeconds: 1.5 }],
    ['unsafe now', { nowSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero ttl', { ttlSeconds: 0 }],
    ['fractional ttl', { ttlSeconds: 1.5 }],
    ['unsafe ttl', { ttlSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative epoch', { connectionEpoch: -1 }],
    ['fractional epoch', { connectionEpoch: 1.5 }],
    ['unsafe epoch', { connectionEpoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty room id', { roomId: '' }],
    ['noncanonical room id', { roomId: ' room-1' }],
    ['oversized room id', { roomId: 'r'.repeat(129) }],
    ['empty user id', { userId: '' }],
    ['noncanonical user id', { userId: 'user-1 ' }],
    ['oversized user id', { userId: 'u'.repeat(129) }],
    ['empty secret', { secret: '' }],
    ['whitespace secret', { secret: '   ' }],
    ['oversized secret', { secret: 's'.repeat(4_097) }],
  ] as const)('rejects %s', (_name, override) => {
    expect(() =>
      createTurnCredentials({ ...TURN_INPUT, ...override }),
    ).toThrow();
  });

  test('rejects expiration arithmetic overflow', () => {
    expect(() =>
      createTurnCredentials({
        ...TURN_INPUT,
        nowSeconds: Number.MAX_SAFE_INTEGER - 1,
        ttlSeconds: 2,
      }),
    ).toThrow(RangeError);
  });
});

describe('public ICE configuration', () => {
  test('groups configured STUN and TURN URLs with credentials only on TURN', () => {
    const urls = [
      'stun:turn.example.test:3478',
      'turn:turn.example.test:3478?transport=udp',
      'turn:turn.example.test:3478?transport=tcp',
      'turns:turn.example.test:5349?transport=tcp',
    ];
    const turnCredentials = createTurnCredentials(TURN_INPUT);

    const configuration = createIceConfiguration({
      urls,
      turnCredentials,
    });

    expect(configuration).toEqual({
      rtcConfiguration: {
        iceServers: [
          { urls: ['stun:turn.example.test:3478'] },
          {
            urls: [
              'turn:turn.example.test:3478?transport=udp',
              'turn:turn.example.test:3478?transport=tcp',
              'turns:turn.example.test:5349?transport=tcp',
            ],
            username: turnCredentials.username,
            credential: turnCredentials.credential,
          },
        ],
        iceTransportPolicy: 'all',
      },
      iceCredentialsExpiresAt: '2023-11-14T22:23:20.000Z',
    });
    expect(() => iceConfigurationDataSchema.parse(configuration)).not.toThrow();
    expect(JSON.stringify(configuration)).not.toContain(TURN_INPUT.secret);
  });

  test('supports an injected relay policy and TURN-only configuration', () => {
    const configuration = createIceConfiguration({
      urls: ['turn:turn.example.test:3478'],
      turnCredentials: createTurnCredentials(TURN_INPUT),
      iceTransportPolicy: 'relay',
    });

    expect(configuration.rtcConfiguration.iceTransportPolicy).toBe('relay');
    expect(configuration.rtcConfiguration.iceServers).toHaveLength(1);
    expect(configuration.rtcConfiguration.iceServers[0]).toMatchObject({
      urls: ['turn:turn.example.test:3478'],
    });
  });

  test('deeply freezes cloned output without retaining the URL input', () => {
    const urls = ['stun:turn.example.test:3478', 'turn:turn.example.test:3478'];
    const configuration = createIceConfiguration({
      urls,
      turnCredentials: createTurnCredentials(TURN_INPUT),
    });
    urls[0] = 'stun:attacker.example.test:3478';

    expect(configuration.rtcConfiguration.iceServers[0]!.urls).toEqual([
      'stun:turn.example.test:3478',
    ]);
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.rtcConfiguration)).toBe(true);
    expect(Object.isFrozen(configuration.rtcConfiguration.iceServers)).toBe(
      true,
    );
    for (const server of configuration.rtcConfiguration.iceServers) {
      expect(Object.isFrozen(server)).toBe(true);
      expect(Object.isFrozen(server.urls)).toBe(true);
    }
  });

  test.each([
    { urls: [] },
    { urls: ['stun:turn.example.test:3478'] },
    { urls: ['https://turn.example.test'] },
    {
      urls: ['turn:attacker.example.test:3478#turn:turn.example.test:3478'],
    },
  ])('rejects unusable or malformed configured URLs: $urls', ({ urls }) => {
    expect(() =>
      createIceConfiguration({
        urls,
        turnCredentials: createTurnCredentials(TURN_INPUT),
      }),
    ).toThrow();
  });

  test('rejects an expiration outside the JavaScript ISO date range', () => {
    const expiresAtSeconds = 8_640_000_000_001;
    const turnCredentials = {
      ...createTurnCredentials(TURN_INPUT),
      expiresAtSeconds,
      username: `${expiresAtSeconds}:AAAAAAAAAAAAAAAAAAAAAA`,
    };

    expect(() =>
      createIceConfiguration({
        urls: ['turn:turn.example.test:3478'],
        turnCredentials,
      }),
    ).toThrow(RangeError);
  });
});
