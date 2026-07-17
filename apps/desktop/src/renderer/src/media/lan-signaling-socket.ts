import type {
  DesktopLanApi,
  LanSocketEvent,
} from '../../../preload/lan-types.js';
import type { SignalingWebSocket } from './signaling-client.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export function createLanIpcWebSocket(
  lan: DesktopLanApi,
  endpoint: string,
  protocols: readonly string[],
): SignalingWebSocket {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let state = CONNECTING;
  let negotiatedProtocol = '';
  let sendQueue: Promise<void> = Promise.resolve();

  const dispatch = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) {
      try {
        listener(event);
      } catch {
        // WebSocket observers cannot break the transport.
      }
    }
  };
  const closeLocally = (code: number, reason: string): void => {
    if (state === CLOSED) return;
    state = CLOSED;
    unsubscribe();
    dispatch('close', { code, reason });
  };
  const onSocketEvent = (event: LanSocketEvent): void => {
    switch (event.type) {
      case 'open':
        if (state !== CONNECTING) return;
        state = OPEN;
        negotiatedProtocol = 'wo-v1';
        dispatch('open', {});
        return;
      case 'message':
        if (state === OPEN) dispatch('message', { data: event.data });
        return;
      case 'error':
        dispatch('error', {});
        return;
      case 'close':
        closeLocally(event.code, event.reason);
    }
  };
  const unsubscribe = lan.socket.subscribe(onSocketEvent);
  void lan.socket.open(endpoint, protocols).catch(() => {
    dispatch('error', {});
    closeLocally(1006, '');
  });

  return Object.freeze({
    get readyState() {
      return state;
    },
    get protocol() {
      return negotiatedProtocol;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      let registered = listeners.get(type);
      if (registered === undefined) {
        registered = new Set();
        listeners.set(type, registered);
      }
      registered.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    send(data: string) {
      if (state !== OPEN) throw new Error('LAN signaling socket is not open');
      sendQueue = sendQueue
        .then(() => lan.socket.send(data))
        .catch(() => {
          dispatch('error', {});
          closeLocally(1006, '');
        });
    },
    close() {
      if (state === CLOSED || state === CLOSING) return;
      state = CLOSING;
      void lan.socket
        .close()
        .then(() => closeLocally(1000, ''))
        .catch(() => closeLocally(1006, ''));
    },
  });
}
