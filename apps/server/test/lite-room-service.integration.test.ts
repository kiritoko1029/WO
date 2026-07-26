import {
  P2P_MEDIA_PLAN,
  p2pAckEnvelopeSchema,
  p2pOutboundResponseSchema,
  p2pRoomJoinAckSchema,
  p2pRoomLeaveAckSchema,
  roomCreateAckSchema,
  roomResumeAckSchema,
  signalTicketResponseSchema,
  type P2pOutboundResponse,
} from '@wo/protocol';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import Fastify from 'fastify';
import { type RawData, WebSocket } from 'ws';
import { afterEach, describe, expect, test } from 'vitest';

import { createLanFrameCodec } from '../src/lite/authenticated-frame.ts';
import {
  startLiteRoomService,
  type RunningLiteRoomService,
} from '../src/lite/lite-room-service.ts';
import type { RoomRegistry } from '../src/modules/rooms/room-types.ts';
import { registerSignalingGateway } from '../src/modules/signaling/gateway.ts';
import { createSignalTicketStore } from '../src/modules/signaling/signal-ticket-store.ts';

const services: RunningLiteRoomService[] = [];

afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.close()),
  );
});

function openSocket(endpoint: string, ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, ['wo-v1', `ticket.${ticket}`]);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function exchangeGuestTicket(
  service: RunningLiteRoomService,
  clientId: string,
  authorization = `Bearer ${service.invite.inviteKey}`,
): Promise<Response> {
  return fetch(service.invite.sessionEndpoint, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      clientId,
      displayName: 'Guest',
    }),
  });
}

function sendLanRequest(
  socket: WebSocket,
  codec: ReturnType<typeof createLanFrameCodec>,
  connectionId: string,
  type: string,
  requestId: string,
  payload: unknown,
): Promise<P2pOutboundResponse> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) throw new Error('Expected a text frame');
        const response = p2pOutboundResponseSchema.parse(
          JSON.parse(codec.decode(connectionId, data.toString())) as unknown,
        );
        if (!('requestId' in response) || response.requestId !== requestId) {
          return;
        }
        socket.off('message', onMessage);
        resolve(response);
      } catch (error) {
        socket.off('message', onMessage);
        reject(error);
      }
    };
    socket.on('message', onMessage);
    socket.send(
      codec.encode(
        connectionId,
        JSON.stringify({ version: 1, requestId, type, payload }),
      ),
    );
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

describe('LAN room service', () => {
  test('keeps the default central gateway frame byte-for-byte unwrapped', async () => {
    const app = Fastify({ logger: false });
    await app.register(websocket, {
      options: {
        handleProtocols: (protocols) =>
          protocols.has('wo-v1') ? 'wo-v1' : false,
      },
    });
    const ticketStore = createSignalTicketStore();
    const expected = p2pAckEnvelopeSchema.parse({
      version: 1,
      requestId: 'ready-1',
      type: 'peer.ready.ack',
      payload: {
        ok: false,
        error: {
          code: 'INVALID_STATE',
          message: 'Operation is not valid in the current state',
        },
      },
    });
    const gateway = registerSignalingGateway(app, {
      ticketStore,
      roomRegistry: {} as RoomRegistry,
      dispatcher: {
        dispatch: () => ({
          response: expected,
          effects: {
            intents: [],
            relays: [],
            confirmations: [],
          },
        }),
      },
    });
    app.addHook('onClose', async () => gateway.shutdown());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const issued = ticketStore.issue({
      userId: 'central-user',
      sessionId: 'central-session',
      displayName: 'Central User',
      accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1_000) + 60,
    });
    const socket = await openSocket(
      `ws://127.0.0.1:${port}/v1/realtime`,
      issued.value,
    );
    const rawResponse = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(data.toString())),
    );
    const rawRequest = JSON.stringify({
      version: 1,
      requestId: 'ready-1',
      type: 'peer.ready',
      payload: {
        roomId: 'room-1',
        connectionEpoch: 1,
        mediaPlan: P2P_MEDIA_PLAN,
      },
    });
    socket.send(rawRequest);
    expect(await rawResponse).toBe(JSON.stringify(expected));
    await app.close();
  });

  test('rejects incompatible media plans through the authenticated LAN gateway', async () => {
    const service = await startLiteRoomService();
    services.push(service);
    const ticket = service.issueHostTicket().ticket;
    const socket = await openSocket(service.invite.endpoint, ticket);
    const codec = createLanFrameCodec(service.invite.inviteKey, 'client');
    codec.bind('legacy-host', ticket);

    for (const [requestId, payload] of [
      ['missing-media-plan', { roomId: 'room-1', connectionEpoch: 1 }],
      [
        'legacy-media-plan',
        {
          roomId: 'room-1',
          connectionEpoch: 1,
          mediaPlan: 'mic-screen-v0',
        },
      ],
    ] as const) {
      expect(
        await sendLanRequest(
          socket,
          codec,
          'legacy-host',
          'peer.ready',
          requestId,
          payload,
        ),
      ).toMatchObject({
        requestId,
        type: 'protocol.error',
        payload: { error: { code: 'UNSUPPORTED_PROTOCOL' } },
      });
    }

    await closeSocket(socket);
  });

  test('rejects an authenticated frame replayed with a fresh ticket', async () => {
    const service = await startLiteRoomService();
    services.push(service);
    const firstTicket = service.issueHostTicket().ticket;
    const firstSocket = await openSocket(service.invite.endpoint, firstTicket);
    const firstCodec = createLanFrameCodec(service.invite.inviteKey, 'client');
    firstCodec.bind('first-host', firstTicket);
    const frame = firstCodec.encode(
      'first-host',
      JSON.stringify({
        version: 1,
        requestId: 'create-before-reconnect',
        type: 'room.create',
        payload: {},
      }),
    );
    const accepted = new Promise<P2pOutboundResponse>((resolve, reject) => {
      firstSocket.once('message', (data, isBinary) => {
        try {
          if (isBinary) throw new Error('Expected a text frame');
          resolve(
            p2pOutboundResponseSchema.parse(
              JSON.parse(
                firstCodec.decode('first-host', data.toString()),
              ) as unknown,
            ),
          );
        } catch (error) {
          reject(error);
        }
      });
    });
    firstSocket.send(frame);
    expect((await accepted).type).toBe('room.create.ack');
    await closeSocket(firstSocket);

    const secondTicket = service.issueHostTicket().ticket;
    const secondSocket = await openSocket(
      service.invite.endpoint,
      secondTicket,
    );
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      secondSocket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    secondSocket.send(frame);
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: 'AUTH_REQUIRED',
    });
  });

  test('runs one authenticated two-person room with LAN-only ICE', async () => {
    const service = await startLiteRoomService({
      hostDisplayName: 'Host',
      randomBytes: (size) => new Uint8Array(size).fill(7),
      randomInt: () => 12_345,
    });
    services.push(service);

    expect(service.invite.endpoint).toMatch(
      /^ws:\/\/(?:10|172|192)\.\d+\.\d+\.\d+:\d+\/v1\/realtime$/u,
    );
    expect(service.invite.roomCode).toBe('012345');
    expect(service.invite.inviteKey).toHaveLength(43);

    const roomCodeOnly = await fetch(service.invite.sessionEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        clientId: '11111111-1111-4111-8111-111111111111',
        displayName: service.invite.roomCode,
      }),
    });
    expect(roomCodeOnly.status).toBe(401);

    const guestResponse = await exchangeGuestTicket(
      service,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(guestResponse.status).toBe(200);
    const guestTicket = (await guestResponse.json()) as {
      readonly ticket: string;
    };
    expect(
      (
        await exchangeGuestTicket(
          service,
          '11111111-1111-4111-8111-111111111111',
        )
      ).status,
    ).toBe(200);
    const unreservedGuestResponse = await exchangeGuestTicket(
      service,
      '22222222-2222-4222-8222-222222222222',
    );
    expect(unreservedGuestResponse.status).toBe(200);
    expect(
      (
        await exchangeGuestTicket(
          service,
          '11111111-1111-4111-8111-111111111111',
          'Bearer wrong-key',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await exchangeGuestTicket(
          service,
          '11111111-1111-4111-8111-111111111111',
          'Bearer wrong-key',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await exchangeGuestTicket(
          service,
          '11111111-1111-4111-8111-111111111111',
          'Bearer wrong-key',
        )
      ).status,
    ).toBe(429);

    const hostTicket = service.issueHostTicket().ticket;
    const host = await openSocket(service.invite.endpoint, hostTicket);
    const guest = await openSocket(service.invite.endpoint, guestTicket.ticket);
    const hostCodec = createLanFrameCodec(service.invite.inviteKey, 'client');
    const guestCodec = createLanFrameCodec(service.invite.inviteKey, 'client');
    hostCodec.bind('host', hostTicket);
    guestCodec.bind('guest', guestTicket.ticket);
    const guestForbiddenPromise = new Promise<P2pOutboundResponse>(
      (resolve, reject) => {
        guest.once('message', (data, isBinary) => {
          try {
            if (isBinary) throw new Error('Expected a text frame');
            resolve(
              p2pOutboundResponseSchema.parse(
                JSON.parse(
                  guestCodec.decode('guest', data.toString()),
                ) as unknown,
              ),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    guest.send(
      guestCodec.encode(
        'guest',
        JSON.stringify({
          version: 1,
          requestId: 'guest-create',
          type: 'room.create',
          payload: {},
        }),
      ),
    );
    expect((await guestForbiddenPromise).payload).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    const hostAckPromise = new Promise<P2pOutboundResponse>(
      (resolve, reject) => {
        host.once('message', (data, isBinary) => {
          try {
            if (isBinary) throw new Error('Expected a text frame');
            resolve(
              p2pOutboundResponseSchema.parse(
                JSON.parse(
                  hostCodec.decode('host', data.toString()),
                ) as unknown,
              ),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    host.send(
      hostCodec.encode(
        'host',
        JSON.stringify({
          version: 1,
          requestId: 'create-1',
          type: 'room.create',
          payload: {},
        }),
      ),
    );
    const created = roomCreateAckSchema.parse(await hostAckPromise);
    expect(created.payload.ok).toBe(true);
    if (!created.payload.ok) throw new Error('Expected room creation');
    expect(created.payload.data.roomCode).toBe(service.invite.roomCode);
    expect(created.payload.data.rtcConfiguration).toEqual({
      mode: 'lan',
      iceServers: [],
      iceTransportPolicy: 'all',
    });

    const guestAckPromise = new Promise<P2pOutboundResponse>(
      (resolve, reject) => {
        guest.once('message', (data, isBinary) => {
          try {
            if (isBinary) throw new Error('Expected a text frame');
            resolve(
              p2pOutboundResponseSchema.parse(
                JSON.parse(
                  guestCodec.decode('guest', data.toString()),
                ) as unknown,
              ),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    guest.send(
      guestCodec.encode(
        'guest',
        JSON.stringify({
          version: 1,
          requestId: 'join-1',
          type: 'room.join',
          payload: { roomCode: service.invite.roomCode },
        }),
      ),
    );
    const joined = await guestAckPromise;
    expect(joined.type).toBe('room.join.ack');
    expect(joined.payload).toMatchObject({ ok: true });

    const hostClosed = new Promise<void>((resolve) =>
      host.once('close', () => resolve()),
    );
    const guestClosed = new Promise<void>((resolve) =>
      guest.once('close', () => resolve()),
    );
    await service.close();
    await Promise.all([hostClosed, guestClosed]);
  });

  test('reserves a joined guest through reconnect and releases it on leave', async () => {
    const firstGuestId = '11111111-1111-4111-8111-111111111111';
    const secondGuestId = '22222222-2222-4222-8222-222222222222';
    const service = await startLiteRoomService();
    services.push(service);

    const hostTicket = service.issueHostTicket().ticket;
    const host = await openSocket(service.invite.endpoint, hostTicket);
    const hostCodec = createLanFrameCodec(service.invite.inviteKey, 'client');
    hostCodec.bind('host', hostTicket);
    const created = roomCreateAckSchema.parse(
      await sendLanRequest(
        host,
        hostCodec,
        'host',
        'room.create',
        'create-reservation-room',
        {},
      ),
    );
    expect(created.payload.ok).toBe(true);
    if (!created.payload.ok) throw new Error('Expected room creation');
    const roomId = created.payload.data.roomId;
    const hostJoin = p2pRoomJoinAckSchema.parse(
      await sendLanRequest(host, hostCodec, 'host', 'room.join', 'host-join', {
        roomCode: service.invite.roomCode,
      }),
    );
    expect(hostJoin.payload).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });

    const firstTicketResponse = await exchangeGuestTicket(
      service,
      firstGuestId,
    );
    const secondTicketResponse = await exchangeGuestTicket(
      service,
      secondGuestId,
    );
    expect(firstTicketResponse.status).toBe(200);
    expect(secondTicketResponse.status).toBe(200);
    const firstTicket = signalTicketResponseSchema.parse(
      await firstTicketResponse.json(),
    );

    const firstGuest = await openSocket(
      service.invite.endpoint,
      firstTicket.ticket,
    );
    const firstGuestCodec = createLanFrameCodec(
      service.invite.inviteKey,
      'client',
    );
    firstGuestCodec.bind('first-guest', firstTicket.ticket);
    const joined = p2pRoomJoinAckSchema.parse(
      await sendLanRequest(
        firstGuest,
        firstGuestCodec,
        'first-guest',
        'room.join',
        'first-join',
        { roomCode: service.invite.roomCode },
      ),
    );
    expect(joined.payload.ok).toBe(true);
    expect((await exchangeGuestTicket(service, secondGuestId)).status).toBe(
      409,
    );

    await closeSocket(firstGuest);
    const reconnectTicketResponse = await exchangeGuestTicket(
      service,
      firstGuestId,
    );
    expect(reconnectTicketResponse.status).toBe(200);
    const reconnectTicket = signalTicketResponseSchema.parse(
      await reconnectTicketResponse.json(),
    );
    const reconnectedGuest = await openSocket(
      service.invite.endpoint,
      reconnectTicket.ticket,
    );
    const reconnectCodec = createLanFrameCodec(
      service.invite.inviteKey,
      'client',
    );
    reconnectCodec.bind('reconnected-guest', reconnectTicket.ticket);
    const resumed = roomResumeAckSchema.parse(
      await sendLanRequest(
        reconnectedGuest,
        reconnectCodec,
        'reconnected-guest',
        'room.resume',
        'first-resume',
        { roomId },
      ),
    );
    expect(resumed.payload.ok).toBe(true);

    const left = p2pRoomLeaveAckSchema.parse(
      await sendLanRequest(
        reconnectedGuest,
        reconnectCodec,
        'reconnected-guest',
        'room.leave',
        'first-leave',
        { roomId },
      ),
    );
    expect(left.payload.ok).toBe(true);
    await closeSocket(reconnectedGuest);

    const replacementTicketResponse = await exchangeGuestTicket(
      service,
      secondGuestId,
    );
    expect(replacementTicketResponse.status).toBe(200);
    const replacementTicket = signalTicketResponseSchema.parse(
      await replacementTicketResponse.json(),
    );
    const replacementGuest = await openSocket(
      service.invite.endpoint,
      replacementTicket.ticket,
    );
    const replacementCodec = createLanFrameCodec(
      service.invite.inviteKey,
      'client',
    );
    replacementCodec.bind('replacement-guest', replacementTicket.ticket);
    const replacementJoined = p2pRoomJoinAckSchema.parse(
      await sendLanRequest(
        replacementGuest,
        replacementCodec,
        'replacement-guest',
        'room.join',
        'replacement-join',
        { roomCode: service.invite.roomCode },
      ),
    );
    expect(replacementJoined.payload.ok).toBe(true);
    expect((await exchangeGuestTicket(service, firstGuestId)).status).toBe(409);
    await closeSocket(replacementGuest);
    await closeSocket(host);
  });

  test('does not reserve a guest when ticket issuance fails', async () => {
    const service = await startLiteRoomService();
    services.push(service);
    const hostTickets = Array.from(
      { length: 8 },
      () => service.issueHostTicket().ticket,
    );

    expect(
      (
        await exchangeGuestTicket(
          service,
          '11111111-1111-4111-8111-111111111111',
        )
      ).status,
    ).toBe(503);

    const host = await openSocket(service.invite.endpoint, hostTickets[0]!);
    await closeSocket(host);

    expect(
      (
        await exchangeGuestTicket(
          service,
          '22222222-2222-4222-8222-222222222222',
        )
      ).status,
    ).toBe(200);
  });

  test('closes the room when its advertised private address disappears', async () => {
    let interfaces = networkInterfaces();
    let watchNetwork = (): void => {
      throw new Error('Network watcher was not registered');
    };
    let clearedTimers = 0;
    const service = await startLiteRoomService({
      networkInterfaces: () => interfaces,
      setInterval: (callback, delayMs) => {
        expect(delayMs).toBe(5_000);
        watchNetwork = callback;
        return 'network-watch';
      },
      clearInterval: (timer) => {
        expect(timer).toBe('network-watch');
        clearedTimers += 1;
      },
    });
    services.push(service);
    const host = await openSocket(
      service.invite.endpoint,
      service.issueHostTicket().ticket,
    );
    const hostClosed = new Promise<void>((resolve) =>
      host.once('close', () => resolve()),
    );

    interfaces = {};
    watchNetwork();
    await hostClosed;

    expect(clearedTimers).toBe(1);
    await expect(service.close()).resolves.toBeUndefined();
  });

  test('closes the room when the advertised address moves to another interface', async () => {
    let interfaces = networkInterfaces();
    let watchNetwork = (): void => {
      throw new Error('Network watcher was not registered');
    };
    const service = await startLiteRoomService({
      networkInterfaces: () => interfaces,
      setInterval: (callback) => {
        watchNetwork = callback;
        return 'network-watch';
      },
      clearInterval: () => undefined,
    });
    services.push(service);
    const advertisedAddress = new URL(service.invite.endpoint).hostname;
    const advertisedInterface = Object.entries(interfaces).find(([, entries]) =>
      (entries ?? []).some(
        (entry) =>
          entry.family === 'IPv4' &&
          !entry.internal &&
          entry.address === advertisedAddress,
      ),
    );
    expect(advertisedInterface).toBeDefined();
    const [interfaceName, entries] = advertisedInterface!;
    interfaces = {
      ...interfaces,
      [interfaceName]: undefined,
      [`renamed-${interfaceName}`]: entries,
    };
    const host = await openSocket(
      service.invite.endpoint,
      service.issueHostTicket().ticket,
    );
    const hostClosed = new Promise<void>((resolve) =>
      host.once('close', () => resolve()),
    );

    watchNetwork();
    await hostClosed;

    await expect(service.close()).resolves.toBeUndefined();
  });
});
