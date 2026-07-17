import {
  applyDevelopmentProfile,
  type ProfileApp,
  type ProfileFileSystem,
} from './runtime-config.js';
import { findJoinIntent } from './join-intent.js';
import type { JoinIntent } from '@wo/protocol';

export interface DesktopLifecycleApp extends ProfileApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(
    event: 'second-instance',
    listener: (event: unknown, argumentsList: readonly string[]) => void,
  ): unknown;
  on(
    event: 'open-url',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
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
  readonly argumentsList?: readonly string[];
  readonly onJoinIntent?: (intent: JoinIntent) => void;
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

  const focusMainWindow = (): void => {
    const window = options.getMainWindow();
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  options.app.on('second-instance', (_event, argumentsList) => {
    const intent = findJoinIntent(argumentsList);
    if (intent !== null) options.onJoinIntent?.(intent);
    focusMainWindow();
  });
  options.app.on('open-url', (event, url) => {
    event.preventDefault();
    const intent = findJoinIntent([url]);
    if (intent === null) return;
    options.onJoinIntent?.(intent);
    focusMainWindow();
  });
  const initialIntent = findJoinIntent(options.argumentsList ?? []);
  if (initialIntent !== null) options.onJoinIntent?.(initialIntent);
  return true;
}
