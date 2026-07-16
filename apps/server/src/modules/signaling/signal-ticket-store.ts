import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

export const SIGNAL_TICKET_EXPIRES_IN_SECONDS = 30;
export const SIGNAL_TICKET_TTL_MS = SIGNAL_TICKET_EXPIRES_IN_SECONDS * 1_000;

const SIGNAL_TICKET_BYTES = 32;
const SIGNAL_TICKET_LENGTH = 43;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_COLLISION_ATTEMPTS = 4;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 100;

export type SignalTicketStoreErrorCode =
  'CAPACITY_EXCEEDED' | 'COLLISION_LIMIT_EXCEEDED' | 'INVALID_RANDOM_SOURCE';

const errorMessages: Record<SignalTicketStoreErrorCode, string> = {
  CAPACITY_EXCEEDED: 'Signaling ticket capacity exceeded',
  COLLISION_LIMIT_EXCEEDED: 'Signaling ticket collision limit exceeded',
  INVALID_RANDOM_SOURCE: 'Signaling ticket random source returned invalid data',
};

export class SignalTicketStoreError extends Error {
  constructor(readonly code: SignalTicketStoreErrorCode) {
    super(errorMessages[code]);
    this.name = 'SignalTicketStoreError';
  }
}

export interface SignalTicketClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly accessTokenExpiresAtSeconds: number;
}

export interface IssuedSignalTicket {
  readonly value: string;
  readonly expiresAtMs: number;
}

export interface SignalTicketStoreStats {
  readonly size: number;
  readonly maxEntries: number;
}

export interface SignalTicketStore {
  issue(claims: SignalTicketClaims): IssuedSignalTicket;
  consume(value: string): SignalTicketClaims | null;
  clear(): void;
  stats(): SignalTicketStoreStats;
}

export interface SignalTicketStoreOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxEntries?: number;
  readonly maxCollisionAttempts?: number;
}

interface StoredSignalTicket {
  readonly claims: SignalTicketClaims;
  readonly expiresAtMs: number;
}

const assertPositiveSafeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

const readNow = (now: () => number): number => {
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('Signaling ticket clock must return milliseconds');
  }
  return nowMs;
};

const assertCanonicalText = (
  value: string,
  name: string,
  maxLength: number,
): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
};

const snapshotClaims = (claims: SignalTicketClaims): SignalTicketClaims =>
  Object.freeze({
    userId: assertCanonicalText(
      claims.userId,
      'Signal ticket user ID',
      MAX_IDENTIFIER_LENGTH,
    ),
    sessionId: assertCanonicalText(
      claims.sessionId,
      'Signal ticket session ID',
      MAX_IDENTIFIER_LENGTH,
    ),
    displayName: assertCanonicalText(
      claims.displayName,
      'Signal ticket display name',
      MAX_DISPLAY_NAME_LENGTH,
    ),
    accessTokenExpiresAtSeconds: (() => {
      if (
        !Number.isSafeInteger(claims.accessTokenExpiresAtSeconds) ||
        claims.accessTokenExpiresAtSeconds <= 0
      ) {
        throw new TypeError('Access token expiration is invalid');
      }
      return claims.accessTokenExpiresAtSeconds;
    })(),
  });

const isCanonicalTicket = (value: string): boolean => {
  if (
    typeof value !== 'string' ||
    value.length !== SIGNAL_TICKET_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64url');
  return (
    decoded.byteLength === SIGNAL_TICKET_BYTES &&
    decoded.toString('base64url') === value
  );
};

const hashTicket = (value: string): string =>
  createHash('sha256').update(value, 'ascii').digest('base64url');

export function createSignalTicketStore(
  options: SignalTicketStoreOptions = {},
): SignalTicketStore {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxCollisionAttempts =
    options.maxCollisionAttempts ?? DEFAULT_MAX_COLLISION_ATTEMPTS;
  assertPositiveSafeInteger(maxEntries, 'Signaling ticket maximum entries');
  assertPositiveSafeInteger(
    maxCollisionAttempts,
    'Signaling ticket maximum collision attempts',
  );

  const entries = new Map<string, StoredSignalTicket>();

  const pruneExpired = (nowMs: number): void => {
    for (const [ticketHash, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(ticketHash);
      }
    }
  };

  return Object.freeze({
    issue(claims: SignalTicketClaims) {
      const claimsSnapshot = snapshotClaims(claims);
      const nowMs = readNow(now);
      if (nowMs > Number.MAX_SAFE_INTEGER - SIGNAL_TICKET_TTL_MS) {
        throw new RangeError('Signaling ticket expiration exceeds safe range');
      }
      pruneExpired(nowMs);
      if (entries.size >= maxEntries) {
        throw new SignalTicketStoreError('CAPACITY_EXCEEDED');
      }

      for (let attempt = 0; attempt < maxCollisionAttempts; attempt += 1) {
        const random = randomBytes(SIGNAL_TICKET_BYTES);
        if (!(random instanceof Uint8Array) || random.byteLength !== 32) {
          throw new SignalTicketStoreError('INVALID_RANDOM_SOURCE');
        }
        const value = Buffer.from(random).toString('base64url');
        const ticketHash = hashTicket(value);
        if (entries.has(ticketHash)) {
          continue;
        }

        const expiresAtMs = nowMs + SIGNAL_TICKET_TTL_MS;
        entries.set(ticketHash, {
          claims: claimsSnapshot,
          expiresAtMs,
        });
        return Object.freeze({ value, expiresAtMs });
      }

      throw new SignalTicketStoreError('COLLISION_LIMIT_EXCEEDED');
    },

    consume(value: string) {
      if (!isCanonicalTicket(value)) {
        return null;
      }
      const nowMs = readNow(now);
      const ticketHash = hashTicket(value);
      const entry = entries.get(ticketHash);
      if (entry === undefined) {
        return null;
      }

      entries.delete(ticketHash);
      if (entry.expiresAtMs <= nowMs) {
        return null;
      }
      return entry.claims;
    },

    clear() {
      entries.clear();
    },

    stats() {
      pruneExpired(readNow(now));
      return Object.freeze({ size: entries.size, maxEntries });
    },
  });
}
