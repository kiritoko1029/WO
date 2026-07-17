import { describe, expect, it, vi } from 'vitest';
import type { JoinIntent } from '@wo/protocol';

import {
  registerShellConfigIpc,
  SHELL_CONFIG_IPC_CHANNELS,
  type ShellConfigIpcMain,
} from '../src/main/shell-config-ipc.js';

const rendererEntry = 'file:///C:/app/out/renderer/index.html';

function createHarness() {
  const handlers = new Map<
    string,
    (event: unknown, ...arguments_: readonly unknown[]) => unknown
  >();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
  } satisfies ShellConfigIpcMain;
  const backendTarget = {
    current: vi.fn(() => ({
      origin: 'https://wo.example.cn',
      source: 'stored' as const,
      readOnly: false,
    })),
    save: vi.fn(),
  };
  const app = { relaunch: vi.fn(), quit: vi.fn() };
  let pendingJoinIntent: JoinIntent | null = null;
  const joinIntents = {
    push: vi.fn((intent: JoinIntent) => {
      pendingJoinIntent = intent;
    }),
    consume: vi.fn(() => {
      const intent = pendingJoinIntent;
      pendingJoinIntent = null;
      return intent;
    }),
  };
  let restart: (() => void) | null = null;
  registerShellConfigIpc(ipcMain, {
    app,
    backendTarget,
    joinIntents,
    relaunchArguments: ['app-entry'],
    rendererEntry,
    scheduleRestart: (operation) => {
      restart = operation;
    },
  });
  const mainFrame = { url: rendererEntry };
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  return {
    app,
    backendTarget,
    event,
    handlers,
    joinIntents,
    restart: () => restart?.(),
  };
}

describe('shell config IPC boundary', () => {
  it('exposes the fixed channel set and schedules one relaunch after a valid save', async () => {
    const harness = createHarness();

    expect([...harness.handlers.keys()]).toEqual([
      ...SHELL_CONFIG_IPC_CHANNELS,
    ]);
    await expect(
      harness.handlers.get('desktop:shell:backend-target:get')?.(harness.event),
    ).resolves.toEqual({
      ok: true,
      value: {
        origin: 'https://wo.example.cn',
        source: 'stored',
        readOnly: false,
      },
    });
    await expect(
      harness.handlers.get('desktop:shell:backend-target:save')?.(
        harness.event,
        'https://next.example.cn',
      ),
    ).resolves.toEqual({ ok: true, value: null });
    expect(harness.backendTarget.save).toHaveBeenCalledWith(
      'https://next.example.cn',
    );
    expect(harness.app.relaunch).not.toHaveBeenCalled();

    harness.restart();

    expect(harness.app.relaunch).toHaveBeenCalledWith({
      args: ['app-entry'],
    });
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it('consumes a pending intent once and relaunches with a validated cross-server intent', async () => {
    const harness = createHarness();
    const intent = {
      version: 1 as const,
      mode: 'server' as const,
      serverOrigin: 'https://next.example.cn',
      roomCode: '123456',
    };
    harness.joinIntents.push(intent);

    await expect(
      harness.handlers.get('desktop:shell:join-intent:consume')?.(
        harness.event,
      ),
    ).resolves.toEqual({ ok: true, value: intent });
    await expect(
      harness.handlers.get('desktop:shell:join-intent:consume')?.(
        harness.event,
      ),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      harness.handlers.get('desktop:shell:join-intent:switch-server')?.(
        harness.event,
        intent,
      ),
    ).resolves.toEqual({ ok: true, value: null });
    expect(harness.backendTarget.save).toHaveBeenCalledWith(
      'https://next.example.cn',
    );

    harness.restart();

    expect(harness.app.relaunch).toHaveBeenCalledWith({
      args: [
        'app-entry',
        'wo://join?v=1&mode=server&origin=https%3A%2F%2Fnext.example.cn&room=123456',
      ],
    });
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it('rejects untrusted senders and invalid argument shapes', async () => {
    const harness = createHarness();

    await expect(
      harness.handlers.get('desktop:shell:backend-target:get')?.({
        senderFrame: null,
        sender: { mainFrame: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_FORBIDDEN' },
    });
    await expect(
      harness.handlers.get('desktop:shell:backend-target:save')?.(
        harness.event,
        { origin: 'https://wo.example.cn' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
    expect(harness.backendTarget.save).not.toHaveBeenCalled();
  });
});
