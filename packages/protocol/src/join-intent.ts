import { z } from 'zod';

import { roomCodeSchema } from './room.js';

const MAX_ORIGIN_LENGTH = 2_048;
const LAN_INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface RuntimeUrl {
  readonly protocol: string;
  readonly origin: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly href: string;
  readonly searchParams: {
    set(name: string, value: string): void;
  };
}

type RuntimeUrlConstructor = new (input: string) => RuntimeUrl;

function runtimeUrl(value: string): RuntimeUrl {
  const constructor = (
    globalThis as unknown as {
      readonly URL?: RuntimeUrlConstructor;
    }
  ).URL;
  if (constructor === undefined) {
    throw new TypeError('URL parser is unavailable');
  }
  return new constructor(value);
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = runtimeUrl(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== hostname.split('.')[index],
    )
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isCanonicalLanRealtimeEndpoint(value: string): boolean {
  try {
    const url = runtimeUrl(value);
    return (
      url.protocol === 'ws:' &&
      isPrivateIpv4(url.hostname) &&
      url.port !== '' &&
      url.pathname === '/v1/realtime' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === '' &&
      url.href === value
    );
  } catch {
    return false;
  }
}

export const serverJoinIntentSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('server'),
    serverOrigin: z
      .string()
      .max(MAX_ORIGIN_LENGTH)
      .refine(isCanonicalHttpsOrigin),
    roomCode: roomCodeSchema,
  })
  .strict();

export const lanJoinIntentSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('lan'),
    endpoint: z
      .string()
      .max(MAX_ORIGIN_LENGTH)
      .refine(isCanonicalLanRealtimeEndpoint),
    roomCode: roomCodeSchema,
    inviteKey: z.string().regex(LAN_INVITE_KEY_PATTERN),
  })
  .strict();

export const joinIntentSchema = z.discriminatedUnion('mode', [
  serverJoinIntentSchema,
  lanJoinIntentSchema,
]);

export type ServerJoinIntent = z.infer<typeof serverJoinIntentSchema>;
export type LanJoinIntent = z.infer<typeof lanJoinIntentSchema>;
export type JoinIntent = z.infer<typeof joinIntentSchema>;

export function createServerShareUrl(intent: ServerJoinIntent): string {
  const parsed = serverJoinIntentSchema.parse(intent);
  return `${parsed.serverOrigin}/join/${parsed.roomCode}`;
}

export function createJoinProtocolUrl(intent: JoinIntent): string {
  const parsed = joinIntentSchema.parse(intent);
  const url = runtimeUrl('wo://join');
  url.searchParams.set('v', String(parsed.version));
  url.searchParams.set('mode', parsed.mode);
  url.searchParams.set(
    parsed.mode === 'server' ? 'origin' : 'endpoint',
    parsed.mode === 'server' ? parsed.serverOrigin : parsed.endpoint,
  );
  url.searchParams.set('room', parsed.roomCode);
  if (parsed.mode === 'lan') url.searchParams.set('key', parsed.inviteKey);
  return url.href;
}
