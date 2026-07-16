import {
  opaqueTokenSchema,
  publicAuthUserSchema,
  signalTicketResponseSchema,
} from '@wo/protocol';

import {
  createDesktopIpcFailure,
  parseDesktopIpcEnvelope,
  type DesktopIpcEnvelope,
} from './ipc-envelope.js';
import type { DesktopBridge, PublicAuthSession } from './types.js';
import type { RealtimeConnectionGrant } from './types.js';

export type Invoke = (
  channel: string,
  ...arguments_: readonly unknown[]
) => Promise<unknown>;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function parsePublicAuthSession(input: unknown): PublicAuthSession {
  if (!isRecord(input)) throw new TypeError('Invalid auth session');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('user') ||
    !keys.includes('accessToken') ||
    !keys.includes('accessTokenExpiresAt')
  ) {
    throw new TypeError('Invalid auth session');
  }
  if (
    typeof input.accessTokenExpiresAt !== 'number' ||
    !Number.isSafeInteger(input.accessTokenExpiresAt) ||
    input.accessTokenExpiresAt <= 0
  ) {
    throw new TypeError('Invalid auth session');
  }
  return Object.freeze({
    user: publicAuthUserSchema.parse(input.user),
    accessToken: opaqueTokenSchema.parse(input.accessToken),
    accessTokenExpiresAt: input.accessTokenExpiresAt,
  });
}

function parseNull(input: unknown): null {
  if (input !== null) throw new TypeError('Expected null');
  return null;
}

function parseRealtimeConnectionGrant(input: unknown): RealtimeConnectionGrant {
  if (!isRecord(input)) throw new TypeError('Invalid realtime grant');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('endpoint') ||
    !keys.includes('ticket') ||
    !keys.includes('expiresInSeconds') ||
    typeof input.endpoint !== 'string'
  ) {
    throw new TypeError('Invalid realtime grant');
  }
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== 'wss:' ||
    endpoint.pathname !== '/v1/realtime' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.href !== input.endpoint
  ) {
    throw new TypeError('Invalid realtime grant');
  }
  const ticket = signalTicketResponseSchema.parse({
    ticket: input.ticket,
    expiresInSeconds: input.expiresInSeconds,
  });
  return Object.freeze({ endpoint: endpoint.href, ...ticket });
}

async function invokeDesktop<Value>(
  invoke: Invoke,
  channel: string,
  arguments_: readonly unknown[],
  parseValue: (input: unknown) => Value,
): Promise<DesktopIpcEnvelope<Value>> {
  let envelope: unknown;
  try {
    envelope = await invoke(channel, ...arguments_);
  } catch {
    return createDesktopIpcFailure({ code: 'IPC_UNAVAILABLE' });
  }
  return parseDesktopIpcEnvelope(envelope, parseValue);
}

export function createDesktopApi(invoke: Invoke): Readonly<DesktopBridge> {
  const auth = Object.freeze({
    register: (input: Parameters<DesktopBridge['auth']['register']>[0]) =>
      invokeDesktop(
        invoke,
        'desktop:auth:register',
        [input],
        parsePublicAuthSession,
      ),
    login: (input: Parameters<DesktopBridge['auth']['login']>[0]) =>
      invokeDesktop(
        invoke,
        'desktop:auth:login',
        [input],
        parsePublicAuthSession,
      ),
    refresh: () =>
      invokeDesktop(invoke, 'desktop:auth:refresh', [], parsePublicAuthSession),
    logout: () => invokeDesktop(invoke, 'desktop:auth:logout', [], parseNull),
  });
  const realtime = Object.freeze({
    issueTicket: (accessToken: string) =>
      invokeDesktop(
        invoke,
        'desktop:realtime:issue-ticket',
        [accessToken],
        parseRealtimeConnectionGrant,
      ),
  });
  return Object.freeze({ auth, realtime });
}
