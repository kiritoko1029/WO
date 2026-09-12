// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://wo.example.com/"}

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/renderer/src/App.js';
import type { DesktopApi, DesktopShellBridge } from '../src/preload/types.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'woShell');
});

function installShell() {
  let notify = (): void => undefined;
  const consume = vi.fn().mockResolvedValue({ ok: true, value: null });
  const switchServer = vi.fn().mockResolvedValue({ ok: true, value: null });
  const bridge: DesktopShellBridge = {
    backendTarget: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          origin: 'https://wo.example.com',
          source: 'stored',
          readOnly: false,
        },
      }),
      save: vi.fn(),
    },
    joinIntent: {
      consume,
      switchServer,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    },
  };
  Object.defineProperty(window, 'woShell', {
    configurable: true,
    value: bridge,
  });
  return {
    switchServer,
    receiveInvitation: async () => {
      consume.mockResolvedValueOnce({
        ok: true,
        value: {
          mode: 'server',
          version: 1,
          serverOrigin: 'https://other.example.com',
          roomCode: '482731',
        },
      });
      await act(async () => {
        notify();
      });
    },
  };
}

function unauthenticatedDesktop(): DesktopApi {
  return {
    auth: {
      register: vi.fn(),
      login: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      changePassword: vi.fn(),
      requestEmailChange: vi.fn(),
      confirmEmailChange: vi.fn(),
      refresh: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('signed out'), { code: 'AUTH_REQUIRED' }),
        ),
      logout: vi.fn(),
    },
    realtime: { issueTicket: vi.fn() },
    capture: {
      list: vi.fn(),
      select: vi.fn(),
      permission: vi.fn(),
      openSettings: vi.fn(),
    },
  };
}

describe('incoming invitation modal ownership', () => {
  it('moves focus above an existing server dialog and restores each dialog in order', async () => {
    const user = userEvent.setup();
    const shell = installShell();
    render(<App desktop={unauthenticatedDesktop()} />);
    await screen.findByRole('heading', { name: '登录 WO' });
    const trigger = screen.getByRole('button', { name: '配置服务器' });
    await user.click(trigger);
    const origin = screen.getByLabelText('HTTPS 服务地址');
    expect(document.activeElement).toBe(origin);

    await shell.receiveInvitation();
    const invitation = screen.getByRole('dialog', {
      name: '切换服务后加入房间？',
    });
    const cancel = within(invitation).getByRole('button', { name: '取消' });
    const confirm = within(invitation).getByRole('button', {
      name: '切换并重启',
    });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    origin.focus();
    expect(document.activeElement).toBe(cancel);

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: '切换服务后加入房间？' }),
    ).toBeNull();
    expect(screen.getByRole('dialog', { name: '服务器' })).toBeTruthy();
    expect(document.activeElement).toBe(origin);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the busy invitation as the keyboard owner until switching completes', async () => {
    const user = userEvent.setup();
    const shell = installShell();
    render(<App desktop={unauthenticatedDesktop()} />);
    await screen.findByRole('heading', { name: '登录 WO' });
    await user.click(screen.getByRole('button', { name: '配置服务器' }));
    await shell.receiveInvitation();
    const invitation = screen.getByRole('dialog', {
      name: '切换服务后加入房间？',
    });
    await user.click(
      within(invitation).getByRole('button', { name: '切换并重启' }),
    );
    expect(shell.switchServer).toHaveBeenCalledWith({
      mode: 'server',
      version: 1,
      serverOrigin: 'https://other.example.com',
      roomCode: '482731',
    });
    await user.keyboard('{Escape}');
    expect(
      within(invitation).getByRole('button', { name: '正在切换' }),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '服务器' })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(invitation);
  });
});
