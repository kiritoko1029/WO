import { describe, expect, test, vi } from 'vitest';

import {
  SCREEN_BITRATE_PRESETS_BPS,
  createSenderBitrateController,
  setScreenBitrate,
  type ScreenBitrateSender,
  type ScreenBitrateTarget,
} from '../src/renderer/src/media/sender-bitrate.js';

const auto = (): ScreenBitrateTarget => ({ mode: 'auto' });
const fixed = (bitrateBps: number): ScreenBitrateTarget => ({
  mode: 'fixed',
  bitrateBps,
});

function parameters(
  transactionId: string,
  encodings: RTCRtpEncodingParameters[],
): RTCRtpSendParameters {
  return {
    transactionId,
    encodings,
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'screen-cname', reducedSize: true },
    degradationPreference: 'maintain-resolution',
  };
}

function cloneParameters(value: RTCRtpSendParameters): RTCRtpSendParameters {
  return {
    ...value,
    encodings: value.encodings.map((encoding) => ({ ...encoding })),
    codecs: value.codecs.map((codec) => ({ ...codec })),
    headerExtensions: value.headerExtensions.map((extension) => ({
      ...extension,
    })),
    rtcp: { ...value.rtcp },
  };
}

function createSender(
  getCurrent: () => RTCRtpSendParameters,
  setParameters: (value: RTCRtpSendParameters) => Promise<void> = async () =>
    undefined,
) {
  return {
    getParameters: vi.fn(() => cloneParameters(getCurrent())),
    setParameters: vi.fn(setParameters),
  } satisfies ScreenBitrateSender;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('one screen sender bitrate transaction', () => {
  test('uses fresh parameters and preserves the transaction and parameter shape', async () => {
    const current = parameters('same-transaction', [
      {
        rid: 'f',
        active: true,
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ]);
    const sender = createSender(() => current);

    await expect(setScreenBitrate(sender, fixed(4_000_000))).resolves.toEqual({
      status: 'applied',
      target: fixed(4_000_000),
    });

    expect(sender.getParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenCalledWith({
      transactionId: 'same-transaction',
      encodings: [
        {
          rid: 'f',
          active: true,
          maxBitrate: 4_000_000,
          maxFramerate: 60,
          scaleResolutionDownBy: 1,
        },
      ],
      codecs: [],
      headerExtensions: [],
      rtcp: { cname: 'screen-cname', reducedSize: true },
      degradationPreference: 'maintain-resolution',
    });
    expect(current.encodings[0]?.maxBitrate).toBe(8_000_000);
  });

  test.each(SCREEN_BITRATE_PRESETS_BPS)(
    'applies the fixed %i bps preset',
    async (bitrateBps) => {
      const sender = createSender(() =>
        parameters('preset-transaction', [
          { rid: 'f', scaleResolutionDownBy: 1 },
        ]),
      );

      await setScreenBitrate(sender, fixed(bitrateBps));

      expect(
        sender.setParameters.mock.calls[0]?.[0].encodings[0]?.maxBitrate,
      ).toBe(bitrateBps);
    },
  );

  test.each([
    [0, 1_000_000],
    [999_999, 1_000_000],
    [10_000_001, 10_000_000],
    [20_000_000, 10_000_000],
  ])('clamps %i bps to the server range %i', async (requested, expected) => {
    const sender = createSender(() =>
      parameters('clamp-transaction', [{ rid: 'f', scaleResolutionDownBy: 1 }]),
    );

    const result = await setScreenBitrate(sender, fixed(requested));

    expect(result).toEqual({ status: 'applied', target: fixed(expected) });
    expect(
      sender.setParameters.mock.calls[0]?.[0].encodings[0]?.maxBitrate,
    ).toBe(expected);
  });

  test('automatic mode removes only the full-resolution maxBitrate', async () => {
    const current = parameters('auto-transaction', [
      {
        rid: 'q',
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 2,
      },
      {
        rid: 'f',
        active: true,
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ]);
    const sender = createSender(() => current);

    await setScreenBitrate(sender, auto());

    const updated = sender.setParameters.mock.calls[0]?.[0];
    expect(updated?.transactionId).toBe('auto-transaction');
    expect(updated?.encodings).toHaveLength(2);
    expect(updated?.encodings[0]).toEqual(current.encodings[0]);
    expect(updated?.encodings[1]).toEqual({
      rid: 'f',
      active: true,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
    });
    expect(Object.hasOwn(updated!.encodings[1]!, 'maxBitrate')).toBe(false);
    expect(current.encodings[1]?.maxBitrate).toBe(8_000_000);
  });

  test('keeps an empty encoding set pending without inserting an encoding', async () => {
    const sender = createSender(() => parameters('empty-transaction', []));

    await expect(setScreenBitrate(sender, fixed(8_000_000))).resolves.toEqual({
      status: 'pending',
      target: fixed(8_000_000),
    });

    expect(sender.getParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters).not.toHaveBeenCalled();
  });

  test.each([
    [
      [
        { rid: 'q', maxBitrate: 2_000_000 },
        { rid: 'x', maxBitrate: 4_000_000 },
      ],
      /missing.*full-resolution/i,
    ],
    [
      [
        { rid: 'f', maxBitrate: 2_000_000 },
        { rid: 'f', maxBitrate: 4_000_000 },
      ],
      /duplicate.*full-resolution/i,
    ],
  ] as const)(
    'rejects a malformed encoding set without calling setParameters',
    async (encodings, message) => {
      const sender = createSender(() =>
        parameters(
          'malformed-transaction',
          encodings.map((encoding) => ({ ...encoding })),
        ),
      );

      await expect(setScreenBitrate(sender, fixed(6_000_000))).rejects.toThrow(
        message,
      );
      expect(sender.setParameters).not.toHaveBeenCalled();
    },
  );
});

describe('serialized sender bitrate controller', () => {
  test('serializes rapid selections, re-reads parameters, and applies the final target', async () => {
    const firstSet = deferred();
    const events: string[] = [];
    let getCount = 0;
    const sender = createSender(
      () => {
        getCount += 1;
        events.push(`get:${getCount}`);
        return parameters(`transaction-${getCount}`, [
          { rid: 'f', scaleResolutionDownBy: 1 },
        ]);
      },
      async (value) => {
        events.push(`set:${value.transactionId}`);
        if (value.transactionId === 'transaction-1') await firstSet.promise;
      },
    );
    const controller = createSenderBitrateController({
      getSender: () => sender,
    });

    const first = controller.setTarget(fixed(2_000_000));
    await vi.waitFor(() => expect(sender.setParameters).toHaveBeenCalledOnce());
    const latest = controller.setTarget(fixed(8_000_000));
    await Promise.resolve();
    expect(sender.getParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenCalledOnce();

    firstSet.resolve();
    await expect(Promise.all([first, latest])).resolves.toEqual([
      { status: 'applied', target: fixed(8_000_000) },
      { status: 'applied', target: fixed(8_000_000) },
    ]);

    expect(events).toEqual([
      'get:1',
      'set:transaction-1',
      'get:2',
      'set:transaction-2',
    ]);
    expect(
      sender.setParameters.mock.calls.map(
        ([value]) => value.encodings[0]?.maxBitrate,
      ),
    ).toEqual([2_000_000, 8_000_000]);
    expect(controller.getSnapshot()).toEqual({
      desiredTarget: fixed(8_000_000),
      lastSuccessfulTarget: fixed(8_000_000),
      pendingTarget: null,
    });
  });

  test('ignores an obsolete rejection when a newer target succeeds', async () => {
    const firstSet = deferred();
    let getCount = 0;
    const sender = createSender(
      () =>
        parameters(`transaction-${++getCount}`, [
          { rid: 'f', scaleResolutionDownBy: 1 },
        ]),
      async (value) => {
        if (value.transactionId === 'transaction-1') await firstSet.promise;
      },
    );
    const controller = createSenderBitrateController({
      getSender: () => sender,
      initialTarget: fixed(4_000_000),
    });

    const obsolete = controller.setTarget(fixed(2_000_000));
    await vi.waitFor(() => expect(sender.setParameters).toHaveBeenCalledOnce());
    const latest = controller.setTarget(fixed(8_000_000));
    firstSet.reject(new Error('obsolete sender rejection'));

    await expect(Promise.all([obsolete, latest])).resolves.toEqual([
      { status: 'applied', target: fixed(8_000_000) },
      { status: 'applied', target: fixed(8_000_000) },
    ]);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().lastSuccessfulTarget).toEqual(
      fixed(8_000_000),
    );
  });

  test('rolls state back after the current rejection without a stale setParameters rollback', async () => {
    const rejection = new DOMException(
      'cannot modify',
      'InvalidModificationError',
    );
    let shouldReject = true;
    let transaction = 0;
    const sender = createSender(
      () =>
        parameters(`transaction-${++transaction}`, [
          { rid: 'f', scaleResolutionDownBy: 1 },
        ]),
      async () => {
        if (shouldReject) throw rejection;
      },
    );
    const controller = createSenderBitrateController({
      getSender: () => sender,
      initialTarget: fixed(4_000_000),
    });

    await expect(controller.setTarget(fixed(8_000_000))).rejects.toBe(
      rejection,
    );

    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toEqual({
      desiredTarget: fixed(4_000_000),
      lastSuccessfulTarget: fixed(4_000_000),
      pendingTarget: null,
    });

    shouldReject = false;
    await expect(controller.setTarget(fixed(2_000_000))).resolves.toEqual({
      status: 'applied',
      target: fixed(2_000_000),
    });
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(sender.getParameters).toHaveBeenCalledTimes(2);
  });

  test('stores an empty-encoding target and replays it when the sender becomes ready', async () => {
    let current = parameters('empty-transaction', []);
    const sender = createSender(() => current);
    const controller = createSenderBitrateController({
      getSender: () => sender,
    });

    await expect(controller.setTarget(fixed(6_000_000))).resolves.toEqual({
      status: 'pending',
      target: fixed(6_000_000),
    });
    expect(sender.setParameters).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({
      desiredTarget: fixed(6_000_000),
      lastSuccessfulTarget: auto(),
      pendingTarget: fixed(6_000_000),
    });

    current = parameters('running-transaction', [
      { rid: 'f', scaleResolutionDownBy: 1 },
    ]);
    await expect(controller.replay()).resolves.toEqual({
      status: 'applied',
      target: fixed(6_000_000),
    });
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters.mock.calls[0]?.[0].transactionId).toBe(
      'running-transaction',
    );
  });

  test('replays the last successful target on a rebuilt sender', async () => {
    const firstSender = createSender(() =>
      parameters('first-sender', [{ rid: 'f', scaleResolutionDownBy: 1 }]),
    );
    const rebuiltSender = createSender(() =>
      parameters('rebuilt-sender', [{ rid: 'f', scaleResolutionDownBy: 1 }]),
    );
    let currentSender: ScreenBitrateSender | null = firstSender;
    const controller = createSenderBitrateController({
      getSender: () => currentSender,
    });
    await controller.setTarget(fixed(4_000_000));

    currentSender = rebuiltSender;
    await controller.replay();

    expect(firstSender.setParameters).toHaveBeenCalledOnce();
    expect(rebuiltSender.getParameters).toHaveBeenCalledOnce();
    expect(rebuiltSender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'rebuilt-sender',
        encodings: [
          expect.objectContaining({ rid: 'f', maxBitrate: 4_000_000 }),
        ],
      }),
    );
  });

  test('keeps a target pending while no sender exists', async () => {
    const controller = createSenderBitrateController({
      getSender: () => null,
    });

    await expect(controller.setTarget(fixed(8_000_000))).resolves.toEqual({
      status: 'pending',
      target: fixed(8_000_000),
    });

    expect(controller.getSnapshot().pendingTarget).toEqual(fixed(8_000_000));
  });

  test('uses only sender parameter methods and never invokes negotiation methods', async () => {
    const addTrack = vi.fn();
    const addTransceiver = vi.fn();
    const createOffer = vi.fn();
    const sender = Object.assign(
      createSender(() =>
        parameters('no-negotiation', [{ rid: 'f', scaleResolutionDownBy: 1 }]),
      ),
      { addTrack, addTransceiver, createOffer },
    );
    const controller = createSenderBitrateController({
      getSender: () => sender,
    });

    await controller.setTarget(fixed(8_000_000));

    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(addTrack).not.toHaveBeenCalled();
    expect(addTransceiver).not.toHaveBeenCalled();
    expect(createOffer).not.toHaveBeenCalled();
  });
});
