/// <reference types="vite/client" />

import type { DesktopBridge } from '../../preload/types.js';

declare global {
  interface Window {
    readonly desktop: DesktopBridge;
  }
}

export {};
