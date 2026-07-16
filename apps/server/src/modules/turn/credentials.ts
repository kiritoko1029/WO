import { createHmac } from 'node:crypto';

const TURN_OPAQUE_ID_DOMAIN = Buffer.from(
  'wo.turn.rest.opaque-identity.v1\0',
  'ascii',
);
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SECRET_LENGTH = 4_096;
const OPAQUE_SUFFIX_BYTES = 16;

export interface CreateTurnCredentialsInput {
  readonly roomId: string;
  readonly userId: string;
  readonly connectionEpoch: number;
  readonly nowSeconds: number;
  readonly ttlSeconds: number;
  readonly secret: string;
}

export interface TurnCredentials {
  readonly username: string;
  readonly credential: string;
  readonly expiresAtSeconds: number;
}

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
};

const assertIdentifier = (value: string, name: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
};

const assertSafeInteger = (
  value: number,
  name: string,
  minimum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
};

const assertSecret = (secret: string): string => {
  if (
    typeof secret !== 'string' ||
    secret.length === 0 ||
    secret.length > MAX_SECRET_LENGTH ||
    secret.trim() !== secret ||
    hasControlCharacter(secret)
  ) {
    throw new TypeError('TURN shared secret is invalid');
  }
  return secret;
};

const lengthPrefixedUtf8 = (value: string): Buffer => {
  const encoded = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.byteLength);
  return Buffer.concat([length, encoded]);
};

const encodeEpoch = (connectionEpoch: number): Buffer => {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(connectionEpoch));
  return encoded;
};

export function createTurnCredentials(
  input: CreateTurnCredentialsInput,
): TurnCredentials {
  const roomId = assertIdentifier(input.roomId, 'TURN room ID');
  const userId = assertIdentifier(input.userId, 'TURN user ID');
  const connectionEpoch = assertSafeInteger(
    input.connectionEpoch,
    'TURN connection epoch',
    0,
  );
  const nowSeconds = assertSafeInteger(
    input.nowSeconds,
    'TURN current time',
    0,
  );
  const ttlSeconds = assertSafeInteger(
    input.ttlSeconds,
    'TURN credential TTL',
    1,
  );
  const secret = assertSecret(input.secret);
  if (nowSeconds > Number.MAX_SAFE_INTEGER - ttlSeconds) {
    throw new RangeError('TURN credential expiration exceeds safe range');
  }

  const expiresAtSeconds = nowSeconds + ttlSeconds;
  const opaqueSuffix = createHmac('sha256', secret)
    .update(TURN_OPAQUE_ID_DOMAIN)
    .update(lengthPrefixedUtf8(roomId))
    .update(lengthPrefixedUtf8(userId))
    .update(encodeEpoch(connectionEpoch))
    .digest()
    .subarray(0, OPAQUE_SUFFIX_BYTES)
    .toString('base64url');
  const username = `${expiresAtSeconds}:${opaqueSuffix}`;
  const credential = createHmac('sha1', secret)
    .update(username, 'utf8')
    .digest('base64');

  return Object.freeze({ username, credential, expiresAtSeconds });
}
