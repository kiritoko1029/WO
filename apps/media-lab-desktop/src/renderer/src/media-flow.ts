import { buildScreenEncodings } from '@wo/media-policy';
import type { types as MediasoupTypes } from 'mediasoup-client';

import { selectVideoCodec, type LabCodec } from './codec.js';

interface SignalingLike {
  request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    data: Record<string, unknown>,
  ): Promise<T>;
}

type ConnectHandler = (
  data: { dtlsParameters: unknown },
  callback: () => void,
  errorCallback: (error: Error) => void,
) => void;

type ProduceHandler = (
  data: {
    kind: string;
    rtpParameters: unknown;
    appData: Record<string, unknown>;
  },
  callback: (data: { id: string }) => void,
  errorCallback: (error: Error) => void,
) => void;

interface ClientTransportLike {
  on(event: 'connect', handler: ConnectHandler): void;
  on(event: 'produce', handler: ProduceHandler): void;
  consume?(options: Record<string, unknown>): Promise<unknown>;
  produce?(options: Record<string, unknown>): Promise<unknown>;
}

interface ClientDeviceLike {
  readonly rtpCapabilities?: {
    readonly codecs?: readonly Record<string, unknown>[];
  };
  createSendTransport?(options: Record<string, unknown>): ClientTransportLike;
  createRecvTransport?(options: Record<string, unknown>): ClientTransportLike;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid ${label} response`);
  }
  return value as Record<string, unknown>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function wireConnect(
  transport: ClientTransportLike,
  signaling: SignalingLike,
): void {
  transport.on('connect', ({ dtlsParameters }, callback, errorCallback) => {
    void signaling
      .request('connectTransport', {
        transportId: (transport as unknown as { id: string }).id,
        dtlsParameters,
      })
      .then(() => callback())
      .catch((error: unknown) => errorCallback(asError(error)));
  });
}

export async function createLabSendTransport(
  device: ClientDeviceLike,
  signaling: SignalingLike,
): Promise<ClientTransportLike> {
  if (!device.createSendTransport) throw new Error('Device cannot send video');
  const options = asRecord(
    await signaling.request('createTransport', { direction: 'send' }),
    'send transport',
  );
  const transport = device.createSendTransport(options);
  wireConnect(transport, signaling);
  transport.on('produce', (data, callback, errorCallback) => {
    void signaling
      .request('produce', {
        transportId: (transport as unknown as { id: string }).id,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: data.appData,
      })
      .then((response) => {
        if (typeof response.id !== 'string') {
          throw new Error('Invalid producer response');
        }
        callback({ id: response.id });
      })
      .catch((error: unknown) => errorCallback(asError(error)));
  });
  return transport;
}

export async function createLabReceiveTransport(
  device: ClientDeviceLike,
  signaling: SignalingLike,
): Promise<ClientTransportLike> {
  if (!device.createRecvTransport)
    throw new Error('Device cannot receive video');
  const options = asRecord(
    await signaling.request('createTransport', { direction: 'recv' }),
    'receive transport',
  );
  const transport = device.createRecvTransport(options);
  wireConnect(transport, signaling);
  return transport;
}

export async function produceScreen(
  transport: {
    produce?(options: Record<string, unknown>): Promise<unknown>;
  },
  track: unknown,
  capabilities: { readonly codecs?: readonly Record<string, unknown>[] },
  codec: LabCodec,
  bitrateBps: number,
): Promise<unknown> {
  if (!transport.produce) throw new Error('Transport cannot produce video');
  const selectedCodec = selectVideoCodec(
    capabilities as {
      readonly codecs?: readonly {
        readonly kind?: string;
        readonly mimeType: string;
        readonly [key: string]: unknown;
      }[];
    },
    codec,
  );
  const options = {
    track,
    codec: selectedCodec,
    encodings: buildScreenEncodings(bitrateBps),
    codecOptions: {
      videoGoogleStartBitrate: 8_000,
      videoGoogleMaxBitrate: 10_000,
    },
    stopTracks: false,
  } satisfies Omit<
    MediasoupTypes.ProducerOptions,
    'track' | 'codec' | 'encodings'
  > & {
    track: unknown;
    codec: typeof selectedCodec;
    encodings: ReturnType<typeof buildScreenEncodings>;
  };
  return transport.produce(options);
}

export async function consumeFirstProducer(
  device: ClientDeviceLike,
  transport: ClientTransportLike,
  signaling: SignalingLike,
): Promise<unknown> {
  if (!transport.consume) throw new Error('Transport cannot consume video');
  const list = await signaling.request('listProducers', {});
  const producerIds = list.producerIds;
  if (!Array.isArray(producerIds) || typeof producerIds[0] !== 'string') {
    throw new Error('No publisher is available');
  }
  const response = asRecord(
    await signaling.request('consume', {
      transportId: (transport as unknown as { id: string }).id,
      producerId: producerIds[0],
      rtpCapabilities: device.rtpCapabilities ?? {},
    }),
    'consumer',
  );
  const consumer = await transport.consume(response);
  if (typeof response.id !== 'string') {
    throw new Error('Invalid consumer ID');
  }
  await signaling.request('resumeConsumer', { consumerId: response.id });
  return consumer;
}
