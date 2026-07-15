export interface CloseableLabResource {
  readonly id: string;
  close(): void;
}

export interface MediaSessionResources {
  readonly producers: CloseableLabResource[];
  readonly consumers: CloseableLabResource[];
  readonly transports: CloseableLabResource[];
}

interface CloseSignaling {
  request(
    method: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

const closeOperations = new WeakMap<MediaSessionResources, Promise<void>>();

async function requestServerClose(
  signaling: CloseSignaling | null,
  resourceType: 'producer' | 'consumer' | 'transport',
  resource: CloseableLabResource,
): Promise<void> {
  if (!signaling) return;
  try {
    await signaling.request('close', {
      resourceType,
      resourceId: resource.id,
    });
  } catch {
    // Local cleanup must continue when an ack is lost or the socket closes.
  }
}

function closeLocally(resource: CloseableLabResource): void {
  try {
    resource.close();
  } catch {
    // A failed local close must not strand the remaining resources.
  }
}

export function closeMediaSessionResources(
  signaling: CloseSignaling | null,
  resources: MediaSessionResources,
): Promise<void> {
  const existing = closeOperations.get(resources);
  if (existing) return existing;

  const operation = (async () => {
    for (const producer of resources.producers) {
      await requestServerClose(signaling, 'producer', producer);
    }
    for (const consumer of resources.consumers) {
      await requestServerClose(signaling, 'consumer', consumer);
    }
    for (const transport of resources.transports) {
      await requestServerClose(signaling, 'transport', transport);
    }

    for (const resource of [
      ...resources.producers,
      ...resources.consumers,
      ...resources.transports,
    ]) {
      closeLocally(resource);
    }
  })();
  closeOperations.set(resources, operation);
  return operation;
}
