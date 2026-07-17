import { createHmac, timingSafeEqual } from 'node:crypto';

import type { SignalingFrameCodec } from '../modules/signaling/gateway.ts';

const INVITE_KEY_BYTES = 32;
const INVITE_KEY_LENGTH = 43;
const MAC_LENGTH = 43;
const MAX_PAYLOAD_LENGTH = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;

type FrameRole = 'client' | 'server';

interface ConnectionState {
  inbound: number;
  outbound: number;
  key: Buffer;
}

interface AuthenticatedFrame {
  readonly version: 1;
  readonly sequence: number;
  readonly payload: string;
  readonly mac: string;
}

function decodeCanonicalBase64url(
  value: string,
  expectedBytes: number,
  expectedLength: number,
): Buffer {
  if (value.length !== expectedLength || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('Authenticated frame credential is invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString('base64url') !== value
  ) {
    throw new TypeError('Authenticated frame credential is invalid');
  }
  return decoded;
}

function frameMac(
  key: Buffer,
  sender: FrameRole,
  sequence: number,
  payload: string,
): Buffer {
  return createHmac('sha256', key)
    .update('wo-lan-frame-v1\n', 'ascii')
    .update(sender, 'ascii')
    .update('\n', 'ascii')
    .update(String(sequence), 'ascii')
    .update('\n', 'ascii')
    .update(payload, 'utf8')
    .digest();
}

function deriveConnectionKey(key: Buffer, ticket: string): Buffer {
  const ticketBytes = decodeCanonicalBase64url(
    ticket,
    INVITE_KEY_BYTES,
    INVITE_KEY_LENGTH,
  );
  return createHmac('sha256', key)
    .update('wo-lan-connection-v1\n', 'ascii')
    .update(ticketBytes)
    .digest();
}

function parseFrame(value: string): AuthenticatedFrame {
  if (Buffer.byteLength(value, 'utf8') > MAX_FRAME_BYTES) {
    throw new TypeError('Authenticated frame is invalid');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError('Authenticated frame is invalid');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new TypeError('Authenticated frame is invalid');
  }
  const frame = decoded as Record<string, unknown>;
  const keys = Object.keys(frame).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'mac' ||
    keys[1] !== 'payload' ||
    keys[2] !== 'sequence' ||
    keys[3] !== 'version' ||
    frame['version'] !== 1 ||
    !Number.isSafeInteger(frame['sequence']) ||
    (frame['sequence'] as number) <= 0 ||
    typeof frame['payload'] !== 'string' ||
    frame['payload'].length > MAX_PAYLOAD_LENGTH ||
    typeof frame['mac'] !== 'string'
  ) {
    throw new TypeError('Authenticated frame is invalid');
  }
  return frame as unknown as AuthenticatedFrame;
}

export function createLanFrameCodec(
  inviteKey: string,
  role: FrameRole,
): SignalingFrameCodec {
  const key = decodeCanonicalBase64url(
    inviteKey,
    INVITE_KEY_BYTES,
    INVITE_KEY_LENGTH,
  );
  const peerRole: FrameRole = role === 'server' ? 'client' : 'server';
  const connections = new Map<string, ConnectionState>();
  const state = (connectionId: string): ConnectionState => {
    const current = connections.get(connectionId);
    if (current === undefined) {
      throw new TypeError('Authenticated frame connection is not bound');
    }
    return current;
  };

  return Object.freeze({
    bind(connectionId: string, ticket: string) {
      if (connections.has(connectionId)) {
        throw new TypeError('Authenticated frame connection is already bound');
      }
      connections.set(connectionId, {
        inbound: 0,
        outbound: 0,
        key: deriveConnectionKey(key, ticket),
      });
    },

    encode(connectionId: string, payload: string) {
      const current = state(connectionId);
      if (current.outbound === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Authenticated frame sequence is exhausted');
      }
      const sequence = current.outbound + 1;
      const mac = frameMac(current.key, role, sequence, payload).toString(
        'base64url',
      );
      current.outbound = sequence;
      return JSON.stringify({ version: 1, sequence, payload, mac });
    },

    decode(connectionId: string, value: string) {
      const frame = parseFrame(value);
      const current = state(connectionId);
      if (frame.sequence !== current.inbound + 1) {
        throw new TypeError('Authenticated frame sequence is out of order');
      }
      const actualMac = decodeCanonicalBase64url(
        frame.mac,
        INVITE_KEY_BYTES,
        MAC_LENGTH,
      );
      const expectedMac = frameMac(
        current.key,
        peerRole,
        frame.sequence,
        frame.payload,
      );
      if (!timingSafeEqual(actualMac, expectedMac)) {
        throw new TypeError('Authenticated frame MAC is invalid');
      }
      current.inbound = frame.sequence;
      return frame.payload;
    },

    release(connectionId: string) {
      connections.delete(connectionId);
    },

    clear() {
      connections.clear();
    },
  });
}
