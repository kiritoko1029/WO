import { SignJWT, jwtVerify } from 'jose';

export const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;
export const ACCESS_TOKEN_AUDIENCE = 'wo-desktop';
export const ACCESS_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS = 5;
export const ACCESS_TOKEN_MAX_LENGTH = 4_096;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AccessTokenIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SignAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AccessTokenService {
  sign(input: SignAccessTokenInput): Promise<string>;
  verify(token: string): Promise<AccessTokenIdentity>;
}

export interface AccessTokenServiceOptions {
  readonly jwtAccessSecret: string;
  readonly issuer: string;
  readonly now?: () => Date;
}

function decodeCanonicalSecret(secret: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(secret)) {
    throw new TypeError('JWT access secret must use canonical base64url');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.toString('base64url') !== secret) {
    throw new TypeError('JWT access secret must use canonical base64url');
  }
  if (decoded.byteLength < 32) {
    throw new TypeError('JWT access secret must decode to at least 32 bytes');
  }
  return new Uint8Array(decoded);
}

function snapshotDate(value: Date): Date {
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('Access-token clock must return a valid Date');
  }
  return new Date(milliseconds);
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError('Access token identity claims must be UUIDs');
  }
}

function assertNumericDate(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Access token contains invalid temporal claims');
  }
}

function assertTemporalClaims(
  issuedAt: number,
  expiresAt: number,
  currentTime: number,
): void {
  if (
    issuedAt < 0 ||
    issuedAt > currentTime + ACCESS_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ACCESS_TOKEN_EXPIRES_IN_SECONDS
  ) {
    throw new TypeError('Access token contains invalid temporal claims');
  }
}

export function createAccessTokenService(
  options: AccessTokenServiceOptions,
): AccessTokenService {
  const key = decodeCanonicalSecret(options.jwtAccessSecret);
  const issuer = new URL(options.issuer).toString();
  const now = options.now ?? (() => new Date());

  return {
    async sign(input) {
      assertUuid(input.userId);
      assertUuid(input.sessionId);
      const issuedAt = Math.floor(snapshotDate(now()).getTime() / 1_000);
      return new SignJWT({ sessionId: input.sessionId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(input.userId)
        .setIssuer(issuer)
        .setAudience(ACCESS_TOKEN_AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_EXPIRES_IN_SECONDS)
        .sign(key);
    },

    async verify(token) {
      if (token.length > ACCESS_TOKEN_MAX_LENGTH) {
        throw new RangeError('Access token exceeds maximum length');
      }
      const currentDate = snapshotDate(now());
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience: ACCESS_TOKEN_AUDIENCE,
        issuer,
        currentDate,
        requiredClaims: ['sub', 'sessionId', 'iat', 'exp'],
      });
      const userId = payload.sub;
      const sessionId = payload.sessionId;
      const issuedAt = payload.iat;
      const expiresAt = payload.exp;
      assertUuid(userId);
      assertUuid(sessionId);
      assertNumericDate(issuedAt);
      assertNumericDate(expiresAt);
      assertTemporalClaims(
        issuedAt,
        expiresAt,
        Math.floor(currentDate.getTime() / 1_000),
      );

      return {
        userId,
        sessionId,
        issuedAt,
        expiresAt,
      };
    },
  };
}
