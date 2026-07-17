import {
  lanJoinIntentSchema,
  publicAuthUserSchema,
  signalTicketResponseSchema,
  type LanJoinIntent,
} from '@wo/protocol';

import type { Invoke } from './api.js';
import {
  createDesktopIpcFailure,
  parseDesktopIpcEnvelope,
  type DesktopIpcEnvelope,
} from './ipc-envelope.js';
import type {
  DesktopLanBridge,
  LanSessionSnapshot,
  LanSocketEvent,
} from './lan-types.js';
import type { RealtimeConnectionGrant } from './types.js';

export type SubscribeLanEvent = (
  channel: string,
  listener: (value: unknown) => void,
) => () => void;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected record');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError('Unexpected keys');
  }
}

function parseLanSession(value: unknown): LanSessionSnapshot {
  const input = record(value);
  exactKeys(input, [
    'role',
    'user',
    'accessToken',
    'accessTokenExpiresAt',
    'joinIntent',
  ]);
  const user = publicAuthUserSchema.parse(input.user);
  const joinIntent = lanJoinIntentSchema.parse(input.joinIntent);
  if (
    (input.role !== 'host' && input.role !== 'guest') ||
    input.accessToken !== `lan:${user.userId}` ||
    !Number.isSafeInteger(input.accessTokenExpiresAt) ||
    (input.accessTokenExpiresAt as number) <= 0
  ) {
    throw new TypeError('Invalid LAN session');
  }
  return Object.freeze({
    role: input.role,
    user,
    accessToken: input.accessToken,
    accessTokenExpiresAt: input.accessTokenExpiresAt as number,
    joinIntent,
  });
}

function parseLanIntent(value: unknown): LanJoinIntent {
  return lanJoinIntentSchema.parse(value);
}

function parseGrant(value: unknown): RealtimeConnectionGrant {
  const input = record(value);
  exactKeys(input, ['endpoint', 'ticket', 'expiresInSeconds']);
  if (typeof input.endpoint !== 'string') {
    throw new TypeError('Invalid LAN grant');
  }
  const endpoint = lanJoinIntentSchema.safeParse({
    version: 1,
    mode: 'lan',
    endpoint: input.endpoint,
    roomCode: '000000',
    inviteKey: 'A'.repeat(43),
  });
  if (!endpoint.success) throw new TypeError('Invalid LAN grant');
  const ticket = signalTicketResponseSchema.parse({
    ticket: input.ticket,
    expiresInSeconds: input.expiresInSeconds,
  });
  return Object.freeze({ endpoint: endpoint.data.endpoint, ...ticket });
}

function parseNull(value: unknown): null {
  if (value !== null) throw new TypeError('Expected null');
  return null;
}

export function parseLanSocketEvent(value: unknown): LanSocketEvent {
  const input = record(value);
  if (input.type === 'open' || input.type === 'error') {
    exactKeys(input, ['type']);
    return Object.freeze({ type: input.type });
  }
  if (input.type === 'message') {
    exactKeys(input, ['type', 'data']);
    if (
      typeof input.data !== 'string' ||
      new TextEncoder().encode(input.data).byteLength > 1_048_576
    ) {
      throw new TypeError('Invalid LAN socket message');
    }
    return Object.freeze({ type: 'message', data: input.data });
  }
  if (input.type === 'close') {
    exactKeys(input, ['type', 'code', 'reason']);
    if (
      !Number.isSafeInteger(input.code) ||
      (input.code as number) < 0 ||
      (input.code as number) > 65_535 ||
      typeof input.reason !== 'string' ||
      new TextEncoder().encode(input.reason).byteLength > 123
    ) {
      throw new TypeError('Invalid LAN socket close');
    }
    return Object.freeze({
      type: 'close',
      code: input.code as number,
      reason: input.reason,
    });
  }
  throw new TypeError('Invalid LAN socket event');
}

async function invokeLan<Value>(
  invoke: Invoke,
  channel: string,
  arguments_: readonly unknown[],
  parseValue: (value: unknown) => Value,
): Promise<DesktopIpcEnvelope<Value>> {
  let envelope: unknown;
  try {
    envelope = await invoke(channel, ...arguments_);
  } catch {
    return createDesktopIpcFailure({ code: 'IPC_UNAVAILABLE' });
  }
  return parseDesktopIpcEnvelope(envelope, parseValue);
}

export function createDesktopLanBridge(
  invoke: Invoke,
  subscribe: SubscribeLanEvent = () => () => undefined,
): Readonly<DesktopLanBridge> {
  const socket = Object.freeze({
    open: (endpoint: string, protocols: readonly string[]) =>
      invokeLan(
        invoke,
        'desktop:lan:socket:open',
        [endpoint, protocols],
        parseNull,
      ),
    send: (data: string) =>
      invokeLan(invoke, 'desktop:lan:socket:send', [data], parseNull),
    close: () => invokeLan(invoke, 'desktop:lan:socket:close', [], parseNull),
    subscribe: (listener: (event: LanSocketEvent) => void) =>
      subscribe('desktop:lan:socket:event', (value) => {
        try {
          listener(parseLanSocketEvent(value));
        } catch {
          listener({ type: 'error' });
        }
      }),
  });
  return Object.freeze({
    host: (displayName: string) =>
      invokeLan(invoke, 'desktop:lan:host', [displayName], parseLanSession),
    join: (displayName: string, intent: LanJoinIntent) =>
      invokeLan(
        invoke,
        'desktop:lan:join',
        [displayName, intent],
        parseLanSession,
      ),
    parseInvite: (value: string) =>
      invokeLan(invoke, 'desktop:lan:parse-invite', [value], parseLanIntent),
    issueTicket: () =>
      invokeLan(invoke, 'desktop:lan:issue-ticket', [], parseGrant),
    stop: () => invokeLan(invoke, 'desktop:lan:stop', [], parseNull),
    socket,
  });
}
