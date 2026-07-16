import {
  applyDevelopmentProfile,
  type ProfileApp,
  type ProfileFileSystem,
} from './runtime-config.js';

export interface DesktopLifecycleApp extends ProfileApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

export interface DesktopMainWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface DesktopLifecycleOptions {
  readonly app: DesktopLifecycleApp;
  readonly developmentProfile: string | null;
  readonly profileFileSystem?: ProfileFileSystem;
  readonly getMainWindow: () => DesktopMainWindow | null;
}

export function establishDesktopLifecycle(
  options: DesktopLifecycleOptions,
): boolean {
  if (options.developmentProfile !== null) {
    applyDevelopmentProfile(
      options.app,
      options.developmentProfile,
      options.profileFileSystem,
    );
  }
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return false;
  }

  options.app.on('second-instance', () => {
    const window = options.getMainWindow();
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
