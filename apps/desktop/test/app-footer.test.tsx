// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_VERSION, SOURCE_REPOSITORY_URL } from '@wo/protocol';
import type { DesktopShellBridge } from '../src/preload/types.js';
import { AppFooter } from '../src/renderer/src/components/AppFooter.js';

afterEach(() => {
  cleanup();
  delete window.woShell;
});

function installDesktopBridge(): DesktopShellBridge {
  const bridge = {
    backendTarget: {
      get: vi.fn(),
      save: vi.fn(),
    },
    joinIntent: {
      consume: vi.fn(),
      switchServer: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
    openExternal: vi.fn(async () => ({ ok: true, value: null })),
  } satisfies DesktopShellBridge;
  Object.defineProperty(window, 'woShell', {
    configurable: true,
    value: bridge,
  });
  return bridge;
}

describe('AppFooter', () => {
  it('renders the version and a plain anchor on the web client', () => {
    render(<AppFooter />);

    expect(screen.getByText(`WO v${APP_VERSION}`)).toBeDefined();
    const link = screen.getByRole('link', { name: /GitHub/u });
    expect(link.getAttribute('href')).toBe(SOURCE_REPOSITORY_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('routes desktop clicks through the allowlisted shell IPC channel', async () => {
    const bridge = installDesktopBridge();
    const user = userEvent.setup();
    render(<AppFooter />);

    await user.click(screen.getByRole('button', { name: /GitHub/u }));
    expect(bridge.openExternal).toHaveBeenCalledTimes(1);
    expect(bridge.openExternal).toHaveBeenCalledWith(SOURCE_REPOSITORY_URL);
  });

  it('keeps the screen usable when the IPC handshake fails', async () => {
    const bridge = installDesktopBridge();
    bridge.openExternal = vi.fn(async () => ({
      ok: false,
      error: { code: 'IPC_UNAVAILABLE' },
    }));
    const user = userEvent.setup();
    render(<AppFooter />);

    await user.click(screen.getByRole('button', { name: /GitHub/u }));
    expect(screen.getByText(`WO v${APP_VERSION}`)).toBeDefined();
  });
});
