import {
  P2P_MEDIA_PLAN,
  p2pAckEnvelopeSchema,
  p2pRoomJoinAckSchema,
  p2pScreenAcquireAckSchema,
  p2pScreenReleaseAckSchema,
  p2pScreenRenewAckSchema,
  p2pRequestEnvelopeSchema,
  roomCreateAckSchema,
  screenBitrateAckSchema,
  type IceConfigurationData,
  type P2pRequestEnvelope,
} from '@wo/protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createRoomRegistry } from '../src/modules/rooms/room-registry.ts';
import { createScreenLeaseRegistry } from '../src/modules/screen/screen-lease-registry.ts';
import {
  createSignalingDispatcher,
  type SignalingRequestContext,
} from '../src/modules/signaling/dispatcher.ts';
import { createRoomRequestHandler } from '../src/modules/signaling/handlers/room.ts';
import { createScreenRequestHandler } from '../src/modules/signaling/handlers/screen.ts';
import { createWebrtcRequestHandler } from '../src/modules/signaling/handlers/webrtc.ts';

const fixedIceConfiguration = (suffix: number): IceConfigurationData => ({
  rtcConfiguration: {
    iceServers: [
      { urls: ['stun:rtc.example.test:3478'] },
      {
        urls: ['turn:rtc.example.test:3478?transport=udp'],
        username: `1700000600:opaque-${suffix}`,
        credential: `credential-${suffix}`,
      },
    ],
    iceTransportPolicy: 'all',
  },
  iceCredentialsExpiresAt: '2023-11-14T22:23:20.000Z',
});

const request = (type: string, requestId: string, payload: unknown) =>
  p2pRequestEnvelopeSchema.parse({ version: 1, requestId, type, payload });

const createContext = (
  userId: string,
  displayName: string,
  connectionId: string,
): SignalingRequestContext => ({
  identity: {
    userId,
    displayName,
    sessionId: `session-${userId}`,
    accessTokenExpiresAtSeconds: 2_000_000_000,
  },
  connectionId,
  binding: null,
  remoteIp: '203.0.113.10',
  requestDigest: 'd'.repeat(43),
});

const withBinding = (
  context: SignalingRequestContext,
  binding: NonNullable<SignalingRequestContext['binding']>,
): SignalingRequestContext => ({ ...context, binding });

function createHarness(
  options: Readonly<{
    failIceCalls?: readonly number[];
    roomOperationAllowed?: boolean;
  }> = {},
) {
  let uuid = 0;
  let ice = 0;
  const asyncIntents: unknown[] = [];
  const registry = createRoomRegistry({
    randomInt: () => 12_345,
    randomUUID: () => `generated-${++uuid}`,
    onAsyncIntent: (intent) => asyncIntents.push(intent),
  });
  const consume = vi.fn(() => ({
    allowed: true,
    remaining: 4,
    retryAfterMs: 0,
  }));
  const consumeRoomOperation = vi.fn(() => ({
    allowed: options.roomOperationAllowed ?? true,
    remaining: options.roomOperationAllowed === false ? 0 : 9_999,
    retryAfterMs: options.roomOperationAllowed === false ? 60_000 : 0,
  }));
  const createFreshIce = vi.fn(() => {
    ice += 1;
    if (options.failIceCalls?.includes(ice) === true) {
      throw new Error(`ICE failure ${ice}`);
    }
    return fixedIceConfiguration(ice);
  });
  const dispatcher = createSignalingDispatcher({
    roomHandler: createRoomRequestHandler({
      roomRegistry: registry,
      joinAttemptLimiter: { consume },
      roomOperationLimiter: { consume: consumeRoomOperation },
      createFreshIce,
    }),
    webrtcHandler: createWebrtcRequestHandler({
      roomRegistry: registry,
      createFreshIce,
    }),
    screenHandler: createScreenRequestHandler({
      leases: createScreenLeaseRegistry({ roomRegistry: registry }),
    }),
  });
  return {
    registry,
    dispatcher,
    consume,
    consumeRoomOperation,
    createFreshIce,
    asyncIntents,
  };
}

const dispatch = (
  dispatcher: ReturnType<typeof createSignalingDispatcher>,
  context: SignalingRequestContext,
  value: P2pRequestEnvelope,
) => dispatcher.dispatch(context, value);

afterEach(() => vi.useRealTimers());

describe('P2P signaling dispatcher', () => {
  test('creates and joins one room using trusted identities and fresh ICE', () => {
    vi.useFakeTimers();
    const {
      registry,
      dispatcher,
      consume,
      consumeRoomOperation,
      createFreshIce,
    } = createHarness();
    const creator = createContext('creator', 'Creator', 'creator-connection');
    const joiner = createContext('joiner', 'Joiner', 'joiner-connection');

    const created = dispatch(
      dispatcher,
      creator,
      request('room.create', 'create-1', {}),
    );
    const createdAck = roomCreateAckSchema.parse(created.response);
    expect(createdAck.payload.ok).toBe(true);
    if (!createdAck.payload.ok) throw new Error('expected create success');
    expect(createdAck.payload.data).toMatchObject({
      role: 'creator',
      state: 'waiting',
      peer: null,
      roomCode: '012345',
    });
    expect(created.effects.binding).toEqual({
      roomId: createdAck.payload.data.roomId,
      connectionEpoch: createdAck.payload.data.connectionEpoch,
    });

    const joined = dispatch(
      dispatcher,
      joiner,
      request('room.join', 'join-1', {
        roomCode: createdAck.payload.data.roomCode,
      }),
    );
    const joinedAck = p2pRoomJoinAckSchema.parse(joined.response);
    expect(joinedAck.payload.ok).toBe(true);
    if (!joinedAck.payload.ok) throw new Error('expected join success');
    expect(joinedAck.payload.data).toMatchObject({
      role: 'joiner',
      peer: { userId: 'creator', displayName: 'Creator', ready: false },
    });
    expect(joined.effects.intents).toContainEqual({
      type: 'peer.joined',
      roomId: createdAck.payload.data.roomId,
      userId: 'joiner',
    });
    expect(consume).toHaveBeenCalledWith({
      userId: 'joiner',
      remoteIp: '203.0.113.10',
      requestId: 'join-1',
    });
    expect(consumeRoomOperation).toHaveBeenCalledTimes(2);
    expect(createFreshIce).toHaveBeenCalledTimes(2);
    expect(
      joinedAck.payload.data.rtcConfiguration.iceServers[1]?.username,
    ).not.toBe(
      createdAck.payload.data.rtcConfiguration.iceServers[1]?.username,
    );
    registry.clear();
  });

  test('rejects room creation at the server-wide operation limit', () => {
    const { registry, dispatcher, consumeRoomOperation } = createHarness({
      roomOperationAllowed: false,
    });
    const creator = createContext('creator', 'Creator', 'creator-connection');

    const created = dispatch(
      dispatcher,
      creator,
      request('room.create', 'globally-limited-create', {}),
    );

    expect(p2pAckEnvelopeSchema.parse(created.response).payload).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', retryable: true },
    });
    expect(consumeRoomOperation).toHaveBeenCalledWith({
      userId: 'server-wide-room-operations',
      remoteIp: '0.0.0.0',
      requestId: 'globally-limited-create',
    });
    expect(registry.getStats().rooms).toBe(0);
  });

  test.each([
    ['create', 1],
    ['join', 2],
    ['resume', 3],
  ] as const)(
    'compensates a room when %s ICE generation fails',
    (operation, failCall) => {
      vi.useFakeTimers();
      const { registry, dispatcher, asyncIntents } = createHarness({
        failIceCalls: [failCall],
      });
      let creator = createContext('creator', 'Creator', 'creator-connection');
      let joiner = createContext('joiner', 'Joiner', 'joiner-connection');

      const created = dispatch(
        dispatcher,
        creator,
        request('room.create', 'create-1', {}),
      );
      if (operation === 'create') {
        expect(
          p2pAckEnvelopeSchema.parse(created.response).payload,
        ).toMatchObject({
          ok: false,
          error: { code: 'SIGNALING_UNAVAILABLE' },
        });
        expect(registry.getStats().rooms).toBe(0);
        return;
      }
      const createAck = roomCreateAckSchema.parse(created.response);
      if (!createAck.payload.ok || created.effects.binding == null) {
        throw new Error('expected create success');
      }
      creator = withBinding(creator, created.effects.binding);
      const roomId = createAck.payload.data.roomId;

      const joined = dispatch(
        dispatcher,
        joiner,
        request('room.join', 'join-1', {
          roomCode: createAck.payload.data.roomCode,
        }),
      );
      if (operation === 'join') {
        expect(
          p2pAckEnvelopeSchema.parse(joined.response).payload,
        ).toMatchObject({
          ok: false,
          error: { code: 'SIGNALING_UNAVAILABLE' },
        });
        expect(registry.getStats().rooms).toBe(0);
        expect(asyncIntents).toContainEqual({
          type: 'room.closed',
          roomId,
          reason: 'signaling_error',
        });
        return;
      }
      const joinAck = p2pRoomJoinAckSchema.parse(joined.response);
      if (!joinAck.payload.ok || joined.effects.binding == null) {
        throw new Error('expected join success');
      }
      joiner = withBinding(joiner, joined.effects.binding);
      registry.disconnect({
        roomId,
        userId: 'joiner',
        connectionId: joiner.connectionId,
        connectionEpoch: joiner.binding!.connectionEpoch,
      });
      joiner = createContext('joiner', 'Joiner', 'joiner-replacement');

      const resumed = dispatch(
        dispatcher,
        joiner,
        request('room.resume', 'resume-1', { roomId }),
      );
      expect(
        p2pAckEnvelopeSchema.parse(resumed.response).payload,
      ).toMatchObject({
        ok: false,
        error: { code: 'SIGNALING_UNAVAILABLE' },
      });
      expect(registry.getStats().rooms).toBe(0);
      expect(asyncIntents).toContainEqual({
        type: 'room.closed',
        roomId,
        reason: 'signaling_error',
      });
      expect(creator.binding).not.toBeNull();
    },
  );

  test('enforces creator offer and supports completed candidates and ICE restart', () => {
    vi.useFakeTimers();
    const { registry, dispatcher } = createHarness();
    let creator = createContext('creator', 'Creator', 'creator-connection');
    let joiner = createContext('joiner', 'Joiner', 'joiner-connection');
    const created = dispatch(
      dispatcher,
      creator,
      request('room.create', 'create-1', {}),
    );
    const createAck = roomCreateAckSchema.parse(created.response);
    if (!createAck.payload.ok || created.effects.binding == null) {
      throw new Error('expected create success');
    }
    creator = withBinding(creator, created.effects.binding);
    const joined = dispatch(
      dispatcher,
      joiner,
      request('room.join', 'join-1', {
        roomCode: createAck.payload.data.roomCode,
      }),
    );
    const joinAck = p2pRoomJoinAckSchema.parse(joined.response);
    if (!joinAck.payload.ok || joined.effects.binding == null) {
      throw new Error('expected join success');
    }
    joiner = withBinding(joiner, joined.effects.binding);
    const roomId = createAck.payload.data.roomId;

    dispatch(
      dispatcher,
      creator,
      request('peer.ready', 'ready-creator', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        mediaPlan: P2P_MEDIA_PLAN,
      }),
    );
    dispatch(
      dispatcher,
      joiner,
      request('peer.ready', 'ready-joiner', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        mediaPlan: P2P_MEDIA_PLAN,
      }),
    );

    const refreshBeforeOffer = dispatch(
      dispatcher,
      creator,
      request('webrtc.iceServers.refresh', 'refresh-before-offer', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'not-started-yet',
      }),
    );
    expect(
      p2pAckEnvelopeSchema.parse(refreshBeforeOffer.response).payload,
    ).toMatchObject({
      ok: true,
      data: { rtcConfiguration: { iceTransportPolicy: 'all' } },
    });

    const forbiddenOffer = dispatch(
      dispatcher,
      joiner,
      request('webrtc.offer', 'offer-joiner', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-joiner',
        description: { type: 'offer', sdp: 'v=0\r\n' },
      }),
    );
    expect(
      p2pAckEnvelopeSchema.parse(forbiddenOffer.response).payload,
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const offer = dispatch(
      dispatcher,
      creator,
      request('webrtc.offer', 'offer-1', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        description: { type: 'offer', sdp: 'v=0\r\n' },
      }),
    );
    expect(offer.effects.relays).toEqual([
      expect.objectContaining({ targetUserId: 'joiner', type: 'webrtc.offer' }),
    ]);
    const prematureCandidate = dispatch(
      dispatcher,
      creator,
      request('webrtc.iceCandidate', 'candidate-before-offer-queued', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        candidate: null,
      }),
    );
    expect(
      p2pAckEnvelopeSchema.parse(prematureCandidate.response).payload,
    ).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(prematureCandidate.effects.relays).toEqual([]);
    const offerConfirmation = offer.effects.confirmations[0];
    expect(offerConfirmation?.type).toBe('offer.confirmQueued');
    if (offerConfirmation?.type !== 'offer.confirmQueued') {
      throw new Error('expected offer relay confirmation');
    }
    registry.confirmOfferRelay(offerConfirmation.input);

    const queuedRestart = dispatch(
      dispatcher,
      joiner,
      request('webrtc.restartRequested', 'restart-during-negotiation', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
      }),
    );
    expect(queuedRestart.effects.relays[0]).toMatchObject({
      targetUserId: 'creator',
      type: 'webrtc.restartRequested',
    });

    const conflictingAnswer = dispatch(
      dispatcher,
      joiner,
      request('webrtc.answer', 'ready-joiner', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        description: { type: 'answer', sdp: 'v=0\r\n' },
      }),
    );
    expect(
      p2pAckEnvelopeSchema.parse(conflictingAnswer.response).payload,
    ).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(conflictingAnswer.effects.relays).toEqual([]);

    const answer = dispatch(
      dispatcher,
      joiner,
      request('webrtc.answer', 'answer-1', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        description: { type: 'answer', sdp: 'v=0\r\n' },
      }),
    );
    expect(answer.effects.relays[0]).toMatchObject({
      targetUserId: 'creator',
      type: 'webrtc.answer',
    });
    const answerConfirmation = answer.effects.confirmations[0];
    expect(answerConfirmation?.type).toBe('answer.confirmQueued');
    if (answerConfirmation?.type !== 'answer.confirmQueued') {
      throw new Error('expected answer relay confirmation');
    }
    registry.confirmAnswerRelay(answerConfirmation.input);

    const applied = dispatch(
      dispatcher,
      creator,
      request('webrtc.answerApplied', 'answer-applied-1', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
      }),
    );
    expect(p2pAckEnvelopeSchema.parse(applied.response).payload).toMatchObject({
      ok: true,
    });
    expect(applied.effects.relays).toEqual([]);
    expect(
      registry.getCurrentConnectionSnapshot({
        roomId,
        userId: 'creator',
        connectionId: creator.connectionId,
        connectionEpoch: creator.binding!.connectionEpoch,
      }).activeNegotiation,
    ).toMatchObject({ status: 'completed' });

    const candidate = dispatch(
      dispatcher,
      creator,
      request('webrtc.iceCandidate', 'candidate-after-answer', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        candidate: null,
      }),
    );
    expect(candidate.effects.relays[0]).toMatchObject({
      targetUserId: 'joiner',
      type: 'webrtc.iceCandidate',
      payload: { candidate: null },
    });

    const restartRequested = dispatch(
      dispatcher,
      joiner,
      request('webrtc.restartRequested', 'restart-requested-1', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
      }),
    );
    expect(restartRequested.effects.relays[0]).toMatchObject({
      targetUserId: 'creator',
      type: 'webrtc.restartRequested',
    });

    const restarted = dispatch(
      dispatcher,
      creator,
      request('webrtc.iceRestart', 'ice-restart-1', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-2',
        description: { type: 'offer', sdp: 'v=0\r\n' },
      }),
    );
    expect(restarted.effects.relays[0]).toMatchObject({
      targetUserId: 'joiner',
      type: 'webrtc.iceRestart',
    });

    const stale = dispatch(
      dispatcher,
      joiner,
      request('webrtc.iceCandidate', 'stale-candidate', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-1',
        candidate: null,
      }),
    );
    expect(p2pAckEnvelopeSchema.parse(stale.response).payload).toMatchObject({
      ok: false,
      error: { code: 'STALE_NEGOTIATION' },
    });

    const refresh = dispatch(
      dispatcher,
      creator,
      request('webrtc.iceServers.refresh', 'refresh-1', {
        roomId,
        connectionEpoch: creator.binding!.connectionEpoch,
        negotiationId: 'negotiation-2',
      }),
    );
    expect(p2pAckEnvelopeSchema.parse(refresh.response).payload).toMatchObject({
      ok: true,
      data: { rtcConfiguration: { iceTransportPolicy: 'all' } },
    });

    const recoveryReset = dispatch(
      dispatcher,
      joiner,
      request('webrtc.recoveryReset', 'recovery-reset-1', {
        roomId,
        connectionEpoch: joiner.binding!.connectionEpoch,
        negotiationId: 'negotiation-2',
      }),
    );
    expect(
      p2pAckEnvelopeSchema.parse(recoveryReset.response).payload,
    ).toMatchObject({
      ok: true,
      data: {
        negotiationId: expect.any(String),
        resetGeneration: 1,
        reason: 'signaling_reset',
      },
    });
    expect(recoveryReset.effects.intents).toEqual([
      expect.objectContaining({
        type: 'webrtc.negotiationReset',
        roomId,
        generation: 1,
        reason: 'signaling_reset',
      }),
    ]);
    expect(
      registry
        .getCurrentConnectionSnapshot({
          roomId,
          userId: 'joiner',
          connectionId: joiner.connectionId,
          connectionEpoch: joiner.binding!.connectionEpoch,
        })
        .members.map(({ ready }) => ready),
    ).toEqual([false, false]);
    registry.clear();
  });

  test('acquires, renews, updates, and releases a trusted socket screen lease', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { registry, dispatcher } = createHarness();
    let creator = createContext('creator', 'Creator', 'creator-connection');
    let joiner = createContext('joiner', 'Joiner', 'joiner-connection');
    const created = dispatch(
      dispatcher,
      creator,
      request('room.create', 'create-screen-room', {}),
    );
    const createAck = roomCreateAckSchema.parse(created.response);
    if (!createAck.payload.ok || created.effects.binding == null) {
      throw new Error('expected create success');
    }
    creator = withBinding(creator, created.effects.binding);
    const joined = dispatch(
      dispatcher,
      joiner,
      request('room.join', 'join-screen-room', {
        roomCode: createAck.payload.data.roomCode,
      }),
    );
    if (joined.effects.binding == null)
      throw new Error('expected join success');
    joiner = withBinding(joiner, joined.effects.binding);
    const roomId = createAck.payload.data.roomId;

    const acquired = dispatch(
      dispatcher,
      creator,
      request('screen.acquire', 'screen-acquire', { roomId }),
    );
    const acquireAck = p2pScreenAcquireAckSchema.parse(acquired.response);
    if (!acquireAck.payload.ok) throw new Error('expected acquire success');
    expect(acquireAck.payload.data.lease).toMatchObject({
      roomId,
      holderId: 'creator',
      expiresAt: '1970-01-01T00:00:15.000Z',
    });
    expect(acquired.effects.intents).toContainEqual({
      type: 'screen.ownerChanged',
      roomId,
      ownerUserId: 'creator',
      leaseId: acquireAck.payload.data.lease.leaseId,
    });

    const busy = dispatch(
      dispatcher,
      joiner,
      request('screen.acquire', 'screen-busy', { roomId }),
    );
    expect(p2pAckEnvelopeSchema.parse(busy.response).payload).toMatchObject({
      ok: false,
      error: { code: 'SCREEN_SHARE_BUSY' },
    });

    vi.advanceTimersByTime(5_000);
    const leaseId = acquireAck.payload.data.lease.leaseId;
    const renewed = dispatch(
      dispatcher,
      creator,
      request('screen.renew', 'screen-renew', { roomId, leaseId }),
    );
    expect(
      p2pScreenRenewAckSchema.parse(renewed.response).payload,
    ).toMatchObject({
      ok: true,
      data: {
        lease: { holderId: 'creator', expiresAt: '1970-01-01T00:00:20.000Z' },
      },
    });

    const bitrate = dispatch(
      dispatcher,
      creator,
      request('screen.bitrate', 'screen-bitrate', {
        roomId,
        leaseId,
        bitrate: 8_000_000,
      }),
    );
    expect(screenBitrateAckSchema.parse(bitrate.response).payload).toEqual({
      ok: true,
      data: { bitrate: 8_000_000 },
    });
    expect(bitrate.effects.intents).toContainEqual({
      type: 'screen.bitrateChanged',
      roomId,
      ownerUserId: 'creator',
      leaseId,
      bitrateBps: 8_000_000,
    });

    const released = dispatch(
      dispatcher,
      creator,
      request('screen.release', 'screen-release', { roomId, leaseId }),
    );
    expect(p2pScreenReleaseAckSchema.parse(released.response).payload).toEqual({
      ok: true,
      data: {},
    });

    registry.clear();
  });
});
