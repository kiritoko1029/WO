import { describe, expect, it, vi } from 'vitest';

import {
  createPeerConnectionController,
  type PeerConnectionLike,
} from '../src/renderer/src/media/peer-connection-controller.js';

const rtcConfiguration = {
  iceServers: [
    {
      urls: ['turn:turn.example.cn:3478?transport=udp'],
      username: 'user',
      credential: 'credential',
    },
  ],
  iceTransportPolicy: 'relay' as const,
};

function createTransceiver(kind: 'audio' | 'video', mid: string) {
  const localTrack = {
    kind,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    mid,
    direction: 'sendrecv' as RTCRtpTransceiverDirection,
    sender: {
      track: localTrack,
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    },
    receiver: { track: { kind } as MediaStreamTrack },
    setCodecPreferences: vi.fn(),
    localTrack,
  };
}

function createPeer() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const audio = createTransceiver('audio', '0');
  const screen = createTransceiver('video', '1');
  const pc = {
    addTransceiver: vi
      .fn()
      .mockReturnValueOnce(audio)
      .mockReturnValueOnce(screen),
    getTransceivers: vi.fn(() => [audio, screen]),
    addEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        const values = listeners.get(type) ?? new Set();
        values.add(listener);
        listeners.set(type, values);
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
      },
    ),
    setConfiguration: vi.fn(),
    restartIce: vi.fn(),
    getStats: vi.fn().mockResolvedValue(new Map()),
    close: vi.fn(),
    connectionState: 'connected',
    iceConnectionState: 'connected',
    signalingState: 'stable',
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return { pc, audio, screen, listeners };
}

describe('PeerConnection ownership', () => {
  it('owns one configured PC and installs ICE/track listeners before any remote description', async () => {
    const peer = createPeer();
    const factory = vi.fn(() => peer.pc as unknown as PeerConnectionLike);
    const onLocalCandidate = vi.fn();
    const onRemoteTrack = vi.fn();
    const onConnectionStateChange = vi.fn();

    const controller = createPeerConnectionController({
      role: 'creator',
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
      connectionEpoch: 3,
      createPeerConnection: factory,
      onLocalCandidate,
      onRemoteTrack,
      onConnectionStateChange,
      codecCapabilities: { audio: [], video: [] },
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(rtcConfiguration);
    expect(peer.pc.addEventListener.mock.calls.map(([type]) => type)).toEqual([
      'icecandidate',
      'track',
      'connectionstatechange',
      'iceconnectionstatechange',
    ]);
    expect(controller.transceivers).toEqual({
      audio: peer.audio,
      screen: peer.screen,
    });
    expect(controller.audioSender).toBe(peer.audio.sender);
    expect(controller.screenSender).toBe(peer.screen.sender);
    expect(controller.screenReceiver).toBe(peer.screen.receiver);
    peer.pc.emit('icecandidate', { candidate: null });
    expect(onLocalCandidate).toHaveBeenCalledWith(null, 0);
    const remoteAudio = { kind: 'audio' } as MediaStreamTrack;
    peer.pc.emit('track', { track: remoteAudio, streams: [] });
    expect(onRemoteTrack).toHaveBeenCalledWith(remoteAudio);
    peer.pc.emit('connectionstatechange', {});
    expect(onConnectionStateChange).toHaveBeenCalledWith({
      connectionState: 'connected',
      iceConnectionState: 'connected',
      signalingState: 'stable',
    });
    expect(controller.connectionState).toBe('connected');
    expect(controller.iceConnectionState).toBe('connected');
    expect(controller.signalingState).toBe('stable');
    controller.restartIce();
    expect(peer.pc.restartIce).toHaveBeenCalledOnce();
    await expect(controller.getStats()).resolves.toEqual(new Map());
  });

  it('does not create joiner transceivers before applying the remote offer', async () => {
    const peer = createPeer();
    peer.pc.addTransceiver.mockReset();
    const controller = createPeerConnectionController({
      role: 'joiner',
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
      connectionEpoch: 4,
      createPeerConnection: () => peer.pc as unknown as PeerConnectionLike,
      onLocalCandidate: vi.fn(),
      onRemoteTrack: vi.fn(),
      codecCapabilities: { audio: [], video: [] },
    });

    expect(peer.pc.addTransceiver).not.toHaveBeenCalled();
    await controller.configureJoinerTransceivers({
      kind: 'audio',
    } as MediaStreamTrack);
    expect(peer.pc.addTransceiver).not.toHaveBeenCalled();
    expect(controller.transceivers).toEqual({
      audio: peer.audio,
      screen: peer.screen,
    });
  });

  it('tracks media and signaling generations independently across WSS resume', () => {
    const peer = createPeer();
    const controller = createPeerConnectionController({
      role: 'creator',
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
      connectionEpoch: 8,
      createPeerConnection: () => peer.pc as unknown as PeerConnectionLike,
      onLocalCandidate: vi.fn(),
      onRemoteTrack: vi.fn(),
      codecCapabilities: { audio: [], video: [] },
    });

    controller.beginNegotiation('negotiation-1');
    expect(controller.currentNegotiationId).toBe('negotiation-1');
    expect(controller.acceptRemoteConnectionEpoch(5)).toBe(true);
    expect(controller.acceptRemoteConnectionEpoch(4)).toBe(false);
    expect(controller.lastAcceptedRemoteConnectionEpoch).toBe(5);
    const mediaGeneration = controller.mediaGeneration;
    const signalingGeneration = controller.signalingGeneration;
    controller.updateLocalConnectionEpoch(9);
    expect(controller.connectionEpoch).toBe(9);
    expect(controller.mediaGeneration).toBe(mediaGeneration);
    expect(controller.signalingGeneration).toBe(signalingGeneration + 1);
    expect(controller.isCurrentGeneration(mediaGeneration)).toBe(true);
    expect(
      controller.isCurrentSignalContext(
        mediaGeneration,
        signalingGeneration,
        8,
      ),
    ).toBe(false);
  });

  it('keeps media on WSS close and disposes only transport ownership on leave', async () => {
    const peer = createPeer();
    const controller = createPeerConnectionController({
      role: 'creator',
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
      connectionEpoch: 2,
      createPeerConnection: () => peer.pc as unknown as PeerConnectionLike,
      onLocalCandidate: vi.fn(),
      onRemoteTrack: vi.fn(),
      codecCapabilities: { audio: [], video: [] },
    });

    const mediaGeneration = controller.mediaGeneration;
    const signalingGeneration = controller.signalingGeneration;
    controller.handleSignalingClose();
    expect(peer.pc.close).not.toHaveBeenCalled();
    expect(controller.mediaGeneration).toBe(mediaGeneration);
    expect(controller.signalingGeneration).toBe(signalingGeneration + 1);
    expect(
      controller.isCurrentSignalContext(
        mediaGeneration,
        signalingGeneration,
        controller.connectionEpoch,
      ),
    ).toBe(false);
    const first = controller.cleanup();
    const second = controller.cleanup();
    expect(second).toBe(first);
    await first;

    expect(peer.audio.sender.replaceTrack).not.toHaveBeenCalled();
    expect(peer.screen.sender.replaceTrack).not.toHaveBeenCalled();
    expect(peer.audio.localTrack.stop).not.toHaveBeenCalled();
    expect(peer.screen.localTrack.stop).not.toHaveBeenCalled();
    expect(peer.pc.close).toHaveBeenCalledOnce();
    expect(peer.listeners.get('icecandidate')?.size ?? 0).toBe(0);
    expect(peer.listeners.get('track')?.size ?? 0).toBe(0);
    expect(peer.listeners.get('connectionstatechange')?.size ?? 0).toBe(0);
    expect(peer.listeners.get('iceconnectionstatechange')?.size ?? 0).toBe(0);
  });

  it('supports a transport-only rebuild without stopping voice-owned tracks', async () => {
    const peer = createPeer();
    const controller = createPeerConnectionController({
      role: 'creator',
      rtcConfiguration,
      iceCredentialsExpiresAt: '2026-07-16T15:30:00.000Z',
      connectionEpoch: 2,
      createPeerConnection: () => peer.pc as unknown as PeerConnectionLike,
      onLocalCandidate: vi.fn(),
      onRemoteTrack: vi.fn(),
      codecCapabilities: { audio: [], video: [] },
    });

    await expect(
      controller.disposeTransport({ stopOwnedTracks: false }),
    ).resolves.toBeUndefined();

    expect(peer.audio.sender.replaceTrack).not.toHaveBeenCalled();
    expect(peer.screen.sender.replaceTrack).not.toHaveBeenCalled();
    expect(peer.audio.localTrack.stop).not.toHaveBeenCalled();
    expect(peer.screen.localTrack.stop).not.toHaveBeenCalled();
    expect(peer.pc.close).toHaveBeenCalledOnce();
  });
});
