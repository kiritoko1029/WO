import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createDesktopApi } from '../src/preload/api.js';
import type { DesktopBridge } from '../src/preload/types.js';
import { createRendererDesktopApi } from '../src/renderer/src/api/desktop-api.js';

function cloneBridge(bridge: DesktopBridge): DesktopBridge {
  return {
    auth: {
      register: async (input) =>
        structuredClone(await bridge.auth.register(input)),
      login: async (input) => structuredClone(await bridge.auth.login(input)),
      refresh: async () => structuredClone(await bridge.auth.refresh()),
      logout: async () => structuredClone(await bridge.auth.logout()),
    },
    realtime: {
      issueTicket: async (accessToken) =>
        structuredClone(await bridge.realtime.issueTicket(accessToken)),
    },
  };
}

describe('desktop preload API', () => {
  it('exposes exactly five immutable auth and realtime commands', async () => {
    const authSession = {
      user: {
        userId: 'user-1',
        email: 'person@example.cn',
        displayName: 'Person',
      },
      accessToken: 'access-token',
      accessTokenExpiresAt: 1_000,
    };
    const invoke = vi.fn(async (channel: string) => ({
      ok: true,
      value:
        channel === 'desktop:auth:logout'
          ? null
          : channel === 'desktop:realtime:issue-ticket'
            ? { ticket: 'A'.repeat(43), expiresInSeconds: 30 }
            : authSession,
    }));
    const bridge = createDesktopApi(invoke);

    expect(Object.keys(bridge)).toEqual(['auth', 'realtime']);
    expect(Object.keys(bridge.auth)).toEqual([
      'register',
      'login',
      'refresh',
      'logout',
    ]);
    expect(Object.keys(bridge.realtime)).toEqual(['issueTicket']);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.auth)).toBe(true);
    expect(Object.isFrozen(bridge.realtime)).toBe(true);
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

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'desktop:auth:register',
      'desktop:auth:login',
      'desktop:auth:refresh',
      'desktop:auth:logout',
      'desktop:realtime:issue-ticket',
    ]);
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
    const api = createRendererDesktopApi(cloneBridge(createDesktopApi(invoke)));

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
        ),
      ),
    );

    await expect(api.auth.refresh()).rejects.toMatchObject({
      code: 'IPC_UNAVAILABLE',
      message: 'Desktop service is unavailable',
    });
  });

  it('publishes only the frozen desktop API through contextBridge', async () => {
    const source = await readFile(
      new URL('../src/preload/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(/contextBridge\.exposeInMainWorld\(\s*'desktop'/u);
    expect(source).toContain('createDesktopApi');
    expect(source).not.toContain('ipcRenderer.send');
    expect(source).not.toContain('ipcRenderer.on');
    expect(source).not.toContain('webFrame');
  });
});
