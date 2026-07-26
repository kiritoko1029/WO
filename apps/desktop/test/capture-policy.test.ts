import { describe, expect, test, vi } from 'vitest';

import {
  captureSecurityOrigin,
  createCaptureSourceBroker,
  isDisplayCaptureRequestAllowed,
} from '../src/main/capture-policy.js';
import {
  createCaptureSourceService,
  installDisplayMediaHandler,
  type DesktopCaptureSource,
} from '../src/main/capture-sources.js';
import {
  createScreenPermissionService,
  systemAudioModeForPlatform,
  type ScreenPermissionStatus,
} from '../src/main/permissions.js';

const sources = [
  { id: 'window:101:0', name: 'Private document' },
  { id: 'screen:202:0', name: 'Entire screen' },
] as const;

describe('desktop capture source policy', () => {
  test('issues opaque short-lived tokens bound to one WebContents', () => {
    let nowMs = 1_000;
    let token = 0;
    const broker = createCaptureSourceBroker({
      now: () => nowMs,
      tokenTtlMs: 30_000,
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });

    const listed = broker.replaceAvailable(7, sources);

    expect(listed).toEqual([
      {
        token: '00000000-0000-4000-8000-000000000001',
        name: 'Private document',
      },
      { token: '00000000-0000-4000-8000-000000000002', name: 'Entire screen' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('window:101:0');
    expect(JSON.stringify(listed)).not.toContain('screen:202:0');
    broker.select(7, listed[0]!.token);
    expect(() => broker.consumeSelected(8)).toThrow(/unavailable/i);
    expect(broker.consumeSelected(7)).toBe(sources[0]);
    expect(() => broker.consumeSelected(7)).toThrow(/unavailable/i);
    expect(() => broker.select(7, listed[1]!.token)).toThrow(/not enumerated/i);

    const refreshed = broker.replaceAvailable(7, [sources[1]]);
    nowMs += 30_001;
    expect(() => broker.select(7, refreshed[0]!.token)).toThrow(/expired/i);
  });

  test('clears stale tokens and rejects renderer source IDs or paths', () => {
    let token = 0;
    const broker = createCaptureSourceBroker({
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });
    const first = broker.replaceAvailable(4, sources);
    broker.replaceAvailable(4, [sources[1]]);

    expect(() => broker.select(4, first[0]!.token)).toThrow(/not enumerated/i);
    expect(() => broker.select(4, 'window:101:0')).toThrow(/token/i);
    expect(() => broker.select(4, 'C:\\Users\\person\\secret.txt')).toThrow(
      /token/i,
    );
    broker.clear(4);
    expect(() => broker.select(4, first[1]!.token)).toThrow(/not enumerated/i);
  });

  test('preserves an opaque selection across refresh while the source remains available', () => {
    let nowMs = 1_000;
    let token = 0;
    const broker = createCaptureSourceBroker({
      now: () => nowMs,
      tokenTtlMs: 30_000,
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });
    const first = broker.replaceAvailable(7, sources);
    broker.select(7, first[0]!.token);
    nowMs += 20_000;
    const refreshedSource = {
      id: sources[0].id,
      name: 'Private document (updated)',
    };

    const refreshed = broker.replaceAvailable(7, [refreshedSource, sources[1]]);

    expect(refreshed[0]!.token).toBe(first[0]!.token);
    expect(refreshed[1]!.token).not.toBe(first[1]!.token);
    expect(refreshed[0]!.name).toBe('Private document (updated)');
    nowMs += 20_000;
    expect(broker.consumeSelected(7)).toBe(refreshedSource);
  });

  test('revokes a selected token when its source disappears during refresh', () => {
    let token = 0;
    const broker = createCaptureSourceBroker({
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });
    const first = broker.replaceAvailable(7, sources);
    broker.select(7, first[0]!.token);

    const refreshed = broker.replaceAvailable(7, [sources[1]]);

    expect(refreshed[0]!.token).not.toBe(first[1]!.token);
    expect(() => broker.select(7, first[0]!.token)).toThrow(/not enumerated/i);
    expect(() => broker.consumeSelected(7)).toThrow(/no capture source/i);
  });

  test('returns bounded picker summaries without raw platform identifiers', async () => {
    let token = 0;
    const broker = createCaptureSourceBroker<DesktopCaptureSource>({
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });
    const getSources = vi.fn(async () => [
      {
        id: 'window:101:0',
        name: 'Editor',
        display_id: 'display-secret',
        appIcon: { secretHandle: 42 },
        thumbnail: {
          toDataURL: () => 'data:image/png;base64,AAAA',
          getSize: () => ({ width: 320, height: 180 }),
        },
        path: 'C:\\private\\document.txt',
      },
      {
        id: 'screen:202:0',
        name: 'Screen 1',
        display_id: '202',
        appIcon: null,
        thumbnail: {
          toDataURL: () => 'data:image/png;base64,BBBB',
          getSize: () => ({ width: 320, height: 180 }),
        },
      },
    ]);
    const service = createCaptureSourceService({
      broker,
      desktopCapturer: { getSources },
    });

    const listed = await service.list(9);

    expect(getSources).toHaveBeenCalledWith({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
      thumbnailSize: { width: 200, height: 112 },
    });
    expect(listed).toEqual([
      {
        token: '00000000-0000-4000-8000-000000000001',
        name: 'Editor',
        kind: 'window',
        thumbnailDataUrl: 'data:image/png;base64,AAAA',
      },
      {
        token: '00000000-0000-4000-8000-000000000002',
        name: 'Screen 1',
        kind: 'screen',
        thumbnailDataUrl: 'data:image/png;base64,BBBB',
      },
    ]);
    const serialized = JSON.stringify(listed);
    for (const secret of [
      'window:101:0',
      'screen:202:0',
      'display-secret',
      'secretHandle',
      'private',
      'appIcon',
      'display_id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('normalizes hostile platform titles instead of failing the picker', async () => {
    let token = 0;
    const broker = createCaptureSourceBroker<DesktopCaptureSource>({
      randomToken: () =>
        `00000000-0000-4000-8000-${String(++token).padStart(12, '0')}`,
    });
    const service = createCaptureSourceService({
      broker,
      desktopCapturer: {
        getSources: async () => [
          {
            id: 'window:1:0',
            name: '  Editor\u0000\n  ',
            thumbnail: {
              toDataURL: () => 'data:image/png;base64,AAAA',
              getSize: () => ({ width: 320, height: 180 }),
            },
          },
          {
            id: 'screen:1:0',
            name: '\u0000\n',
            thumbnail: {
              toDataURL: () => 'data:image/png;base64,BBBB',
              getSize: () => ({ width: 320, height: 180 }),
            },
          },
          {
            id: 'window:2:0',
            name: '😀'.repeat(300),
            thumbnail: {
              toDataURL: () => 'data:image/png;base64,CCCC',
              getSize: () => ({ width: 320, height: 180 }),
            },
          },
        ],
      },
    });

    const listed = await service.list(3);

    expect(listed.slice(0, 2).map(({ name }) => name)).toEqual([
      'Editor',
      'Unnamed screen',
    ]);
    expect([...listed[2]!.name]).toHaveLength(256);
  });

  test('rejects excessive source counts and thumbnail payloads', async () => {
    const broker = createCaptureSourceBroker<DesktopCaptureSource>();
    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      id: `window:${index}:0`,
      name: `Window ${index}`,
      thumbnail: {
        toDataURL: () => 'data:image/png;base64,AA==',
        getSize: () => ({ width: 320, height: 180 }),
      },
    }));
    const countService = createCaptureSourceService({
      broker,
      desktopCapturer: { getSources: async () => tooMany },
    });
    await expect(countService.list(1)).rejects.toThrow(/too many/i);

    const thumbnailService = createCaptureSourceService({
      broker,
      desktopCapturer: {
        getSources: async () => [
          {
            id: 'window:1:0',
            name: 'Window',
            thumbnail: {
              toDataURL: () => `data:image/png;base64,${'A'.repeat(524_289)}`,
              getSize: () => ({ width: 320, height: 180 }),
            },
          },
        ],
      },
    });
    await expect(thumbnailService.list(1)).rejects.toThrow(/thumbnail/i);

    const dimensionsService = createCaptureSourceService({
      broker,
      desktopCapturer: {
        getSources: async () => [
          {
            id: 'screen:1:0',
            name: 'Screen',
            thumbnail: {
              toDataURL: () => 'data:image/png;base64,AAAA',
              getSize: () => ({ width: 1_280, height: 720 }),
            },
          },
        ],
      },
    });
    await expect(dimensionsService.list(1)).rejects.toThrow(/dimensions/i);

    const protectedService = createCaptureSourceService({
      broker,
      desktopCapturer: {
        getSources: async () => [
          {
            id: 'window:protected:0',
            name: 'Protected window',
            thumbnail: {
              toDataURL: () => 'data:image/png;base64,',
              getSize: () => ({ width: 0, height: 0 }),
            },
          },
        ],
      },
    });
    // Sources with a 0×0 thumbnail (protected/minimized windows) are no
    // longer dropped — they get a placeholder so they still appear in the
    // picker and the user can select them via the system dialog.
    const protectedResult = await protectedService.list(1);
    expect(protectedResult).toHaveLength(1);
    expect(protectedResult[0]).toMatchObject({
      name: 'Protected window',
      kind: 'window',
    });
    expect(protectedResult[0]!.thumbnailDataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  test.each([
    ['win32', '10.0.26100'],
    ['darwin', '23.2.0'],
  ] as const)(
    'grants a selected source once with loopback on %s %s',
    (platform, platformRelease) => {
      const broker = createCaptureSourceBroker({
        randomToken: () => '00000000-0000-4000-8000-000000000001',
      });
      const [summary] = broker.replaceAvailable(12, [sources[0]]);
      broker.select(12, summary!.token);
      const mainFrame = { url: 'https://app.example.test/index.html' };
      let handler:
        | ((
            request: Record<string, unknown>,
            callback: (value: unknown) => void,
          ) => void)
        | undefined;
      const session = {
        setDisplayMediaRequestHandler: vi.fn((next) => {
          handler = next;
        }),
      };
      installDisplayMediaHandler({
        session,
        webContents: { id: 12, mainFrame },
        rendererEntry: mainFrame.url,
        broker,
        platform,
        platformRelease,
      });
      const callback = vi.fn();
      const request = {
        frame: mainFrame,
        securityOrigin: 'https://app.example.test',
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      };

      handler?.({ ...request, audioRequested: true }, callback);
      // Audio is now allowed — handler provides loopback audio alongside video.
      expect(callback).toHaveBeenLastCalledWith({
        video: sources[0],
        audio: 'loopback',
      });
      // Second call: source already consumed, callback falls back gracefully.
      handler?.(request, callback);
      expect(callback).toHaveBeenLastCalledWith({});
      expect(session.setDisplayMediaRequestHandler).toHaveBeenCalledWith(
        expect.any(Function),
        { useSystemPicker: false },
      );
    },
  );

  test('fails closed for unsupported system audio without consuming the selected source', () => {
    const broker = createCaptureSourceBroker({
      randomToken: () => '00000000-0000-4000-8000-000000000001',
    });
    const [summary] = broker.replaceAvailable(12, [sources[0]]);
    broker.select(12, summary!.token);
    const mainFrame = { url: 'https://app.example.test/index.html' };
    let handler:
      | ((
          request: Record<string, unknown>,
          callback: (value: unknown) => void,
        ) => void)
      | undefined;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      }),
    };
    installDisplayMediaHandler({
      session,
      webContents: { id: 12, mainFrame },
      rendererEntry: mainFrame.url,
      broker,
      platform: 'darwin',
      platformRelease: '23.1.0',
    });
    const callback = vi.fn();
    const request = {
      frame: mainFrame,
      securityOrigin: 'https://app.example.test',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    };

    handler?.({ ...request, audioRequested: true }, callback);
    expect(callback).toHaveBeenLastCalledWith({});

    handler?.(request, callback);
    expect(callback).toHaveBeenLastCalledWith({ video: sources[0] });
  });

  test('uses the macOS 15 system picker without consuming a custom source token', () => {
    const broker = createCaptureSourceBroker({
      randomToken: () => '00000000-0000-4000-8000-000000000001',
    });
    const [summary] = broker.replaceAvailable(12, [sources[0]]);
    broker.select(12, summary!.token);
    const mainFrame = { url: 'https://app.example.test/index.html' };
    let handler:
      | ((
          request: Record<string, unknown>,
          callback: (value: unknown) => void,
        ) => void)
      | undefined;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      }),
    };
    installDisplayMediaHandler({
      session,
      webContents: { id: 12, mainFrame },
      rendererEntry: mainFrame.url,
      broker,
      platform: 'darwin',
      platformRelease: '24.0.0',
    });
    const callback = vi.fn();

    handler?.(
      {
        frame: mainFrame,
        securityOrigin: 'https://app.example.test',
        videoRequested: true,
        audioRequested: true,
        userGesture: true,
      },
      callback,
    );

    expect(callback).toHaveBeenLastCalledWith({});
    expect(session.setDisplayMediaRequestHandler).toHaveBeenCalledWith(
      expect.any(Function),
      { useSystemPicker: true },
    );
    expect(broker.consumeSelected(12)).toBe(sources[0]);
  });

  test('authorizes only a trusted main-frame, user-gesture, video-only request', () => {
    const mainFrame = { url: 'https://app.example.test/index.html' };
    const base = {
      frame: mainFrame,
      securityOrigin: 'https://app.example.test',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    };
    const policy = {
      mainFrame,
      rendererEntry: 'https://app.example.test/index.html',
    };

    expect(isDisplayCaptureRequestAllowed(base, policy)).toBe(true);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...base, securityOrigin: 'https://app.example.test/' },
        policy,
      ),
    ).toBe(true);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...base, frame: { ...mainFrame } },
        policy,
      ),
    ).toBe(false);
    expect(
      isDisplayCaptureRequestAllowed({ ...base, userGesture: false }, policy),
    ).toBe(false);
    // Audio alongside video is now allowed (desktop audio sharing).
    expect(
      isDisplayCaptureRequestAllowed({ ...base, audioRequested: true }, policy),
    ).toBe(true);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...base, videoRequested: false },
        policy,
      ),
    ).toBe(false);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...base, securityOrigin: 'https://evil.example' },
        policy,
      ),
    ).toBe(false);
    for (const securityOrigin of [
      'https://user@app.example.test/',
      'https://app.example.test:444/',
      'https://app.example.test/path',
      'https://app.example.test/?query=1',
      'https://app.example.test/#fragment',
      'not a URL',
    ]) {
      expect(
        isDisplayCaptureRequestAllowed({ ...base, securityOrigin }, policy),
      ).toBe(false);
    }
  });

  test('derives exact HTTP, file, and packaged display-capture origins', () => {
    expect(captureSecurityOrigin('https://app.example.test/index.html')).toBe(
      'https://app.example.test',
    );
    expect(captureSecurityOrigin('file:///opt/wo/index.html')).toBe('file://');
    expect(captureSecurityOrigin('wo-app://bundle/index.html')).toBe(
      'wo-app://bundle',
    );
    for (const rendererEntry of [
      'wo-app://attacker/index.html',
      'wo-app://bundle:444/index.html',
      'wo-app://user@bundle/index.html',
      'wo-app://user:password@bundle/index.html',
    ]) {
      expect(captureSecurityOrigin(rendererEntry)).not.toBe('wo-app://bundle');
    }
  });

  test('accepts only the exact packaged renderer display-capture origin', () => {
    const mainFrame = { url: 'wo-app://bundle/index.html' };
    const request = {
      frame: mainFrame,
      securityOrigin: 'wo-app://bundle',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    };
    const policy = {
      mainFrame,
      rendererEntry: mainFrame.url,
    };

    expect(isDisplayCaptureRequestAllowed(request, policy)).toBe(true);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...request, securityOrigin: 'wo-app://bundle/' },
        policy,
      ),
    ).toBe(true);
    for (const securityOrigin of [
      'wo-app://attacker',
      'wo-app://bundle:444',
      'wo-app://user@bundle',
      'wo-app://user:password@bundle',
      'wo-app://bundle/path',
      'wo-app://bundle/?query=1',
      'wo-app://bundle/#fragment',
    ]) {
      expect(
        isDisplayCaptureRequestAllowed({ ...request, securityOrigin }, policy),
      ).toBe(false);
    }
    for (const frameUrl of [
      'wo-app://attacker/index.html',
      'wo-app://bundle:444/index.html',
      'wo-app://user@bundle/index.html',
    ]) {
      const attackerFrame = { url: frameUrl };
      expect(
        isDisplayCaptureRequestAllowed(
          { ...request, frame: attackerFrame },
          { ...policy, mainFrame: attackerFrame },
        ),
      ).toBe(false);
    }
  });

  test('accepts Electron packaged file origins without allowing file paths', () => {
    const mainFrame = { url: 'file:///opt/wo/index.html' };
    const request = {
      frame: mainFrame,
      securityOrigin: 'file:///',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    };
    const policy = {
      mainFrame,
      rendererEntry: mainFrame.url,
    };

    expect(isDisplayCaptureRequestAllowed(request, policy)).toBe(true);
    expect(
      isDisplayCaptureRequestAllowed(
        { ...request, securityOrigin: 'file:///tmp' },
        policy,
      ),
    ).toBe(false);
  });
});

describe('screen permission policy', () => {
  test.each([
    ['win32', '10.0.26100', 'loopback'],
    ['darwin', '23.1.0', 'unsupported'],
    ['darwin', '23.2.0', 'loopback'],
    ['darwin', '23.6.0', 'loopback'],
    ['darwin', '23', 'unsupported'],
    ['darwin', '23.2beta', 'unsupported'],
    ['darwin', '24.0.0', 'native-picker'],
    ['darwin', '25', 'native-picker'],
    ['darwin', '24beta', 'unsupported'],
    ['darwin', '24.999999999999999999999', 'unsupported'],
    ['darwin', '24.0.999999999999999999999', 'unsupported'],
    ['linux', '24.0.0', 'unsupported'],
  ] as const)(
    'maps %s release %s to %s system audio',
    (platform, platformRelease, expected) => {
      expect(systemAudioModeForPlatform(platform, platformRelease)).toBe(
        expected,
      );
    },
  );

  test.each<ScreenPermissionStatus>([
    'not-determined',
    'granted',
    'denied',
    'restricted',
    'unknown',
  ])(
    'reports the macOS system screen status %s without bypassing it',
    (status) => {
      const getMediaAccessStatus = vi.fn(() => status);
      const service = createScreenPermissionService({
        platform: 'darwin',
        platformRelease: '23.6.0',
        systemPreferences: { getMediaAccessStatus },
        shell: { openExternal: vi.fn(async () => undefined) },
      });

      expect(service.status()).toEqual({
        status,
        canOpenSettings: status === 'denied' || status === 'restricted',
        systemAudioMode: 'loopback',
      });
      expect(getMediaAccessStatus).toHaveBeenCalledWith('screen');
    },
  );

  test('opens only the fixed macOS Screen Recording settings URL', async () => {
    const openExternal = vi.fn(async () => undefined);
    const service = createScreenPermissionService({
      platform: 'darwin',
      platformRelease: '23.6.0',
      systemPreferences: { getMediaAccessStatus: () => 'denied' },
      shell: { openExternal },
    });

    await service.openSettings();

    expect(openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  test('does not offer a settings bypass on other platforms or granted macOS', async () => {
    const openExternal = vi.fn(async () => undefined);
    const windows = createScreenPermissionService({
      platform: 'win32',
      platformRelease: '10.0.26100',
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
      shell: { openExternal },
    });
    const grantedMac = createScreenPermissionService({
      platform: 'darwin',
      platformRelease: '24.0.0',
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
      shell: { openExternal },
    });

    expect(windows.status()).toEqual({
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'loopback',
    });
    expect(grantedMac.status()).toEqual({
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'native-picker',
    });
    await expect(windows.openSettings()).rejects.toThrow(/unavailable/i);
    await expect(grantedMac.openSettings()).rejects.toThrow(/unavailable/i);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
