export type ScreenPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface ScreenPermissionService {
  status(): Readonly<{
    status: ScreenPermissionStatus;
    canOpenSettings: boolean;
  }>;
  openSettings(): Promise<void>;
}

export interface ScreenPermissionServiceDependencies {
  readonly platform: NodeJS.Platform;
  readonly systemPreferences: {
    getMediaAccessStatus(mediaType: 'screen'): ScreenPermissionStatus;
  };
  readonly shell: {
    openExternal(url: string): Promise<void>;
  };
}

const MACOS_SCREEN_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export function createScreenPermissionService(
  dependencies: ScreenPermissionServiceDependencies,
): ScreenPermissionService {
  const status = () => {
    const current =
      dependencies.platform === 'darwin' || dependencies.platform === 'win32'
        ? dependencies.systemPreferences.getMediaAccessStatus('screen')
        : 'unknown';
    return Object.freeze({
      status: current,
      canOpenSettings:
        dependencies.platform === 'darwin' &&
        (current === 'denied' || current === 'restricted'),
    });
  };
  return Object.freeze({
    status,
    async openSettings() {
      if (!status().canOpenSettings) {
        throw new Error('Screen permission settings are unavailable');
      }
      await dependencies.shell.openExternal(MACOS_SCREEN_SETTINGS);
    },
  });
}
