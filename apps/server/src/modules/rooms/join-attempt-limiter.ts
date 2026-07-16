import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_KEYS = 10_000;

interface AttemptWindow {
  attempts: number;
  expiresAtMs: number;
}

export interface JoinAttemptInput {
  readonly userId: string;
  readonly remoteIp: string;
  readonly requestId: string;
}

export interface JoinAttemptResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface JoinAttemptLimitedEvent {
  readonly anonymousUserId: string;
  readonly requestId: string;
  readonly retryAfterMs: number;
}

export interface JoinAttemptLimiterDependencies {
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly maxAttempts?: number;
  readonly maxKeys?: number;
  readonly anonymizeUserId?: (userId: string) => string;
  readonly onLimited?: (event: JoinAttemptLimitedEvent) => void;
}

export interface JoinAttemptLimiter {
  consume(input: JoinAttemptInput): JoinAttemptResult;
  getStats(): Readonly<{ keys: number }>;
  clear(): void;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function snapshotNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new RangeError('Join-attempt clock must return a finite number');
  }
  return value;
}

function canonicalizeIp(remoteIp: string): string {
  const version = isIP(remoteIp);
  if (version === 0) {
    throw new TypeError(
      'remoteIp must be a canonicalizable IPv4 or IPv6 address',
    );
  }
  if (version === 4) {
    return remoteIp;
  }

  const host = new URL(`http://[${remoteIp}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mapped === null) {
    return host;
  }
  const upper = Number.parseInt(mapped[1]!, 16);
  const lower = Number.parseInt(mapped[2]!, 16);
  return [upper >>> 8, upper & 0xff, lower >>> 8, lower & 0xff].join('.');
}

function defaultAnonymizeUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('base64url').slice(0, 16);
}

export function createJoinAttemptLimiter(
  dependencies: JoinAttemptLimiterDependencies = {},
): JoinAttemptLimiter {
  const now = dependencies.now ?? Date.now;
  const windowMs = requirePositiveInteger(
    dependencies.windowMs ?? DEFAULT_WINDOW_MS,
    'windowMs',
  );
  const maxAttempts = requirePositiveInteger(
    dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    'maxAttempts',
  );
  const maxKeys = requirePositiveInteger(
    dependencies.maxKeys ?? DEFAULT_MAX_KEYS,
    'maxKeys',
  );
  const anonymizeUserId =
    dependencies.anonymizeUserId ?? defaultAnonymizeUserId;
  const windows = new Map<string, AttemptWindow>();

  const pruneExpired = (operationTime: number): void => {
    for (const [key, value] of windows) {
      if (value.expiresAtMs <= operationTime) {
        windows.delete(key);
      }
    }
  };

  const makeRoom = (operationTime: number): void => {
    pruneExpired(operationTime);
    while (windows.size >= maxKeys) {
      const oldestKey = windows.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      windows.delete(oldestKey);
    }
  };

  return {
    consume(input) {
      if (input.userId.trim().length === 0) {
        throw new TypeError('userId must not be empty');
      }
      if (input.requestId.trim().length === 0) {
        throw new TypeError('requestId must not be empty');
      }

      const operationTime = snapshotNow(now);
      const key = JSON.stringify([
        input.userId,
        canonicalizeIp(input.remoteIp),
      ]);
      let window = windows.get(key);
      if (window !== undefined && window.expiresAtMs <= operationTime) {
        windows.delete(key);
        window = undefined;
      }
      if (window === undefined) {
        makeRoom(operationTime);
        window = { attempts: 0, expiresAtMs: operationTime + windowMs };
      } else {
        windows.delete(key);
      }
      windows.set(key, window);

      if (window.attempts >= maxAttempts) {
        const retryAfterMs = Math.max(0, window.expiresAtMs - operationTime);
        try {
          dependencies.onLimited?.({
            anonymousUserId: anonymizeUserId(input.userId),
            requestId: input.requestId,
            retryAfterMs,
          });
        } catch {
          // Observability must not change the rate-limit decision.
        }
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      window.attempts += 1;
      return {
        allowed: true,
        remaining: maxAttempts - window.attempts,
        retryAfterMs: 0,
      };
    },

    getStats() {
      pruneExpired(snapshotNow(now));
      return Object.freeze({ keys: windows.size });
    },

    clear() {
      windows.clear();
    },
  };
}
