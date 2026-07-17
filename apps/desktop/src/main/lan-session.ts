import { randomUUID as nodeRandomUUID } from 'node:crypto';

import {
  displayNameSchema,
  lanJoinIntentSchema,
  publicAuthUserSchema,
  signalTicketResponseSchema,
  type LanJoinIntent,
  type PublicAuthUser,
} from '@wo/protocol';
import {
  startLiteRoomService,
  type RunningLiteRoomService,
  type StartLiteRoomServiceOptions,
} from '@wo/server/lite';

import type { LanSessionSnapshot } from '../preload/lan-types.js';
import type { RealtimeConnectionGrant } from '../preload/types.js';
import type { DesktopIpcErrorCode } from '../preload/ipc-envelope.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_RESPONSE_LIMIT = 16 * 1_024;
const SESSION_TIMEOUT_MS = 5_000;

type StartLiteRoomService = (
  options?: StartLiteRoomServiceOptions,
) => Promise<RunningLiteRoomService>;

export interface LanSessionControllerOptions {
  readonly startService?: StartLiteRoomService;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

interface ActiveLanSession {
  readonly snapshot: LanSessionSnapshot;
  readonly service: RunningLiteRoomService | null;
  cachedGrant: RealtimeConnectionGrant | null;
}

class LanSessionError extends Error {
  readonly code: DesktopIpcErrorCode;

  constructor(code: DesktopIpcErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'LanSessionError';
    this.code = code;
  }
}

function user(clientId: string, displayName: string): PublicAuthUser {
  return publicAuthUserSchema.parse({
    userId: clientId,
    email: `${clientId}@lan.invalid`,
    displayName,
  });
}

function snapshot(
  role: LanSessionSnapshot['role'],
  clientId: string,
  displayName: string,
  joinIntent: LanJoinIntent,
  now: number,
): LanSessionSnapshot {
  return Object.freeze({
    role,
    user: user(clientId, displayName),
    accessToken: `lan:${clientId}`,
    accessTokenExpiresAt: now + SESSION_TTL_MS,
    joinIntent,
  });
}

function sessionEndpoint(intent: LanJoinIntent): string {
  const endpoint = new URL(intent.endpoint);
  endpoint.protocol = 'http:';
  endpoint.pathname = '/v1/lite/session';
  return endpoint.href;
}

async function limitedText(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/u.test(length) || Number(length) > SESSION_RESPONSE_LIMIT)
  ) {
    throw new LanSessionError('RESPONSE_TOO_LARGE');
  }
  if (response.body === null) throw new LanSessionError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let result = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > SESSION_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new LanSessionError('RESPONSE_TOO_LARGE');
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

function responseError(status: number): LanSessionError {
  switch (status) {
    case 401:
      return new LanSessionError('AUTH_REQUIRED');
    case 409:
      return new LanSessionError('INVALID_STATE');
    case 429:
      return new LanSessionError('RATE_LIMITED');
    default:
      return new LanSessionError('HTTP_ERROR');
  }
}

export interface LanSessionController {
  startHost(displayName: string): Promise<LanSessionSnapshot>;
  startGuest(
    displayName: string,
    intent: LanJoinIntent,
  ): Promise<LanSessionSnapshot>;
  issueTicket(): Promise<RealtimeConnectionGrant>;
  currentIntent(): LanJoinIntent | null;
  stop(): Promise<void>;
}

export function createLanSessionController(
  options: LanSessionControllerOptions = {},
): LanSessionController {
  const startService = options.startService ?? startLiteRoomService;
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  let active: ActiveLanSession | null = null;
  let queue: Promise<void> = Promise.resolve();

  const exclusive = <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const stopActive = async (): Promise<void> => {
    const previous = active;
    active = null;
    await previous?.service?.close();
  };

  const exchangeGuestTicket = async (
    current: ActiveLanSession,
  ): Promise<RealtimeConnectionGrant> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
    let response: Response;
    try {
      response = await request(sessionEndpoint(current.snapshot.joinIntent), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${current.snapshot.joinIntent.inviteKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          clientId: current.snapshot.user.userId,
          displayName: current.snapshot.user.displayName,
        }),
      });
    } catch (error) {
      throw new LanSessionError(
        controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        error,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw responseError(response.status);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await limitedText(response)) as unknown;
    } catch (error) {
      if (error instanceof LanSessionError) throw error;
      throw new LanSessionError('INVALID_RESPONSE', error);
    }
    const ticket = signalTicketResponseSchema.safeParse(decoded);
    if (!ticket.success) throw new LanSessionError('INVALID_RESPONSE');
    return Object.freeze({
      endpoint: current.snapshot.joinIntent.endpoint,
      ...ticket.data,
    });
  };

  return Object.freeze({
    startHost: (rawDisplayName: string) =>
      exclusive(async () => {
        const displayName = displayNameSchema.parse(rawDisplayName);
        await stopActive();
        let service: RunningLiteRoomService;
        try {
          service = await startService({ hostDisplayName: displayName });
        } catch (error) {
          throw new LanSessionError('SERVICE_UNAVAILABLE', error);
        }
        const joinIntent = lanJoinIntentSchema.parse({
          version: 1,
          mode: 'lan',
          endpoint: service.invite.endpoint,
          roomCode: service.invite.roomCode,
          inviteKey: service.invite.inviteKey,
        });
        const next: ActiveLanSession = {
          snapshot: snapshot(
            'host',
            service.hostClientId,
            service.hostDisplayName,
            joinIntent,
            now(),
          ),
          service,
          cachedGrant: null,
        };
        active = next;
        return next.snapshot;
      }),
    startGuest: (rawDisplayName: string, rawIntent: LanJoinIntent) =>
      exclusive(async () => {
        const displayName = displayNameSchema.parse(rawDisplayName);
        const intent = lanJoinIntentSchema.parse(rawIntent);
        await stopActive();
        const next: ActiveLanSession = {
          snapshot: snapshot('guest', randomUUID(), displayName, intent, now()),
          service: null,
          cachedGrant: null,
        };
        next.cachedGrant = await exchangeGuestTicket(next);
        active = next;
        return next.snapshot;
      }),
    issueTicket: () =>
      exclusive(async () => {
        const current = active;
        if (current === null) throw new LanSessionError('INVALID_STATE');
        if (current.cachedGrant !== null) {
          const grant = current.cachedGrant;
          current.cachedGrant = null;
          return grant;
        }
        if (current.service !== null) {
          return Object.freeze({
            endpoint: current.snapshot.joinIntent.endpoint,
            ...current.service.issueHostTicket(),
          });
        }
        return exchangeGuestTicket(current);
      }),
    currentIntent: () => active?.snapshot.joinIntent ?? null,
    stop: () => exclusive(stopActive),
  });
}
