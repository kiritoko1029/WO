export interface CaptureSource {
  readonly id: string;
  readonly name: string;
}

export class CaptureSourceSelection<T extends CaptureSource = CaptureSource> {
  readonly #available = new Map<string, T>();
  #selectedId: string | null = null;

  replaceAvailable(sources: readonly T[]): void {
    this.#available.clear();
    for (const source of sources) this.#available.set(source.id, source);
    if (this.#selectedId && !this.#available.has(this.#selectedId)) {
      this.#selectedId = null;
    }
  }

  select(id: string): void {
    if (!this.#available.has(id)) {
      throw new Error(`Capture source was not enumerated: ${id}`);
    }
    this.#selectedId = id;
  }

  selectedForRequest(): T {
    const source =
      this.#selectedId === null
        ? undefined
        : this.#available.get(this.#selectedId);
    if (!source) throw new Error('No capture source is selected');
    return source;
  }
}
