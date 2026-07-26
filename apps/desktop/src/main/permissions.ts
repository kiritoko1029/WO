export type ScreenPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export type SystemAudioMode = 'loopback' | 'native-picker' | 'unsupported';

export interface ScreenPermissionService {
  status(): Readonly<{
    status: ScreenPermissionStatus;
    canOpenSettings: boolean;
    systemAudioMode: SystemAudioMode;
  }>;
  openSettings(): Promise<void>;
}

export interface ScreenPermissionServiceDependencies {
  readonly platform: NodeJS.Platform;
  readonly platformRelease: string;
  readonly systemPreferences: {
    getMediaAccessStatus(mediaType: 'screen'): ScreenPermissionStatus;
  };
  readonly shell: {
    openExternal(url: string): Promise<void>;
  };
}

const MACOS_SCREEN_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export function systemAudioModeForPlatform(
  platform: NodeJS.Platform,
  platformRelease: string,
): SystemAudioMode {
  if (platform === 'win32') return 'loopback';
  if (platform !== 'darwin') return 'unsupported';
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/u.exec(
    platformRelease,
  );
  if (match === null) return 'unsupported';
  const darwinMajor = Number(match[1]);
  const darwinMinor = match[2] === undefined ? null : Number(match[2]);
  const darwinPatch = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(darwinMajor) ||
    (darwinMinor !== null && !Number.isSafeInteger(darwinMinor)) ||
    (darwinPatch !== null && !Number.isSafeInteger(darwinPatch))
  ) {
    return 'unsupported';
  }
  if (darwinMajor >= 24) return 'native-picker';
  return darwinMajor === 23 && darwinMinor !== null && darwinMinor >= 2
    ? 'loopback'
    : 'unsupported';
}

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
      systemAudioMode: systemAudioModeForPlatform(
        dependencies.platform,
        dependencies.platformRelease,
      ),
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
