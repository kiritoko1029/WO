import { describe, expect, test } from 'vitest';

import {
  ServerConfigError,
  parseServerConfig,
  type ServerConfig,
} from '../src/index.js';

const developmentEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://rtc:password@localhost:5432/rtc',
  REDIS_URL: 'redis://localhost:6379/0',
  RUSTFS_ENDPOINT: 'http://localhost:9000',
  RUSTFS_REGION: 'cn-east-1',
  RUSTFS_ACCESS_KEY: 'dev-access',
  RUSTFS_SECRET_KEY: 'dev-secret',
  RUSTFS_BUCKET: 'rtc-assets',
  JWT_ACCESS_SECRET: 'dev-jwt',
  TURN_SHARED_SECRET: 'dev-turn',
  MEDIASOUP_ANNOUNCED_ADDRESS: 'localhost',
  MEDIASOUP_WORKER_PORT_MIN: '40000',
  MEDIASOUP_WORKER_PORT_MAX: '40100',
  SCREEN_BITRATE_MIN: '1000000',
  SCREEN_BITRATE_MAX: '10000000',
});

const productionEnv = (): Record<string, string> => ({
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://rtc.example.com',
  DATABASE_URL: 'postgres://rtc:password@db.internal:5432/rtc',
  REDIS_URL: 'rediss://cache.internal:6379/0',
  RUSTFS_ENDPOINT: 'https://rustfs.internal:9000',
  RUSTFS_REGION: 'cn-east-1',
  RUSTFS_ACCESS_KEY: 'prod-access-2026',
  RUSTFS_SECRET_KEY: 'rustfs-9C73mAq2Lx8Vt4Np6Yw1Hd5Ks7Rb',
  RUSTFS_BUCKET: 'rtc-assets',
  JWT_ACCESS_SECRET: 'jwt-4Rk8Px2Vn7Qm5Ts9Yc3Ld6Hw1Ba0Je',
  TURN_SHARED_SECRET: 'turn-6Zn2Qw8Ms4Yp7Kc1Vh5Tx9Ld3Ar0Fe',
  MEDIASOUP_ANNOUNCED_ADDRESS: '1.1.1.1',
  MEDIASOUP_WORKER_PORT_MIN: '40000',
  MEDIASOUP_WORKER_PORT_MAX: '40100',
  SCREEN_BITRATE_MIN: '1000000',
  SCREEN_BITRATE_MAX: '10000000',
});

const captureError = (env: Record<string, string | undefined>) => {
  try {
    parseServerConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerConfigError);
    return error as ServerConfigError;
  }

  throw new Error('Expected parseServerConfig to throw');
};

describe('parseServerConfig', () => {
  test('returns a canonical, deeply immutable development config', () => {
    const config: ServerConfig = parseServerConfig(developmentEnv());

    expect(config).toEqual({
      nodeEnv: 'development',
      publicUrl: 'http://localhost:3000/',
      database: {
        url: 'postgresql://rtc:password@localhost:5432/rtc',
      },
      redis: { url: 'redis://localhost:6379/0' },
      rustfs: {
        endpoint: 'http://localhost:9000/',
        region: 'cn-east-1',
        accessKey: 'dev-access',
        secretKey: 'dev-secret',
        bucket: 'rtc-assets',
      },
      auth: { jwtAccessSecret: 'dev-jwt' },
      turn: { sharedSecret: 'dev-turn' },
      mediasoup: {
        announcedAddress: 'localhost',
        workerPortRange: { min: 40000, max: 40100 },
      },
      screen: {
        bitrateRange: { min: 1_000_000, max: 10_000_000 },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.rustfs)).toBe(true);
    expect(Object.isFrozen(config.mediasoup.workerPortRange)).toBe(true);
    expect(Object.isFrozen(config.screen.bitrateRange)).toBe(true);
    expect(Reflect.set(config.screen.bitrateRange, 'min', 2)).toBe(false);
  });

  test('accepts a secure production config', () => {
    const config = parseServerConfig(productionEnv());

    expect(config.nodeEnv).toBe('production');
    expect(config.publicUrl).toBe('https://rtc.example.com/');
    expect(config.redis.url).toMatch(/^rediss:/);
    expect(config.mediasoup.announcedAddress).toBe('1.1.1.1');
  });

  test.each([
    'NODE_ENV',
    'PUBLIC_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'RUSTFS_ENDPOINT',
    'RUSTFS_REGION',
    'RUSTFS_ACCESS_KEY',
    'RUSTFS_SECRET_KEY',
    'RUSTFS_BUCKET',
    'JWT_ACCESS_SECRET',
    'TURN_SHARED_SECRET',
    'MEDIASOUP_ANNOUNCED_ADDRESS',
    'MEDIASOUP_WORKER_PORT_MIN',
    'MEDIASOUP_WORKER_PORT_MAX',
    'SCREEN_BITRATE_MIN',
    'SCREEN_BITRATE_MAX',
  ])('rejects missing required field %s', (field) => {
    const env: Record<string, string | undefined> = developmentEnv();
    delete env[field];

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.issues).toContainEqual(expect.objectContaining({ field }));
  });

  test('rejects an unsupported NODE_ENV', () => {
    const env = developmentEnv();
    env.NODE_ENV = 'staging';

    expect(() => parseServerConfig(env)).toThrow(/NODE_ENV/);
  });

  test.each([
    ['PUBLIC_URL', 'ftp://rtc.example.com'],
    ['DATABASE_URL', 'mysql://db.internal/rtc'],
    ['REDIS_URL', 'https://cache.internal'],
    ['RUSTFS_ENDPOINT', 's3://rustfs.internal'],
  ])('rejects an invalid URL scheme for %s', (field, value) => {
    const env = developmentEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.message).toMatch(/scheme|protocol/i);
  });

  test.each([
    ['development', 'http://localhost:3000/app'],
    ['test', 'http://localhost:3000/app'],
    ['production', 'https://rtc.example.com/app'],
  ])('requires an origin-only PUBLIC_URL in %s', (nodeEnv, publicUrl) => {
    const env = nodeEnv === 'production' ? productionEnv() : developmentEnv();
    env.NODE_ENV = nodeEnv;
    env.PUBLIC_URL = publicUrl;

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toMatch(/origin/i);
  });

  test.each([
    ['query', 'http://localhost:3000/?token=secret'],
    ['empty query', 'http://localhost:3000/?'],
    ['fragment', 'http://localhost:3000/#section'],
    ['empty fragment', 'http://localhost:3000/#'],
  ])('rejects a PUBLIC_URL with a %s', (_component, publicUrl) => {
    const env = developmentEnv();
    env.PUBLIC_URL = publicUrl;

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toMatch(/origin/i);
  });

  test.each([
    ['path', 'http://localhost:9000/bucket'],
    ['query', 'http://localhost:9000/?region=local'],
    ['empty query', 'http://localhost:9000/?'],
    ['fragment', 'http://localhost:9000/#section'],
    ['empty fragment', 'http://localhost:9000/#'],
  ])('rejects a RUSTFS_ENDPOINT with a %s', (_component, endpoint) => {
    const env = developmentEnv();
    env.RUSTFS_ENDPOINT = endpoint;

    const error = captureError(env);
    expect(error.message).toContain('RUSTFS_ENDPOINT');
    expect(error.message).toMatch(/origin/i);
  });

  test.each([
    ['PUBLIC_URL', 'http://url-user:url-password@localhost:3000/'],
    ['RUSTFS_ENDPOINT', 'http://rustfs-user:rustfs-password@localhost:9000/'],
  ])('rejects user information in %s without leaking it', (field, value) => {
    const env = developmentEnv();
    env[field] = value;

    const error = captureError(env);
    expect(error.message).toContain(field);
    expect(error.message).toMatch(/origin/i);
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain(new URL(value).username);
    expect(error.message).not.toContain(new URL(value).password);
    expect(JSON.stringify(error.issues)).not.toContain(value);
    expect(JSON.stringify(error.issues)).not.toContain(new URL(value).username);
    expect(JSON.stringify(error.issues)).not.toContain(new URL(value).password);
  });

  test('continues to allow user information and paths in database and Redis URLs', () => {
    const env = developmentEnv();
    env.DATABASE_URL =
      'postgresql://db-user:db-password@db.internal:5432/rtc/app?sslmode=require';
    env.REDIS_URL = 'redis://cache-user:cache-password@cache.internal:6379/4';

    const config = parseServerConfig(env);
    expect(config.database.url).toBe(env.DATABASE_URL);
    expect(config.redis.url).toBe(env.REDIS_URL);
  });

  test('requires HTTPS public URL in production', () => {
    const env = productionEnv();
    env.PUBLIC_URL = 'http://rtc.example.com';

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toContain('HTTPS');
  });

  test.each([
    ['localhost', 'https://localhost'],
    ['localhost subdomain', 'https://media.localhost'],
    ['localhost with trailing dot', 'https://localhost.'],
    ['IPv4 loopback', 'https://127.0.0.1'],
    ['IPv4 wildcard', 'https://0.0.0.0'],
    ['IPv6 loopback', 'https://[::1]'],
    ['IPv6 wildcard', 'https://[::]'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]'],
    ['IPv4-mapped wildcard', 'https://[::ffff:0.0.0.0]'],
  ])('rejects a production PUBLIC_URL using %s', (_kind, publicUrl) => {
    const env = productionEnv();
    env.PUBLIC_URL = publicUrl;

    const error = captureError(env);
    expect(error.message).toContain('PUBLIC_URL');
    expect(error.message).toMatch(/localhost|loopback|wildcard/i);
  });

  test('rejects a reversed worker port range', () => {
    const env = developmentEnv();
    env.MEDIASOUP_WORKER_PORT_MIN = '40100';
    env.MEDIASOUP_WORKER_PORT_MAX = '40000';

    const error = captureError(env);
    expect(error.message).toContain('MEDIASOUP_WORKER_PORT_MIN');
    expect(error.message).toMatch(/less than or equal/i);
  });

  test.each(['0', '65536', '40000.5', 'not-a-number'])(
    'rejects invalid worker port %s',
    (port) => {
      const env = developmentEnv();
      env.MEDIASOUP_WORKER_PORT_MIN = port;

      expect(() => parseServerConfig(env)).toThrow(/MEDIASOUP_WORKER_PORT_MIN/);
    },
  );

  test.each([
    ['SCREEN_BITRATE_MIN', '999999'],
    ['SCREEN_BITRATE_MIN', '10000000.5'],
    ['SCREEN_BITRATE_MAX', '10000001'],
  ])('rejects out-of-product bitrate for %s', (field, value) => {
    const env = developmentEnv();
    env[field] = value;

    expect(() => parseServerConfig(env)).toThrow(new RegExp(field));
  });

  test('rejects a reversed screen bitrate range', () => {
    const env = developmentEnv();
    env.SCREEN_BITRATE_MIN = '8000000';
    env.SCREEN_BITRATE_MAX = '4000000';

    const error = captureError(env);
    expect(error.message).toContain('SCREEN_BITRATE_MIN');
    expect(error.message).toMatch(/less than or equal/i);
  });

  test.each([
    ['JWT_ACCESS_SECRET', 'changeme'],
    ['TURN_SHARED_SECRET', 'default-turn-secret'],
    ['RUSTFS_SECRET_KEY', 'short'],
    ['RUSTFS_ACCESS_KEY', 'your-access-key'],
  ])(
    'rejects placeholder or short production credential %s',
    (field, value) => {
      const env = productionEnv();
      env[field] = value;

      const error = captureError(env);
      expect(error.message).toContain(field);
      expect(error.message).not.toContain(value);
    },
  );

  test.each([
    ['private', '10.0.0.1'],
    ['private', '172.16.0.1'],
    ['private', '192.168.0.1'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['link-local', '169.254.0.1'],
    ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['reserved', '240.0.0.1'],
    ['benchmark', '198.18.0.1'],
    ['documentation', '192.0.2.1'],
    ['unspecified', '0.0.0.0'],
    ['loopback', '127.0.0.1'],
    ['IPv4-mapped private IPv6', '::ffff:192.168.0.1'],
    ['IPv4-mapped public IPv6', '::ffff:1.1.1.1'],
    ['public IPv6', '2606:4700:4700::1111'],
    ['loopback IPv6', '::1'],
    ['hostname', 'media.example.com'],
  ])('rejects production %s announced address %s', (_range, address) => {
    const env = productionEnv();
    env.MEDIASOUP_ANNOUNCED_ADDRESS = address;

    const error = captureError(env);
    expect(error.message).toContain('MEDIASOUP_ANNOUNCED_ADDRESS');
    expect(error.message).toMatch(/public.*IPv4/i);
    expect(error.message).not.toContain(address);
    expect(JSON.stringify(error.issues)).not.toContain(address);
  });

  test.each(['localhost', 'media.internal', '127.0.0.1', '::1'])(
    'allows announced address %s in development',
    (address) => {
      const env = developmentEnv();
      env.MEDIASOUP_ANNOUNCED_ADDRESS = address;

      expect(parseServerConfig(env).mediasoup.announcedAddress).toBe(address);
    },
  );

  test('allows a public IPv4 announced address in development', () => {
    const env = developmentEnv();
    env.MEDIASOUP_ANNOUNCED_ADDRESS = '8.8.8.8';

    expect(parseServerConfig(env).mediasoup.announcedAddress).toBe('8.8.8.8');
  });

  test('does not include a rejected secret value in errors', () => {
    const env = productionEnv();
    const rejectedSecret = 'visible-but-too-short';
    env.JWT_ACCESS_SECRET = rejectedSecret;

    const error = captureError(env);
    expect(error.message).toContain('JWT_ACCESS_SECRET');
    expect(error.message).not.toContain(rejectedSecret);
    expect(JSON.stringify(error.issues)).not.toContain(rejectedSecret);
  });

  test('preserves ordered legacy issue details for multiple failures', () => {
    const env = productionEnv();
    env.PUBLIC_URL = 'http://localhost:3000';
    env.JWT_ACCESS_SECRET = 'change-me';
    env.SCREEN_BITRATE_MIN = '8000000';
    env.SCREEN_BITRATE_MAX = '4000000';

    const error = captureError(env);
    expect(error.issues).toEqual([
      {
        field: 'SCREEN_BITRATE_MIN',
        reason: 'must be less than or equal to SCREEN_BITRATE_MAX',
      },
      { field: 'PUBLIC_URL', reason: 'must use HTTPS in production' },
      {
        field: 'PUBLIC_URL',
        reason:
          'must not use localhost, a loopback IP, or a wildcard IP in production',
      },
      {
        field: 'JWT_ACCESS_SECRET',
        reason: 'must not use a placeholder value in production',
      },
    ]);
    expect(error.message).toBe(
      'Invalid server configuration: SCREEN_BITRATE_MIN: must be less than or equal to SCREEN_BITRATE_MAX; PUBLIC_URL: must use HTTPS in production; PUBLIC_URL: must not use localhost, a loopback IP, or a wildcard IP in production; JWT_ACCESS_SECRET: must not use a placeholder value in production',
    );
  });
});
