/// <reference types="vite/client" />

import type { DesktopBridge, DesktopShellBridge } from '../../preload/types.js';
import type { DesktopLanBridge } from '../../preload/lan-types.js';

declare global {
  interface Window {
    readonly desktop: DesktopBridge;
    readonly woLan?: DesktopLanBridge;
    readonly woShell?: DesktopShellBridge;
  }
}

export {};
