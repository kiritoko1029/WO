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
  createScreenController,
} from '../src/renderer/src/media/screen-controller.js';

class FakeTrack {
  readonly kind = 'video';
  readonly stop = vi.fn();
  readyState: MediaStreamTrackState = 'live';
  readonly getSettings = vi.fn(() => ({
    width: 1_920,
    height: 1_080,
    frameRate: 60,
  }));
  private readonly ended = new Set<() => void>();

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

function streamWith(track: FakeTrack) {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
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
    signaling: signaling as never,
    capture: desktop,
    mediaDevices: mediaDevices as unknown as MediaDevices,
    makeRequestId: () => `screen-request-${++request}`,
    now: () => Date.now(),
  });
  return {
    controller,
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
      audio: true,
      video: {
        frameRate: { ideal: 60 },
      },
    });
    expect(harness.track.getSettings).toHaveBeenCalledOnce();
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
