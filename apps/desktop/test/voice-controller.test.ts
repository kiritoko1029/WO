// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createAudioOutput } from '../src/renderer/src/media/audio-output.js';
import { resetSharedRnnoiseCacheForTests } from '../src/renderer/src/media/noise-suppressor.js';
import {
  createVoiceController as createVoiceControllerImpl,
  clampMicrophoneVolume,
  readMicrophoneVolume,
  writeMicrophoneVolume,
} from '../src/renderer/src/media/voice-controller.js';

/**
 * Force RNNoise + Web Audio to fall back so tests keep using the raw mock
 * getUserMedia track identity (replaceTrack assertions).
 */
function createVoiceController(
  options: Parameters<typeof createVoiceControllerImpl>[0],
) {
  return createVoiceControllerImpl({
    createAudioContext: () => {
      throw new Error('AudioContext unavailable in unit tests');
    },
    loadRnnoise: async () => {
      throw new Error('RNNoise unavailable in unit tests');
    },
    // Default intensity `light` would re-capture for native NS after RNNoise
    // fails; pin to `off` so tests exercise a single getUserMedia call unless
    // they override initialNoiseIntensity.
    initialNoiseIntensity: 'off',
    ...options,
  });
}

function track(kind: 'audio' | 'video' = 'audio') {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
    id: `${kind}-${Math.random()}`,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function eventfulAudioTrack() {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let readyState: MediaStreamTrackState = 'live';
  return {
    kind: 'audio',
    enabled: true,
    get readyState() {
      return readyState;
    },
    stop: vi.fn(() => {
      readyState = 'ended';
    }),
    addEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (type === 'ended' && listener !== null) listeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (type === 'ended' && listener !== null) listeners.delete(listener);
      },
    ),
    emitEnded() {
      readyState = 'ended';
      const event = new Event('ended');
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
  } as unknown as MediaStreamTrack & { emitEnded(): void };
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
    volume: 1,
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

// Test helper pins intensity to `off` → native noiseSuppression stays false.
const defaultConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48_000,
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

  it('detaches an unexpectedly ended microphone and allows capture retry', async () => {
    const microphone = eventfulAudioTrack();
    const replacement = eventfulAudioTrack();
    const audioSender = sender();
    const onMicrophoneEnded = vi.fn();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([microphone]))
          .mockResolvedValueOnce(stream([replacement])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
      onMicrophoneEnded,
    });
    await voice.start(audioSender);

    microphone.emitEnded();

    expect(onMicrophoneEnded).toHaveBeenCalledOnce();
    expect(onMicrophoneEnded).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MICROPHONE_CAPTURE_ENDED' }),
    );
    expect(voice.microphoneTrack).toBeNull();
    await vi.waitFor(() =>
      expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(null),
    );

    await expect(voice.start(audioSender)).resolves.toBe(replacement);
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(replacement);
    expect(voice.microphoneTrack).toBe(replacement);
  });

  it('does not report intentional microphone replacement or cleanup as an ended capture', async () => {
    const first = eventfulAudioTrack();
    const second = eventfulAudioTrack();
    const onMicrophoneEnded = vi.fn();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([first]))
          .mockResolvedValueOnce(stream([second])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
      onMicrophoneEnded,
    });
    await voice.start(sender());

    await voice.switchMicrophone('device-2');
    first.emitEnded();
    await voice.cleanup();
    second.emitEnded();

    expect(onMicrophoneEnded).not.toHaveBeenCalled();
  });

  it('does not detach a replacement committed while the old microphone ends', async () => {
    const first = eventfulAudioTrack();
    const second = eventfulAudioTrack();
    const replacement = deferred<void>();
    const audioSender = sender();
    audioSender.replaceTrack
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(replacement.promise);
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([first]))
          .mockResolvedValueOnce(stream([second])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
      onMicrophoneEnded: vi.fn(),
    });
    await voice.start(audioSender);
    const switching = voice.switchMicrophone('device-2');
    await vi.waitFor(() =>
      expect(audioSender.replaceTrack).toHaveBeenCalledWith(second),
    );

    first.emitEnded();
    replacement.resolve();
    await switching;
    await Promise.resolve();

    expect(voice.microphoneTrack).toBe(second);
    expect(audioSender.replaceTrack).toHaveBeenCalledTimes(2);
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(second);
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

    voice.setMuted(false);
    expect(newTrack.enabled).toBe(true);
    expect(voice.muted).toBe(false);
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

    voice.setOutputMuted(false);
    expect(element.muted).toBe(false);
    expect(voice.outputMuted).toBe(false);
  });

  it('normalizes remote volume before updating playback and controller state', () => {
    const element = audioElement();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(element),
    });

    for (const [input, expected] of [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
      [-1, 0],
      [2, 1],
      [Number.NaN, 1],
      [Number.NEGATIVE_INFINITY, 1],
      [Number.POSITIVE_INFINITY, 1],
    ] as const) {
      voice.setRemoteVolume(input);
      expect(voice.remoteVolume).toBe(expected);
      expect(element.volume).toBe(expected);
    }
  });

  it('mixes microphone and desktop-audio remote tracks instead of replacing', async () => {
    // Two audio transceivers (mic + screen system audio) each fire ontrack.
    // Replacing the first with the second silenced voice whenever desktop
    // audio was negotiated — even when that second track was silent.
    const element = audioElement();
    const playback = createAudioOutput({
      createElement: () => element,
      createMediaStream: (tracks) => stream([...tracks]),
    });
    const mic = track();
    const desktop = track();
    Object.defineProperty(mic, 'id', { value: 'remote-mic' });
    Object.defineProperty(desktop, 'id', { value: 'remote-desktop' });
    Object.defineProperty(mic, 'readyState', { value: 'live' });
    Object.defineProperty(desktop, 'readyState', { value: 'live' });
    // Mock addEventListener used by multi-track attach.
    (
      mic as unknown as { addEventListener: ReturnType<typeof vi.fn> }
    ).addEventListener = vi.fn();
    (
      desktop as unknown as { addEventListener: ReturnType<typeof vi.fn> }
    ).addEventListener = vi.fn();
    (
      mic as unknown as { removeEventListener: ReturnType<typeof vi.fn> }
    ).removeEventListener = vi.fn();
    (
      desktop as unknown as { removeEventListener: ReturnType<typeof vi.fn> }
    ).removeEventListener = vi.fn();

    await playback.attach(mic);
    await playback.attach(desktop);

    const attached = element.srcObject?.getAudioTracks() ?? [];
    expect(attached).toEqual(expect.arrayContaining([mic, desktop]));
    expect(attached).toHaveLength(2);
    expect(element.play).toHaveBeenCalledTimes(2);
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

  it('keeps the applied noise intensity when an intensity recapture is denied', async () => {
    const initial = track();
    const audioSender = sender();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream([initial]))
      .mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
      );
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);

    await expect(voice.setNoiseIntensity('medium')).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });

    expect(voice.noiseIntensity).toBe('off');
    expect(voice.microphoneTrack).toBe(initial);
    expect(initial.stop).not.toHaveBeenCalled();
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(initial);
  });

  it('keeps the applied noise intensity when sender replacement fails', async () => {
    const initial = track();
    const replacement = track();
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([initial]))
          .mockResolvedValueOnce(stream([replacement])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);
    audioSender.replaceTrack.mockRejectedValueOnce(new Error('replace failed'));

    await expect(voice.setNoiseIntensity('medium')).rejects.toThrow(
      'replace failed',
    );

    expect(voice.noiseIntensity).toBe('off');
    expect(voice.microphoneTrack).toBe(initial);
    expect(initial.stop).not.toHaveBeenCalled();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });

  it('commits a rebuilt noise intensity only after sender replacement succeeds', async () => {
    const initial = track();
    const replacement = track();
    const replace = deferred<void>();
    const audioSender = sender();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream([initial]))
      .mockResolvedValueOnce(stream([replacement]));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);
    audioSender.replaceTrack.mockReturnValueOnce(replace.promise);

    const changing = voice.setNoiseIntensity('medium');
    await vi.waitFor(() =>
      expect(audioSender.replaceTrack).toHaveBeenCalledWith(replacement),
    );
    expect(voice.noiseIntensity).toBe('off');
    replace.resolve();
    await expect(changing).resolves.toBeUndefined();

    expect(voice.noiseIntensity).toBe('medium');
    expect(voice.microphoneTrack).toBe(replacement);
    expect(initial.stop).toHaveBeenCalledOnce();
  });

  it('keeps the latest intensity when concurrent rebuilds finish out of order', async () => {
    const initial = track();
    const stale = track();
    const latest = track();
    const staleCapture = deferred<MediaStream>();
    const latestCapture = deferred<MediaStream>();
    const audioSender = sender();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream([initial]))
      .mockReturnValueOnce(staleCapture.promise)
      .mockReturnValueOnce(latestCapture.promise);
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);

    const staleChange = voice.setNoiseIntensity('medium');
    const latestChange = voice.setNoiseIntensity('aggressive');
    latestCapture.resolve(stream([latest]));
    await expect(latestChange).resolves.toBeUndefined();
    staleCapture.resolve(stream([stale]));
    await expect(staleChange).rejects.toMatchObject({
      code: 'MICROPHONE_CAPTURE_INVALID',
    });

    expect(voice.noiseIntensity).toBe('aggressive');
    expect(voice.microphoneTrack).toBe(latest);
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(latest);
  });

  it('does not rebuild capture when the selected noise intensity is unchanged', async () => {
    const microphone = track();
    const audioSender = sender();
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);

    await expect(voice.setNoiseIntensity('off')).resolves.toBeUndefined();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(audioSender.replaceTrack).toHaveBeenCalledOnce();
    expect(voice.microphoneTrack).toBe(microphone);
  });

  it('releases capture when the initial outbound pipeline build throws', async () => {
    const microphone = track();
    Object.defineProperty(microphone, 'enabled', {
      configurable: true,
      get: () => true,
      set: () => {
        throw new Error('outbound state failed');
      },
    });
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream([microphone])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });

    await expect(voice.start(sender())).rejects.toThrow(
      'outbound state failed',
    );

    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(voice.microphoneTrack).toBeNull();
  });

  it('releases capture when the native fallback pipeline rebuild throws', async () => {
    const microphone = track();
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    let enabledWrites = 0;
    Object.defineProperties(microphone, {
      applyConstraints: { configurable: true, value: applyConstraints },
      enabled: {
        configurable: true,
        get: () => true,
        set: () => {
          enabledWrites += 1;
          if (enabledWrites === 2) {
            throw new Error('fallback outbound state failed');
          }
        },
      },
    });
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream([microphone])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
      initialNoiseIntensity: 'medium',
    });

    await expect(voice.start(sender())).rejects.toThrow(
      'fallback outbound state failed',
    );

    expect(applyConstraints).toHaveBeenCalledWith({ noiseSuppression: true });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(voice.microphoneTrack).toBeNull();
  });

  it('updates a live RNNoise pipeline intensity without recapture or sender replacement', async () => {
    resetSharedRnnoiseCacheForTests();
    const microphone = track();
    const outbound = track();
    const sourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const processorNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    };
    const gainNode = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const destinationNode = {
      stream: {
        getAudioTracks: () => [outbound],
      },
    };
    const context = {
      state: 'running',
      createMediaStreamSource: vi.fn(() => sourceNode),
      createScriptProcessor: vi.fn(() => processorNode),
      createGain: vi.fn(() => gainNode),
      createMediaStreamDestination: vi.fn(() => destinationNode),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;
    class FakeMediaStream {
      constructor(private readonly tracks: readonly MediaStreamTrack[]) {}

      getAudioTracks(): readonly MediaStreamTrack[] {
        return this.tracks.filter((item) => item.kind === 'audio');
      }
    }
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
      initialNoiseIntensity: 'medium',
      createAudioContext: () => context,
      loadRnnoise: async () => ({
        frameSize: 4,
        createDenoiseState: () => ({
          processFrame: () => 0.5,
          destroy: vi.fn(),
        }),
      }),
    });

    try {
      await voice.start(audioSender);
      expect(voice.rnnoiseActive).toBe(true);
      expect(voice.microphoneTrack).toBe(outbound);

      const mediumOutput = new Float32Array(4);
      processorNode.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array([1, 1, 1, 1]),
        },
        outputBuffer: {
          getChannelData: () => mediumOutput,
        },
      } as unknown as AudioProcessingEvent);
      for (const sample of mediumOutput) {
        expect(sample).toBeCloseTo(0.55);
      }

      await voice.setNoiseIntensity('aggressive');

      const aggressiveOutput = new Float32Array(4);
      processorNode.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array([1, 1, 1, 1]),
        },
        outputBuffer: {
          getChannelData: () => aggressiveOutput,
        },
      } as unknown as AudioProcessingEvent);
      for (const sample of aggressiveOutput) {
        expect(sample).toBeCloseTo(0.15);
      }
      expect(voice.noiseIntensity).toBe('aggressive');
      expect(voice.microphoneTrack).toBe(outbound);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(audioSender.replaceTrack).toHaveBeenCalledOnce();
      expect(context.createScriptProcessor).toHaveBeenCalledOnce();
    } finally {
      await voice.cleanup();
      vi.unstubAllGlobals();
      resetSharedRnnoiseCacheForTests();
    }
  });

  it('reattaches the current microphone when a joiner sender was attached earlier', async () => {
    const initial = track();
    const replacement = track();
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([initial]))
          .mockResolvedValueOnce(stream([replacement])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start();
    await audioSender.replaceTrack(initial);

    await voice.switchMicrophone('mic-2');
    await voice.bindSender(audioSender, true);

    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(replacement);
    expect(initial.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(voice.microphoneTrack).toBe(replacement);
  });

  it('serializes a joiner sender bind behind an in-flight microphone switch', async () => {
    const initial = track();
    const replacement = track();
    const replace = deferred<void>();
    const audioSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([initial]))
          .mockResolvedValueOnce(stream([replacement])),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(audioSender);
    audioSender.replaceTrack.mockReturnValueOnce(replace.promise);

    const switching = voice.switchMicrophone('mic-2');
    await vi.waitFor(() =>
      expect(audioSender.replaceTrack).toHaveBeenCalledWith(replacement),
    );
    const binding = voice.bindSender(audioSender, true);
    replace.resolve();

    await expect(switching).resolves.toBe(replacement);
    await expect(binding).resolves.toBeUndefined();
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(replacement);
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(voice.microphoneTrack).toBe(replacement);
  });

  it('stops an uncommitted capture after a successful sender rebind', async () => {
    const initial = track();
    const stale = track();
    const newestCapture = deferred<MediaStream>();
    const forwardReplace = deferred<void>();
    const firstSender = sender();
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream([initial]))
          .mockResolvedValueOnce(stream([stale]))
          .mockReturnValueOnce(newestCapture.promise),
        enumerateDevices: vi.fn(),
      } as unknown as MediaDevices,
      audioOutput: output(),
    });
    await voice.start(firstSender);
    firstSender.replaceTrack
      .mockReturnValueOnce(forwardReplace.promise)
      .mockRejectedValueOnce(new Error('rollback failed'));

    const staleSwitch = voice.switchMicrophone('mic-stale');
    await vi.waitFor(() =>
      expect(firstSender.replaceTrack).toHaveBeenCalledWith(stale),
    );
    const newestSwitch = voice.switchMicrophone('mic-newest');
    forwardReplace.resolve();
    await expect(staleSwitch).rejects.toThrow('rollback failed');
    expect(stale.stop).not.toHaveBeenCalled();

    const nextSender = sender();
    await voice.bindSender(nextSender, true);
    expect(nextSender.replaceTrack).toHaveBeenCalledWith(initial);
    expect(stale.stop).toHaveBeenCalledOnce();

    newestCapture.reject(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    await expect(newestSwitch).rejects.toMatchObject({
      code: 'MICROPHONE_PERMISSION_DENIED',
    });
    await voice.cleanup();
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

describe('microphone volume', () => {
  it('clamps volume into the supported range', () => {
    expect(clampMicrophoneVolume(Number.NaN)).toBe(1);
    expect(clampMicrophoneVolume(-1)).toBe(0);
    expect(clampMicrophoneVolume(0)).toBe(0);
    expect(clampMicrophoneVolume(1)).toBe(1);
    expect(clampMicrophoneVolume(2)).toBe(2);
    expect(clampMicrophoneVolume(3)).toBe(2);
    expect(clampMicrophoneVolume(0.5)).toBe(0.5);
  });

  it('persists microphone volume through localStorage', () => {
    window.localStorage.clear();
    writeMicrophoneVolume(1.5);
    expect(readMicrophoneVolume()).toBe(1.5);
    window.localStorage.clear();
    expect(readMicrophoneVolume()).toBe(1);
  });

  it('stores microphone volume without rebuilding capture when the gain pipeline is unavailable', async () => {
    const microphone = track();
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      audioOutput: output(),
      initialMicrophoneVolume: 0.8,
    });
    await voice.start(sender());
    expect(voice.microphoneVolume).toBe(0.8);
    voice.setMicrophoneVolume(1.25);
    expect(voice.microphoneVolume).toBe(1.25);
    // Without a gain pipeline the raw track is still sent.
    expect(voice.microphoneTrack).toBe(microphone);
  });

  it('falls back to native noiseSuppression via applyConstraints when RNNoise fails', async () => {
    const microphone = track();
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    Object.assign(microphone, { applyConstraints });
    const getUserMedia = vi.fn().mockResolvedValue(stream([microphone]));
    const voice = createVoiceController({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([]),
      } as unknown as MediaDevices,
      audioOutput: output(),
      initialNoiseIntensity: 'medium',
      loadRnnoise: async () => {
        throw new Error('wasm missing');
      },
    });
    await voice.start(sender());
    // Prefer a single capture; enable Chromium NS on the same track.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: expect.objectContaining({ noiseSuppression: false }),
    });
    expect(applyConstraints).toHaveBeenCalledWith({ noiseSuppression: true });
    expect(voice.rnnoiseActive).toBe(false);
    expect(voice.microphoneTrack).toBe(microphone);
  });
});
