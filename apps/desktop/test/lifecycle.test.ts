import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  establishDesktopLifecycle,
  type DesktopLifecycleApp,
} from '../src/main/lifecycle.js';

function createApp(
  heldProfiles: Set<string>,
): DesktopLifecycleApp & { readonly userDataPath: () => string } {
  const appData = 'C:\\Users\\person\\AppData\\Roaming';
  let userData = join(appData, 'WO');
  return {
    getPath: vi.fn((name: 'appData') => {
      if (name !== 'appData') throw new Error('unexpected path');
      return appData;
    }),
    setPath: vi.fn((name: 'userData' | 'sessionData', path: string) => {
      if (name === 'userData') userData = path;
    }),
    isReady: vi.fn(() => false),
    requestSingleInstanceLock: vi.fn(() => {
      if (heldProfiles.has(userData)) return false;
      heldProfiles.add(userData);
      return true;
    }),
    quit: vi.fn(),
    on: vi.fn(),
    userDataPath: () => userData,
  };
}

describe('desktop single-instance lifecycle', () => {
  it('quits immediately and does not register listeners when the lock is denied', () => {
    const app = createApp(new Set(['C:\\Users\\person\\AppData\\Roaming\\WO']));

    const acquired = establishDesktopLifecycle({
      app,
      developmentProfile: null,
      getMainWindow: () => null,
    });

    expect(acquired).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
  });

  it('restores, shows, and focuses the main window for a second instance', () => {
    const app = createApp(new Set());
    let secondInstance: (() => void) | undefined;
    vi.mocked(app.on).mockImplementation((event, listener) => {
      if (event === 'second-instance') secondInstance = listener;
    });
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(
      establishDesktopLifecycle({
        app,
        developmentProfile: null,
        getMainWindow: () => window,
      }),
    ).toBe(true);
    secondInstance?.();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(
      window.focus.mock.invocationCallOrder[0]!,
    );
  });

  it('uses isolated development userData paths as independent lock scopes', () => {
    const heldProfiles = new Set<string>();
    const first = createApp(heldProfiles);
    const second = createApp(heldProfiles);
    const duplicate = createApp(heldProfiles);
    const profileFileSystem = { mkdirSync: vi.fn() };

    expect(
      establishDesktopLifecycle({
        app: first,
        developmentProfile: 'person-a',
        profileFileSystem,
        getMainWindow: () => null,
      }),
    ).toBe(true);
    expect(
      establishDesktopLifecycle({
        app: second,
        developmentProfile: 'person-b',
        profileFileSystem,
        getMainWindow: () => null,
      }),
    ).toBe(true);
    expect(
      establishDesktopLifecycle({
        app: duplicate,
        developmentProfile: 'person-a',
        profileFileSystem,
        getMainWindow: () => null,
      }),
    ).toBe(false);
    expect(first.userDataPath()).not.toBe(second.userDataPath());
    expect(duplicate.quit).toHaveBeenCalledOnce();
  });

  it('does not create profile directories for a production/null profile', () => {
    const app = createApp(new Set());
    const profileFileSystem = { mkdirSync: vi.fn() };

    expect(
      establishDesktopLifecycle({
        app,
        developmentProfile: null,
        profileFileSystem,
        getMainWindow: () => null,
      }),
    ).toBe(true);
    expect(profileFileSystem.mkdirSync).not.toHaveBeenCalled();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('requests the lock before secure-store creation and app readiness', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );

    const lifecycleCall = source.indexOf(
      'const ownsSingleInstance = establishDesktopLifecycle',
    );
    expect(lifecycleCall).toBeGreaterThanOrEqual(0);
    expect(lifecycleCall).toBeLessThan(
      source.lastIndexOf('createSecureSessionStore'),
    );
    expect(lifecycleCall).toBeLessThan(source.indexOf('app.whenReady()'));
  });
});
