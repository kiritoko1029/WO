interface ManagedSignaling {
  readonly closed: boolean;
  request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    data: Record<string, unknown>,
  ): Promise<T>;
  onClose(listener: () => void): void;
  close(): void;
}

interface LabConnection<TDevice, TSignaling extends ManagedSignaling> {
  readonly device: TDevice;
  readonly signaling: TSignaling;
}

interface LabConnectionManagerOptions<
  TDevice,
  TSignaling extends ManagedSignaling,
> {
  createSignaling(): Promise<TSignaling>;
  createDevice(): Promise<TDevice>;
  loadDevice(
    device: TDevice,
    routerRtpCapabilities: Record<string, unknown>,
  ): Promise<void>;
}

export class LabConnectionManager<
  TDevice,
  TSignaling extends ManagedSignaling,
> {
  #current: LabConnection<TDevice, TSignaling> | null = null;
  #connecting: Promise<LabConnection<TDevice, TSignaling>> | null = null;

  constructor(
    private readonly options: LabConnectionManagerOptions<TDevice, TSignaling>,
  ) {}

  get current(): LabConnection<TDevice, TSignaling> | null {
    return this.#current;
  }

  connect(): Promise<LabConnection<TDevice, TSignaling>> {
    if (this.#current && !this.#current.signaling.closed) {
      return Promise.resolve(this.#current);
    }
    this.#current = null;
    if (this.#connecting) return this.#connecting;

    const operation = this.#initialize();
    this.#connecting = operation;
    void operation.then(
      () => {
        if (this.#connecting === operation) this.#connecting = null;
      },
      () => {
        if (this.#connecting === operation) this.#connecting = null;
      },
    );
    return operation;
  }

  async #initialize(): Promise<LabConnection<TDevice, TSignaling>> {
    let signaling: TSignaling | null = null;
    try {
      signaling = await this.options.createSignaling();
      if (signaling.closed) throw new Error('Signaling socket is closed');

      const response = await signaling.request('getRouterRtpCapabilities', {});
      if (
        !response.rtpCapabilities ||
        typeof response.rtpCapabilities !== 'object'
      ) {
        throw new Error('Invalid router capabilities');
      }

      const device = await this.options.createDevice();
      await this.options.loadDevice(
        device,
        response.rtpCapabilities as Record<string, unknown>,
      );
      if (signaling.closed) throw new Error('Signaling socket is closed');

      const connection = { device, signaling };
      this.#current = connection;
      signaling.onClose(() => {
        if (this.#current === connection) this.#current = null;
      });
      if (signaling.closed) {
        this.#current = null;
        throw new Error('Signaling socket is closed');
      }
      return connection;
    } catch (error) {
      signaling?.close();
      throw error;
    }
  }
}
