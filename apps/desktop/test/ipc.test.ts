import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_IPC_CHANNELS,
  registerDesktopIpc,
  type DesktopIpcMain,
} from '../src/main/ipc.js';
import { createDesktopApi } from '../src/preload/api.js';
import type { DesktopBridge } from '../src/preload/types.js';
import { createRendererDesktopApi } from '../src/renderer/src/api/desktop-api.js';

const rendererEntry = 'file:///C:/app/out/renderer/index.html';

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

function createHarness() {
  const handlers = new Map<
    string,
    (event: unknown, ...args: readonly unknown[]) => unknown
  >();
  const ipcMain = {
    handle: vi.fn((channel, handler) => {
      handlers.set(channel, handler);
    }),
  } satisfies DesktopIpcMain;
  const auth = {
    register: vi.fn().mockResolvedValue({ kind: 'register' }),
    login: vi.fn().mockResolvedValue({ kind: 'login' }),
    refresh: vi.fn().mockResolvedValue({ kind: 'refresh' }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const realtime = {
    issueTicket: vi
      .fn()
      .mockResolvedValue({ ticket: 'A'.repeat(43), expiresInSeconds: 30 }),
  };
  registerDesktopIpc(ipcMain, { auth, realtime, rendererEntry });
  const mainFrame = { url: rendererEntry };
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  return { auth, event, handlers, ipcMain, realtime };
}

describe('desktop IPC boundary', () => {
  it('registers exactly the five explicitly allowlisted handlers', () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()]).toEqual([...DESKTOP_IPC_CHANNELS]);
    expect(DESKTOP_IPC_CHANNELS).toEqual([
      'desktop:auth:register',
      'desktop:auth:login',
      'desktop:auth:refresh',
      'desktop:auth:logout',
      'desktop:realtime:issue-ticket',
    ]);
  });

  it('validates arguments before invoking every broker operation', async () => {
    const { auth, event, handlers, realtime } = createHarness();

    await expect(
      handlers.get('desktop:auth:register')?.(event, {
        email: ' PERSON@EXAMPLE.CN ',
        password: 'long-password',
        displayName: ' Person ',
      }),
    ).resolves.toEqual({ ok: true, value: { kind: 'register' } });
    expect(auth.register).toHaveBeenCalledWith({
      email: 'person@example.cn',
      password: 'long-password',
      displayName: 'Person',
    });

    await expect(
      handlers.get('desktop:auth:login')?.(event, {
        email: 'person@example.cn',
        password: 'long-password',
      }),
    ).resolves.toEqual({ ok: true, value: { kind: 'login' } });
    await expect(
      handlers.get('desktop:auth:refresh')?.(event),
    ).resolves.toEqual({ ok: true, value: { kind: 'refresh' } });
    await expect(handlers.get('desktop:auth:logout')?.(event)).resolves.toEqual(
      { ok: true, value: null },
    );
    await expect(
      handlers.get('desktop:realtime:issue-ticket')?.(event, 'access-token'),
    ).resolves.toEqual({
      ok: true,
      value: { ticket: 'A'.repeat(43), expiresInSeconds: 30 },
    });
    expect(realtime.issueTicket).toHaveBeenCalledWith('access-token');

    const invalidArguments = {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENTS',
        message: 'IPC arguments were rejected',
      },
    };
    await expect(
      handlers.get('desktop:auth:refresh')?.(event, 'extra'),
    ).resolves.toEqual(invalidArguments);
    await expect(
      handlers.get('desktop:auth:login')?.(event, {
        email: 'bad',
        password: 'short',
      }),
    ).resolves.toEqual(invalidArguments);
    await expect(
      handlers.get('desktop:realtime:issue-ticket')?.(event, ''),
    ).resolves.toEqual(invalidArguments);
  });

  it('serializes broker failures into fixed safe envelopes without stack or secrets', async () => {
    const harness = createHarness();
    harness.auth.login.mockRejectedValue(
      Object.assign(new Error('password=server-secret'), {
        code: 'INVALID_CREDENTIALS',
        stack: 'private stack and token',
      }),
    );

    const raw = await harness.handlers.get('desktop:auth:login')?.(
      harness.event,
      { email: 'person@example.cn', password: 'long-password' },
    );
    const serialized = structuredClone(raw);

    expect(serialized).toEqual({
      ok: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Authentication failed',
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('server-secret');
    expect(JSON.stringify(serialized)).not.toContain('stack');
    expect(Object.keys(serialized as object)).toEqual(['ok', 'error']);
  });

  it('preserves safe codes across a simulated Electron serialization boundary', async () => {
    const harness = createHarness();
    harness.auth.refresh.mockRejectedValue(
      Object.assign(new Error('network detail'), { code: 'NETWORK_ERROR' }),
    );
    harness.realtime.issueTicket.mockRejectedValue(
      Object.assign(new Error('rate detail'), { code: 'RATE_LIMITED' }),
    );
    const invoke = async (channel: string, ...arguments_: readonly unknown[]) =>
      structuredClone(
        await harness.handlers.get(channel)?.(harness.event, ...arguments_),
      );
    const api = createRendererDesktopApi(cloneBridge(createDesktopApi(invoke)));

    await expect(api.auth.refresh()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The server is unavailable',
    });
    await expect(
      api.realtime.issueTicket('access-token'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    });
  });

  it.each([
    {
      name: 'missing sender frame',
      event: { senderFrame: null, sender: { mainFrame: {} } },
    },
    {
      name: 'subframe sender',
      event: { senderFrame: { url: rendererEntry }, sender: { mainFrame: {} } },
    },
    {
      name: 'wrong exact renderer URL',
      event: {
        senderFrame: { url: 'file:///C:/app/out/renderer/other.html' },
        sender: {
          mainFrame: { url: 'file:///C:/app/out/renderer/other.html' },
        },
      },
    },
  ])('rejects $name before invoking a broker', async ({ event }) => {
    const harness = createHarness();
    if (event.senderFrame !== null && 'mainFrame' in event.sender) {
      event.sender.mainFrame = event.senderFrame;
      if (event.senderFrame.url === rendererEntry) {
        event.sender.mainFrame = {};
      }
    }

    await expect(
      harness.handlers.get('desktop:auth:refresh')?.(event),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'IPC_FORBIDDEN',
        message: 'IPC request was rejected',
      },
    });
    expect(harness.auth.refresh).not.toHaveBeenCalled();
  });
});
