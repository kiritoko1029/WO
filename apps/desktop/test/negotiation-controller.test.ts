import { PROTOCOL_VERSION } from '@wo/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createNegotiationController,
  type NegotiationSignaling,
} from '../src/renderer/src/media/negotiation-controller.js';
import {
  createPeerConnectionController,
  type PeerConnectionLike,
} from '../src/renderer/src/media/peer-connection-controller.js';

const rtcConfiguration = {
  iceServers: [
    {
      urls: ['turn:old.example.cn:3478?transport=udp'],
      username: 'old-user',
      credential: 'old-credential',
    },
  ],
  iceTransportPolicy: 'relay' as const,
};

const freshIce = {
  rtcConfiguration: {
    iceServers: [
      {
        urls: ['turn:fresh.example.cn:3478?transport=udp'],
        username: 'fresh-user',
        credential: 'fresh-credential',
      },
    ],
    iceTransportPolicy: 'relay' as const,
  },
  iceCredentialsExpiresAt: '2026-07-16T16:10:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transceiver(kind: 'audio' | 'video', mid: string) {
  return {
    mid,
    direction: 'recvonly' as RTCRtpTransceiverDirection,
    sender: {
      track: null,
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    },
    receiver: { track: { kind } as MediaStreamTrack },
    setCodecPreferences: vi.fn(),
  };
}

function createPc(log: string[]) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const audio = transceiver('audio', '0');
  const screenAudio = transceiver('audio', '1');
  const video = transceiver('video', '2');
  const pc = {
    connectionState: 'connected' as RTCPeerConnectionState,
    remoteDescription: null as RTCSessionDescription | null,
    addTransceiver: vi
      .fn()
      .mockReturnValueOnce(audio)
      .mockReturnValueOnce(screenAudio)
      .mockReturnValueOnce(video),
    getTransceivers: vi.fn(() => [video, audio, screenAudio]),
    addEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        const values = listeners.get(type) ?? new Set();
        values.add(listener);
        listeners.set(type, values);
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) =>
        listeners.get(type)?.delete(listener),
    ),
    createOffer: vi.fn(async () => {
      log.push('createOffer');
      return { type: 'offer' as const, sdp: 'v=0\r\na=sendrecv' };
    }),
    createAnswer: vi.fn(async () => {
      log.push('createAnswer');
      return {
        type: 'answer' as const,
        sdp:
          'v=0\r\nm=audio\r\na=sendrecv\r\n' +
          'm=audio\r\na=sendrecv\r\nm=video\r\na=sendrecv',
      };
    }),
    setLocalDescription: vi.fn(async () => {
      log.push('setLocalDescription');
    }),
    setRemoteDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        log.push(`setRemoteDescription:${description.type}`);
        pc.remoteDescription = description as RTCSessionDescription;
      },
    ),
    addIceCandidate: vi.fn(async (candidate: RTCIceCandidateInit | null) => {
      log.push(`addIceCandidate:${candidate?.candidate ?? 'end'}`);
    }),
    setConfiguration: vi.fn(() => log.push('setConfiguration')),
    restartIce: vi.fn(() => log.push('restartIce')),
    close: vi.fn(),
  };
  return { pc, audio, screenAudio, video, listeners };
}

function ack(type: string, data: unknown = {}) {
  return {
    version: PROTOCOL_VERSION,
    requestId: 'ack-request',
    type: `${type}.ack`,
    payload: { ok: true, data },
  };
}

function createSignaling(
  implementation?: (
    type: string,
    payload: unknown,
    options?: unknown,
  ) => unknown,
): NegotiationSignaling & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async (type, payload, _schema, options) => {
      return implementation?.(type, payload, options) ?? ack(type);
    }),
    requestEnvelope: vi.fn(
      async (envelope) =>
        implementation?.(envelope.type, envelope.payload, envelope) ??
        ack(envelope.type),
    ),
  } as unknown as NegotiationSignaling & {
    request: ReturnType<typeof vi.fn>;
    requestEnvelope: ReturnType<typeof vi.fn>;
  };
}

function setup(
  role: 'creator' | 'joiner',
  options: {
    readonly signaling?: NegotiationSignaling;
    readonly now?: number;
    readonly expiresAt?: string;
  } = {},
) {
  const log: string[] = [];
  const fake = createPc(log);
  const localCandidateRef: {
    current?: (
      candidate: RTCIceCandidateInit | null,
      generation: number,
    ) => void;
  } = {};
  const peer = createPeerConnectionController({
    role,
    rtcConfiguration,
    iceCredentialsExpiresAt: options.expiresAt ?? '2026-07-16T16:10:00.000Z',
    connectionEpoch: role === 'creator' ? 10 : 20,
    createPeerConnection: () => fake.pc as unknown as PeerConnectionLike,
    onLocalCandidate: (candidate, generation) =>
      localCandidateRef.current?.(candidate, generation),
    onRemoteTrack: vi.fn(),
    codecCapabilities: { audio: [], video: [] },
  });
  const signaling = options.signaling ?? createSignaling();
  const negotiation = createNegotiationController({
    peer,
    signaling,
    roomId: 'room-1',
    microphone: () => ({ kind: 'audio' }) as MediaStreamTrack,
    now: () => options.now ?? Date.parse('2026-07-16T16:00:00.000Z'),
    makeNegotiationId: () => 'negotiation-1',
    makeRequestId: () => 'answer-applied-request',
  });
  localCandidateRef.current = negotiation.handleLocalCandidate;
  return { ...fake, peer, signaling, negotiation, log };
}

describe('creator-only fixed-plan negotiation', () => {
  it('refreshes near-expiry ICE before offering and flushes local candidates only after offer ACK', async () => {
    const offerAck = deferred<unknown>();
    const signaling = createSignaling((type) => {
      if (type === 'webrtc.iceServers.refresh') return ack(type, freshIce);
      if (type === 'webrtc.offer') return offerAck.promise;
      return ack(type);
    });
    const subject = setup('creator', {
      signaling,
      expiresAt: '2026-07-16T16:01:59.000Z',
    });

    const offering = subject.negotiation.startCreatorOffer();
    await vi.waitFor(() =>
      expect(subject.pc.setLocalDescription).toHaveBeenCalledOnce(),
    );
    subject.negotiation.handleLocalCandidate(
      { candidate: 'candidate-1', sdpMid: '0' },
      subject.peer.mediaGeneration,
    );
    subject.negotiation.handleLocalCandidate(
      null,
      subject.peer.mediaGeneration,
    );
    expect(
      (signaling.request as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([type]) => type === 'webrtc.iceCandidate',
      ),
    ).toHaveLength(0);
    offerAck.resolve(ack('webrtc.offer'));
    await offering;

    expect(subject.log.slice(0, 3)).toEqual([
      'setConfiguration',
      'createOffer',
      'setLocalDescription',
    ]);
    expect(
      (signaling.request as ReturnType<typeof vi.fn>).mock.calls.map(
        ([type]) => type,
      ),
    ).toEqual([
      'webrtc.iceServers.refresh',
      'webrtc.offer',
      'webrtc.iceCandidate',
      'webrtc.iceCandidate',
    ]);
  });

  it('never uses a create-ack TURN credential that is 599 seconds old for the first offer', async () => {
    const signaling = createSignaling((type) =>
      type === 'webrtc.iceServers.refresh' ? ack(type, freshIce) : ack(type),
    );
    const subject = setup('creator', {
      signaling,
      now: Date.parse('2026-07-16T16:09:59.000Z'),
      expiresAt: '2026-07-16T16:10:00.000Z',
    });

    await subject.negotiation.startCreatorOffer();

    expect(subject.log.indexOf('setConfiguration')).toBeLessThan(
      subject.log.indexOf('createOffer'),
    );
    expect(signaling.request).toHaveBeenCalledWith(
      'webrtc.iceServers.refresh',
      expect.objectContaining({ connectionEpoch: 10 }),
      expect.anything(),
      undefined,
    );
  });

  it('lets the joiner map remote transceivers, attach mic and answer only after SRD', async () => {
    const subject = setup('joiner');

    await subject.negotiation.handleOffer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
      },
    });

    expect(subject.pc.addTransceiver).not.toHaveBeenCalled();
    expect(subject.log).toEqual([
      'setRemoteDescription:offer',
      'createAnswer',
      'setLocalDescription',
    ]);
    expect(subject.audio.sender.replaceTrack).toHaveBeenCalledBefore(
      subject.pc.createAnswer,
    );
    expect(subject.signaling.request).toHaveBeenCalledWith(
      'webrtc.answer',
      expect.objectContaining({
        connectionEpoch: 20,
        description: expect.objectContaining({
          type: 'answer',
          sdp: expect.stringMatching(
            /m=audio[\s\S]*sendrecv[\s\S]*m=video[\s\S]*sendrecv/u,
          ),
        }),
      }),
      expect.anything(),
      undefined,
    );
  });

  it('buffers and serializes remote candidates by negotiation and remote epoch until SRD', async () => {
    const subject = setup('joiner');
    const first = deferred<void>();
    subject.pc.addIceCandidate
      .mockImplementationOnce(async (candidate) => {
        subject.log.push(`addIceCandidate:${candidate?.candidate ?? 'end'}`);
        return first.promise;
      })
      .mockImplementation(async (candidate) => {
        subject.log.push(`applied:${candidate?.candidate ?? 'end'}`);
      });

    await subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      candidate: { candidate: 'candidate-1', sdpMid: '0' },
    });
    await subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'other-negotiation',
      connectionEpoch: 10,
      candidate: { candidate: 'wrong-negotiation', sdpMid: '0' },
    });
    const answering = subject.negotiation.handleOffer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
      },
    });
    await vi.waitFor(() =>
      expect(subject.pc.addIceCandidate).toHaveBeenCalledTimes(1),
    );
    subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      candidate: null,
    });
    expect(subject.pc.addIceCandidate).toHaveBeenCalledTimes(1);
    first.resolve();
    await answering;

    expect(subject.pc.addIceCandidate.mock.calls).toEqual([
      [{ candidate: 'candidate-1', sdpMid: '0' }],
      [null],
    ]);
    expect(subject.log.indexOf('setRemoteDescription:offer')).toBeLessThan(
      subject.log.indexOf('addIceCandidate:candidate-1'),
    );
  });

  it('sends answerApplied with one immutable envelope and retries the same request ID on timeout', async () => {
    const timeout = Object.assign(new Error('timeout'), {
      code: 'SIGNALING_TIMEOUT',
    });
    const signaling = createSignaling();
    const requestEnvelope = signaling.requestEnvelope as ReturnType<
      typeof vi.fn
    >;
    requestEnvelope
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(ack('webrtc.answerApplied'));
    const subject = setup('creator', { signaling });
    subject.peer.beginNegotiation('negotiation-1');

    await subject.negotiation.handleAnswer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 20,
      description: { type: 'answer', sdp: 'v=0\r\na=sendrecv' },
    });

    expect(requestEnvelope).toHaveBeenCalledTimes(2);
    expect(requestEnvelope.mock.calls[0]![0]).toEqual(
      requestEnvelope.mock.calls[1]![0],
    );
    expect(requestEnvelope.mock.calls[0]![0]).toEqual({
      version: PROTOCOL_VERSION,
      requestId: 'answer-applied-request',
      type: 'webrtc.answerApplied',
      payload: {
        roomId: 'room-1',
        negotiationId: 'negotiation-1',
        connectionEpoch: 10,
      },
    });
  });

  it('never sends answerApplied from a stale media generation or connection epoch', async () => {
    const subject = setup('creator');
    const remoteApplied = deferred<void>();
    subject.pc.setRemoteDescription.mockImplementationOnce(
      async () => remoteApplied.promise,
    );
    subject.peer.beginNegotiation('negotiation-1');
    const answering = subject.negotiation.handleAnswer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 20,
      description: { type: 'answer', sdp: 'v=0\r\na=sendrecv' },
    });
    subject.peer.updateLocalConnectionEpoch(11);
    remoteApplied.resolve();
    await answering;

    expect(subject.signaling.requestEnvelope).not.toHaveBeenCalled();
  });

  it('prevents joiners and track changes from creating offers or transceivers', async () => {
    const subject = setup('joiner');
    await expect(subject.negotiation.startCreatorOffer()).rejects.toThrow(
      'creator',
    );
    await subject.audio.sender.replaceTrack({
      kind: 'audio',
    } as MediaStreamTrack);
    expect(subject.pc.createOffer).not.toHaveBeenCalled();
    expect(subject.pc.addTransceiver).not.toHaveBeenCalled();
  });

  it('coalesces concurrent creator-ready signals into exactly one offer', async () => {
    const offerAck = deferred<unknown>();
    const signaling = createSignaling((type) =>
      type === 'webrtc.offer' ? offerAck.promise : ack(type),
    );
    const subject = setup('creator', { signaling });

    const first = subject.negotiation.startCreatorOffer();
    const second = subject.negotiation.startCreatorOffer();
    await vi.waitFor(() =>
      expect(subject.pc.createOffer).toHaveBeenCalledOnce(),
    );
    offerAck.resolve(ack('webrtc.offer'));
    await Promise.all([first, second]);
    await subject.negotiation.startCreatorOffer();

    expect(subject.pc.createOffer).toHaveBeenCalledOnce();
  });

  it('uses the server reset negotiation ID for the replacement creator offer', async () => {
    const subject = setup('creator');

    await subject.negotiation.startCreatorOffer('server-reset-id');

    expect(subject.peer.currentNegotiationId).toBe('server-reset-id');
    expect(subject.signaling.request).toHaveBeenCalledWith(
      'webrtc.offer',
      expect.objectContaining({ negotiationId: 'server-reset-id' }),
      expect.anything(),
      expect.objectContaining({ retryTimeouts: 1 }),
    );
  });

  it('forces fresh ICE credentials before a creator restart offer', async () => {
    const signaling = createSignaling((type) =>
      type === 'webrtc.iceServers.refresh' ? ack(type, freshIce) : ack(type),
    );
    const subject = setup('creator', { signaling });
    subject.peer.beginNegotiation('completed-negotiation');

    await subject.negotiation.refreshIceServers();
    await subject.negotiation.restartCreatorIce('restart-negotiation');

    expect(subject.pc.setConfiguration).toHaveBeenCalledWith(
      freshIce.rtcConfiguration,
    );
    expect(subject.pc.restartIce).toHaveBeenCalledOnce();
    expect(subject.signaling.request).toHaveBeenCalledWith(
      'webrtc.iceRestart',
      expect.objectContaining({ negotiationId: 'restart-negotiation' }),
      expect.anything(),
      expect.objectContaining({ retryTimeouts: 1 }),
    );
    expect(subject.log.indexOf('setConfiguration')).toBeLessThan(
      subject.log.indexOf('restartIce'),
    );
  });

  it('sends one idempotent restart request from a joiner context', async () => {
    const subject = setup('joiner');
    subject.peer.beginNegotiation('completed-negotiation');

    await subject.negotiation.requestCreatorRestart('restart-request-id');

    expect(subject.signaling.request).toHaveBeenCalledWith(
      'webrtc.restartRequested',
      {
        roomId: 'room-1',
        negotiationId: 'completed-negotiation',
        connectionEpoch: 20,
      },
      expect.anything(),
      { requestId: 'restart-request-id', retryTimeouts: 1 },
    );
  });

  it('requests one authoritative transport reset for the current negotiation', async () => {
    const signaling = createSignaling((type) =>
      type === 'webrtc.recoveryReset'
        ? ack(type, {
            negotiationId: 'server-recovery-reset',
            resetGeneration: 3,
            reason: 'signaling_reset',
          })
        : ack(type),
    );
    const subject = setup('joiner', { signaling });
    subject.peer.beginNegotiation('failed-negotiation');

    await expect(
      subject.negotiation.requestRecoveryReset('recovery-request-id'),
    ).resolves.toEqual({
      negotiationId: 'server-recovery-reset',
      resetGeneration: 3,
      reason: 'signaling_reset',
    });
    expect(subject.signaling.request).toHaveBeenCalledWith(
      'webrtc.recoveryReset',
      {
        roomId: 'room-1',
        negotiationId: 'failed-negotiation',
        connectionEpoch: 20,
      },
      expect.anything(),
      { requestId: 'recovery-request-id', retryTimeouts: 1 },
    );
  });

  it('allows an explicitly rejected readiness offer to be retried safely', async () => {
    const signaling = createSignaling((type) => {
      if (type === 'webrtc.offer') {
        const offerCalls = (
          signaling.request as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([requestType]) => requestType === 'webrtc.offer',
        ).length;
        if (offerCalls === 1) {
          throw Object.assign(new Error('not ready'), {
            code: 'INVALID_STATE',
          });
        }
      }
      return ack(type);
    });
    const subject = setup('creator', { signaling });

    await expect(subject.negotiation.startCreatorOffer()).rejects.toMatchObject(
      {
        code: 'INVALID_STATE',
      },
    );
    await expect(
      subject.negotiation.startCreatorOffer(),
    ).resolves.toBeUndefined();

    expect(subject.pc.createOffer).toHaveBeenCalledTimes(2);
  });

  it('never relabels a late ICE candidate from an old ufrag as the new negotiation', async () => {
    const subject = setup('creator');
    subject.pc.createOffer
      .mockResolvedValueOnce({
        type: 'offer',
        sdp: 'v=0\r\na=ice-ufrag:old-ufrag\r\na=sendrecv',
      })
      .mockResolvedValueOnce({
        type: 'offer',
        sdp: 'v=0\r\na=ice-ufrag:new-ufrag\r\na=sendrecv',
      });
    await subject.negotiation.startCreatorOffer();
    subject.peer.handleSignalingClose();
    await subject.negotiation.startCreatorOffer();
    const request = subject.signaling.request as ReturnType<typeof vi.fn>;
    request.mockClear();

    subject.negotiation.handleLocalCandidate(
      { candidate: 'candidate-old', usernameFragment: 'old-ufrag' },
      subject.peer.mediaGeneration,
    );
    subject.negotiation.handleLocalCandidate(
      { candidate: 'candidate-new', usernameFragment: 'new-ufrag' },
      subject.peer.mediaGeneration,
    );
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([type]) => type === 'webrtc.iceCandidate'),
      ).toHaveLength(1),
    );

    expect(request.mock.calls[0]![1]).toMatchObject({
      candidate: { candidate: 'candidate-new' },
    });
  });

  it('drops a late remote candidate after a newer remote description becomes active', async () => {
    const subject = setup('joiner');
    await subject.negotiation.handleOffer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
      },
    });
    await subject.negotiation.handleOffer({
      roomId: 'room-1',
      negotiationId: 'negotiation-2',
      connectionEpoch: 10,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
      },
    });
    subject.pc.addIceCandidate.mockClear();

    await subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      candidate: { candidate: 'late-old', sdpMid: '0' },
    });
    await subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-2',
      connectionEpoch: 10,
      candidate: { candidate: 'current-new', sdpMid: '0' },
    });

    expect(subject.pc.addIceCandidate.mock.calls).toEqual([
      [{ candidate: 'current-new', sdpMid: '0' }],
    ]);
  });

  it('clears bounded candidate state on reset and ignores all work after dispose', async () => {
    const subject = setup('creator');
    await subject.negotiation.startCreatorOffer();
    subject.negotiation.reset();
    await subject.negotiation.startCreatorOffer();
    expect(subject.pc.createOffer).toHaveBeenCalledTimes(2);

    subject.negotiation.dispose();
    await subject.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-3',
      connectionEpoch: 20,
      candidate: { candidate: 'ignored', sdpMid: '0' },
    });
    await subject.negotiation.handleAnswer({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 20,
      description: { type: 'answer', sdp: 'v=0\r\na=sendrecv' },
    });
    expect(subject.pc.addIceCandidate).not.toHaveBeenCalled();
    expect(subject.pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('handles duplicate offer and answer broadcasts idempotently', async () => {
    const joiner = setup('joiner');
    const offer = {
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      description: {
        type: 'offer' as const,
        sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
      },
    };
    const firstOffer = joiner.negotiation.handleOffer(offer);
    const secondOffer = joiner.negotiation.handleOffer(offer);
    await Promise.all([firstOffer, secondOffer]);
    expect(joiner.pc.createAnswer).toHaveBeenCalledOnce();

    const creator = setup('creator');
    creator.peer.beginNegotiation('negotiation-1');
    const answer = {
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 20,
      description: { type: 'answer' as const, sdp: 'v=0\r\na=sendrecv' },
    };
    const firstAnswer = creator.negotiation.handleAnswer(answer);
    const secondAnswer = creator.negotiation.handleAnswer(answer);
    await Promise.all([firstAnswer, secondAnswer]);
    expect(creator.signaling.requestEnvelope).toHaveBeenCalledOnce();
  });

  it('isolates ready-listener errors and uses a fixed retryable request for each local candidate', async () => {
    const subject = setup('creator');
    subject.negotiation.subscribeNegotiationReady(() => {
      throw new Error('listener failed');
    });
    subject.peer.beginNegotiation('negotiation-1');

    await expect(
      subject.negotiation.handleAnswer({
        roomId: 'room-1',
        negotiationId: 'negotiation-1',
        connectionEpoch: 20,
        description: { type: 'answer', sdp: 'v=0\r\na=sendrecv' },
      }),
    ).resolves.toBeUndefined();

    const creator = setup('creator');
    const offering = creator.negotiation.startCreatorOffer();
    await vi.waitFor(() =>
      expect(creator.pc.setLocalDescription).toHaveBeenCalledOnce(),
    );
    creator.negotiation.handleLocalCandidate(
      { candidate: 'candidate-fixed', sdpMid: '0' },
      creator.peer.mediaGeneration,
    );
    await offering;
    const requestMock = creator.signaling.request as ReturnType<typeof vi.fn>;
    await vi.waitFor(() =>
      expect(
        requestMock.mock.calls.some(([type]) => type === 'webrtc.iceCandidate'),
      ).toBe(true),
    );
    expect(creator.signaling.request).toHaveBeenCalledWith(
      'webrtc.iceCandidate',
      expect.objectContaining({
        candidate: expect.objectContaining({ candidate: 'candidate-fixed' }),
      }),
      expect.anything(),
      { requestId: expect.any(String), retryTimeouts: 1 },
    );
  });

  it('bounds candidate context queues and does not poison a later negotiation after addIceCandidate failure', async () => {
    const subject = setup('joiner');
    for (let index = 0; index < 8; index += 1) {
      await subject.negotiation.handleRemoteCandidate({
        roomId: 'room-1',
        negotiationId: `queued-${index}`,
        connectionEpoch: 10,
        candidate: { candidate: `candidate-${index}`, sdpMid: '0' },
      });
    }
    await expect(
      subject.negotiation.handleRemoteCandidate({
        roomId: 'room-1',
        negotiationId: 'queued-overflow',
        connectionEpoch: 10,
        candidate: { candidate: 'candidate-overflow', sdpMid: '0' },
      }),
    ).rejects.toThrow('candidate context limit');

    const recovering = setup('joiner');
    recovering.pc.addIceCandidate.mockRejectedValueOnce(new Error('bad ICE'));
    await recovering.negotiation.handleRemoteCandidate({
      roomId: 'room-1',
      negotiationId: 'negotiation-1',
      connectionEpoch: 10,
      candidate: { candidate: 'bad-candidate', sdpMid: '0' },
    });
    await expect(
      recovering.negotiation.handleOffer({
        roomId: 'room-1',
        negotiationId: 'negotiation-1',
        connectionEpoch: 10,
        description: {
          type: 'offer',
          sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
        },
      }),
    ).rejects.toThrow('bad ICE');
    await expect(
      recovering.negotiation.handleOffer({
        roomId: 'room-1',
        negotiationId: 'negotiation-2',
        connectionEpoch: 11,
        description: {
          type: 'offer',
          sdp: 'v=0\r\nm=audio\r\nm=audio\r\nm=video',
        },
      }),
    ).resolves.toBeUndefined();
    expect(recovering.pc.createAnswer).toHaveBeenCalledOnce();
  });
});
