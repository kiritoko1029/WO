import type { MediaLabApi } from '../../preload/api.js';

declare global {
  interface Window {
    readonly mediaLab: Readonly<MediaLabApi>;
  }
}

export {};
