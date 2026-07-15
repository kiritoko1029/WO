import { createWorker } from 'mediasoup';
import type {
  Router,
  RouterRtpCodecCapability,
  WebRtcServer,
  Worker,
} from 'mediasoup/types';

export const LAB_MEDIA_CODECS: readonly RouterRtpCodecCapability[] = [
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90_000,
    parameters: { 'x-google-start-bitrate': 1_000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90_000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90_000,
    parameters: { 'profile-id': 0 },
  },
];

export interface LabWorkerStack {
  readonly worker: Worker;
  readonly router: Router;
  readonly webRtcServer: WebRtcServer;
}

export interface LabWorkerOptions {
  readonly rtcPort?: number;
}

export async function createLabWorker(
  options: LabWorkerOptions = {},
): Promise<LabWorkerStack> {
  if (
    options.rtcPort !== undefined &&
    (!Number.isInteger(options.rtcPort) ||
      options.rtcPort < 1_024 ||
      options.rtcPort > 65_535)
  ) {
    throw new RangeError('RTC port must be an integer between 1024 and 65535');
  }

  const worker = await createWorker({
    logLevel: 'warn',
    rtcMinPort: 40_000,
    rtcMaxPort: 40_100,
  });

  try {
    const router = await worker.createRouter({
      mediaCodecs: [...LAB_MEDIA_CODECS],
    });
    const port = options.rtcPort === undefined ? {} : { port: options.rtcPort };
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip: '127.0.0.1', ...port },
        { protocol: 'tcp', ip: '127.0.0.1', ...port },
      ],
    });

    return { worker, router, webRtcServer };
  } catch (error) {
    worker.close();
    throw error;
  }
}

export async function closeLabWorker(stack: LabWorkerStack): Promise<void> {
  if (!stack.webRtcServer.closed) stack.webRtcServer.close();
  if (!stack.router.closed) stack.router.close();
  if (stack.worker.closed) return;

  const subprocessClosed = new Promise<void>((resolve) => {
    stack.worker.once('subprocessclose', resolve);
  });
  stack.worker.close();
  await subprocessClosed;
}
