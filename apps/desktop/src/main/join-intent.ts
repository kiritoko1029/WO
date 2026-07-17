import {
  createJoinProtocolUrl,
  createServerShareUrl,
  joinIntentSchema,
  type JoinIntent,
  type ServerJoinIntent,
} from '@wo/protocol';

export { createJoinProtocolUrl, createServerShareUrl };

const MAX_JOIN_URL_LENGTH = 4_096;
const SERVER_KEYS = new Set(['v', 'mode', 'origin', 'room']);
const LAN_KEYS = new Set(['v', 'mode', 'endpoint', 'room', 'key']);

function hasExactKeys(search: URLSearchParams, expected: Set<string>): boolean {
  const keys = [...search.keys()];
  return (
    keys.length === expected.size &&
    keys.every((key) => expected.has(key) && search.getAll(key).length === 1)
  );
}

function parseWoJoinUrl(url: URL): JoinIntent | null {
  if (
    url.protocol !== 'wo:' ||
    url.hostname !== 'join' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  const version = url.searchParams.get('v');
  const mode = url.searchParams.get('mode');
  const input =
    version === '1' &&
    mode === 'server' &&
    hasExactKeys(url.searchParams, SERVER_KEYS)
      ? {
          version: 1,
          mode,
          serverOrigin: url.searchParams.get('origin'),
          roomCode: url.searchParams.get('room'),
        }
      : version === '1' &&
          mode === 'lan' &&
          hasExactKeys(url.searchParams, LAN_KEYS)
        ? {
            version: 1,
            mode,
            endpoint: url.searchParams.get('endpoint'),
            roomCode: url.searchParams.get('room'),
            inviteKey: url.searchParams.get('key'),
          }
        : null;
  if (input === null) return null;
  const parsed = joinIntentSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseHttpsJoinUrl(url: URL): ServerJoinIntent | null {
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  const match = /^\/join\/(\d{6})$/u.exec(url.pathname);
  if (match === null) return null;
  const parsed = joinIntentSchema.safeParse({
    version: 1,
    mode: 'server',
    serverOrigin: url.origin,
    roomCode: match[1],
  });
  return parsed.success && parsed.data.mode === 'server' ? parsed.data : null;
}

export function parseJoinIntent(value: string): JoinIntent | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_JOIN_URL_LENGTH
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'wo:'
      ? parseWoJoinUrl(url)
      : parseHttpsJoinUrl(url);
  } catch {
    return null;
  }
}

export function findJoinIntent(
  argumentsList: readonly string[],
): JoinIntent | null {
  for (const argument of argumentsList) {
    const intent = parseJoinIntent(argument);
    if (intent !== null) return intent;
  }
  return null;
}

export function withoutJoinIntentArguments(
  argumentsList: readonly string[],
): string[] {
  return argumentsList.filter((argument) => parseJoinIntent(argument) === null);
}

export interface PendingJoinIntentStore {
  push(intent: JoinIntent): void;
  consume(): JoinIntent | null;
}

export function createPendingJoinIntentStore(): PendingJoinIntentStore {
  let pending: JoinIntent | null = null;
  return Object.freeze({
    push: (intent: JoinIntent) => {
      pending = joinIntentSchema.parse(intent);
    },
    consume: () => {
      const intent = pending;
      pending = null;
      return intent;
    },
  });
}
