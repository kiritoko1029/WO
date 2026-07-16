import {
  DesktopIpcError,
  unwrapDesktopIpcEnvelope,
} from '../../../preload/ipc-envelope.js';
import type {
  DesktopApi,
  DesktopBridge,
  CaptureSourceSummary,
  PublicAuthSession,
  RealtimeConnectionGrant,
  ScreenPermissionSnapshot,
} from '../../../preload/types.js';

async function unwrapBridge<Value>(
  operation: Promise<unknown>,
  parseValue: (input: unknown) => Value,
): Promise<Value> {
  let envelope: unknown;
  try {
    envelope = await operation;
  } catch {
    throw new DesktopIpcError('IPC_UNAVAILABLE');
  }
  return unwrapDesktopIpcEnvelope(envelope, parseValue);
}

const identity = <Value>(value: unknown) => value as Value;

export function createRendererDesktopApi(
  bridge: DesktopBridge,
): Readonly<DesktopApi> {
  const auth = Object.freeze({
    register: (input: Parameters<DesktopApi['auth']['register']>[0]) =>
      unwrapBridge<PublicAuthSession>(bridge.auth.register(input), identity),
    login: (input: Parameters<DesktopApi['auth']['login']>[0]) =>
      unwrapBridge<PublicAuthSession>(bridge.auth.login(input), identity),
    refresh: () =>
      unwrapBridge<PublicAuthSession>(bridge.auth.refresh(), identity),
    logout: async () => {
      await unwrapBridge<null>(bridge.auth.logout(), (value) => {
        if (value !== null) throw new TypeError('Expected null');
        return null;
      });
    },
  });
  const realtime = Object.freeze({
    issueTicket: (accessToken: string) =>
      unwrapBridge<RealtimeConnectionGrant>(
        bridge.realtime.issueTicket(accessToken),
        identity,
      ),
  });
  const capture = Object.freeze({
    list: () =>
      unwrapBridge<readonly CaptureSourceSummary[]>(
        bridge.capture.list(),
        identity,
      ),
    select: async (token: string) => {
      await unwrapBridge<null>(bridge.capture.select(token), (value) => {
        if (value !== null) throw new TypeError('Expected null');
        return null;
      });
    },
    permission: () =>
      unwrapBridge<ScreenPermissionSnapshot>(
        bridge.capture.permission(),
        identity,
      ),
    openSettings: async () => {
      await unwrapBridge<null>(bridge.capture.openSettings(), (value) => {
        if (value !== null) throw new TypeError('Expected null');
        return null;
      });
    },
  });
  return Object.freeze({ auth, realtime, capture });
}
