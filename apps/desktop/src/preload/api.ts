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
import type {
  CaptureSourceSummary,
  DesktopBridge,
  PublicAuthSession,
  ScreenPermissionSnapshot,
} from './types.js';
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

const CAPTURE_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CAPTURE_SOURCES = 100;
const MAX_THUMBNAIL_BYTES = 512 * 1_024;
const MAX_TOTAL_THUMBNAIL_BYTES = 8 * 1_024 * 1_024;

function parseCaptureSourceSummaries(
  input: unknown,
): readonly CaptureSourceSummary[] {
  if (!Array.isArray(input) || input.length > MAX_CAPTURE_SOURCES) {
    throw new TypeError('Invalid capture sources');
  }
  let totalThumbnailBytes = 0;
  const sources = input.map((value) => {
    if (!isRecord(value)) throw new TypeError('Invalid capture source');
    const keys = Object.keys(value);
    if (
      keys.length !== 4 ||
      !keys.includes('token') ||
      !keys.includes('name') ||
      !keys.includes('kind') ||
      !keys.includes('thumbnailDataUrl') ||
      typeof value.token !== 'string' ||
      !CAPTURE_TOKEN.test(value.token) ||
      typeof value.name !== 'string' ||
      value.name.length === 0 ||
      [...value.name].length > 256 ||
      value.name.trim() !== value.name ||
      (value.kind !== 'screen' && value.kind !== 'window') ||
      typeof value.thumbnailDataUrl !== 'string' ||
      !value.thumbnailDataUrl.startsWith('data:image/png;base64,')
    ) {
      throw new TypeError('Invalid capture source');
    }
    const thumbnailBytes = new TextEncoder().encode(
      value.thumbnailDataUrl,
    ).byteLength;
    if (thumbnailBytes > MAX_THUMBNAIL_BYTES) {
      throw new TypeError('Invalid capture source thumbnail');
    }
    totalThumbnailBytes += thumbnailBytes;
    if (totalThumbnailBytes > MAX_TOTAL_THUMBNAIL_BYTES) {
      throw new TypeError('Invalid capture source thumbnails');
    }
    return Object.freeze({
      token: value.token,
      name: value.name,
      kind: value.kind,
      thumbnailDataUrl: value.thumbnailDataUrl,
    });
  });
  return Object.freeze(sources);
}

function parseScreenPermission(input: unknown): ScreenPermissionSnapshot {
  if (!isRecord(input)) throw new TypeError('Invalid screen permission');
  const keys = Object.keys(input);
  const statuses = new Set([
    'not-determined',
    'granted',
    'denied',
    'restricted',
    'unknown',
  ]);
  if (
    keys.length !== 2 ||
    !keys.includes('status') ||
    !keys.includes('canOpenSettings') ||
    typeof input.status !== 'string' ||
    !statuses.has(input.status) ||
    typeof input.canOpenSettings !== 'boolean' ||
    (input.canOpenSettings &&
      input.status !== 'denied' &&
      input.status !== 'restricted')
  ) {
    throw new TypeError('Invalid screen permission');
  }
  return Object.freeze({
    status: input.status as ScreenPermissionSnapshot['status'],
    canOpenSettings: input.canOpenSettings,
  });
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

function parseAuthRegisterResult(input: unknown): import('./types.js').AuthRegisterResult {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    throw new TypeError('Invalid auth register result');
  }
  if (input.kind === 'session') {
    return Object.freeze({
      kind: 'session' as const,
      session: parsePublicAuthSession(input.session),
    });
  }
  if (input.kind === 'verification_required') {
    if (typeof input.email !== 'string') {
      throw new TypeError('Invalid auth register result');
    }
    return Object.freeze({
      kind: 'verification_required' as const,
      email: input.email,
    });
  }
  throw new TypeError('Invalid auth register result');
}

function parseEmailOnly(input: unknown): Readonly<{ email: string }> {
  if (!isRecord(input) || typeof input.email !== 'string') {
    throw new TypeError('Invalid email response');
  }
  return Object.freeze({ email: input.email });
}

export function createDesktopApi(invoke: Invoke): Readonly<DesktopBridge> {
  const auth = Object.freeze({
    register: (input: Parameters<DesktopBridge['auth']['register']>[0]) =>
      invokeDesktop(
        invoke,
        'desktop:auth:register',
        [input],
        parseAuthRegisterResult,
      ),
    login: (input: Parameters<DesktopBridge['auth']['login']>[0]) =>
      invokeDesktop(
        invoke,
        'desktop:auth:login',
        [input],
        parsePublicAuthSession,
      ),
    verifyEmail: (input: Parameters<DesktopBridge['auth']['verifyEmail']>[0]) =>
      invokeDesktop(
        invoke,
        'desktop:auth:verify-email',
        [input],
        parsePublicAuthSession,
      ),
    resendVerification: (
      input: Parameters<DesktopBridge['auth']['resendVerification']>[0],
    ) =>
      invokeDesktop(
        invoke,
        'desktop:auth:resend-verification',
        [input],
        parseEmailOnly,
      ),
    changePassword: (
      input: Parameters<DesktopBridge['auth']['changePassword']>[0],
    ) =>
      invokeDesktop(invoke, 'desktop:auth:change-password', [input], parseNull),
    requestEmailChange: (
      input: Parameters<DesktopBridge['auth']['requestEmailChange']>[0],
    ) =>
      invokeDesktop(
        invoke,
        'desktop:auth:request-email-change',
        [input],
        parseEmailOnly,
      ),
    confirmEmailChange: (
      input: Parameters<DesktopBridge['auth']['confirmEmailChange']>[0],
    ) =>
      invokeDesktop(
        invoke,
        'desktop:auth:confirm-email-change',
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
  const capture = Object.freeze({
    list: () =>
      invokeDesktop(
        invoke,
        'desktop:capture:list',
        [],
        parseCaptureSourceSummaries,
      ),
    select: (token: string) =>
      invokeDesktop(invoke, 'desktop:capture:select', [token], parseNull),
    permission: () =>
      invokeDesktop(
        invoke,
        'desktop:capture:permission',
        [],
        parseScreenPermission,
      ),
    openSettings: () =>
      invokeDesktop(invoke, 'desktop:capture:open-settings', [], parseNull),
  });
  return Object.freeze({ auth, realtime, capture });
}
