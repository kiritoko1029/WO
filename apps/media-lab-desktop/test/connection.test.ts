import { readFile } from 'node:fs/promises';

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

function acknowledgeCapabilities(socket: FakeSocket): void {
  const raw = socket.send.mock.calls.at(-1)?.[0];
  if (typeof raw !== 'string')
    throw new Error('Capabilities were not requested');
  const request = JSON.parse(raw) as { id: string };
  socket.emit(
    'message',
    JSON.stringify({
      type: 'ack',
      id: request.id,
      data: { rtpCapabilities: { codecs: [] } },
    }),
  );
}

describe('lab connection manager', () => {
  test.each(['close', 'error'] as const)(
    'rebuilds after signaling %s invalidates the active connection',
    async (event) => {
      const [{ LabConnectionManager }, { SignalingClient }] = await Promise.all(
        [
          import('../src/renderer/src/connection.js'),
          import('../src/renderer/src/signaling.js'),
        ],
      );
      const sockets = [new FakeSocket(), new FakeSocket()];
      let socketIndex = 0;
      const createSignaling = vi.fn(
        async () => new SignalingClient(sockets[socketIndex++]!),
      );
      const createDevice = vi.fn(async () => ({ loadMarker: socketIndex }));
      const loadDevice = vi.fn().mockResolvedValue(undefined);
      const manager = new LabConnectionManager({
        createSignaling,
        createDevice,
        loadDevice,
      });

      const firstPending = manager.connect();
      await vi.waitFor(() => expect(sockets[0]!.send).toHaveBeenCalledOnce());
      acknowledgeCapabilities(sockets[0]!);
      const first = await firstPending;
      expect(manager.current).toBe(first);

      sockets[0]!.emit(event);
      expect(manager.current).toBeNull();

      const secondPending = manager.connect();
      await vi.waitFor(() => expect(sockets[1]!.send).toHaveBeenCalledOnce());
      acknowledgeCapabilities(sockets[1]!);
      const second = await secondPending;

      expect(second.signaling).not.toBe(first.signaling);
      expect(manager.current).toBe(second);
      expect(createSignaling).toHaveBeenCalledTimes(2);
      if (event === 'error') expect(sockets[0]!.close).toHaveBeenCalledOnce();
    },
  );

  test('closes partial initialization and retries with fresh state', async () => {
    const [{ LabConnectionManager }, { SignalingClient }] = await Promise.all([
      import('../src/renderer/src/connection.js'),
      import('../src/renderer/src/signaling.js'),
    ]);
    const sockets = [new FakeSocket(), new FakeSocket()];
    let socketIndex = 0;
    const createSignaling = vi.fn(
      async () => new SignalingClient(sockets[socketIndex++]!),
    );
    const createDevice = vi.fn(async () => ({ loadMarker: socketIndex }));
    const loadDevice = vi
      .fn()
      .mockRejectedValueOnce(new Error('device load failed'))
      .mockResolvedValueOnce(undefined);
    const manager = new LabConnectionManager({
      createSignaling,
      createDevice,
      loadDevice,
    });

    const failed = manager.connect();
    await vi.waitFor(() => expect(sockets[0]!.send).toHaveBeenCalledOnce());
    acknowledgeCapabilities(sockets[0]!);
    await expect(failed).rejects.toThrow('device load failed');
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(manager.current).toBeNull();

    const retried = manager.connect();
    await vi.waitFor(() => expect(sockets[1]!.send).toHaveBeenCalledOnce());
    acknowledgeCapabilities(sockets[1]!);
    const retriedConnection = await retried;
    expect(retriedConnection).toBe(manager.current);
    expect(createSignaling).toHaveBeenCalledTimes(2);
    expect(createDevice).toHaveBeenCalledTimes(2);
  });

  test('shares one atomic initialization across concurrent connect calls', async () => {
    const [{ LabConnectionManager }, { SignalingClient }] = await Promise.all([
      import('../src/renderer/src/connection.js'),
      import('../src/renderer/src/signaling.js'),
    ]);
    const socket = new FakeSocket();
    const createSignaling = vi.fn(async () => new SignalingClient(socket));
    const createDevice = vi.fn(async () => ({ loaded: false }));
    const loadDevice = vi.fn().mockResolvedValue(undefined);
    const manager = new LabConnectionManager({
      createSignaling,
      createDevice,
      loadDevice,
    });

    const first = manager.connect();
    const second = manager.connect();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    acknowledgeCapabilities(socket);

    const [firstConnection, secondConnection] = await Promise.all([
      first,
      second,
    ]);
    expect(secondConnection).toBe(firstConnection);
    expect(createSignaling).toHaveBeenCalledOnce();
    expect(createDevice).toHaveBeenCalledOnce();
    expect(loadDevice).toHaveBeenCalledOnce();
  });

  test('renderer delegates connection ownership to the manager', async () => {
    const source = await readFile(
      new URL('../src/renderer/src/main.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('new LabConnectionManager');
    expect(source).not.toContain('let socket: WebSocket | null');
    expect(source).not.toContain('let signaling: SignalingClient | null');
    expect(source).not.toContain('let device: Device | null');
    expect(source).toContain('connectionManager.current');
  });
});
