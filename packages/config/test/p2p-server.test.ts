import { describe, expect, test } from 'vitest';

import {
  ServerConfigError,
  parseP2pServerConfig,
  type P2pServerConfig,
} from '../src/index.js';

const PRODUCTION_JWT_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString('base64url');
const PRODUCTION_TURN_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 32),
).toString('base64url');

const validP2pEnv = (): Record<string, string> => ({
  NODE_ENV: 'test',
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: '3000',
  PUBLIC_URL: 'https://rtc.example.test',
  DATABASE_URL: 'postgres://wo:secret@127.0.0.1:5432/wo',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  TURN_SHARED_SECRET: 'test-turn-secret-at-least-32-characters',
  TURN_REALM: 'rtc.example.test',
  TURN_HOST: 'turn.example.test',
  TURN_URLS:
    'stun:turn.example.test:3478,turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp,turns:turn.example.test:5349?transport=tcp',
  TURN_CREDENTIAL_TTL_SECONDS: '600',
  ROOM_CODE_TTL_SECONDS: '600',
  ROOM_DISCONNECT_GRACE_SECONDS: '120',
  SCREEN_LEASE_TTL_SECONDS: '15',
  SCREEN_BITRATE_MIN: '1000000',
  SCREEN_BITRATE_MAX: '10000000',
});

const productionP2pEnv = (): Record<string, string> => ({
  ...validP2pEnv(),
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://rtc.example.com',
  JWT_ACCESS_SECRET: PRODUCTION_JWT_SECRET,
  TURN_SHARED_SECRET: PRODUCTION_TURN_SECRET,
  TURN_REALM: 'rtc.example.com',
  TURN_HOST: 'turn.example.com',
  TURN_URLS:
    'stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp',
});

const captureError = (env: Record<string, string | undefined>) => {
  try {
    parseP2pServerConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerConfigError);
    return error as ServerConfigError;
  }

  throw new Error('Expected parseP2pServerConfig to throw');
};

describe('parseP2pServerConfig', () => {
  test('parses the minimal P2P environment without legacy SFU services', () => {
    const config: P2pServerConfig = parseP2pServerConfig(validP2pEnv());

    expect(config).toEqual({
      nodeEnv: 'test',
      server: { host: '127.0.0.1', port: 3000 },
      publicUrl: 'https://rtc.example.test/',
      database: {
        url: 'postgres://wo:secret@127.0.0.1:5432/wo',
      },
      auth: {
        jwtAccessSecret: 'test-access-secret-at-least-32-characters',
      },
      turn: {
        sharedSecret: 'test-turn-secret-at-least-32-characters',
        realm: 'rtc.example.test',
        host: 'turn.example.test',
        urls: [
          'stun:turn.example.test:3478',
          'turn:turn.example.test:3478?transport=udp',
          'turn:turn.example.test:3478?transport=tcp',
          'turns:turn.example.test:5349?transport=tcp',
        ],
        credentialTtlSeconds: 600,
      },
      room: { codeTtlSeconds: 600, disconnectGraceSeconds: 120 },
      screen: {
        leaseTtlSeconds: 15,
        bitrateRange: { min: 1_000_000, max: 10_000_000 },
      },
    });
    expect(config).not.toHaveProperty('redis');
    expect(config).not.toHaveProperty('rustfs');
    expect(config).not.toHaveProperty('mediasoup');
  });

  test('deeply freezes every nested object and the TURN URL array', () => {
    const config = parseP2pServerConfig(validP2pEnv());

    const frozenValues = [
      config,
      config.server,
      config.database,
      config.auth,
      config.turn,
      config.turn.urls,
      config.room,
      config.screen,
      config.screen.bitrateRange,
    ];
    for (const value of frozenValues) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(config.server, 'port', 4000)).toBe(false);
    expect(Reflect.set(config.turn.urls, '0', 'stun:attacker.test')).toBe(
      false,
    );
    expect(Reflect.set(config.screen.bitrateRange, 'min', 2)).toBe(false);
  });

  test.each([
    'NODE_ENV',
    'SERVER_HOST',
    'SERVER_PORT',
    'PUBLIC_URL',
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'TURN_SHARED_SECRET',
    'TURN_REALM',
    'TURN_HOST',
    'TURN_URLS',
    'TURN_CREDENTIAL_TTL_SECONDS',
    'ROOM_CODE_TTL_SECONDS',
    'ROOM_DISCONNECT_GRACE_SECONDS',
    'SCREEN_LEASE_TTL_SECONDS',
    'SCREEN_BITRATE_MIN',
    'SCREEN_BITRATE_MAX',
  ])('rejects missing required field %s', (field) => {
    const env: Record<string, string | undefined> = validP2pEnv();
    delete env[field];

    const error = captureError(env);
    expect(error.issues).toContainEqual(expect.objectContaining({ field }));
  });

  test.each(
    Object.entries(validP2pEnv()).flatMap(([field, value]) =>
      [
        ['leading whitespace', `\u2003${value}`],
        ['trailing whitespace', `${value}\u2003`],
        ['C0 control character', `${value}\u0000`],
        ['C1 control character', `${value}\u0085`],
      ].map(([kind, unsafeValue]) => [field, kind, unsafeValue] as const),
    ),
  )('rejects %s containing %s without leaking it', (field, _kind, value) => {
    const env = validP2pEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.message).not.toContain(value);
    expect(JSON.stringify(error.issues)).not.toContain(value);
  });

  test('preserves valid P2P secret bytes exactly', () => {
    const env = validP2pEnv();
    env.JWT_ACCESS_SECRET = 'test-JWT_secret-MiXeD-0123456789_abcdef';
    env.TURN_SHARED_SECRET = 'test-TURN_secret-MiXeD-9876543210_uvwxyz';

    const config = parseP2pServerConfig(env);

    expect(config.auth.jwtAccessSecret).toBe(env.JWT_ACCESS_SECRET);
    expect(config.turn.sharedSecret).toBe(env.TURN_SHARED_SECRET);
  });

  test.each([
    ['fragment', 'postgres://wo:secret@db.example.test:5432/wo#unexpected'],
    ['empty fragment', 'postgres://u:p@db.internal:5432/wo#'],
    ['empty path', 'postgres://wo:secret@db.example.test:5432'],
    ['root-only path', 'postgres://wo:secret@db.example.test:5432/'],
    [
      'multiple path segments',
      'postgres://wo:secret@db.example.test:5432/wo/schema',
    ],
    [
      'trailing empty path segment',
      'postgres://wo:secret@db.example.test:5432/wo/',
    ],
    [
      'literal parent path segment',
      'postgres://u:p@db.internal:5432/wo/../other',
    ],
    [
      'encoded parent path segment before another segment',
      'postgres://u:p@db.internal:5432/wo/%2e%2e/other',
    ],
    [
      'single encoded parent path segment',
      'postgres://u:p@db.internal:5432/%2e%2e',
    ],
    [
      'encoded slash inside the database segment',
      'postgres://u:p@db.internal:5432/wo%2Fother',
    ],
    [
      'invalid password percent escape',
      'postgres://wo:secret%ZZ@db.example.test:5432/wo',
    ],
    [
      'incomplete path percent escape',
      'postgres://wo:secret@db.example.test:5432/wo%2',
    ],
    [
      'bare query percent escape',
      'postgres://wo:secret@db.example.test:5432/wo?sslmode=%',
    ],
  ])('rejects a P2P DATABASE_URL containing %s', (_kind, databaseUrl) => {
    const env = validP2pEnv();
    env.DATABASE_URL = databaseUrl;

    const error = captureError(env);
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain(databaseUrl);
    expect(JSON.stringify(error.issues)).not.toContain(databaseUrl);
  });

  test('preserves valid PostgreSQL userinfo and query parameters', () => {
    const env = validP2pEnv();
    env.DATABASE_URL =
      'postgresql://wo%40user:p%40ss%23word@db.internal:5432/wo_db?sslmode=require&application_name=wo';

    const config = parseP2pServerConfig(env);

    expect(config.database.url).toBe(env.DATABASE_URL);
    const databaseUrl = new URL(config.database.url);
    expect(databaseUrl.username).toBe('wo%40user');
    expect(databaseUrl.password).toBe('p%40ss%23word');
    expect(databaseUrl.searchParams.get('sslmode')).toBe('require');
    expect(databaseUrl.searchParams.get('application_name')).toBe('wo');
  });

  test('accepts a secure production environment', () => {
    const config = parseP2pServerConfig(productionP2pEnv());

    expect(config.nodeEnv).toBe('production');
    expect(config.publicUrl).toBe('https://rtc.example.com/');
    expect(config.auth.jwtAccessSecret).toBe(PRODUCTION_JWT_SECRET);
    expect(config.turn.sharedSecret).toBe(PRODUCTION_TURN_SECRET);
  });

  test('requires HTTPS public URL in production', () => {
    const env = productionP2pEnv();
    env.PUBLIC_URL = 'http://rtc.example.com';

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toContain('HTTPS');
  });

  test.each([
    ['localhost', 'https://localhost'],
    ['localhost subdomain', 'https://api.localhost'],
    ['IPv4 loopback', 'https://127.0.0.1'],
    ['IPv4 wildcard', 'https://0.0.0.0'],
    ['IPv6 loopback', 'https://[::1]'],
    ['IPv6 wildcard', 'https://[::]'],
  ])('rejects a production PUBLIC_URL using %s', (_kind, publicUrl) => {
    const env = productionP2pEnv();
    env.PUBLIC_URL = publicUrl;

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toMatch(/localhost|loopback|wildcard/i);
  });

  test.each([
    ['localhost with two trailing dots', 'https://localhost..'],
    ['DNS with two trailing dots', 'https://rtc.example.com..'],
    ['DNS with three trailing dots', 'https://rtc.example.com...'],
    ['interior empty DNS label', 'https://rtc..example.com'],
    ['leading empty DNS label', 'https://.rtc.example.com'],
    ['underscore in DNS label', 'https://rtc_api.example.com'],
    ['leading hyphen in DNS label', 'https://-rtc.example.com'],
    ['trailing hyphen in DNS label', 'https://rtc-.example.com'],
  ])('rejects a production PUBLIC_URL containing %s', (_kind, publicUrl) => {
    const env = productionP2pEnv();
    env.PUBLIC_URL = publicUrl;

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).not.toContain(publicUrl);
    expect(JSON.stringify(error.issues)).not.toContain(publicUrl);
  });

  test('allows a production PUBLIC_URL with one trailing DNS root dot', () => {
    const env = productionP2pEnv();
    env.PUBLIC_URL = 'https://rtc.example.com.';

    expect(parseP2pServerConfig(env).publicUrl).toBe(
      'https://rtc.example.com./',
    );
  });

  test.each([
    ['localhost', 'localhost', 'turn:localhost:3478'],
    ['localhost subdomain', 'relay.localhost', 'turn:relay.localhost:3478'],
    ['IPv4 loopback', '127.0.0.1', 'turn:127.0.0.1:3478'],
    ['IPv4 wildcard', '0.0.0.0', 'turn:0.0.0.0:3478'],
    ['IPv6 loopback', '::1', 'turn:[::1]:3478'],
    ['IPv6 wildcard', '::', 'turn:[::]:3478'],
    [
      'IPv4-mapped loopback',
      '::ffff:127.0.0.1',
      'turn:[::ffff:127.0.0.1]:3478',
    ],
    ['IPv4-mapped wildcard', '::ffff:0.0.0.0', 'turn:[::ffff:0.0.0.0]:3478'],
  ])('rejects a production TURN_HOST using %s', (_kind, turnHost, turnUrl) => {
    const env = productionP2pEnv();
    env.TURN_HOST = turnHost;
    env.TURN_URLS = turnUrl;

    const error = captureError(env);
    expect(error.message).toContain('TURN_HOST');
    expect(error.message).toMatch(/localhost|loopback|wildcard/i);
  });

  test.each([
    ['hexadecimal integer', '0x7f000001'],
    ['hexadecimal dotted IPv4', '0x7f.0x0.0x0.0x1'],
    ['octal dotted IPv4', '0177.0.0.1'],
    ['short dotted IPv4', '127.1'],
  ])(
    'rejects TURN_HOST using alternate numeric host syntax: %s',
    (_kind, turnHost) => {
      const env = productionP2pEnv();
      env.TURN_HOST = turnHost;
      env.TURN_URLS = `turn:${turnHost}:3478`;

      const error = captureError(env);
      expect(error.message).toContain('TURN_HOST');
      expect(error.message).not.toContain(turnHost);
    },
  );

  test.each([
    ['private IPv4', '10.0.0.5', 'turn:10.0.0.5:3478'],
    ['private IPv4', '172.16.0.5', 'turn:172.16.0.5:3478'],
    ['private IPv4', '192.168.1.5', 'turn:192.168.1.5:3478'],
    ['unique-local IPv6', 'fd00::5', 'turn:[fd00::5]:3478'],
    ['LAN DNS', 'turn.internal', 'turn:turn.internal:3478'],
  ])(
    'allows a production TURN_HOST using %s for a private deployment',
    (_kind, turnHost, turnUrl) => {
      const env = productionP2pEnv();
      env.TURN_HOST = turnHost;
      env.TURN_URLS = turnUrl;

      expect(parseP2pServerConfig(env).turn.host).toBe(turnHost);
    },
  );

  test.each([
    ['JWT_ACCESS_SECRET', 'change-me'],
    ['TURN_SHARED_SECRET', 'replace-me'],
    ['JWT_ACCESS_SECRET', 'short'],
    ['TURN_SHARED_SECRET', 'short'],
  ])('rejects unsafe production credential %s', (field, value) => {
    const env = productionP2pEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.message).not.toContain(value);
  });

  test.each(
    ['JWT_ACCESS_SECRET', 'TURN_SHARED_SECRET'].flatMap((field) =>
      [
        ['32 repeated characters', 'a'.repeat(32)],
        ['single-character repetition', '0'.repeat(43)],
        ['cycling digits', '0123456789'.repeat(5).slice(0, 43)],
        ['short repeating period', 'abcdefghijklmnop'.repeat(3).slice(0, 43)],
        [
          'only 31 decoded bytes',
          Buffer.from(Array.from({ length: 31 }, (_, index) => index)).toString(
            'base64url',
          ),
        ],
        ['base64 padding', `${PRODUCTION_JWT_SECRET}=`],
        ['non-base64url character', `+${PRODUCTION_JWT_SECRET.slice(1)}`],
      ].map(([kind, value]) => [field, kind, value] as const),
    ),
  )('rejects weak production %s using %s', (field, _kind, value) => {
    const env = productionP2pEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.message).not.toContain(value);
  });

  test.each([
    ['non-ICE scheme', 'https://turn.example.test'],
    ['TLS STUN scheme', 'stuns:turn.example.test:5349'],
    [
      'TURN TLS over unsupported UDP transport',
      'turns:turn.example.test:5349?transport=udp',
    ],
    ['uppercase STUN scheme', 'STUN:turn.example.test:3478'],
    ['STUN query', 'stun:turn.example.test:3478?transport=udp'],
    ['unsupported TURN query', 'turn:turn.example.test:3478?region=cn'],
    ['embedded user information', 'turn:user@turn.example.test:3478'],
    ['path', 'stun:turn.example.test/private'],
    ['leading-zero port', 'stun:turn.example.test:03478'],
    ['zero port', 'stun:turn.example.test:0'],
    ['out-of-range port', 'turn:turn.example.test:65536'],
  ])('rejects %s in TURN_URLS', (_kind, url) => {
    const env = validP2pEnv();
    env.TURN_URLS = url;

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
  });

  test('requires every TURN URL hostname to match TURN_HOST', () => {
    const env = validP2pEnv();
    env.TURN_URLS =
      'stun:turn.example.test:3478,turn:relay.example.test:3478?transport=udp';

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
    expect(error.message).toMatch(/TURN_HOST/);
  });

  test.each([
    [
      'unpaired opening bracket on IPv6',
      '[2001:db8::1',
      'stun:[2001:db8::1]:3478',
    ],
    [
      'unpaired closing bracket on DNS',
      'turn.example.test]',
      'stun:turn.example.test:3478',
    ],
    ['bracketed DNS', '[turn.example.test]', 'stun:turn.example.test:3478'],
    ['bracketed IPv4', '[203.0.113.10]', 'stun:203.0.113.10:3478'],
    ['bracketed IPv6', '[2001:db8::1]', 'stun:[2001:db8::1]:3478'],
  ])('rejects TURN_HOST with %s', (_kind, turnHost, turnUrl) => {
    const env = validP2pEnv();
    env.TURN_HOST = turnHost;
    env.TURN_URLS = turnUrl;

    const error = captureError(env);
    expect(error.message).toContain('TURN_HOST');
  });

  test('normalizes a bare DNS TURN_HOST to lowercase without its trailing dot', () => {
    const env = validP2pEnv();
    env.TURN_HOST = 'TURN.EXAMPLE.TEST.';
    env.TURN_URLS =
      'stun:turn.example.test.:3478,turn:TURN.EXAMPLE.TEST.:3478?transport=udp';

    expect(parseP2pServerConfig(env).turn.host).toBe('turn.example.test');
  });

  test.each([
    ['DNS', 'turn.example.test', 'turn:turn.example.test:3478'],
    ['IPv4', '203.0.113.10', 'turn:203.0.113.10:3478'],
    ['IPv6', '2001:db8::1', 'turn:[2001:db8::1]:3478'],
  ])('accepts a bare %s TURN_HOST', (_kind, turnHost, turnUrl) => {
    const env = validP2pEnv();
    env.TURN_HOST = turnHost;
    env.TURN_URLS = turnUrl;

    expect(parseP2pServerConfig(env).turn.host).toBe(turnHost);
  });

  test('rejects duplicate TURN URLs instead of silently removing them', () => {
    const env = validP2pEnv();
    env.TURN_URLS = 'stun:turn.example.test:3478,stun:turn.example.test:3478';

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
    expect(error.message).toMatch(/duplicate/i);
  });

  test('rejects a leading-zero port beside its canonical equivalent', () => {
    const env = validP2pEnv();
    env.TURN_URLS = 'stun:turn.example.test:3478,stun:turn.example.test:03478';

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
  });

  test.each([
    [
      'STUN default port with normalized DNS spelling',
      'stun:TURN.EXAMPLE.TEST.,stun:turn.example.test:3478',
    ],
    [
      'TURN TCP default port',
      'turn:turn.example.test?transport=tcp,turn:turn.example.test:3478?transport=tcp',
    ],
    [
      'TURN default transport with explicit UDP',
      'turn:turn.example.test:3478,turn:turn.example.test:3478?transport=udp',
    ],
    [
      'TURN TLS default port and transport',
      'turns:turn.example.test,turns:turn.example.test:5349?transport=tcp',
    ],
  ])('rejects duplicate endpoint expressed as %s', (_kind, urls) => {
    const env = validP2pEnv();
    env.TURN_URLS = urls;

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
    expect(error.message).toMatch(/duplicate/i);
  });

  test('keeps TURN UDP and TCP as distinct endpoints', () => {
    const env = validP2pEnv();
    env.TURN_URLS =
      'turn:turn.example.test,turn:turn.example.test?transport=tcp';

    expect(parseP2pServerConfig(env).turn.urls).toEqual(
      env.TURN_URLS.split(','),
    );
  });

  test.each([
    'turns:turn.example.test',
    'turns:turn.example.test:5349?transport=tcp',
    'turns:[2001:db8::1]:5349?transport=tcp',
  ])('accepts a canonical TURN TLS URL %s', (turnUrl) => {
    const env = validP2pEnv();
    env.TURN_HOST = turnUrl.includes('[2001:db8::1]')
      ? '2001:db8::1'
      : 'turn.example.test';
    env.TURN_URLS = turnUrl;

    expect(parseP2pServerConfig(env).turn.urls).toEqual([turnUrl]);
  });

  test.each(['development', 'test', 'production'] as const)(
    'requires at least one turn: URL in %s',
    (nodeEnv) => {
      const env = nodeEnv === 'production' ? productionP2pEnv() : validP2pEnv();
      env.NODE_ENV = nodeEnv;
      env.TURN_URLS = `stun:${env.TURN_HOST}:3478`;

      const error = captureError(env);
      expect(error.message).toContain('TURN_URLS');
      expect(error.message).toMatch(/turn:/i);
    },
  );

  test.each(['1', '299'])(
    'requires production TURN credentials to live at least 300 seconds (%s)',
    (ttl) => {
      const env = productionP2pEnv();
      env.TURN_CREDENTIAL_TTL_SECONDS = ttl;

      const error = captureError(env);
      expect(error.message).toContain('TURN_CREDENTIAL_TTL_SECONDS');
      expect(error.message).not.toContain(`=${ttl}`);
    },
  );

  test.each(['300', '86400'])(
    'accepts production TURN credential TTL boundary %s',
    (ttl) => {
      const env = productionP2pEnv();
      env.TURN_CREDENTIAL_TTL_SECONDS = ttl;

      expect(parseP2pServerConfig(env).turn.credentialTtlSeconds).toBe(
        Number(ttl),
      );
    },
  );

  test.each(['development', 'test'] as const)(
    'allows a one-second TURN credential TTL in %s',
    (nodeEnv) => {
      const env = validP2pEnv();
      env.NODE_ENV = nodeEnv;
      env.TURN_CREDENTIAL_TTL_SECONDS = '1';

      expect(parseP2pServerConfig(env).turn.credentialTtlSeconds).toBe(1);
    },
  );

  test.each([
    ['', /required|at least one/i],
    [
      Array.from(
        { length: 9 },
        (_, index) => `turn:turn.example.test:${3478 + index}`,
      ).join(','),
      /at most 8/i,
    ],
  ])('rejects an unbounded TURN_URLS list', (urls, reason) => {
    const env = validP2pEnv();
    env.TURN_URLS = urls;

    const error = captureError(env);
    expect(error.message).toContain('TURN_URLS');
    expect(error.message).toMatch(reason);
  });

  test.each([
    ['TURN_CREDENTIAL_TTL_SECONDS', '0'],
    ['TURN_CREDENTIAL_TTL_SECONDS', '86401'],
    ['ROOM_CODE_TTL_SECONDS', '-1'],
    ['ROOM_DISCONNECT_GRACE_SECONDS', '1.5'],
    ['SCREEN_LEASE_TTL_SECONDS', 'not-a-number'],
  ])('rejects invalid TTL %s=%s', (field, value) => {
    const env = validP2pEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
  });

  test.each([
    ['SERVER_PORT', '0'],
    ['SERVER_PORT', '65536'],
    ['SCREEN_BITRATE_MIN', '999999'],
    ['SCREEN_BITRATE_MAX', '10000001'],
  ])('rejects out-of-range numeric field %s=%s', (field, value) => {
    const env = validP2pEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
  });

  test('rejects a reversed screen bitrate range', () => {
    const env = validP2pEnv();
    env.SCREEN_BITRATE_MIN = '8000000';
    env.SCREEN_BITRATE_MAX = '4000000';

    const error = captureError(env);
    expect(error.issues).toContainEqual({
      field: 'SCREEN_BITRATE_MIN',
      reason: 'must be less than or equal to SCREEN_BITRATE_MAX',
    });
  });
});
