import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { parseRefreshTokenHash, type RefreshTokenHash } from '@wo/database';

export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export interface RefreshTokenGenerationOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

export function generateRefreshToken(
  options: RefreshTokenGenerationOptions = {},
): string {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const bytes = randomBytes(REFRESH_TOKEN_BYTES);
  if (bytes.byteLength !== REFRESH_TOKEN_BYTES) {
    throw new RangeError('Refresh-token source returned an invalid byte count');
  }
  return bytes.toString('base64url');
}

export function hashRefreshToken(token: string): RefreshTokenHash {
  return parseRefreshTokenHash(
    createHash('sha256').update(token, 'utf8').digest('hex'),
  );
}
