import { expect, test } from 'vitest';

test('advertises Baseline Level 4.2 before the compatibility fallback', async () => {
  const { LAB_MEDIA_CODECS } = await import('../src/worker.js');
  const h264Codecs = LAB_MEDIA_CODECS.filter(
    (codec) => codec.mimeType.toLowerCase() === 'video/h264',
  );

  expect(h264Codecs[0]?.parameters).toMatchObject({
    'packetization-mode': 1,
    'profile-level-id': '42002a',
    'level-asymmetry-allowed': 1,
  });
  expect(h264Codecs[1]?.parameters).toMatchObject({
    'packetization-mode': 1,
    'profile-level-id': '42e01f',
    'level-asymmetry-allowed': 1,
  });
});

test('starts and closes a real mediasoup Worker, Router and WebRtcServer', async () => {
  const { closeLabWorker, createLabWorker } = await import('../src/worker.js');
  const stack = await createLabWorker();

  try {
    expect(stack.worker.closed).toBe(false);
    expect(stack.router.closed).toBe(false);
    expect(stack.webRtcServer.closed).toBe(false);
    expect(
      (stack.router.rtpCapabilities.codecs ?? []).map(
        (codec: { mimeType: string }) => codec.mimeType,
      ),
    ).toEqual(expect.arrayContaining(['video/VP8', 'video/H264', 'video/VP9']));
    expect(
      (stack.router.rtpCapabilities.codecs ?? [])
        .filter((codec) => codec.mimeType.toLowerCase() === 'video/h264')
        .map((codec) => codec.parameters?.['profile-level-id']),
    ).toEqual(['42002a', '42e01f']);

    const publisher = await stack.router.createWebRtcTransport({
      webRtcServer: stack.webRtcServer,
      enableUdp: true,
      enableTcp: true,
    });
    const receiver = await stack.router.createWebRtcTransport({
      webRtcServer: stack.webRtcServer,
      enableUdp: true,
      enableTcp: true,
    });
    expect(publisher.closed).toBe(false);
    expect(receiver.closed).toBe(false);
    publisher.close();
    receiver.close();
  } finally {
    await closeLabWorker(stack);
  }

  expect(stack.worker.closed).toBe(true);
});
