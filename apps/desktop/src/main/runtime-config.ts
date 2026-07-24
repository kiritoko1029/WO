import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGED_RENDERER_ENTRY } from './packaged-renderer-protocol.js';

export interface DesktopRuntimeConfig {
  readonly apiOrigin: string;
  readonly realtimeOrigin: string;
  readonly rendererEntry: string;
  readonly developmentProfile: string | null;
  readonly isPackaged: boolean;
}

export interface RuntimeConfigInput {
  readonly apiOrigin: string;
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly packagedRendererEntry: string;
}

export type RuntimeProfileInput = Pick<
  RuntimeConfigInput,
  'isPackaged' | 'environment'
>;

export interface ProfileApp {
  getPath(name: 'appData'): string;
  setPath(name: 'userData' | 'sessionData', path: string): void;
  isReady(): boolean;
}

export interface ProfileFileSystem {
  mkdirSync(
    path: string,
    options: { readonly recursive: true; readonly mode: number },
  ): unknown;
}

const nodeProfileFileSystem: ProfileFileSystem = { mkdirSync };

const DEVELOPMENT_PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

export function canonicalHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    value.length > 2_048 ||
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Backend origin must be a canonical HTTPS origin');
  }
  return url.origin;
}

function packagedEntry(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'file:' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/index.html')
  ) {
    throw new TypeError('Packaged renderer entry is invalid');
  }
  return PACKAGED_RENDERER_ENTRY;
}

function developmentEntry(value: string): string {
  const url = new URL(value);
  const isLoopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]';
  if (
    !isLoopback ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Development renderer URL is invalid');
  }
  return `${url.origin}/`;
}

function profile(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!DEVELOPMENT_PROFILE_PATTERN.test(value)) {
    throw new TypeError('WO_DEV_PROFILE is invalid');
  }
  return value;
}

export function loadRuntimeConfig(
  input: RuntimeConfigInput,
): Readonly<DesktopRuntimeConfig> {
  const apiOrigin = canonicalHttpsOrigin(input.apiOrigin);
  const apiUrl = new URL(apiOrigin);
  apiUrl.protocol = 'wss:';

  return Object.freeze({
    apiOrigin,
    realtimeOrigin: apiUrl.origin,
    rendererEntry: input.isPackaged
      ? packagedEntry(input.packagedRendererEntry)
      : developmentEntry(
          input.environment.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:5173',
        ),
    developmentProfile: resolveDevelopmentProfile(input),
    isPackaged: input.isPackaged,
  });
}

export function resolveDevelopmentProfile(
  input: RuntimeProfileInput,
): string | null {
  return input.isPackaged ? null : profile(input.environment.WO_DEV_PROFILE);
}

export function applyDevelopmentProfile(
  app: ProfileApp,
  developmentProfile: string,
  fileSystem: ProfileFileSystem = nodeProfileFileSystem,
): void {
  if (!DEVELOPMENT_PROFILE_PATTERN.test(developmentProfile)) {
    throw new TypeError('Development profile is invalid');
  }
  if (app.isReady()) {
    throw new Error('Development profile must be applied before app readiness');
  }
  const profilePath = join(
    app.getPath('appData'),
    'wo-desktop-development',
    developmentProfile,
  );
  const sessionPath = join(profilePath, 'session-data');
  fileSystem.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  fileSystem.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  app.setPath('userData', profilePath);
  app.setPath('sessionData', sessionPath);
}
