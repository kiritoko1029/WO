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
      thumbnailSize: { width: 320, height: 180 },
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
    await expect(protectedService.list(1)).resolves.toEqual([]);
  });

  test('grants a selected source once through the independently checked handler', () => {
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
    handler?.(request, callback);
    expect(callback).toHaveBeenLastCalledWith({});
    expect(session.setDisplayMediaRequestHandler).toHaveBeenCalledWith(
      expect.any(Function),
      { useSystemPicker: false },
    );
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
    expect(
      isDisplayCaptureRequestAllowed({ ...base, audioRequested: true }, policy),
    ).toBe(false);
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

  test('derives exact HTTP and file display-capture origins', () => {
    expect(captureSecurityOrigin('https://app.example.test/index.html')).toBe(
      'https://app.example.test',
    );
    expect(captureSecurityOrigin('file:///opt/wo/index.html')).toBe('file://');
  });
});

describe('screen permission policy', () => {
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
        systemPreferences: { getMediaAccessStatus },
        shell: { openExternal: vi.fn(async () => undefined) },
      });

      expect(service.status()).toEqual({
        status,
        canOpenSettings: status === 'denied' || status === 'restricted',
      });
      expect(getMediaAccessStatus).toHaveBeenCalledWith('screen');
    },
  );

  test('opens only the fixed macOS Screen Recording settings URL', async () => {
    const openExternal = vi.fn(async () => undefined);
    const service = createScreenPermissionService({
      platform: 'darwin',
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
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
      shell: { openExternal },
    });
    const grantedMac = createScreenPermissionService({
      platform: 'darwin',
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
      shell: { openExternal },
    });

    expect(windows.status()).toEqual({
      status: 'granted',
      canOpenSettings: false,
    });
    await expect(windows.openSettings()).rejects.toThrow(/unavailable/i);
    await expect(grantedMac.openSettings()).rejects.toThrow(/unavailable/i);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
