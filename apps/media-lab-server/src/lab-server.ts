import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  createAck,
  createError,
  parseClientMessage,
  type LabRequest,
} from './protocol.js';
import {
  closeLabWorker,
  createLabWorker,
  type LabWorkerOptions,
  type LabWorkerStack,
} from './worker.js';

export interface ClosableResource {
  readonly id: string;
  close(): void;
}

function adoptCreated<T extends ClosableResource>(
  resource: T,
  adopt: (resource: T) => void,
): T {
  try {
    adopt(resource);
    return resource;
  } catch (error) {
    resource.close();
    throw error;
  }
}

type ResourceType = 'transport' | 'producer' | 'consumer';

export class ProducerDirectory<T extends ClosableResource = ClosableResource> {
  readonly #producers = new Map<string, T>();

  add(producer: T): void {
    if (this.#producers.has(producer.id)) {
      throw new Error(`Duplicate producer ID: ${producer.id}`);
    }
    this.#producers.set(producer.id, producer);
  }

  get<U extends T = T>(id: string): U {
    const producer = this.#producers.get(id);
    if (!producer) throw new Error(`Producer not found: ${id}`);
    return producer as U;
  }

  remove(id: string): void {
    this.#producers.delete(id);
  }

  ids(): string[] {
    return [...this.#producers.keys()];
  }
}

export class ConnectionResources {
  readonly #transports = new Map<string, ClosableResource>();
  readonly #producers = new Map<string, ClosableResource>();
  readonly #consumers = new Map<string, ClosableResource>();
  readonly #transportDirections = new Map<string, 'send' | 'recv'>();
  #closed = false;

  constructor(
    private readonly producerDirectory: ProducerDirectory = new ProducerDirectory(),
  ) {}

  addTransport(
    transport: ClosableResource,
    direction: 'send' | 'recv' = 'send',
  ): void {
    this.#add(this.#transports, transport, 'transport');
    this.#transportDirections.set(transport.id, direction);
  }

  addProducer(producer: ClosableResource): void {
    this.#add(this.#producers, producer, 'producer');
    this.producerDirectory.add(producer);
  }

  addConsumer(consumer: ClosableResource): void {
    this.#add(this.#consumers, consumer, 'consumer');
  }

  getTransport<T extends ClosableResource = ClosableResource>(
    id: string,
    direction?: 'send' | 'recv',
  ): T {
    const transport = this.#get(this.#transports, id, 'transport');
    if (direction && this.#transportDirections.get(id) !== direction) {
      throw new Error(`Transport ${id} is not a ${direction} transport`);
    }
    return transport as T;
  }

  getConsumer<T extends ClosableResource = ClosableResource>(id: string): T {
    return this.#get(this.#consumers, id, 'consumer') as T;
  }

  closeResource(type: ResourceType, id: string): void {
    const resources = this.#mapFor(type);
    const resource = resources.get(id);
    if (!resource) return;
    resources.delete(id);
    if (type === 'transport') this.#transportDirections.delete(id);
    if (type === 'producer') this.producerDirectory.remove(id);
    resource.close();
  }

  closeAll(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#consumers.keys()]) {
      this.closeResource('consumer', id);
    }
    for (const id of [...this.#producers.keys()]) {
      this.closeResource('producer', id);
    }
    for (const id of [...this.#transports.keys()]) {
      this.closeResource('transport', id);
    }
  }

  #add(
    resources: Map<string, ClosableResource>,
    resource: ClosableResource,
    type: ResourceType,
  ): void {
    if (this.#closed) throw new Error('Connection resources are closed');
    if (resources.has(resource.id)) {
      throw new Error(`Duplicate ${type} ID: ${resource.id}`);
    }
    resources.set(resource.id, resource);
  }

  #get(
    resources: Map<string, ClosableResource>,
    id: string,
    type: ResourceType,
  ): ClosableResource {
    const resource = resources.get(id);
    if (!resource) throw new Error(`${type} not found: ${id}`);
    return resource;
  }

  #mapFor(type: ResourceType): Map<string, ClosableResource> {
    if (type === 'transport') return this.#transports;
    if (type === 'producer') return this.#producers;
    return this.#consumers;
  }
}

interface SignalProducer extends ClosableResource {
  readonly observer?: { on(event: 'close', listener: () => void): void };
}

interface SignalConsumer extends ClosableResource {
  readonly producerId: string;
  readonly kind: string;
  readonly rtpParameters: unknown;
  readonly type: string;
  readonly producerPaused: boolean;
  resume(): Promise<void>;
}

interface SignalTransport extends ClosableResource {
  readonly iceParameters: unknown;
  readonly iceCandidates: unknown;
  readonly dtlsParameters: unknown;
  readonly sctpParameters?: unknown;
  connect?(options: { dtlsParameters: unknown }): Promise<void>;
  produce?(options: {
    kind: 'video';
    rtpParameters: unknown;
    appData?: Record<string, unknown>;
  }): Promise<SignalProducer>;
  consume?(options: {
    producerId: string;
    rtpCapabilities: unknown;
    paused: boolean;
  }): Promise<SignalConsumer>;
}

interface SignalRouter {
  readonly rtpCapabilities: unknown;
  createWebRtcTransport(options: {
    webRtcServer: unknown;
    enableUdp: boolean;
    enableTcp: boolean;
    preferUdp: boolean;
    initialAvailableOutgoingBitrate: number;
  }): Promise<SignalTransport>;
  canConsume?(options: {
    producerId: string;
    rtpCapabilities: unknown;
  }): boolean;
}

export interface LabRequestContext {
  readonly router: SignalRouter;
  readonly webRtcServer: unknown;
  readonly producers: ProducerDirectory;
  readonly resources: ConnectionResources;
}

export async function handleLabRequest(
  request: LabRequest,
  context: LabRequestContext,
): Promise<Record<string, unknown>> {
  switch (request.method) {
    case 'getRouterRtpCapabilities':
      return { rtpCapabilities: context.router.rtpCapabilities };
    case 'listProducers':
      return { producerIds: context.producers.ids() };
    case 'createTransport': {
      const transport = adoptCreated(
        await context.router.createWebRtcTransport({
          webRtcServer: context.webRtcServer,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 10_000_000,
        }),
        (created) =>
          context.resources.addTransport(created, request.data.direction),
      );
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        ...(transport.sctpParameters
          ? { sctpParameters: transport.sctpParameters }
          : {}),
      };
    }
    case 'connectTransport': {
      const transport = context.resources.getTransport<SignalTransport>(
        request.data.transportId,
      );
      if (!transport.connect) throw new Error('Transport cannot connect');
      await transport.connect({ dtlsParameters: request.data.dtlsParameters });
      return {};
    }
    case 'produce': {
      const transport = context.resources.getTransport<SignalTransport>(
        request.data.transportId,
        'send',
      );
      if (!transport.produce) throw new Error('Transport cannot produce');
      const producer = adoptCreated(
        await transport.produce({
          kind: request.data.kind,
          rtpParameters: request.data.rtpParameters,
          ...(request.data.appData ? { appData: request.data.appData } : {}),
        }),
        (created) => context.resources.addProducer(created),
      );
      producer.observer?.on('close', () => {
        context.producers.remove(producer.id);
      });
      return { id: producer.id };
    }
    case 'consume': {
      context.producers.get(request.data.producerId);
      if (
        !context.router.canConsume?.({
          producerId: request.data.producerId,
          rtpCapabilities: request.data.rtpCapabilities,
        })
      ) {
        throw new Error(`Cannot consume producer: ${request.data.producerId}`);
      }
      const transport = context.resources.getTransport<SignalTransport>(
        request.data.transportId,
        'recv',
      );
      if (!transport.consume) throw new Error('Transport cannot consume');
      const consumer = adoptCreated(
        await transport.consume({
          producerId: request.data.producerId,
          rtpCapabilities: request.data.rtpCapabilities,
          paused: true,
        }),
        (created) => context.resources.addConsumer(created),
      );
      return {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
      };
    }
    case 'resumeConsumer': {
      const consumer = context.resources.getConsumer<SignalConsumer>(
        request.data.consumerId,
      );
      await consumer.resume();
      return {};
    }
    case 'close':
      context.resources.closeResource(
        request.data.resourceType,
        request.data.resourceId,
      );
      return {};
  }
}

export function assertLoopbackHost(host: string): '127.0.0.1' {
  if (host !== '127.0.0.1') {
    throw new Error('Media lab must bind to explicit loopback host 127.0.0.1');
  }
  return host;
}

export interface LabServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly rtcPort?: number;
  readonly tls: {
    readonly key: string | Buffer;
    readonly cert: string | Buffer;
  };
}

export interface LabServerDependencies {
  createWorker(options: LabWorkerOptions): Promise<LabWorkerStack>;
  closeWorker(stack: LabWorkerStack): Promise<void>;
  createHttpsServer(
    tls: LabServerOptions['tls'],
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): HttpsServer;
}

const defaultLabServerDependencies: LabServerDependencies = {
  createWorker: createLabWorker,
  closeWorker: closeLabWorker,
  createHttpsServer: (tls, listener) => createServer(tls, listener),
};

export interface RunningLabServer {
  readonly url: string;
  readonly stack: LabWorkerStack;
  close(): Promise<void>;
}

function listen(
  server: HttpsServer,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeHttpsServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown signaling error';
}

export async function createLabServer(
  options: LabServerOptions,
  dependencies: LabServerDependencies = defaultLabServerDependencies,
): Promise<RunningLabServer> {
  const host = assertLoopbackHost(options.host ?? '127.0.0.1');
  const stack = await dependencies.createWorker({
    rtcPort: options.rtcPort ?? 44_444,
  });
  const producers = new ProducerDirectory();
  let httpsServer: HttpsServer | undefined;
  let webSocketServer: WebSocketServer | undefined;

  try {
    const nextHttpsServer = dependencies.createHttpsServer(
      options.tls,
      (_request, response) => {
        response.writeHead(404).end();
      },
    );
    httpsServer = nextHttpsServer;
    const nextWebSocketServer = new WebSocketServer({
      server: nextHttpsServer,
      maxPayload: 1_048_576,
    });
    webSocketServer = nextWebSocketServer;

    nextWebSocketServer.on('connection', (socket: WebSocket) => {
      const resources = new ConnectionResources(producers);
      const context: LabRequestContext = {
        router: stack.router as unknown as SignalRouter,
        webRtcServer: stack.webRtcServer,
        producers,
        resources,
      };

      socket.on('message', async (rawData, isBinary) => {
        let id = 'invalid';
        try {
          if (isBinary) throw new Error('Binary signaling is not supported');
          const request = parseClientMessage(rawData.toString());
          id = request.id;
          const data = await handleLabRequest(request, context);
          socket.send(JSON.stringify(createAck(request.id, data)));
        } catch (error) {
          socket.send(
            JSON.stringify(createError(id, 'BAD_REQUEST', errorText(error))),
          );
        }
      });
      socket.once('close', () => resources.closeAll());
      socket.once('error', () => resources.closeAll());
    });

    await listen(nextHttpsServer, options.port ?? 4_443, host);

    const address = nextHttpsServer.address() as AddressInfo;
    let closed = false;
    return {
      url: `wss://${host}:${address.port}`,
      stack,
      async close() {
        if (closed) return;
        closed = true;
        for (const client of nextWebSocketServer.clients) client.terminate();
        nextWebSocketServer.close();
        await closeHttpsServer(nextHttpsServer);
        await dependencies.closeWorker(stack);
      },
    };
  } catch (error) {
    webSocketServer?.close();
    httpsServer?.close();
    await dependencies.closeWorker(stack);
    throw error;
  }
}
