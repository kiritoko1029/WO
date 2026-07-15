interface ReadyApp {
  whenReady(): Promise<void>;
}

interface ClosableWindow {
  once(event: 'closed', listener: () => void): unknown;
}

export function registerAppReady(app: ReadyApp, onReady: () => void): void {
  void app.whenReady().then(onReady);
}

export class WindowOwner<T extends ClosableWindow> {
  readonly #windows = new Set<T>();

  add(window: T): T {
    this.#windows.add(window);
    window.once('closed', () => this.#windows.delete(window));
    return window;
  }

  has(window: T): boolean {
    return this.#windows.has(window);
  }

  get size(): number {
    return this.#windows.size;
  }
}
