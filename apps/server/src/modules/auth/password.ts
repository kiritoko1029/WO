import { argon2id, hash, verify } from 'argon2';

export const PASSWORD_HASH_OPTIONS = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_HASH_ALGORITHM = 'argon2id';
const PASSWORD_HASH_VERSION = 'v=19';
const PASSWORD_HASH_PARAMETERS =
  `m=${PASSWORD_HASH_OPTIONS.memoryCost},` +
  `t=${PASSWORD_HASH_OPTIONS.timeCost},` +
  `p=${PASSWORD_HASH_OPTIONS.parallelism}`;

function phcBase64Length(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

const PASSWORD_SALT_ENCODED_LENGTH = phcBase64Length(PASSWORD_SALT_LENGTH);
const PASSWORD_DIGEST_ENCODED_LENGTH = phcBase64Length(
  PASSWORD_HASH_OPTIONS.hashLength,
);
const PASSWORD_HASH_MAX_LENGTH =
  `$${PASSWORD_HASH_ALGORITHM}$${PASSWORD_HASH_VERSION}$${PASSWORD_HASH_PARAMETERS}$`
    .length +
  PASSWORD_SALT_ENCODED_LENGTH +
  1 +
  PASSWORD_DIGEST_ENCODED_LENGTH;

export interface PasswordVerifierDependencies {
  readonly verifyHash: (
    passwordHash: string,
    password: string,
  ) => Promise<boolean>;
}

function isCanonicalPhcBase64(value: string, decodedLength: number): boolean {
  if (value.length !== phcBase64Length(decodedLength)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return (
      decoded.length === decodedLength &&
      decoded.toString('base64').replace(/=+$/u, '') === value
    );
  } catch {
    return false;
  }
}

function isSupportedPasswordHash(passwordHash: string): boolean {
  if (passwordHash.length > PASSWORD_HASH_MAX_LENGTH) {
    return false;
  }

  const parts = passwordHash.split('$');
  if (parts.length !== 6) {
    return false;
  }
  const [empty, algorithm, version, parameters, salt, digest] = parts;
  return (
    empty === '' &&
    algorithm === PASSWORD_HASH_ALGORITHM &&
    version === PASSWORD_HASH_VERSION &&
    parameters === PASSWORD_HASH_PARAMETERS &&
    isCanonicalPhcBase64(salt, PASSWORD_SALT_LENGTH) &&
    isCanonicalPhcBase64(digest, PASSWORD_HASH_OPTIONS.hashLength)
  );
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    type: argon2id,
    ...PASSWORD_HASH_OPTIONS,
  });
}

export function createPasswordVerifier(
  dependencies: PasswordVerifierDependencies,
): (passwordHash: string, password: string) => Promise<boolean> {
  return async (passwordHash, password) => {
    if (!isSupportedPasswordHash(passwordHash)) {
      return false;
    }
    try {
      return await dependencies.verifyHash(passwordHash, password);
    } catch {
      return false;
    }
  };
}

export const verifyPassword = createPasswordVerifier({ verifyHash: verify });
