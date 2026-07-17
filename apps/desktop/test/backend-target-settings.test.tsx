// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BackendTargetSnapshot,
  DesktopShellBridge,
} from '../src/preload/types.js';
import { BackendTargetSettings } from '../src/renderer/src/components/BackendTargetSettings.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'woShell');
});

function installBridge(
  target: BackendTargetSnapshot,
  save = vi.fn().mockResolvedValue({ ok: true, value: null }),
): DesktopShellBridge {
  const bridge = {
    backendTarget: {
      get: vi.fn().mockResolvedValue({ ok: true, value: target }),
      save,
    },
  } satisfies DesktopShellBridge;
  Object.defineProperty(window, 'woShell', {
    configurable: true,
    value: bridge,
  });
  return bridge;
}

describe('backend target settings', () => {
  it('saves the edited canonical origin and waits for relaunch', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      origin: 'https://old.example.cn',
      source: 'stored',
      readOnly: false,
    });
    render(<BackendTargetSettings />);

    await screen.findByText('https://old.example.cn');
    await user.click(screen.getByRole('button', { name: '配置后端服务' }));
    const input = screen.getByLabelText('HTTPS 服务地址');
    await user.clear(input);
    await user.type(input, 'https://next.example.cn');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(bridge.backendTarget.save).toHaveBeenCalledWith(
      'https://next.example.cn',
    );
    expect(screen.getByRole('button', { name: '正在重启' })).toBeTruthy();
  });

  it('keeps environment-managed targets read-only', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      origin: 'https://managed.example.cn',
      source: 'environment',
      readOnly: true,
    });
    render(<BackendTargetSettings />);

    await screen.findByText('https://managed.example.cn');
    await user.click(screen.getByRole('button', { name: '配置后端服务' }));

    expect(screen.getByText('由 WO_API_ORIGIN 管理')).toBeTruthy();
    expect(
      (screen.getByLabelText('HTTPS 服务地址') as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '保存' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(bridge.backendTarget.save).not.toHaveBeenCalled();
  });

  it('keeps main-process validation errors visible', async () => {
    const user = userEvent.setup();
    installBridge(
      {
        origin: 'https://old.example.cn',
        source: 'stored',
        readOnly: false,
      },
      vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request was rejected',
        },
      }),
    );
    render(<BackendTargetSettings />);

    await screen.findByText('https://old.example.cn');
    await user.click(screen.getByRole('button', { name: '配置后端服务' }));
    const input = screen.getByLabelText('HTTPS 服务地址');
    await user.clear(input);
    await user.type(input, 'http://invalid.example.cn');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('请输入规范的 HTTPS 服务地址')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('retains a load failure when the dialog is opened', async () => {
    const user = userEvent.setup();
    const bridge = {
      backendTarget: {
        get: vi.fn().mockRejectedValue(new Error('private stack')),
        save: vi.fn(),
      },
    } satisfies DesktopShellBridge;
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: bridge,
    });
    render(<BackendTargetSettings />);

    await screen.findByText('无法读取服务地址');
    await user.click(screen.getByRole('button', { name: '配置后端服务' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('无法读取服务地址');
    expect(
      (screen.getByRole('button', { name: '保存' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
