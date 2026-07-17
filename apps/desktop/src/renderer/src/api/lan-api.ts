import {
  DesktopIpcError,
  unwrapDesktopIpcEnvelope,
} from '../../../preload/ipc-envelope.js';
import type {
  DesktopLanApi,
  DesktopLanBridge,
  LanSessionSnapshot,
  LanSocketEvent,
} from '../../../preload/lan-types.js';
import type { RealtimeConnectionGrant } from '../../../preload/types.js';
import type { LanJoinIntent } from '@wo/protocol';

async function unwrap<Value>(operation: Promise<unknown>): Promise<Value> {
  let envelope: unknown;
  try {
    envelope = await operation;
  } catch {
    throw new DesktopIpcError('IPC_UNAVAILABLE');
  }
  return unwrapDesktopIpcEnvelope(envelope, (value) => value as Value);
}

export function createRendererLanApi(
  bridge: DesktopLanBridge,
): Readonly<DesktopLanApi> {
  const socket = Object.freeze({
    open: async (endpoint: string, protocols: readonly string[]) => {
      await unwrap<null>(bridge.socket.open(endpoint, protocols));
    },
    send: async (data: string) => {
      await unwrap<null>(bridge.socket.send(data));
    },
    close: async () => {
      await unwrap<null>(bridge.socket.close());
    },
    subscribe: (listener: (event: LanSocketEvent) => void) =>
      bridge.socket.subscribe(listener),
  });
  return Object.freeze({
    host: (displayName: string) =>
      unwrap<LanSessionSnapshot>(bridge.host(displayName)),
    join: (displayName: string, intent: LanJoinIntent) =>
      unwrap<LanSessionSnapshot>(bridge.join(displayName, intent)),
    parseInvite: (value: string) =>
      unwrap<Awaited<ReturnType<DesktopLanApi['parseInvite']>>>(
        bridge.parseInvite(value),
      ),
    issueTicket: () => unwrap<RealtimeConnectionGrant>(bridge.issueTicket()),
    stop: async () => {
      await unwrap<null>(bridge.stop());
    },
    socket,
  });
}
