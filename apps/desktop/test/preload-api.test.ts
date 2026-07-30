import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL } from '../src/ipc-channels.js';
import { createDesktopApi } from '../src/preload/api.js';
import type { DesktopBridge } from '../src/preload/types.js';
import { createRendererDesktopApi } from '../src/renderer/src/api/desktop-api.js';

const unusedSubscribe = () => () => undefined;

function cloneBridge(bridge: DesktopBridge): DesktopBridge {
  return {
    auth: {
      register: async (input) =>
        structuredClone(await bridge.auth.register(input)),
      login: async (input) => structuredClone(await bridge.auth.login(input)),
      verifyEmail: async (input) =>
        structuredClone(await bridge.auth.verifyEmail(input)),
      resendVerification: async (input) =>
        structuredClone(await bridge.auth.resendVerification(input)),
      changePassword: async (input) =>
        structuredClone(await bridge.auth.changePassword(input)),
      requestEmailChange: async (input) =>
        structuredClone(await bridge.auth.requestEmailChange(input)),
      confirmEmailChange: async (input) =>
        structuredClone(await bridge.auth.confirmEmailChange(input)),
      refresh: async () => structuredClone(await bridge.auth.refresh()),
      logout: async () => structuredClone(await bridge.auth.logout()),
    },
    realtime: {
      issueTicket: async (accessToken) =>
        structuredClone(await bridge.realtime.issueTicket(accessToken)),
    },
    capture: {
      list: async () => structuredClone(await bridge.capture.list()),
      select: async (token) =>
        structuredClone(await bridge.capture.select(token)),
      permission: async () =>
        structuredClone(await bridge.capture.permission()),
      openSettings: async () =>
        structuredClone(await bridge.capture.openSettings()),
      subscribeStopRequested: (listener) =>
        bridge.capture.subscribeStopRequested(listener),
    },
  };
}

describe('desktop preload API', () => {
  it('exposes only immutable auth, realtime, and capture commands', async () => {
    const authSession = {
      user: {
        userId: 'user-1',
        email: 'person@example.cn',
        displayName: 'Person',
      },
      accessToken: 'access-token',
      accessTokenExpiresAt: 1_000,
    };
    const invoke = vi.fn(async (channel: string) => {
      const value =
        channel === 'desktop:auth:logout' ||
        channel === 'desktop:auth:change-password' ||
        channel === 'desktop:capture:select' ||
        channel === 'desktop:capture:open-settings'
          ? null
          : channel === 'desktop:auth:register'
            ? { kind: 'session', session: authSession }
            : channel === 'desktop:auth:resend-verification' ||
                channel === 'desktop:auth:request-email-change'
              ? { email: authSession.user.email }
              : channel === 'desktop:realtime:issue-ticket'
                ? { ticket: 'A'.repeat(43), expiresInSeconds: 30 }
                : channel === 'desktop:capture:list'
                  ? [
                      {
                        token: '00000000-0000-4000-8000-000000000001',
                        name: 'Editor',
                        kind: 'window',
                        thumbnailDataUrl: 'data:image/png;base64,AAAA',
                      },
                    ]
                  : channel === 'desktop:capture:permission'
                    ? {
                        status: 'granted',
                        canOpenSettings: false,
                        systemAudioMode: 'loopback',
                        captureProcessElevated: false,
                      }
                    : authSession;
      return { ok: true, value };
    });
    const removeListener = vi.fn();
    const subscribe = vi.fn(() => removeListener);
    const bridge = createDesktopApi(invoke, subscribe);

    expect(Object.keys(bridge)).toEqual(['auth', 'realtime', 'capture']);
    expect(Object.keys(bridge.auth)).toEqual([
      'register',
      'login',
      'verifyEmail',
      'resendVerification',
      'changePassword',
      'requestEmailChange',
      'confirmEmailChange',
      'refresh',
      'logout',
    ]);
    expect(Object.keys(bridge.realtime)).toEqual(['issueTicket']);
    expect(Object.keys(bridge.capture)).toEqual([
      'list',
      'select',
      'permission',
      'openSettings',
      'subscribeStopRequested',
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.auth)).toBe(true);
    expect(Object.isFrozen(bridge.realtime)).toBe(true);
    expect(Object.isFrozen(bridge.capture)).toBe(true);
    expect(JSON.stringify(bridge)).not.toContain('getRefreshToken');

    await bridge.auth.register({
      email: 'person@example.cn',
      password: 'long-password',
      displayName: 'Person',
    });
    await bridge.auth.login({
      email: 'person@example.cn',
      password: 'long-password',
    });
    await bridge.auth.refresh();
    await bridge.auth.logout();
    await bridge.realtime.issueTicket('access-token');
    await expect(bridge.capture.list()).resolves.toEqual({
      ok: true,
      value: [
        {
          token: '00000000-0000-4000-8000-000000000001',
          name: 'Editor',
          kind: 'window',
          thumbnailDataUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });
    await bridge.capture.select('00000000-0000-4000-8000-000000000001');
    await expect(bridge.capture.permission()).resolves.toEqual({
      ok: true,
      value: {
        status: 'granted',
        canOpenSettings: false,
        systemAudioMode: 'loopback',
        captureProcessElevated: false,
      },
    });
    await bridge.capture.openSettings();
    const stopListener = vi.fn();
    const unsubscribe = bridge.capture.subscribeStopRequested(stopListener);
    expect(subscribe).toHaveBeenCalledWith(
      DESKTOP_CAPTURE_STOP_REQUESTED_CHANNEL,
      stopListener,
    );
    unsubscribe();
    expect(removeListener).toHaveBeenCalledOnce();

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'desktop:auth:register',
      'desktop:auth:login',
      'desktop:auth:refresh',
      'desktop:auth:logout',
      'desktop:realtime:issue-ticket',
      'desktop:capture:list',
      'desktop:capture:select',
      'desktop:capture:permission',
      'desktop:capture:open-settings',
    ]);
  });

  it('rejects capture summaries that expose unexpected platform fields', async () => {
    const bridge = createDesktopApi(
      vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            token: '00000000-0000-4000-8000-000000000001',
            name: 'Editor',
            kind: 'window',
            thumbnailDataUrl: 'data:image/png;base64,AAAA',
            id: 'window:101:0',
          },
        ],
      }),
      unusedSubscribe,
    );

    await expect(bridge.capture.list()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
  });

  it.each([
    { status: 'granted', canOpenSettings: false },
    {
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'loopback',
      captureProcessElevated: false,
      unexpected: true,
    },
    {
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'macos-loopback',
      captureProcessElevated: false,
    },
    {
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'loopback',
      captureProcessElevated: 'yes',
    },
  ])('rejects an invalid screen permission capability: %o', async (value) => {
    const bridge = createDesktopApi(
      vi.fn().mockResolvedValue({ ok: true, value }),
      unusedSubscribe,
    );

    await expect(bridge.capture.permission()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
  });

  it('accepts the same 256-code-point title bound used by main', async () => {
    const name = '😀'.repeat(256);
    const bridge = createDesktopApi(
      vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            token: '00000000-0000-4000-8000-000000000001',
            name,
            kind: 'window',
            thumbnailDataUrl: 'data:image/png;base64,AAAA',
          },
        ],
      }),
      unusedSubscribe,
    );

    await expect(bridge.capture.list()).resolves.toEqual({
      ok: true,
      value: [expect.objectContaining({ name })],
    });
  });

  it('rebuilds safe coded errors and validates strict envelopes', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'unsafe mismatched server detail',
        },
      });
    const api = createRendererDesktopApi(
      cloneBridge(createDesktopApi(invoke, unusedSubscribe)),
    );

    await expect(api.auth.refresh()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required',
    });
    await expect(
      api.realtime.issueTicket('access-token'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    });
    await expect(api.auth.refresh()).rejects.toMatchObject({
      code: 'INVALID_IPC_RESPONSE',
      message: 'IPC response was rejected',
    });
  });

  it('replaces rejected invoke details with a safe availability error', async () => {
    const api = createRendererDesktopApi(
      cloneBridge(
        createDesktopApi(
          vi.fn().mockRejectedValue(new Error('main stack token=secret')),
          unusedSubscribe,
        ),
      ),
    );

    await expect(api.auth.refresh()).rejects.toMatchObject({
      code: 'IPC_UNAVAILABLE',
      message: 'Desktop service is unavailable',
    });
  });

  it('publishes separate desktop and shell bridges through contextBridge', async () => {
    const source = await readFile(
      new URL('../src/preload/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(/contextBridge\.exposeInMainWorld\(\s*'desktop'/u);
    expect(source).toContain(
      'createDesktopApi(invoke, subscribeCaptureStop)',
    );
    expect(source).toMatch(
      /contextBridge\.exposeInMainWorld\(\s*'woShell',\s*createDesktopShellBridge\(invoke, subscribeNotification\)/u,
    );
    expect(source).toContain('createDesktopApi');
    expect(source).toContain('createCaptureStopSubscribe');
    expect(source).toContain('createDesktopShellBridge');
    expect(source).not.toContain('ipcRenderer.send');
    expect(source).toContain('ipcRenderer.on(channel, handler)');
    expect(source).toContain('ipcRenderer.removeListener(channel, handler)');
    expect(source).not.toContain('webFrame');
  });

  it('publishes a narrow IPC-backed clipboard writer through both preloads', async () => {
    const sources = await Promise.all(
      ['index.ts', 'index.acceptance.ts'].map((entry) =>
        readFile(new URL(`../src/preload/${entry}`, import.meta.url), 'utf8'),
      ),
    );

    for (const source of sources) {
      expect(source).toContain(
        "import { contextBridge, ipcRenderer } from 'electron';",
      );
      expect(source).toMatch(
        /contextBridge\.exposeInMainWorld\(\s*'woClipboard',\s*createDesktopClipboardBridge\(invoke\)/u,
      );
      expect(source).not.toMatch(
        /import\s*\{[^}]*\bclipboard\b[^}]*\}\s*from\s*'electron'/u,
      );
      expect(source).not.toContain('readText');
    }
  });
});
