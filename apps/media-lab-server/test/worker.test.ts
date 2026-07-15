import { expect, test } from 'vitest';

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
