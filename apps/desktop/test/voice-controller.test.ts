import { describe, expect, it, vi } from 'vitest';

import { createAudioOutput } from '../src/renderer/src/media/audio-output.js';
import { createVoiceController } from '../src/renderer/src/media/voice-controller.js';

function track(kind: 'audio' | 'video' = 'audio') {
  return {
    kind,
    enabled: true,
    stop: vi.fn(),
    id: `${kind}-${Math.random()}`,
  } as unknown as MediaStreamTrack;
}

function stream(tracks: MediaStreamTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
  } as unknown as MediaStream;
}

function sender() {
  return {
    track: null,
    replaceTrack: vi.fn().mockResolvedValue(undefined),
  } as unknown as RTCRtpSender & { replaceTrack: ReturnType<typeof vi.fn> };
}

function audioElement(sink = true) {
  const element = {
    autoplay: false,
    playsInline: false,
    muted: false,
    srcObject: null as MediaStream | null,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    remove: vi.fn(),
    ...(sink ? { setSinkId: vi.fn().mockResolvedValue(undefined) } : {}),
  };
  return element;
}

function output(element = audioElement()) {
  return createAudioOutput({
    createElement: () => element,
    createMediaStream: (tracks) => stream([...tracks]),
    onPlaybackError: vi.fn(),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const defaultConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

describe('voice capture and playback', () => {
  it('requests the exact voice capture intent and attaches one microphone', async () => {
    const microphone = track();
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const mediaDevices = {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
    } as unknown as MediaDevices;
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices,
      audioOutput: output(),
    });

    await expect(voice.start(audioSender)).resolves.toBe(microphone);

    expect(getUserMedia).toHaveBeenCalledWith(defaultConstraints);
    expect(audioSender.replaceTrack).toHaveBeenCalledWith(microphone);
    expect(voice.microphoneTrack).toBe(microphone);
  });

  it('surfaces permission denial and stops every track in an invalid capture stream', async () => {
    const deniedDevices = {
      getUserMedia: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
        ),
      enumerateDevices: vi.fn(),
    } as unknown as MediaDevices;
    const denied = createVoiceController({
      mediaDevices: deniedDevices,
      audioOutput: output(),
    });
    await expect(denied.start(sender())).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });

    const first = track();
    const second = track();
    const invalidDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream([first, second])),
      enumerateDevices: vi.fn(),
    } as unknown as MediaDevices;
    const invalid = createVoiceController({
      mediaDevices: invalidDevices,
      audioOutput: output(),
    });
    await expect(invalid.start(sender())).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('mutes locally and hot-swaps the microphone without renegotiation', async () => {
    const oldTrack = track();
    const newTrack = track();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream([oldTrack]))
      .mockResolvedValueOnce(stream([newTrack]));
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);
    voice.setMuted(true);

    await voice.switchMicrophone('device-2');

    expect(newTrack.enabled).toBe(false);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { ...defaultConstraints.audio, deviceId: { exact: 'device-2' } },
      video: false,
    });
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(newTrack);
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(voice.muted).toBe(true);
  });

  it('keeps the old microphone when replaceTrack fails and stops the new one', async () => {
    const oldTrack = track();
    const newTrack = track();
    const audioSender = sender();
    audioSender.replaceTrack
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('replace failed'));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([oldTrack]))
          .mockResolvedValueOnce(stream([newTrack])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);

    await expect(voice.switchMicrophone('device-2')).rejects.toThrow(
      'replace failed',
    );

    expect(voice.microphoneTrack).toBe(oldTrack);
    expect(oldTrack.stop).not.toHaveBeenCalled();
    expect(newTrack.stop).toHaveBeenCalledOnce();
  });

  it('uses one owned audio element for remote playback, mute and supported sink selection', async () => {
    const element = audioElement();
    const createElement = vi.fn(() => element);
    const playback = createAudioOutput({
      createElement,
      createMediaStream: (tracks) => stream([...tracks]),
      onPlaybackError: vi.fn(),
    });
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: playback,
    });
    const remote = track();

    await voice.attachRemoteTrack(remote);
    voice.setOutputMuted(true);
    await expect(voice.selectOutput('speaker-2')).resolves.toBe(true);

    expect(createElement).toHaveBeenCalledOnce();
    expect(element.srcObject?.getAudioTracks()).toEqual([remote]);
    expect(element.autoplay).toBe(true);
    expect(element.playsInline).toBe(true);
    expect(element.play).toHaveBeenCalledOnce();
    expect(element.muted).toBe(true);
    expect(element.setSinkId).toHaveBeenCalledWith('speaker-2');
  });

  it('degrades output selection without interrupting playback when setSinkId is unavailable', async () => {
    const element = audioElement(false);
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(element),
    });
    await voice.attachRemoteTrack(track());

    await expect(voice.selectOutput('speaker-2')).resolves.toBe(false);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it('keeps playback healthy when the operating system rejects a sink selection', async () => {
    const element = audioElement();
    element.setSinkId!.mockRejectedValue(new Error('speaker disappeared'));
    const onPlaybackError = vi.fn();
    const onSinkSelectionError = vi.fn();
    const playback = createAudioOutput({
      createElement: () => element,
      createMediaStream: (tracks) => stream([...tracks]),
      onPlaybackError,
      onSinkSelectionError,
    });
    const remote = track();
    await playback.attach(remote);
    const attachedStream = element.srcObject;

    await expect(playback.selectSink('speaker-2')).resolves.toBe(false);

    expect(onSinkSelectionError).toHaveBeenCalledOnce();
    expect(onPlaybackError).not.toHaveBeenCalled();
    expect(element.srcObject).toBe(attachedStream);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it('lists input/output devices and cleans sender, tracks and audio exactly once', async () => {
    const microphone = track();
    const audioSender = sender();
    const element = audioElement();
    const mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream([microphone])),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'USB Mic' },
        { kind: 'audiooutput', deviceId: 'speaker-1', label: 'Display' },
        { kind: 'videoinput', deviceId: 'camera-1', label: 'Camera' },
      ]),
    } as unknown as MediaDevices;
    const voice = createVoiceController({
      mediaDevices,
      audioOutput: output(element),
    });
    await voice.start(audioSender);

    await expect(voice.listDevices()).resolves.toEqual({
      inputs: [{ deviceId: 'mic-1', label: 'USB Mic' }],
      outputs: [{ deviceId: 'speaker-1', label: 'Display' }],
    });
    const first = voice.cleanup();
    const second = voice.cleanup();
    expect(second).toBe(first);
    await first;

    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.srcObject).toBeNull();
    expect(element.remove).toHaveBeenCalledOnce();
  });

  it('does not attach a capture or sender after cleanup wins an async race', async () => {
    const captured = deferred<MediaStream>();
    const microphone = track();
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn(() => captured.promise),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });

    const starting = voice.start(audioSender);
    await voice.cleanup();
    captured.resolve(stream([microphone]));

    await expect(starting).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(audioSender.replaceTrack).not.toHaveBeenCalledWith(microphone);
    expect(voice.microphoneTrack).toBeNull();

    const secondTrack = track();
    const replace = deferred<void>();
    const racingSender = sender();
    racingSender.replaceTrack.mockReturnValueOnce(replace.promise);
    const racing = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream([secondTrack])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    const replacing = racing.start(racingSender);
    await vi.waitFor(() =>
      expect(racingSender.replaceTrack).toHaveBeenCalledWith(secondTrack),
    );
    const racingCleanup = racing.cleanup();
    replace.resolve();
    await racingCleanup;
    await expect(replacing).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(racing.microphoneTrack).toBeNull();
  });

  it('makes the final requested microphone win concurrent switch completions', async () => {
    const initial = track();
    const first = track();
    const second = track();
    const firstCapture = deferred<MediaStream>();
    const secondCapture = deferred<MediaStream>();
    const audioSender = sender();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream([initial]))
      .mockReturnValueOnce(firstCapture.promise)
      .mockReturnValueOnce(secondCapture.promise);
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);

    const switchFirst = voice.switchMicrophone('mic-1');
    const switchSecond = voice.switchMicrophone('mic-2');
    secondCapture.resolve(stream([second]));
    await expect(switchSecond).resolves.toBe(second);
    firstCapture.resolve(stream([first]));
    await expect(switchFirst).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });

    expect(voice.microphoneTrack).toBe(second);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(second);
  });

  it('refuses remote playback after the owned audio output is cleaned', async () => {
    const element = audioElement();
    const playback = output(element);
    await playback.cleanup();

    await expect(playback.attach(track())).rejects.toThrow('cleaned');
    expect(element.play).not.toHaveBeenCalled();
  });

  it('rejects a duplicate successful start without capturing or leaking another stream', async () => {
    const microphone = track();
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(sender());

    await expect(voice.start(sender())).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(microphone.stop).not.toHaveBeenCalled();
  });
});
