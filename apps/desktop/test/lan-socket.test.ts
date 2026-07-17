import { describe, expect, it, vi } from 'vitest';
import { createLanFrameCodec } from '@wo/server/lite';

import { LAN_IPC_CHANNELS, registerLanIpc } from '../src/main/lan-ipc.js';
import type { LanSessionController } from '../src/main/lan-session.js';
import {
  createLanSocketController,
  type LanSocketController,
} from '../src/main/lan-socket.js';
import type { LanSocketEvent } from '../src/preload/lan-types.js';

const rendererEntry = 'file:///C:/app/out/renderer/index.html';
const endpoint = 'ws://192.168.1.24:43120/v1/realtime';
const inviteKey = 'A'.repeat(43);
const ticket = 'E'.repeat(43);
const intent = {
  version: 1 as const,
  mode: 'lan' as const,
  endpoint,
  roomCode: '482731',
  inviteKey,
};

type SocketListener =
  | (() => void)
  | ((code: number, reason: Uint8Array) => void)
  | ((data: unknown, isBinary: boolean) => void);

class FakeSocket {
  readyState = 0;
  protocol = 'wo-v1';
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, SocketListener>();

  on(type: 'open', listener: () => void): void;
  on(type: 'error', listener: () => void): void;
  on(type: 'close', listener: (code: number, reason: Uint8Array) => void): void;
  on(
    type: 'message',
    listener: (data: unknown, isBinary: boolean) => void,
  ): void;
  on(type: string, listener: SocketListener): void {
    this.listeners.set(type, listener);
  }

  open(): void {
    this.readyState = 1;
    (this.listeners.get('open') as (() => void) | undefined)?.();
  }

  message(data: unknown, isBinary = false): void {
    (
      this.listeners.get('message') as
        ((value: unknown, binary: boolean) => void) | undefined
    )?.(data, isBinary);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  closed(code = 1000, reason = ''): void {
    this.readyState = 3;
    (
      this.listeners.get('close') as
        ((value: number, detail: Uint8Array) => void) | undefined
    )?.(code, new TextEncoder().encode(reason));
  }
}

function sessionController(): LanSessionController {
  return {
    startHost: vi.fn(),
    startGuest: vi.fn(),
    issueTicket: vi.fn(),
    currentIntent: vi.fn(() => intent),
    stop: vi.fn(),
  };
}

describe('desktop authenticated LAN socket', () => {
  it('authenticates frames and rejects another renderer owner', () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket);
    const events: LanSocketEvent[] = [];
    const controller = createLanSocketController({
      sessions: sessionController(),
      createSocket,
    });

    controller.open(7, endpoint, ['wo-v1', `ticket.${ticket}`], (event) =>
      events.push(event),
    );
    socket.open();
    expect(events).toEqual([{ type: 'open' }]);

    const serverCodec = createLanFrameCodec(inviteKey, 'server');
    serverCodec.bind('connection', ticket);
    socket.message(serverCodec.encode('connection', '{"type":"snapshot"}'));
    expect(events.at(-1)).toEqual({
      type: 'message',
      data: '{"type":"snapshot"}',
    });

    controller.send(7, '{"type":"join"}');
    expect(serverCodec.decode('connection', socket.sent[0]!)).toBe(
      '{"type":"join"}',
    );
    expect(socket.sent[0]).not.toContain(inviteKey);
    expect(socket.sent[0]).not.toContain(ticket);
    expect(() => controller.send(8, '{}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(() =>
      controller.open(8, endpoint, ['wo-v1', `ticket.${ticket}`], vi.fn()),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));

    socket.message('{}');
    expect(socket.closes.at(-1)).toEqual({
      code: 1008,
      reason: 'Invalid authenticated frame',
    });
  });

  it('notifies the renderer exactly once when the main process stops', () => {
    const socket = new FakeSocket();
    const events: LanSocketEvent[] = [];
    const controller = createLanSocketController({
      sessions: sessionController(),
      createSocket: () => socket,
    });

    controller.open(7, endpoint, ['wo-v1', `ticket.${ticket}`], (event) =>
      events.push(event),
    );
    socket.open();
    controller.stop();
    controller.stop();
    socket.closed(1000, 'LAN session closed');

    expect(socket.closes).toEqual([
      { code: 1000, reason: 'LAN session closed' },
    ]);
    expect(events).toEqual([
      { type: 'open' },
      { type: 'close', code: 1000, reason: 'LAN session closed' },
    ]);
  });

  it('does not broadcast an old close into a same-owner replacement', () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const firstEvents: LanSocketEvent[] = [];
    const secondEvents: LanSocketEvent[] = [];
    const subscribers = [
      (event: LanSocketEvent) => {
        firstEvents.push(event);
      },
    ];
    const broadcast = (event: LanSocketEvent): void => {
      for (const subscriber of subscribers) subscriber(event);
    };
    const controller = createLanSocketController({
      sessions: sessionController(),
      createSocket: () => sockets.shift()!,
    });

    controller.open(7, endpoint, ['wo-v1', `ticket.${ticket}`], broadcast);
    firstSocket.open();
    subscribers.push((event) => {
      secondEvents.push(event);
    });
    controller.open(7, endpoint, ['wo-v1', `ticket.${ticket}`], broadcast);
    secondSocket.open();

    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'LAN session closed' },
    ]);
    expect(firstEvents).toEqual([{ type: 'open' }, { type: 'open' }]);
    expect(secondEvents).toEqual([{ type: 'open' }]);
  });

  it('closes the active socket when its trusted IPC owner is destroyed', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ...arguments_: readonly unknown[]) => unknown
    >();
    const ipcMain = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    };
    let emit: ((event: LanSocketEvent) => void) | undefined;
    const sockets = {
      open: vi.fn(
        (
          _ownerId: number,
          _endpoint: string,
          _protocols: readonly string[],
          listener: (event: LanSocketEvent) => void,
        ) => {
          emit = listener;
        },
      ),
      send: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
    } satisfies LanSocketController;
    const sessions = sessionController();
    registerLanIpc(ipcMain, {
      sessions,
      sockets,
      rendererEntry,
    });
    expect([...handlers.keys()]).toEqual([...LAN_IPC_CHANNELS]);

    const mainFrame = { url: rendererEntry };
    let destroy = (): void => undefined;
    const sender = {
      id: 7,
      mainFrame,
      getURL: () => rendererEntry,
      isDestroyed: () => false,
      once: vi.fn((_type: 'destroyed', listener: () => void) => {
        destroy = listener;
      }),
      send: vi.fn(),
    };
    const event = { senderFrame: mainFrame, sender };
    await expect(
      handlers.get('desktop:lan:socket:open')?.(event, endpoint, [
        'wo-v1',
        `ticket.${ticket}`,
      ]),
    ).resolves.toEqual({ ok: true, value: null });

    emit?.({ type: 'message', data: '{}' });
    expect(sender.send).toHaveBeenCalledWith('desktop:lan:socket:event', {
      type: 'message',
      data: '{}',
    });
    destroy();
    expect(sockets.close).toHaveBeenCalledWith(7);

    const foreignFrame = { url: 'https://attacker.example/' };
    const forbidden = {
      ...event,
      senderFrame: foreignFrame,
      sender: { ...sender, mainFrame: foreignFrame },
    };
    await expect(
      handlers.get('desktop:lan:socket:send')?.(forbidden, '{}'),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_FORBIDDEN' },
    });
    expect(sockets.send).not.toHaveBeenCalled();
  });
});
