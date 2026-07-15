export interface SignalingSocket {
  send(data: string): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void;
  close?(): void;
}

interface PendingRequest {
  readonly resolve: (data: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export class SignalingClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #closeListeners = new Set<() => void>();
  #requestNumber = 0;
  #closed = false;

  constructor(private readonly socket: SignalingSocket) {
    socket.addEventListener('message', (event) =>
      this.#handleMessage(event.data),
    );
    socket.addEventListener('close', () => this.#handleClose());
    socket.addEventListener('error', () => {
      socket.close?.();
      this.#handleClose();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClose(listener: () => void): void {
    if (this.#closed) {
      listener();
      return;
    }
    this.#closeListeners.add(listener);
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error('Signaling socket is closed'));
    const id = `request-${++this.#requestNumber}`;
    const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ type: 'request', id, method, data }));
    return pending as Promise<T>;
  }

  close(): void {
    this.socket.close?.();
    this.#handleClose();
  }

  #handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const candidate = message as Record<string, unknown>;
    if (typeof candidate.id !== 'string') return;
    const pending = this.#pending.get(candidate.id);
    if (!pending) return;
    this.#pending.delete(candidate.id);

    if (
      candidate.type === 'ack' &&
      candidate.data &&
      typeof candidate.data === 'object'
    ) {
      pending.resolve(candidate.data as Record<string, unknown>);
      return;
    }
    if (
      candidate.type === 'error' &&
      candidate.error &&
      typeof candidate.error === 'object'
    ) {
      const details = candidate.error as Record<string, unknown>;
      pending.reject(
        new Error(`${String(details.code)}: ${String(details.message)}`),
      );
      return;
    }
    pending.reject(new Error('Invalid signaling response'));
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Signaling socket closed'));
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}
