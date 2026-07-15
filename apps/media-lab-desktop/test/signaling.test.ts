import { describe, expect, test, vi } from 'vitest';

class FakeSocket {
  readonly send = vi.fn();
  readonly close = vi.fn();
  readonly listeners = new Map<string, (event: { data?: unknown }) => void>();

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ) {
    this.listeners.set(type, listener);
  }

  emit(type: 'message' | 'close' | 'error', data?: unknown) {
    this.listeners.get(type)?.({ data });
  }
}

describe('signaling client', () => {
  test('correlates an acknowledgement with its request ID', async () => {
    const { SignalingClient } =
      await import('../src/renderer/src/signaling.js');
    const socket = new FakeSocket();
    const client = new SignalingClient(socket);

    const pending = client.request('listProducers', {});
    const sent = JSON.parse(socket.send.mock.calls[0]?.[0] as string) as {
      id: string;
    };
    socket.emit(
      'message',
      JSON.stringify({
        type: 'ack',
        id: sent.id,
        data: { producerIds: ['p1'] },
      }),
    );

    await expect(pending).resolves.toEqual({ producerIds: ['p1'] });
  });

  test('rejects server errors and all pending work when the socket closes', async () => {
    const { SignalingClient } =
      await import('../src/renderer/src/signaling.js');
    const socket = new FakeSocket();
    const client = new SignalingClient(socket);
    const rejected = client.request('listProducers', {});
    const rejectedId = JSON.parse(socket.send.mock.calls[0]?.[0] as string).id;
    socket.emit(
      'message',
      JSON.stringify({
        type: 'error',
        id: rejectedId,
        error: { code: 'BAD_REQUEST', message: 'No producer' },
      }),
    );
    await expect(rejected).rejects.toThrow('BAD_REQUEST: No producer');

    const closed = client.request('listProducers', {});
    socket.emit('close');
    await expect(closed).rejects.toThrow(/closed/i);
  });

  test('exposes closure and notifies listeners once', async () => {
    const { SignalingClient } =
      await import('../src/renderer/src/signaling.js');
    const socket = new FakeSocket();
    const client = new SignalingClient(socket);
    const onClose = vi.fn();

    client.onClose(onClose);
    expect(client.closed).toBe(false);

    socket.emit('close');
    socket.emit('close');
    const lateListener = vi.fn();
    client.onClose(lateListener);

    expect(client.closed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(lateListener).toHaveBeenCalledOnce();
  });

  test('treats a socket error as closure and closes the socket', async () => {
    const { SignalingClient } =
      await import('../src/renderer/src/signaling.js');
    const socket = new FakeSocket();
    const client = new SignalingClient(socket);
    const onClose = vi.fn();
    client.onClose(onClose);
    const pending = client.request('listProducers', {});

    socket.emit('error');

    await expect(pending).rejects.toThrow(/closed/i);
    expect(client.closed).toBe(true);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
