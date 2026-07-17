import {
  DesktopIpcError,
  unwrapDesktopIpcEnvelope,
} from '../../../preload/ipc-envelope.js';
import type {
  BackendTargetSnapshot,
  DesktopShellApi,
  DesktopShellBridge,
} from '../../../preload/types.js';
import { joinIntentSchema, type JoinIntent } from '@wo/protocol';

const identity = <Value>(value: unknown) => value as Value;

async function unwrapBridge<Value>(
  operation: () => Promise<unknown>,
  parseValue: (input: unknown) => Value,
): Promise<Value> {
  let envelope: unknown;
  try {
    envelope = await operation();
  } catch {
    throw new DesktopIpcError('IPC_UNAVAILABLE');
  }
  return unwrapDesktopIpcEnvelope(envelope, parseValue);
}

export function createRendererShellConfigApi(
  bridge: DesktopShellBridge,
): Readonly<DesktopShellApi> {
  let consumeInFlight: Promise<JoinIntent | null> | null = null;
  const consumeJoinIntent = (): Promise<JoinIntent | null> => {
    if (consumeInFlight !== null) return consumeInFlight;
    const pending = unwrapBridge<JoinIntent | null>(
      () => bridge.joinIntent.consume(),
      (value) => {
        if (value === null) return null;
        return joinIntentSchema.parse(value);
      },
    );
    consumeInFlight = pending;
    void pending.then(
      () => {
        if (consumeInFlight === pending) consumeInFlight = null;
      },
      () => {
        if (consumeInFlight === pending) consumeInFlight = null;
      },
    );
    return pending;
  };
  const backendTarget = Object.freeze({
    get: () =>
      unwrapBridge<BackendTargetSnapshot>(
        () => bridge.backendTarget.get(),
        identity,
      ),
    save: (origin: string) =>
      unwrapBridge<null>(
        () => bridge.backendTarget.save(origin),
        (value) => {
          if (value !== null) throw new TypeError('Expected null');
          return null;
        },
      ).then(() => undefined),
  });
  const joinIntent = Object.freeze({
    consume: consumeJoinIntent,
    switchServer: (intent: Extract<JoinIntent, { mode: 'server' }>) =>
      unwrapBridge<null>(
        () => bridge.joinIntent.switchServer(intent),
        (value) => {
          if (value !== null) throw new TypeError('Expected null');
          return null;
        },
      ).then(() => undefined),
    subscribe: (listener: () => void) => bridge.joinIntent.subscribe(listener),
  });
  return Object.freeze({ backendTarget, joinIntent });
}
