import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createConnectionRegistry,
  type SignalingSocket,
} from '../src/modules/signaling/connection-registry.ts';

class FakeSocket implements SignalingSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  pings = 0;
  terminations = 0;
  closeHook: (() => void) | undefined;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
    this.closeHook?.();
    this.readyState = 2;
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminations += 1;
    this.readyState = 3;
  }
}

class NullSuccessSocket extends FakeSocket {
  override send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.(null as never);
  }
}

class DeferredErrorSocket extends FakeSocket {
  private callback: ((error?: Error) => void) | undefined;

  override send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    this.callback = callback;
  }

  failDelivery(): void {
    this.callback?.(new Error('deferred delivery failure'));
  }
}

const identity = {
  userId: 'user-1',
  sessionId: 'session-1',
  displayName: 'Person One',
  accessTokenExpiresAtSeconds: 2_000_000_000,
};

describe('signaling connection registry', () => {
  afterEach(() => vi.useRealTimers());

  test('supersedes only the exact old room connection', () => {
    const registry = createConnectionRegistry({ heartbeatIntervalMs: 60_000 });
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    registry.register({ connectionId: 'old', identity, socket: oldSocket });
    registry.bind({
      connectionId: 'old',
      roomId: 'room-1',
      connectionEpoch: 1,
    });
    registry.register({ connectionId: 'new', identity, socket: newSocket });
    registry.bind({
      connectionId: 'new',
      roomId: 'room-1',
      connectionEpoch: 2,
    });
    let oldConnectionAcceptedQueuedSend = true;
    oldSocket.closeHook = () => {
      oldConnectionAcceptedQueuedSend = registry.send('old', '{"late":true}');
    };

    expect(
      registry.supersede({
        roomId: 'room-1',
        userId: 'user-1',
        replacedConnectionId: 'old',
        replacedConnectionEpoch: 1,
        closeCode: 4409,
        reason: 'SESSION_REPLACED',
      }),
    ).toBe(true);
    expect(oldSocket.closes).toEqual([[4409, 'SESSION_REPLACED']]);
    expect(oldConnectionAcceptedQueuedSend).toBe(false);
    expect(registry.remove('old')?.connectionId).toBe('old');
    expect(registry.findCurrent('room-1', 'user-1')?.connectionId).toBe('new');
    registry.shutdown();
  });

  test('unbinds explicitly so one socket can enter another room', () => {
    const registry = createConnectionRegistry({ heartbeatIntervalMs: 60_000 });
    registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new FakeSocket(),
    });
    registry.bind({
      connectionId: 'connection-1',
      roomId: 'room-1',
      connectionEpoch: 1,
    });

    expect(registry.listCurrentInRoom('room-1')).toHaveLength(1);
    expect(registry.unbind('connection-1').binding).toBeNull();
    expect(registry.findCurrent('room-1', 'user-1')).toBeNull();
    expect(
      registry.bind({
        connectionId: 'connection-1',
        roomId: 'room-2',
        connectionEpoch: 1,
      }).binding,
    ).toEqual({ roomId: 'room-2', connectionEpoch: 1 });
    registry.shutdown();
  });

  test('caches only a digest and serialized ack with bounded LRU replay', () => {
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      maxAckEntriesPerConnection: 2,
    });
    registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new FakeSocket(),
    });
    const firstDigest = 'a'.repeat(43);
    const secondDigest = 'b'.repeat(43);
    const thirdDigest = 'c'.repeat(43);

    registry.storeAck('connection-1', 'request-1', firstDigest, '{"ack":1}');
    expect(
      registry.lookupAck('connection-1', 'request-1', firstDigest),
    ).toEqual({ kind: 'replay', serializedAck: '{"ack":1}' });
    expect(
      registry.lookupAck('connection-1', 'request-1', secondDigest),
    ).toEqual({ kind: 'conflict' });
    registry.storeAck('connection-1', 'request-2', secondDigest, '{"ack":2}');
    registry.storeAck('connection-1', 'request-3', thirdDigest, '{"ack":3}');
    expect(
      registry.lookupAck('connection-1', 'request-1', firstDigest),
    ).toEqual({ kind: 'miss' });
    registry.shutdown();
  });

  test('bounds acknowledgement bytes and total live connections', () => {
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      maxConnections: 1,
      maxSerializedAckBytes: 8,
    });
    const registered = registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new FakeSocket(),
    });

    expect(Object.isFrozen(registered)).toBe(true);
    expect(() =>
      registry.storeAck(
        'connection-1',
        'request-1',
        'a'.repeat(43),
        '123456789',
      ),
    ).toThrow(RangeError);
    expect(() =>
      registry.register({
        connectionId: 'connection-2',
        identity,
        socket: new FakeSocket(),
      }),
    ).toThrow(RangeError);
    registry.shutdown();
  });

  test('evicts acknowledgements to enforce an aggregate byte budget', () => {
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      maxAckEntriesPerConnection: 10,
      maxSerializedAckBytes: 10,
      maxAckCacheBytesPerConnection: 15,
    });
    registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new FakeSocket(),
    });
    registry.storeAck('connection-1', 'request-1', 'a'.repeat(43), '12345678');
    registry.storeAck('connection-1', 'request-1', 'a'.repeat(43), '12');
    registry.storeAck('connection-1', 'request-2', 'b'.repeat(43), 'abcdefgh');
    expect(
      registry.lookupAck('connection-1', 'request-1', 'a'.repeat(43)),
    ).toEqual({ kind: 'replay', serializedAck: '12' });
    registry.storeAck('connection-1', 'request-3', 'c'.repeat(43), 'ABCDEFGH');

    expect(
      registry.lookupAck('connection-1', 'request-2', 'b'.repeat(43)),
    ).toEqual({ kind: 'miss' });
    expect(
      registry.lookupAck('connection-1', 'request-3', 'c'.repeat(43)),
    ).toEqual({ kind: 'replay', serializedAck: 'ABCDEFGH' });
    expect(() =>
      createConnectionRegistry({
        maxSerializedAckBytes: 16,
        maxAckCacheBytesPerConnection: 15,
      }),
    ).toThrow(RangeError);
    registry.shutdown();
  });

  test('bounds inbound count and bytes with an injectable window clock', () => {
    let nowMs = 1_000;
    const registry = createConnectionRegistry({
      now: () => nowMs,
      heartbeatIntervalMs: 60_000,
      inboundRateWindowMs: 1_000,
      maxInboundMessagesPerWindow: 2,
      maxInboundBytesPerWindow: 10,
    });
    registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new FakeSocket(),
    });

    expect(registry.consumeInbound('connection-1', 4)).toBe('accepted');
    expect(registry.consumeInbound('connection-1', 6)).toBe('accepted');
    expect(registry.consumeInbound('connection-1', 1)).toBe('rate_limited');
    expect(() => registry.consumeInbound('connection-1', -1)).toThrow(
      RangeError,
    );
    expect(() => registry.consumeInbound('connection-1', 1.5)).toThrow(
      RangeError,
    );
    nowMs += 1_000;
    expect(registry.consumeInbound('connection-1', 10)).toBe('accepted');
    registry.shutdown();
  });

  test('expires an idle connection no later than the next heartbeat', () => {
    vi.useFakeTimers();
    let nowMs = 1_999_999_999_000;
    const socket = new FakeSocket();
    const onTransportDead = vi.fn();
    const registry = createConnectionRegistry({
      now: () => nowMs,
      heartbeatIntervalMs: 1_000,
      onTransportDead,
    });
    registry.register({ connectionId: 'connection-1', identity, socket });

    nowMs = identity.accessTokenExpiresAtSeconds * 1_000;
    vi.advanceTimersByTime(1_000);
    expect(socket.closes).toEqual([[4401, 'AUTH_EXPIRED']]);
    expect(onTransportDead).toHaveBeenCalledWith('connection-1');
    registry.shutdown();
  });

  test('rolls back a created heartbeat timer when unref fails', () => {
    const clearInterval = vi.fn();
    const timer = {
      unref() {
        throw new Error('unref failed');
      },
    };
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      setInterval: () => timer,
      clearInterval,
    });

    expect(() =>
      registry.register({
        connectionId: 'connection-1',
        identity,
        socket: new FakeSocket(),
      }),
    ).toThrow('unref failed');
    expect(clearInterval).toHaveBeenCalledWith(timer);
    registry.shutdown();
  });

  test('closes a connection before buffering output above the limit', () => {
    const onTransportDead = vi.fn();
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      maxBufferedBytes: 16,
      onTransportDead,
    });
    const socket = new FakeSocket();
    socket.bufferedAmount = 10;
    registry.register({ connectionId: 'connection-1', identity, socket });

    expect(registry.send('connection-1', '1234567')).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([[1013, 'BACKPRESSURE']]);
    expect(onTransportDead).toHaveBeenCalledWith('connection-1');
    registry.shutdown();
  });

  test('treats a null ws send callback value as success', () => {
    const onTransportDead = vi.fn();
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      onTransportDead,
    });
    registry.register({
      connectionId: 'connection-1',
      identity,
      socket: new NullSuccessSocket(),
    });

    expect(registry.send('connection-1', '{"ok":true}')).toBe(true);
    expect(registry.get('connection-1')?.state).toBe('active');
    expect(onTransportDead).not.toHaveBeenCalled();
    registry.shutdown();
  });

  test('reports an asynchronous delivery failure before transport cleanup', () => {
    const order: string[] = [];
    const socket = new DeferredErrorSocket();
    const registry = createConnectionRegistry({
      heartbeatIntervalMs: 60_000,
      onTransportDead() {
        order.push('transport-dead');
      },
    });
    registry.register({ connectionId: 'connection-1', identity, socket });

    expect(
      registry.send('connection-1', '{"answer":true}', () => {
        order.push('delivery-failed');
      }),
    ).toBe(true);
    socket.failDelivery();

    expect(order).toEqual(['delivery-failed', 'transport-dead']);
    expect(socket.terminations).toBe(1);
    registry.shutdown();
  });

  test('terminates after two missed pong intervals and clears timers', () => {
    vi.useFakeTimers();
    const registry = createConnectionRegistry({ heartbeatIntervalMs: 1_000 });
    const socket = new FakeSocket();
    registry.register({ connectionId: 'connection-1', identity, socket });

    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(2);
    registry.markPong('connection-1');
    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(3);
    vi.advanceTimersByTime(2_000);
    expect(socket.terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    registry.shutdown();
  });
});
