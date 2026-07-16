import { argon2i, hash as hashWithArgon } from 'argon2';
import { describe, expect, test, vi } from 'vitest';

import {
  PASSWORD_HASH_OPTIONS,
  createPasswordVerifier,
  hashPassword,
  verifyPassword,
} from '../src/modules/auth/password.ts';

const CANONICAL_SALT = 'cNYqBnfl1U5oBLHQAyYd6A';
const CANONICAL_DIGEST = 'tpbMk8xf2F4smIV3VZGYOSwkUvPVupW1cHbAv4GBFps';
const CANONICAL_PASSWORD_HASH = `$argon2id$v=19$m=19456,t=2,p=1$${CANONICAL_SALT}$${CANONICAL_DIGEST}`;

describe('password hashing', () => {
  test('composes password verification with a native verifier', async () => {
    const verifyHash = vi.fn(async () => true);
    const verifier = createPasswordVerifier({ verifyHash });

    await expect(
      verifier(CANONICAL_PASSWORD_HASH, 'correct horse battery staple'),
    ).resolves.toBe(true);
    expect(verifyHash).toHaveBeenCalledOnce();
    expect(verifyHash).toHaveBeenCalledWith(
      CANONICAL_PASSWORD_HASH,
      'correct horse battery staple',
    );
  });

  test.each([
    [
      'an oversized encoded hash',
      `${CANONICAL_PASSWORD_HASH}${'A'.repeat(4_096)}`,
    ],
    [
      'an excessive memory cost',
      CANONICAL_PASSWORD_HASH.replace('m=19456', 'm=4294967295'),
    ],
    [
      'a different memory cost',
      CANONICAL_PASSWORD_HASH.replace('m=19456', 'm=19455'),
    ],
    ['a different time cost', CANONICAL_PASSWORD_HASH.replace('t=2', 't=3')],
    ['a different parallelism', CANONICAL_PASSWORD_HASH.replace('p=1', 'p=2')],
    [
      'a different Argon2 algorithm',
      CANONICAL_PASSWORD_HASH.replace('argon2id', 'argon2i'),
    ],
    [
      'a different Argon2 version',
      CANONICAL_PASSWORD_HASH.replace('v=19', 'v=16'),
    ],
    [
      'a non-canonical memory cost integer',
      CANONICAL_PASSWORD_HASH.replace('m=19456', 'm=019456'),
    ],
    [
      'a non-canonical time cost integer',
      CANONICAL_PASSWORD_HASH.replace('t=2', 't=02'),
    ],
    [
      'a non-canonical parallelism integer',
      CANONICAL_PASSWORD_HASH.replace('p=1', 'p=01'),
    ],
    [
      'an extra Argon2 parameter',
      CANONICAL_PASSWORD_HASH.replace('p=1', 'p=1,keyid=AA'),
    ],
    [
      'a missing digest field',
      CANONICAL_PASSWORD_HASH.slice(
        0,
        CANONICAL_PASSWORD_HASH.lastIndexOf('$'),
      ),
    ],
    ['an extra PHC field', `${CANONICAL_PASSWORD_HASH}$extra`],
    [
      'a salt encoding outside the PHC base64 alphabet',
      CANONICAL_PASSWORD_HASH.replace(
        CANONICAL_SALT,
        `-${CANONICAL_SALT.slice(1)}`,
      ),
    ],
    [
      'a padded salt encoding',
      CANONICAL_PASSWORD_HASH.replace(CANONICAL_SALT, `${CANONICAL_SALT}==`),
    ],
    [
      'a salt encoding with non-zero trailing bits',
      CANONICAL_PASSWORD_HASH.replace(
        CANONICAL_SALT,
        `${CANONICAL_SALT.slice(0, -1)}B`,
      ),
    ],
    [
      'a padded digest encoding',
      CANONICAL_PASSWORD_HASH.replace(CANONICAL_DIGEST, `${CANONICAL_DIGEST}=`),
    ],
    [
      'a digest encoding with non-zero trailing bits',
      CANONICAL_PASSWORD_HASH.replace(
        CANONICAL_DIGEST,
        `${CANONICAL_DIGEST.slice(0, -1)}t`,
      ),
    ],
    [
      'a salt with the wrong decoded length',
      CANONICAL_PASSWORD_HASH.replace(CANONICAL_SALT, CANONICAL_SALT.slice(1)),
    ],
    [
      'a digest with the wrong decoded length',
      CANONICAL_PASSWORD_HASH.replace(
        CANONICAL_DIGEST,
        CANONICAL_DIGEST.slice(1),
      ),
    ],
  ])('rejects %s before native verification', async (_case, passwordHash) => {
    const verifyHash = vi.fn(async () => false);
    const verifier = createPasswordVerifier({ verifyHash });

    await expect(
      verifier(passwordHash, 'correct horse battery staple'),
    ).resolves.toBe(false);
    expect(verifyHash.mock.calls.length).toBe(0);
  });

  test('stores an explicitly configured Argon2id hash rather than the password', async () => {
    const password = 'correct horse battery staple';

    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(hash).not.toContain('correct horse');
    expect(PASSWORD_HASH_OPTIONS).toEqual({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  test('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(
      verifyPassword(hash, 'wrong horse battery staple'),
    ).resolves.toBe(false);
  });

  test.each(['', 'not-an-argon-hash', '$argon2id$malformed'])(
    'treats malformed stored hash %j as a failed verification',
    async (hash) => {
      await expect(
        verifyPassword(hash, 'correct horse battery staple'),
      ).resolves.toBe(false);
    },
  );

  test('rejects a stored digest using a different Argon2 variant', async () => {
    const digest = await hashWithArgon('correct horse battery staple', {
      type: argon2i,
    });

    await expect(
      verifyPassword(digest, 'correct horse battery staple'),
    ).resolves.toBe(false);
  });
});
