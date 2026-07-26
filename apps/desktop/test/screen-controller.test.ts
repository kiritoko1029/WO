import {
  p2pScreenAcquireAckSchema,
  p2pScreenLeaseSchema,
  p2pScreenReleaseAckSchema,
  p2pScreenRenewAckSchema,
  type P2pScreenLease,
} from '@wo/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DISPLAY_CAPTURE_CONSTRAINTS,
  SYSTEM_AUDIO_DISPLAY_CAPTURE_CONSTRAINTS,
  createScreenController,
} from '../src/renderer/src/media/screen-controller.js';
import type { SystemAudioMode } from '../src/preload/types.js';

class FakeTrack {
  readonly stop = vi.fn();
  readyState: MediaStreamTrackState = 'live';
  readonly getSettings = vi.fn(() => ({
    width: 1_920,
    height: 1_080,
    frameRate: 60,
  }));
  private readonly ended = new Set<() => void>();

  constructor(readonly kind: 'audio' | 'video' = 'video') {}

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.ended.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.ended.delete(listener);
  }

  end(): void {
    this.readyState = 'ended';
    for (const listener of [...this.ended]) listener();
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function streamWith(track: FakeTrack, audioTrack?: FakeTrack) {
  const tracks = audioTrack === undefined ? [track] : [track, audioTrack];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [track],
    getAudioTracks: () => (audioTrack === undefined ? [] : [audioTrack]),
  } as unknown as MediaStream;
}

function lease(expiresAtMs: number): P2pScreenLease {
  return p2pScreenLeaseSchema.parse({
    roomId: 'room-1',
    leaseId: 'lease-1',
    holderId: 'user-1',
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

function ack(
  type: 'screen.acquire' | 'screen.renew' | 'screen.release',
  requestId: string,
  data: unknown,
) {
  const value = {
    version: 1,
    requestId,
    type: `${type}.ack`,
    payload: { ok: true, data },
  };
  if (type === 'screen.acquire') return p2pScreenAcquireAckSchema.parse(value);
  if (type === 'screen.renew') return p2pScreenRenewAckSchema.parse(value);
  return p2pScreenReleaseAckSchema.parse(value);
}

function failedReleaseAck(requestId: string) {
  return p2pScreenReleaseAckSchema.parse({
    version: 1,
    requestId,
    type: 'screen.release.ack',
    payload: {
      ok: false,
      error: {
        code: 'LEASE_LOST',
        message: 'Lease is no longer current',
        retryable: false,
      },
    },
  });
}

function createHarness(
  options: {
    readonly acquire?: Promise<P2pScreenLease>;
    readonly releaseFails?: boolean;
    readonly capture?: Promise<MediaStream>;
    readonly systemAudioMode?: SystemAudioMode;
    readonly replaceTrack?: (track: MediaStreamTrack | null) => Promise<void>;
    readonly renew?: (
      call: number,
      requestOptions: { readonly timeoutMs?: number },
    ) => Promise<P2pScreenLease>;
  } = {},
) {
  let request = 0;
  let renewCall = 0;
  const order: string[] = [];
  const track = new FakeTrack();
  const capture = options.capture ?? Promise.resolve(streamWith(track));
  const mediaDevices = {
    getDisplayMedia: vi.fn(() => {
      order.push('getDisplayMedia');
      return capture;
    }),
  };
  const sender = {
    replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
      order.push(next === null ? 'replaceTrack:null' : 'replaceTrack:track');
      await options.replaceTrack?.(next);
    }),
  };
  const audioSender = {
    replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
      order.push(
        next === null ? 'replaceAudioTrack:null' : 'replaceAudioTrack:track',
      );
    }),
  };
  const desktop = {
    list: vi.fn(async () => {
      order.push('list');
      return [
        {
          token: '00000000-0000-4000-8000-000000000001',
          name: 'Editor',
          kind: 'window' as const,
          thumbnailDataUrl: 'data:image/png;base64,AAAA',
        },
      ];
    }),
    select: vi.fn(async () => {
      order.push('select');
    }),
  };
  const signaling = {
    request: vi.fn(
      async (
        type: 'screen.acquire' | 'screen.renew' | 'screen.release',
        _payload: unknown,
        _schema: unknown,
        requestOptions: {
          readonly requestId?: string;
          readonly timeoutMs?: number;
        },
      ) => {
        const requestId = requestOptions.requestId!;
        order.push(type);
        if (type === 'screen.acquire') {
          return ack(type, requestId, {
            lease: options.acquire
              ? await options.acquire
              : lease(Date.now() + 15_000),
          });
        }
        if (type === 'screen.renew') {
          renewCall += 1;
          const renewed = options.renew
            ? await options.renew(renewCall, requestOptions)
            : lease(Date.now() + 15_000);
          return ack(type, requestId, { lease: renewed });
        }
        return options.releaseFails
          ? failedReleaseAck(requestId)
          : ack(type, requestId, {});
      },
    ),
  };
  const controller = createScreenController({
    roomId: 'room-1',
    userId: 'user-1',
    sender: sender as unknown as RTCRtpSender,
    audioSender: audioSender as unknown as RTCRtpSender,
    signaling: signaling as never,
    capture: desktop,
    getSystemAudioMode: () => options.systemAudioMode ?? 'loopback',
    mediaDevices: mediaDevices as unknown as MediaDevices,
    makeRequestId: () => `screen-request-${++request}`,
    now: () => Date.now(),
  });
  return {
    controller,
    audioSender,
    desktop,
    mediaDevices,
    order,
    sender,
    signaling,
    track,
    getRenewCalls: () => renewCall,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => vi.useRealTimers());

describe('single screen controller', () => {
  test('releases an acquire ACK that arrives after explicit stop without leaving error state', async () => {
    const acquire = deferred<P2pScreenLease>();
    const harness = createHarness({ acquire: acquire.promise });

    const preparing = harness.controller.prepare();
    await vi.waitFor(() =>
      expect(harness.signaling.request).toHaveBeenCalledWith(
        'screen.acquire',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ),
    );
    await harness.controller.stop();
    acquire.resolve(lease(Date.now() + 15_000));

    await expect(preparing).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await vi.waitFor(() =>
      expect(
        harness.signaling.request.mock.calls.filter(
          ([type]) => type === 'screen.release',
        ),
      ).toHaveLength(1),
    );
    expect(
      harness.signaling.request.mock.calls.find(
        ([type]) => type === 'screen.release',
      )?.[1],
    ).toEqual({ roomId: 'room-1', leaseId: 'lease-1' });
    expect(harness.controller.getSnapshot().state).toBe('idle');
  });

  test('keeps explicit stop idle when an in-flight cadence renewal settles later', async () => {
    const cadenceRenew = deferred<P2pScreenLease>();
    const harness = createHarness({
      renew: (call) =>
        call === 1
          ? Promise.resolve(lease(Date.now() + 15_000))
          : cadenceRenew.promise,
    });
    await harness.controller.prepare();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(harness.getRenewCalls()).toBe(2));

    await harness.controller.stop();
    cadenceRenew.resolve(lease(Date.now() + 15_000));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.controller.getSnapshot().state).toBe('idle');
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('keeps local cleanup complete but reports a failed release acknowledgement', async () => {
    const harness = createHarness({ releaseFails: true });
    await harness.controller.prepare();

    await harness.controller.stop();

    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'idle',
      error: '屏幕已在本机停止，服务端将在租约到期后释放',
    });
    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
  });

  test('does not attach a track ended while final renewal is in flight', async () => {
    const finalRenew = deferred<P2pScreenLease>();
    const harness = createHarness({
      renew: (call) =>
        call === 1
          ? Promise.resolve(lease(Date.now() + 15_000))
          : finalRenew.promise,
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    const started = harness.controller.startSelectedCapture();
    await vi.waitFor(() => expect(harness.getRenewCalls()).toBe(2));
    harness.track.end();
    finalRenew.resolve(lease(Date.now() + 15_000));

    await expect(started).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(harness.sender.replaceTrack).not.toHaveBeenCalledWith(harness.track);
    expect(harness.controller.getSnapshot().state).toBe('idle');
  });

  test('detaches a track ended while replaceTrack is in flight', async () => {
    const attach = deferred<void>();
    const harness = createHarness({
      replaceTrack: (track) =>
        track === null ? Promise.resolve() : attach.promise,
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    const started = harness.controller.startSelectedCapture();
    await vi.waitFor(() =>
      expect(harness.sender.replaceTrack).toHaveBeenCalledWith(harness.track),
    );
    harness.track.end();
    attach.resolve();

    await expect(started).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await vi.waitFor(() =>
      expect(harness.sender.replaceTrack.mock.calls.at(-1)).toEqual([null]),
    );
    expect(harness.controller.getSnapshot().state).toBe('idle');
  });

  test('uses two explicit phases and attaches only after a fresh final renewal', async () => {
    const harness = createHarness();

    await harness.controller.prepare();
    expect(harness.order).toEqual(['screen.acquire', 'screen.renew', 'list']);
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'picking',
      selectedToken: null,
      sources: [expect.objectContaining({ name: 'Editor' })],
    });

    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(harness.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    expect(harness.order.at(-1)).toBe('select');

    const started = harness.controller.startSelectedCapture();
    expect(harness.mediaDevices.getDisplayMedia).toHaveBeenCalledWith(
      DISPLAY_CAPTURE_CONSTRAINTS,
    );
    await started;

    expect(harness.order.slice(-3)).toEqual([
      'getDisplayMedia',
      'screen.renew',
      'replaceTrack:track',
    ]);
    expect(harness.getRenewCalls()).toBe(2);
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'sharing',
      captureSettings: { width: 1_920, height: 1_080, frameRate: 60 },
    });
    expect(harness.sender.replaceTrack).toHaveBeenCalledTimes(1);
  });

  test('requests unconstrained resolution with ideal 60 fps without claiming achievement', async () => {
    const harness = createHarness();
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    await harness.controller.startSelectedCapture();

    expect(DISPLAY_CAPTURE_CONSTRAINTS).toEqual({
      audio: false,
      video: {
        frameRate: { ideal: 60 },
      },
    });
    expect(harness.track.getSettings).toHaveBeenCalledOnce();
  });

  test('coalesces overlapping source refreshes into one enumeration', async () => {
    const harness = createHarness();
    await harness.controller.prepare();
    const refresh = deferred<
      Array<{
        token: string;
        name: string;
        kind: 'window';
        thumbnailDataUrl: string;
      }>
    >();
    harness.desktop.list.mockImplementationOnce(() => refresh.promise);

    const first = harness.controller.refreshSources();
    const second = harness.controller.refreshSources();

    expect(first).toBe(second);
    expect(harness.desktop.list).toHaveBeenCalledTimes(2);
    refresh.resolve([
      {
        token: '00000000-0000-4000-8000-000000000001',
        name: 'Editor refreshed',
        kind: 'window',
        thumbnailDataUrl: 'data:image/png;base64,AAAA',
      },
    ]);
    await Promise.all([first, second]);
    expect(harness.controller.getSnapshot().sources).toEqual([
      expect.objectContaining({ name: 'Editor refreshed' }),
    ]);
  });

  test('does not let a stale refresh block a later picker lifecycle', async () => {
    const harness = createHarness();
    await harness.controller.prepare();
    const staleRefresh = deferred<
      Array<{
        token: string;
        name: string;
        kind: 'window';
        thumbnailDataUrl: string;
      }>
    >();
    harness.desktop.list.mockImplementationOnce(() => staleRefresh.promise);

    const stale = harness.controller.refreshSources();
    await harness.controller.stop();
    await harness.controller.prepare();
    const current = harness.controller.refreshSources();

    expect(harness.desktop.list).toHaveBeenCalledTimes(4);
    await current;
    staleRefresh.resolve([]);
    await stale;
    expect(harness.controller.getSnapshot().state).toBe('picking');
  });

  test('rejects system audio when the platform capability is unsupported', async () => {
    const harness = createHarness({ systemAudioMode: 'unsupported' });
    await harness.controller.prepare();

    expect(() => harness.controller.setSystemAudioEnabled(true)).toThrowError(
      expect.objectContaining({ code: 'SYSTEM_AUDIO_UNSUPPORTED' }),
    );
    expect(harness.controller.getSnapshot().systemAudioEnabled).toBe(false);
    expect(harness.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
  });

  test('captures system audio only after an explicit picker opt-in', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    expect(harness.controller.getSnapshot().systemAudioEnabled).toBe(false);
    harness.controller.setSystemAudioEnabled(true);
    expect(harness.controller.getSnapshot().systemAudioEnabled).toBe(true);

    await harness.controller.startSelectedCapture();

    expect(harness.mediaDevices.getDisplayMedia).toHaveBeenCalledWith(
      SYSTEM_AUDIO_DISPLAY_CAPTURE_CONSTRAINTS,
    );
    expect(harness.audioSender.replaceTrack).toHaveBeenCalledWith(audioTrack);
    expect(harness.controller.getSnapshot().state).toBe('sharing');
  });

  test.each([
    ['missing', undefined],
    ['already ended', 'ended'],
  ] as const)(
    'fails closed when opted-in system audio is %s',
    async (_label, audioState) => {
      const videoTrack = new FakeTrack();
      const audioTrack =
        audioState === undefined ? undefined : new FakeTrack('audio');
      audioTrack?.end();
      const harness = createHarness({
        capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
      });
      await harness.controller.prepare();
      await harness.controller.selectSource(
        '00000000-0000-4000-8000-000000000001',
      );
      harness.controller.setSystemAudioEnabled(true);

      await expect(
        harness.controller.startSelectedCapture(),
      ).rejects.toMatchObject({
        code: 'SYSTEM_AUDIO_UNAVAILABLE',
      });

      expect(videoTrack.stop).toHaveBeenCalledOnce();
      if (audioTrack !== undefined) {
        expect(audioTrack.stop).toHaveBeenCalledOnce();
      }
      expect(harness.sender.replaceTrack).not.toHaveBeenCalledWith(videoTrack);
      expect(harness.audioSender.replaceTrack).not.toHaveBeenCalledWith(
        audioTrack,
      );
      expect(harness.controller.getSnapshot()).toMatchObject({
        state: 'error',
        systemAudioEnabled: false,
        error: '未获取到系统音频，请关闭系统音频后重试',
      });
    },
  );

  test('routes macOS native capture directly to the system picker authority', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
      systemAudioMode: 'native-picker',
    });

    await harness.controller.prepare();

    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'picking',
      sources: [],
      selectedToken: null,
      systemAudioEnabled: false,
    });
    expect(harness.desktop.list).not.toHaveBeenCalled();
    expect(harness.desktop.select).not.toHaveBeenCalled();
    await expect(
      harness.controller.selectSource('00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();

    expect(harness.mediaDevices.getDisplayMedia).toHaveBeenCalledWith(
      SYSTEM_AUDIO_DISPLAY_CAPTURE_CONSTRAINTS,
    );
    expect(harness.desktop.list).not.toHaveBeenCalled();
    expect(harness.desktop.select).not.toHaveBeenCalled();
    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(videoTrack);
    expect(harness.audioSender.replaceTrack).toHaveBeenCalledWith(audioTrack);
    expect(harness.controller.getSnapshot().state).toBe('sharing');
  });

  test('stops system-audio sharing by detaching and stopping both tracks', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();

    await harness.controller.stop();

    expect(harness.sender.replaceTrack.mock.calls).toEqual([
      [videoTrack],
      [null],
    ]);
    expect(harness.audioSender.replaceTrack.mock.calls).toEqual([
      [audioTrack],
      [null],
    ]);
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'idle',
      systemAudioEnabled: false,
    });
  });

  test('reattaches both tracks and detaches only system audio when it ends', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();
    const rebuiltVideoSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };
    const rebuiltAudioSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };

    await harness.controller.reattachTransport(
      rebuiltVideoSender as unknown as RTCRtpSender,
      rebuiltAudioSender as unknown as RTCRtpSender,
    );

    expect(rebuiltVideoSender.replaceTrack).toHaveBeenCalledWith(videoTrack);
    expect(rebuiltAudioSender.replaceTrack).toHaveBeenCalledWith(audioTrack);
    audioTrack.end();
    await vi.waitFor(() =>
      expect(rebuiltAudioSender.replaceTrack.mock.calls).toEqual([
        [audioTrack],
        [null],
      ]),
    );
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'sharing',
      systemAudioEnabled: false,
    });
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).not.toHaveBeenCalled();
    expect(rebuiltVideoSender.replaceTrack).not.toHaveBeenCalledWith(null);
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(0);

    await harness.controller.stop();
  });

  test('does not reattach system audio that ends during transport migration', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();
    const videoAttached = deferred<void>();
    const rebuiltVideoSender = {
      replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => {
        if (track !== null) await videoAttached.promise;
      }),
    };
    const rebuiltAudioSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };

    const reattaching = harness.controller.reattachTransport(
      rebuiltVideoSender as unknown as RTCRtpSender,
      rebuiltAudioSender as unknown as RTCRtpSender,
    );
    await vi.waitFor(() =>
      expect(rebuiltVideoSender.replaceTrack).toHaveBeenCalledWith(videoTrack),
    );
    audioTrack.end();
    videoAttached.resolve();
    await reattaching;

    await vi.waitFor(() =>
      expect(rebuiltAudioSender.replaceTrack).toHaveBeenCalledWith(null),
    );
    expect(rebuiltAudioSender.replaceTrack).not.toHaveBeenCalledWith(
      audioTrack,
    );
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'sharing',
      systemAudioEnabled: false,
    });
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).not.toHaveBeenCalled();

    await harness.controller.stop();
  });

  test('fails and cleans up when screen reattachment rejects', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();
    const failure = new Error('screen reattach failed');
    const rebuiltVideoSender = {
      replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => {
        if (track !== null) throw failure;
      }),
    };
    const rebuiltAudioSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      harness.controller.reattachTransport(
        rebuiltVideoSender as unknown as RTCRtpSender,
        rebuiltAudioSender as unknown as RTCRtpSender,
      ),
    ).rejects.toBe(failure);

    expect(rebuiltVideoSender.replaceTrack.mock.calls).toEqual([
      [videoTrack],
      [null],
    ]);
    expect(rebuiltAudioSender.replaceTrack).toHaveBeenCalledOnce();
    expect(rebuiltAudioSender.replaceTrack).toHaveBeenCalledWith(null);
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('error');
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('rolls back screen reattachment when system audio rejects', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    harness.controller.setSystemAudioEnabled(true);
    await harness.controller.startSelectedCapture();
    const failure = new Error('system audio reattach failed');
    const rebuiltVideoSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };
    const rebuiltAudioSender = {
      replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => {
        if (track !== null) throw failure;
      }),
    };

    await expect(
      harness.controller.reattachTransport(
        rebuiltVideoSender as unknown as RTCRtpSender,
        rebuiltAudioSender as unknown as RTCRtpSender,
      ),
    ).rejects.toBe(failure);

    expect(rebuiltVideoSender.replaceTrack.mock.calls).toEqual([
      [videoTrack],
      [null],
    ]);
    expect(rebuiltAudioSender.replaceTrack.mock.calls).toEqual([
      [audioTrack],
      [null],
    ]);
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().state).toBe('error');
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('fails closed if the platform returns audio without opt-in', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack('audio');
    const harness = createHarness({
      capture: Promise.resolve(streamWith(videoTrack, audioTrack)),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    await expect(
      harness.controller.startSelectedCapture(),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });

    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(harness.audioSender.replaceTrack).not.toHaveBeenCalledWith(
      audioTrack,
    );
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: 'error',
      systemAudioEnabled: false,
    });
  });

  test('stops and releases at most once across ended, stop, and cleanup races', async () => {
    const harness = createHarness();
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    await harness.controller.startSelectedCapture();

    harness.track.end();
    await Promise.all([
      harness.controller.stop(),
      harness.controller.stop(),
      harness.controller.cleanup(),
    ]);

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.sender.replaceTrack.mock.calls).toEqual([
      [harness.track],
      [null],
    ]);
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('detaches locally before a renewal timeout can reach server lease expiry', async () => {
    const harness = createHarness({
      renew: async (call, requestOptions) => {
        if (call === 1) return lease(Date.now() + 15_000);
        return new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('timeout'), {
                  code: 'SIGNALING_TIMEOUT',
                }),
              ),
            requestOptions.timeoutMs,
          );
        });
      },
    });
    await harness.controller.prepare();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sender.replaceTrack).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
    const renewCall = [...harness.signaling.request.mock.calls]
      .reverse()
      .find(([type]) => type === 'screen.renew');
    expect(renewCall?.[3]).toMatchObject({ timeoutMs: 3_000 });
    expect(Date.now()).toBe(1_700_000_008_000);
  });

  test('never attaches a late capture after cadence renewal loses the lease', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    const capture = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const harness = createHarness({
      capture,
      renew: async (call) => {
        if (call === 1) return lease(Date.now() + 15_000);
        throw Object.assign(new Error('lost'), { code: 'LEASE_LOST' });
      },
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );
    const started = harness.controller.startSelectedCapture();
    await vi.advanceTimersByTimeAsync(5_000);
    const lateTrack = new FakeTrack();
    resolveCapture(streamWith(lateTrack));

    await expect(started).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(harness.sender.replaceTrack).not.toHaveBeenCalledWith(lateTrack);
  });

  test('rejects an expired final-renew ack before replaceTrack', async () => {
    const harness = createHarness({
      renew: async (call) =>
        call === 1 ? lease(Date.now() + 15_000) : lease(Date.now() - 1),
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    await expect(
      harness.controller.startSelectedCapture(),
    ).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.sender.replaceTrack).not.toHaveBeenCalledWith(harness.track);
  });

  test('rejects an expired acquire replay before source enumeration', async () => {
    const harness = createHarness();
    harness.signaling.request.mockImplementationOnce(
      async (_type, _payload, _schema, requestOptions) =>
        ack('screen.acquire', requestOptions.requestId!, {
          lease: lease(Date.now() - 1),
        }),
    );

    await expect(harness.controller.prepare()).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });

    expect(harness.desktop.list).not.toHaveBeenCalled();
    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
  });

  test('cleans up when replaceTrack rejects', async () => {
    const failure = new Error('replace failed');
    const harness = createHarness({
      replaceTrack: async (track) => {
        if (track !== null) throw failure;
      },
    });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    await expect(harness.controller.startSelectedCapture()).rejects.toBe(
      failure,
    );

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.sender.replaceTrack.mock.calls.at(-1)).toEqual([null]);
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('canceling the picker never starts capture and releases once', async () => {
    const harness = createHarness();
    await harness.controller.prepare();

    await Promise.all([
      harness.controller.stop(),
      harness.controller.cleanup(),
    ]);

    expect(harness.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    expect(harness.sender.replaceTrack).toHaveBeenCalledOnce();
    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test.each([
    [
      'permission denial',
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    ],
    ['capture failure', new Error('capture failed')],
  ])('cleans the sender and lease after %s', async (_name, failure) => {
    const harness = createHarness({ capture: Promise.reject(failure) });
    await harness.controller.prepare();
    await harness.controller.selectSource(
      '00000000-0000-4000-8000-000000000001',
    );

    await expect(harness.controller.startSelectedCapture()).rejects.toBe(
      failure,
    );

    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
    expect(
      harness.signaling.request.mock.calls.filter(
        ([type]) => type === 'screen.release',
      ),
    ).toHaveLength(1);
  });

  test('cleans share-only state when signaling closes or LEASE_LOST arrives', async () => {
    const harness = createHarness();
    await harness.controller.prepare();

    await Promise.all([
      harness.controller.handleSignalingClosed(),
      harness.controller.handleLeaseLost(),
    ]);

    expect(harness.sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(harness.sender.replaceTrack).toHaveBeenCalledWith(null);
    expect(harness.controller.getSnapshot().state).toBe('error');
  });
});
