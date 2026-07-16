export interface CodecCapabilities {
  readonly audio: readonly RTCRtpCodec[];
  readonly video: readonly RTCRtpCodec[];
}

export interface TransceiverPlan {
  readonly audio: RTCRtpTransceiver;
  readonly screen: RTCRtpTransceiver;
}

export function reorderPreferredCodecs(
  codecs: readonly RTCRtpCodec[],
  preferredMimeType: string,
): RTCRtpCodec[] | null {
  const preferredIndex = codecs.findIndex(
    (codec) => codec.mimeType.toLowerCase() === preferredMimeType.toLowerCase(),
  );
  if (preferredIndex === -1) return null;
  return [
    codecs[preferredIndex]!,
    ...codecs.slice(0, preferredIndex),
    ...codecs.slice(preferredIndex + 1),
  ];
}

function videoPreferences(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] | null {
  const packetizedH264 = codecs.findIndex(
    (codec) =>
      codec.mimeType.toLowerCase() === 'video/h264' &&
      codec.sdpFmtpLine?.toLowerCase().includes('packetization-mode=1') ===
        true,
  );
  const h264 =
    packetizedH264 === -1
      ? codecs.findIndex(
          (codec) => codec.mimeType.toLowerCase() === 'video/h264',
        )
      : packetizedH264;
  if (h264 === -1) return null;
  return [codecs[h264]!, ...codecs.slice(0, h264), ...codecs.slice(h264 + 1)];
}

function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  codecs: readonly RTCRtpCodec[],
  kind: 'audio' | 'video',
): void {
  if (typeof transceiver.setCodecPreferences !== 'function') return;
  const ordered =
    kind === 'audio'
      ? reorderPreferredCodecs(codecs, 'audio/opus')
      : videoPreferences(codecs);
  if (ordered !== null) transceiver.setCodecPreferences(ordered);
}

function browserCapabilities(): CodecCapabilities {
  if (typeof RTCRtpReceiver === 'undefined') return { audio: [], video: [] };
  return {
    audio: RTCRtpReceiver.getCapabilities('audio')?.codecs ?? [],
    video: RTCRtpReceiver.getCapabilities('video')?.codecs ?? [],
  };
}

export function createCreatorTransceiverPlan(
  pc: RTCPeerConnection,
  capabilities: CodecCapabilities = browserCapabilities(),
): TransceiverPlan {
  const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const screenEncoding = {
    rid: 'f',
    active: true,
    maxBitrate: 8_000_000,
    scalabilityMode: 'L1T1',
    scaleResolutionDownBy: 1,
  } as RTCRtpEncodingParameters;
  const screen = pc.addTransceiver('video', {
    direction: 'sendrecv',
    sendEncodings: [screenEncoding],
  });
  applyCodecPreferences(audio, capabilities.audio, 'audio');
  applyCodecPreferences(screen, capabilities.video, 'video');
  return Object.freeze({ audio, screen });
}

export async function configureJoinerTransceiverPlan(
  pc: RTCPeerConnection,
  microphone: MediaStreamTrack,
  capabilities: CodecCapabilities = browserCapabilities(),
): Promise<TransceiverPlan> {
  if (microphone.kind !== 'audio') {
    throw new TypeError('Microphone track must be audio');
  }
  const transceivers = pc.getTransceivers();
  const audioItems = transceivers.filter(
    (item) => item.receiver.track.kind === 'audio',
  );
  const videoItems = transceivers.filter(
    (item) => item.receiver.track.kind === 'video',
  );
  if (
    transceivers.length !== 2 ||
    audioItems.length !== 1 ||
    videoItems.length !== 1
  ) {
    throw new Error(
      'Remote offer must contain exactly one audio and one video',
    );
  }
  const audio = audioItems[0]!;
  const screen = videoItems[0]!;
  if (audio.mid === null || screen.mid === null) {
    throw new Error('Remote transceivers require a non-null MID');
  }
  if (audio.mid === screen.mid) {
    throw new Error('Remote transceivers require a unique MID');
  }
  audio.direction = 'sendrecv';
  screen.direction = 'sendrecv';
  await audio.sender.replaceTrack(microphone);
  applyCodecPreferences(audio, capabilities.audio, 'audio');
  applyCodecPreferences(screen, capabilities.video, 'video');
  return Object.freeze({ audio, screen });
}
