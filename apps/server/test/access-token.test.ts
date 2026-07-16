import { SignJWT, type JWTPayload } from 'jose';
import { describe, expect, test } from 'vitest';

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  createAccessTokenService,
} from '../src/modules/auth/access-token.ts';

const NOW = new Date('2026-07-16T00:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://rtc.example.test/';
const JWT_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
).toString('base64url');
const JWT_KEY = new Uint8Array(Buffer.from(JWT_SECRET, 'base64url'));
const USER_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const MAX_ACCESS_TOKEN_LENGTH = 4_096;
const FUTURE_IAT_TOLERANCE_SECONDS = 5;

function createService() {
  return createAccessTokenService({
    jwtAccessSecret: JWT_SECRET,
    issuer: ISSUER,
    now: () => new Date(NOW),
  });
}

async function signClaims(
  overrides: JWTPayload = {},
  algorithm = 'HS256',
): Promise<string> {
  return new SignJWT({
    sub: USER_ID,
    sessionId: SESSION_ID,
    iss: ISSUER,
    aud: ACCESS_TOKEN_AUDIENCE,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    ...overrides,
  })
    .setProtectedHeader({ alg: algorithm, typ: 'JWT' })
    .sign(JWT_KEY);
}

describe('access-token claim validation', () => {
  test('signs and verifies canonical UUID identities for 15 minutes', async () => {
    const service = createService();

    const token = await service.sign({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(token.length).toBeLessThanOrEqual(MAX_ACCESS_TOKEN_LENGTH);
    await expect(service.verify(token)).resolves.toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    });
  });

  test('accepts an iat exactly five seconds in the future', async () => {
    const issuedAt = NOW_SECONDS + FUTURE_IAT_TOLERANCE_SECONDS;
    const token = await signClaims({
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    });

    await expect(createService().verify(token)).resolves.toMatchObject({
      issuedAt,
    });
  });

  test('rejects an iat more than five seconds in the future', async () => {
    const issuedAt = NOW_SECONDS + FUTURE_IAT_TOLERANCE_SECONDS + 1;
    const token = await signClaims({
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    });

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test('rejects a same-key token with an 86400-second lifetime', async () => {
    const token = await signClaims({
      exp: NOW_SECONDS + 86_400,
    });

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test.each([
    {
      name: 'expiration equal to issuance',
      iat: NOW_SECONDS + 1,
      exp: NOW_SECONDS + 1,
    },
    {
      name: 'expiration before issuance',
      iat: NOW_SECONDS + 2,
      exp: NOW_SECONDS + 1,
    },
  ])('rejects $name', async ({ iat, exp }) => {
    const token = await signClaims({ iat, exp });

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test('rejects a negative iat', async () => {
    const token = await signClaims({ iat: -1 });

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test.each([
    {
      name: 'unsafe iat integer',
      overrides: {
        iat: Number.MAX_SAFE_INTEGER + 1,
        exp: Number.MAX_SAFE_INTEGER + 3,
      },
    },
    {
      name: 'unsafe exp integer',
      overrides: { exp: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: 'fractional iat',
      overrides: { iat: NOW_SECONDS + 0.5 },
    },
    {
      name: 'fractional exp',
      overrides: { exp: NOW_SECONDS + 0.5 },
    },
  ])('rejects a token with an $name', async ({ overrides }) => {
    const token = await signClaims(overrides);

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test.each([
    {
      name: 'non-UUID subject',
      overrides: { sub: 'user-1' },
    },
    {
      name: 'oversized subject',
      overrides: { sub: 'a'.repeat(256) },
    },
    {
      name: 'non-UUID sessionId',
      overrides: { sessionId: 'session-1' },
    },
    {
      name: 'oversized sessionId',
      overrides: { sessionId: 'b'.repeat(256) },
    },
  ])('rejects a same-key token with an $name', async ({ overrides }) => {
    const token = await signClaims(overrides);

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test('rejects a same-key token with a noncanonical uppercase UUID', async () => {
    const token = await signClaims({
      sub: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    });

    await expect(createService().verify(token)).rejects.toThrow(TypeError);
  });

  test.each([
    {
      name: 'non-UUID userId',
      input: { userId: 'user-1', sessionId: SESSION_ID },
    },
    {
      name: 'oversized userId',
      input: { userId: 'a'.repeat(256), sessionId: SESSION_ID },
    },
    {
      name: 'non-UUID sessionId',
      input: { userId: USER_ID, sessionId: 'session-1' },
    },
    {
      name: 'oversized sessionId',
      input: { userId: USER_ID, sessionId: 'b'.repeat(256) },
    },
  ])('refuses to sign an identity with an $name', async ({ input }) => {
    await expect(createService().sign(input)).rejects.toThrow(TypeError);
  });

  test.each([
    {
      name: 'different issuer',
      algorithm: 'HS256',
      overrides: { iss: 'https://attacker.example.test/' },
    },
    {
      name: 'different audience',
      algorithm: 'HS256',
      overrides: { aud: 'attacker-client' },
    },
    {
      name: 'HS512 algorithm',
      algorithm: 'HS512',
      overrides: {},
    },
  ])(
    'rejects a same-key token with a $name',
    async ({ algorithm, overrides }) => {
      const token = await signClaims(overrides, algorithm);

      await expect(createService().verify(token)).rejects.toThrow();
    },
  );

  test('rejects a validly signed token above the total length limit', async () => {
    const token = await signClaims({
      padding: 'x'.repeat(MAX_ACCESS_TOKEN_LENGTH),
    });
    expect(token.length).toBeGreaterThan(MAX_ACCESS_TOKEN_LENGTH);

    await expect(createService().verify(token)).rejects.toThrow(
      /maximum length/iu,
    );
  });
});
