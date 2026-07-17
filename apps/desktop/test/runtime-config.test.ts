import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  applyDevelopmentProfile,
  loadRuntimeConfig,
} from '../src/main/runtime-config.js';

describe('desktop runtime configuration', () => {
  it('validates immutable API, realtime, and exact development renderer origins', () => {
    const config = loadRuntimeConfig({
      apiOrigin: 'https://rtc.example.cn:8443',
      isPackaged: false,
      environment: {
        ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173',
        WO_DEV_PROFILE: 'person-a',
      },
      packagedRendererEntry: 'file:///C:/app/out/renderer/index.html',
    });

    expect(config).toEqual({
      apiOrigin: 'https://rtc.example.cn:8443',
      realtimeOrigin: 'wss://rtc.example.cn:8443',
      rendererEntry: 'http://127.0.0.1:5173/',
      developmentProfile: 'person-a',
      isPackaged: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    'http://rtc.example.cn',
    'https://rtc.example.cn/api',
    'https://rtc.example.cn?x=1',
  ])('rejects invalid API origin %s', (apiOrigin) => {
    expect(() =>
      loadRuntimeConfig({
        apiOrigin,
        isPackaged: false,
        environment: {},
        packagedRendererEntry: 'file:///C:/app/out/renderer/index.html',
      }),
    ).toThrow(TypeError);
  });

  it.each([
    'https://example.cn',
    'http://127.0.0.1:5173/other',
    'file:///C:/source/index.html',
  ])('rejects an unsafe development renderer entry %s', (rendererUrl) => {
    expect(() =>
      loadRuntimeConfig({
        apiOrigin: 'https://localhost',
        isPackaged: false,
        environment: { ELECTRON_RENDERER_URL: rendererUrl },
        packagedRendererEntry: 'file:///C:/app/out/renderer/index.html',
      }),
    ).toThrow(TypeError);
  });

  it('ignores development renderer/profile variables in packaged builds', () => {
    const config = loadRuntimeConfig({
      apiOrigin: 'https://localhost',
      isPackaged: true,
      environment: {
        ELECTRON_RENDERER_URL: 'https://attacker.invalid',
        WO_DEV_PROFILE: '..\\shared',
      },
      packagedRendererEntry: 'file:///C:/app/out/renderer/index.html',
    });

    expect(config.rendererEntry).toBe('file:///C:/app/out/renderer/index.html');
    expect(config.developmentProfile).toBeNull();
  });

  it('sets a contained development userData directory before ready', () => {
    const operations: string[] = [];
    const app = {
      getPath: vi.fn(() => 'C:\\Users\\person\\AppData\\Roaming'),
      setPath: vi.fn((name: string, path: string) => {
        operations.push(`set:${name}:${path}`);
      }),
      isReady: vi.fn(() => false),
    };
    const fileSystem = {
      mkdirSync: vi.fn((path: string) => {
        operations.push(`mkdir:${path}`);
      }),
    };

    applyDevelopmentProfile(app, 'person-a', fileSystem);

    const profilePath = join(
      'C:\\Users\\person\\AppData\\Roaming',
      'wo-desktop-development',
      'person-a',
    );
    const sessionPath = join(profilePath, 'session-data');
    expect(fileSystem.mkdirSync).toHaveBeenNthCalledWith(1, profilePath, {
      recursive: true,
      mode: 0o700,
    });
    expect(fileSystem.mkdirSync).toHaveBeenNthCalledWith(2, sessionPath, {
      recursive: true,
      mode: 0o700,
    });
    expect(app.setPath.mock.calls).toEqual([
      ['userData', profilePath],
      ['sessionData', sessionPath],
    ]);
    expect(operations).toEqual([
      `mkdir:${profilePath}`,
      `mkdir:${sessionPath}`,
      `set:userData:${profilePath}`,
      `set:sessionData:${sessionPath}`,
    ]);
  });

  it('creates the same contained directories idempotently for one profile', () => {
    const app = {
      getPath: vi.fn(() => 'C:\\app-data'),
      setPath: vi.fn(),
      isReady: vi.fn(() => false),
    };
    const fileSystem = { mkdirSync: vi.fn() };

    applyDevelopmentProfile(app, 'person-a', fileSystem);
    applyDevelopmentProfile(app, 'person-a', fileSystem);

    expect(fileSystem.mkdirSync).toHaveBeenCalledTimes(4);
    expect(new Set(app.setPath.mock.calls.map(([, path]) => path)).size).toBe(
      2,
    );
  });

  it('rejects invalid profiles and calls made after app readiness', () => {
    const app = {
      getPath: vi.fn(() => 'C:\\app-data'),
      setPath: vi.fn(),
      isReady: vi.fn(() => false),
    };

    expect(() =>
      applyDevelopmentProfile(app, '..\\shared', { mkdirSync: vi.fn() }),
    ).toThrow(TypeError);
    app.isReady.mockReturnValue(true);
    expect(() =>
      applyDevelopmentProfile(app, 'person-a', { mkdirSync: vi.fn() }),
    ).toThrow(Error);
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
