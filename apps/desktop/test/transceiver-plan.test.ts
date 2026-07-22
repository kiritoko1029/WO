import { describe, expect, it, vi } from 'vitest';

import {
  configureJoinerTransceiverPlan,
  createCreatorTransceiverPlan,
  reorderPreferredCodecs,
} from '../src/renderer/src/media/transceiver-plan.js';

const codec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({
  mimeType,
  clockRate: 90_000,
  sdpFmtpLine,
});

function transceiver(
  kind: 'audio' | 'video',
  mid: string | null,
  withPreferences = true,
) {
  return {
    mid,
    direction: 'recvonly' as RTCRtpTransceiverDirection,
    receiver: { track: { kind } },
    sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
    setCodecPreferences: withPreferences ? vi.fn() : undefined,
  };
}

describe('fixed transceiver plan', () => {
  it('creates mic audio, desktop audio, and screen video transceivers for the creator', () => {
    const audio = transceiver('audio', '0');
    const screenAudio = transceiver('audio', '1');
    const screen = transceiver('video', '2');
    const pc = {
      addTransceiver: vi
        .fn()
        .mockReturnValueOnce(audio)
        .mockReturnValueOnce(screenAudio)
        .mockReturnValueOnce(screen),
    };

    const result = createCreatorTransceiverPlan(
      pc as unknown as RTCPeerConnection,
      {
        audio: [codec('audio/PCMU'), codec('audio/opus')],
        video: [
          codec('video/VP8'),
          codec('video/H264', 'packetization-mode=1;profile-level-id=42e01f'),
          codec('video/rtx'),
        ],
      },
    );

    expect(result).toEqual({ audio, screen, screenAudio });
    // Three addTransceiver calls: mic audio, desktop audio, screen video.
    expect(pc.addTransceiver).toHaveBeenCalledTimes(3);
    expect(pc.addTransceiver.mock.calls[0]).toEqual([
      'audio',
      { direction: 'sendrecv' },
    ]);
    expect(pc.addTransceiver.mock.calls[1]).toEqual([
      'audio',
      { direction: 'sendrecv' },
    ]);
    expect(pc.addTransceiver.mock.calls[2]?.[0]).toBe('video');
    expect(audio.setCodecPreferences).toHaveBeenCalledWith([
      expect.objectContaining({ mimeType: 'audio/opus' }),
      expect.objectContaining({ mimeType: 'audio/PCMU' }),
    ]);
    expect(screenAudio.setCodecPreferences).toHaveBeenCalled();
    expect(screen.setCodecPreferences).toHaveBeenCalledWith([
      expect.objectContaining({ mimeType: 'video/H264' }),
      expect.objectContaining({ mimeType: 'video/VP8' }),
      expect.objectContaining({ mimeType: 'video/rtx' }),
    ]);
  });

  it('reorders a preferred codec without dropping fallback, RTX, or FEC entries', () => {
    const codecs = [
      codec('audio/PCMU'),
      codec('audio/red'),
      codec('audio/opus'),
      codec('audio/CN'),
    ];

    expect(reorderPreferredCodecs(codecs, 'audio/opus')).toEqual([
      codecs[2],
      codecs[0],
      codecs[1],
      codecs[3],
    ]);
    expect(reorderPreferredCodecs(codecs, 'audio/missing')).toBeNull();
  });

  it('maps joiner transceivers (3 m-lines) without creating duplicates', async () => {
    const audio = transceiver('audio', '0');
    const screenAudio = transceiver('audio', '1');
    const screen = transceiver('video', '2');
    const microphone = { kind: 'audio' } as MediaStreamTrack;
    const pc = {
      addTransceiver: vi.fn(),
      getTransceivers: vi.fn(() => [screen, audio, screenAudio]),
    };

    const result = await configureJoinerTransceiverPlan(
      pc as unknown as RTCPeerConnection,
      microphone,
      {
        audio: [codec('audio/opus'), codec('audio/PCMU')],
        video: [codec('video/H264'), codec('video/VP8')],
      },
    );

    expect(result).toEqual({ audio, screen, screenAudio });
    expect(pc.addTransceiver).not.toHaveBeenCalled();
    expect(audio.direction).toBe('sendrecv');
    expect(screenAudio.direction).toBe('sendrecv');
    expect(screen.direction).toBe('sendrecv');
    expect(audio.sender.replaceTrack).toHaveBeenCalledWith(microphone);
  });

  it('maps the remote offer without attaching audio when the microphone is unavailable', async () => {
    const audio = transceiver('audio', '0');
    const screenAudio = transceiver('audio', '1');
    const screen = transceiver('video', '2');
    const pc = {
      getTransceivers: vi.fn(() => [audio, screenAudio, screen]),
    } as unknown as RTCPeerConnection;

    const result = await configureJoinerTransceiverPlan(
      pc,
      null,
      { audio: [], video: [] },
    );

    expect(result).toEqual({ audio, screen, screenAudio });
    expect(audio.direction).toBe('sendrecv');
    expect(screen.direction).toBe('sendrecv');
    expect(audio.sender.replaceTrack).not.toHaveBeenCalled();
  });

  it.each([
    [[transceiver('audio', '0'), transceiver('video', '1')], 'two audio and one video'],
    [[transceiver('audio', '0'), transceiver('audio', '1')], 'two audio and one video'],
    [[transceiver('audio', '0'), transceiver('audio', '1'), transceiver('audio', '2')], 'two audio and one video'],
  ])('rejects an ambiguous remote transceiver map', async (items, message) => {
    await expect(
      configureJoinerTransceiverPlan(
        {
          getTransceivers: () => items,
          addTransceiver: vi.fn(),
        } as unknown as RTCPeerConnection,
        { kind: 'audio' } as MediaStreamTrack,
        { audio: [], video: [] },
      ),
    ).rejects.toThrow(message);
  });

  it('falls back to standards negotiation when codec preferences are unsupported or absent', () => {
    const audio = transceiver('audio', '0', false);
    const screenAudio = transceiver('audio', '1', false);
    const screen = transceiver('video', '2', false);
    const pc = {
      addTransceiver: vi
        .fn()
        .mockReturnValueOnce(audio)
        .mockReturnValueOnce(screenAudio)
        .mockReturnValueOnce(screen),
    };

    expect(() =>
      createCreatorTransceiverPlan(pc as unknown as RTCPeerConnection, {
        audio: [codec('audio/PCMU')],
        video: [codec('video/VP8')],
      }),
    ).not.toThrow();
  });
});
