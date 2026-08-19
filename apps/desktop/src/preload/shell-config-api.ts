import {
  joinIntentSchema,
  type JoinIntent,
  type ServerJoinIntent,
} from '@wo/protocol';
import {
  createDesktopIpcFailure,
  parseDesktopIpcEnvelope,
  type DesktopIpcEnvelope,
} from './ipc-envelope.js';
import type { BackendTargetSnapshot, DesktopShellBridge } from './types.js';
import type { Invoke } from './api.js';

export type Subscribe = (channel: string, listener: () => void) => () => void;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function parseBackendTarget(input: unknown): BackendTargetSnapshot {
  if (!isRecord(input)) throw new TypeError('Invalid backend target');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('origin') ||
    !keys.includes('source') ||
    !keys.includes('readOnly') ||
    typeof input.origin !== 'string' ||
    (input.source !== 'environment' &&
      input.source !== 'stored' &&
      input.source !== 'default') ||
    typeof input.readOnly !== 'boolean' ||
    input.readOnly !== (input.source === 'environment')
  ) {
    throw new TypeError('Invalid backend target');
  }
  const origin = new URL(input.origin);
  if (
    input.origin.length > 2_048 ||
    origin.protocol !== 'https:' ||
    origin.origin !== input.origin ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.username !== '' ||
    origin.password !== ''
  ) {
    throw new TypeError('Invalid backend target');
  }
  return Object.freeze({
    origin: origin.origin,
    source: input.source,
    readOnly: input.readOnly,
  });
}

function parseNull(input: unknown): null {
  if (input !== null) throw new TypeError('Expected null');
  return null;
}

function parseOptionalJoinIntent(input: unknown): JoinIntent | null {
  if (input === null) return null;
  const parsed = joinIntentSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid join intent');
  return parsed.data;
}

async function invokeShell<Value>(
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

export function createDesktopShellBridge(
  invoke: Invoke,
  subscribe: Subscribe = () => () => undefined,
): Readonly<DesktopShellBridge> {
  const backendTarget = Object.freeze({
    get: () =>
      invokeShell(
        invoke,
        'desktop:shell:backend-target:get',
        [],
        parseBackendTarget,
      ),
    save: (origin: string) =>
      invokeShell(
        invoke,
        'desktop:shell:backend-target:save',
        [origin],
        parseNull,
      ),
  });
  const joinIntent = Object.freeze({
    consume: () =>
      invokeShell(
        invoke,
        'desktop:shell:join-intent:consume',
        [],
        parseOptionalJoinIntent,
      ),
    switchServer: (intent: ServerJoinIntent) =>
      invokeShell(
        invoke,
        'desktop:shell:join-intent:switch-server',
        [intent],
        parseNull,
      ),
    subscribe: (listener: () => void) =>
      subscribe('desktop:shell:join-intent:available', listener),
  });
  const openExternal = (url: string) =>
    invokeShell(invoke, 'desktop:shell:open-external', [url], parseNull);
  return Object.freeze({ backendTarget, joinIntent, openExternal });
}
