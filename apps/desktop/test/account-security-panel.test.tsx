// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi, PublicAuthSession } from '../src/preload/types.js';
import { AccountSecurityPanel } from '../src/renderer/src/components/AccountSecurityPanel.js';
import { AuthProvider } from '../src/renderer/src/state/auth-store.js';

afterEach(() => {
  cleanup();
});

const session: PublicAuthSession = {
  user: {
    id: 'user-1',
    email: 'owner@example.cn',
    displayName: '房主',
  },
  accessToken: 'access-token',
  accessTokenExpiresAt: Date.now() + 60_000,
};

function createApi(
  overrides: Partial<DesktopApi['auth']> = {},
): DesktopApi {
  return {
    auth: {
      register: vi.fn(),
      login: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      changePassword: vi.fn().mockResolvedValue(undefined),
      requestEmailChange: vi.fn().mockResolvedValue({ email: 'next@example.cn' }),
      confirmEmailChange: vi.fn().mockResolvedValue(session),
      refresh: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    realtime: {
      issueTicket: vi.fn(),
    },
    capture: {
      list: vi.fn(),
      select: vi.fn(),
      permission: vi.fn(),
      openSettings: vi.fn(),
    },
  };
}

describe('AccountSecurityPanel', () => {
  it('opens a modal dialog from a compact glass trigger', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider api={createApi()}>
        <AccountSecurityPanel />
      </AuthProvider>,
    );

    const trigger = await screen.findByRole('button', { name: '账号安全' });
    expect(trigger.className).toContain('glass-icon-button');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '账号安全' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('owner@example.cn')).toBeTruthy();
    expect(screen.getByRole('button', { name: '修改密码' })).toBeTruthy();
  });

  it('closes on Escape and backdrop click', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider api={createApi()}>
        <AccountSecurityPanel />
      </AuthProvider>,
    );

    await user.click(await screen.findByRole('button', { name: '账号安全' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: '账号安全' }));
    const backdrop = screen.getByRole('dialog').parentElement;
    expect(backdrop?.className).toContain('account-security-backdrop');
    fireEvent.mouseDown(backdrop!);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('does not dismiss while a security request is busy', async () => {
    const user = userEvent.setup();
    let releaseChange!: () => void;
    const changePassword = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseChange = () => resolve();
        }),
    );

    render(
      <AuthProvider api={createApi({ changePassword })}>
        <AccountSecurityPanel />
      </AuthProvider>,
    );

    await user.click(await screen.findByRole('button', { name: '账号安全' }));
    await user.click(screen.getByRole('button', { name: '修改密码' }));
    await user.type(screen.getByLabelText('当前密码'), 'old-password');
    await user.type(screen.getByLabelText('新密码'), 'new-password-1');
    await user.type(screen.getByLabelText('确认新密码'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: '保存密码' }));

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalled();
    });

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();

    const backdrop = screen.getByRole('dialog').parentElement;
    fireEvent.mouseDown(backdrop!);
    expect(screen.getByRole('dialog')).toBeTruthy();

    releaseChange();
    await waitFor(() => {
      expect(screen.getByText('密码已更新')).toBeTruthy();
    });
  });
});
