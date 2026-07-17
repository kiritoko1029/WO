import { randomUUID } from 'node:crypto';

import { createLanFrameCodec } from '@wo/server/lite';
import { opaqueTokenSchema } from '@wo/protocol';
import WebSocket from 'ws';

import type { LanSocketEvent } from '../preload/lan-types.js';
import type { DesktopIpcErrorCode } from '../preload/ipc-envelope.js';
import type { LanSessionController } from './lan-session.js';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_CLOSE_REASON_BYTES = 123;

interface SocketLike {
  readonly readyState: number;
  readonly protocol: string;
  on(type: 'open', listener: () => void): void;
  on(type: 'error', listener: () => void): void;
  on(type: 'close', listener: (code: number, reason: Uint8Array) => void): void;
  on(
    type: 'message',
    listener: (data: unknown, isBinary: boolean) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (
  endpoint: string,
  protocols: readonly string[],
) => SocketLike;

export interface LanSocketControllerOptions {
  readonly sessions: LanSessionController;
  readonly createSocket?: SocketFactory;
}

export interface LanSocketController {
  open(
    ownerId: number,
    endpoint: string,
    protocols: readonly string[],
    emit: (event: LanSocketEvent) => void,
  ): void;
  send(ownerId: number, data: string): void;
  close(ownerId: number): void;
  stop(): void;
}

class LanSocketError extends Error {
  readonly code: DesktopIpcErrorCode;

  constructor(code: DesktopIpcErrorCode) {
    super(code);
    this.name = 'LanSocketError';
    this.code = code;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function textFrame(data: unknown, isBinary: boolean): string {
  if (isBinary) throw new TypeError('LAN signaling frames must be text');
  if (typeof data === 'string') return data;
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('LAN signaling frame is invalid');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function closeReason(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(value)
      .slice(0, MAX_CLOSE_REASON_BYTES);
  } catch {
    return '';
  }
}

export function createLanSocketController(
  options: LanSocketControllerOptions,
): LanSocketController {
  const createSocket: SocketFactory =
    options.createSocket ??
    ((endpoint, protocols) =>
      new WebSocket(endpoint, [...protocols], {
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      }));
  let active:
    | {
        readonly ownerId: number;
        readonly socket: SocketLike;
        readonly connectionId: string;
        readonly codec: ReturnType<typeof createLanFrameCodec>;
        readonly emit: (event: LanSocketEvent) => void;
      }
    | undefined;

  const stopActive = (notifyRenderer: boolean): void => {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    if (
      current.socket.readyState === SOCKET_CONNECTING ||
      current.socket.readyState === SOCKET_OPEN
    ) {
      current.socket.close(1000, 'LAN session closed');
    }
    current.codec.release(current.connectionId);
    if (!notifyRenderer) return;
    try {
      current.emit({
        type: 'close',
        code: 1000,
        reason: 'LAN session closed',
      });
    } catch {
      // Renderer teardown must not make transport cleanup fail.
    }
  };
  const stop = (): void => stopActive(true);

  return Object.freeze({
    open(
      ownerId: number,
      endpoint: string,
      protocols: readonly string[],
      emit: (event: LanSocketEvent) => void,
    ) {
      const intent = options.sessions.currentIntent();
      if (active !== undefined && active.ownerId !== ownerId) {
        throw new LanSocketError('INVALID_STATE');
      }
      if (
        intent === null ||
        endpoint !== intent.endpoint ||
        protocols.length !== 2 ||
        protocols[0] !== 'wo-v1' ||
        typeof protocols[1] !== 'string' ||
        !protocols[1].startsWith('ticket.')
      ) {
        throw new LanSocketError('INVALID_ARGUMENTS');
      }
      const ticket = protocols[1].slice('ticket.'.length);
      opaqueTokenSchema.parse(ticket);
      const connectionId = randomUUID();
      const codec = createLanFrameCodec(intent.inviteKey, 'client');
      codec.bind(connectionId, ticket);
      stopActive(false);
      const socket = createSocket(endpoint, protocols);
      const current = { ownerId, socket, connectionId, codec, emit };
      active = current;

      socket.on('open', () => {
        if (active !== current) return;
        if (socket.protocol !== 'wo-v1') {
          socket.close(1002, 'Unexpected subprotocol');
          return;
        }
        emit({ type: 'open' });
      });
      socket.on('message', (data, isBinary) => {
        if (active !== current) return;
        try {
          const encoded = textFrame(data, isBinary);
          if (byteLength(encoded) > MAX_FRAME_BYTES) {
            throw new TypeError('LAN signaling frame is too large');
          }
          const payload = codec.decode(connectionId, encoded);
          if (byteLength(payload) > MAX_FRAME_BYTES) {
            throw new TypeError('LAN signaling payload is too large');
          }
          emit({ type: 'message', data: payload });
        } catch {
          socket.close(1008, 'Invalid authenticated frame');
        }
      });
      socket.on('error', () => {
        if (active === current) emit({ type: 'error' });
      });
      socket.on('close', (code, reason) => {
        if (active !== current) return;
        active = undefined;
        codec.release(connectionId);
        emit({
          type: 'close',
          code: Number.isSafeInteger(code) ? code : 1006,
          reason: closeReason(reason),
        });
      });
    },
    send(ownerId: number, data: string) {
      const current = active;
      if (
        current === undefined ||
        current.ownerId !== ownerId ||
        current.socket.readyState !== SOCKET_OPEN ||
        typeof data !== 'string' ||
        byteLength(data) > MAX_FRAME_BYTES
      ) {
        throw new LanSocketError('INVALID_STATE');
      }
      try {
        current.socket.send(current.codec.encode(current.connectionId, data));
      } catch {
        current.socket.close(1008, 'LAN signaling send failed');
        throw new LanSocketError('INVALID_STATE');
      }
    },
    close(ownerId: number) {
      if (active?.ownerId !== ownerId) return;
      stop();
    },
    stop,
  });
}
