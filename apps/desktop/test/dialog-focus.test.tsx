// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountSecurityPanel } from '../src/renderer/src/components/AccountSecurityPanel.js';
import { BackendTargetSettings } from '../src/renderer/src/components/BackendTargetSettings.js';
import { SourcePicker } from '../src/renderer/src/components/SourcePicker.js';
import { useDialogFocus } from '../src/renderer/src/hooks/use-dialog-focus.js';
import type { ScreenShareState } from '../src/renderer/src/media/screen-controller.js';

const { auth } = vi.hoisted(() => ({
  auth: {
    session: { user: { email: 'demo@example.com' } },
    busy: false,
    error: null,
    clearError: vi.fn(),
  },
}));
vi.mock('../src/renderer/src/state/auth-store.js', () => ({
  useAuth: () => auth,
}));

afterEach(() => {
  cleanup();
  auth.busy = false;
  Reflect.deleteProperty(window, 'woShell');
});

function FocusHarness({ disabled = false }: { readonly disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useDialogFocus({ open, onDismiss: () => setOpen(false) });
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <section ref={dialogRef} role="dialog" tabIndex={-1}>
          <button disabled={disabled}>First</button>
          <button disabled>Disabled</button>
          <div hidden>
            <button>Hidden</button>
          </div>
          <div style={{ display: 'none' }}>
            <button>Invisible</button>
          </div>
          <button disabled={disabled}>Last</button>
        </section>
      )}
      <button>Outside</button>
    </>
  );
}

function PickerHarness({ state }: { readonly state: ScreenShareState }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Share</button>
      {open && (
        <SourcePicker
          sources={[]}
          selectedToken={null}
          systemAudioEnabled={false}
          systemAudioMode="unsupported"
          state={state}
          onSelect={() => undefined}
          onSystemAudioEnabledChange={() => undefined}
          onStart={() => undefined}
          onCancel={() => setOpen(false)}
          onRefresh={() => undefined}
        />
      )}
    </>
  );
}

function ModalLayer({
  name,
  onDismiss,
}: {
  readonly name: string;
  readonly onDismiss: () => void;
}) {
  const dialogRef = useDialogFocus({ open: true, onDismiss });
  return (
    <section ref={dialogRef} role="dialog" aria-label={name} tabIndex={-1}>
      <button>{name} action</button>
      <button onClick={onDismiss}>Close {name}</button>
    </section>
  );
}

function StackHarness({
  showLower = true,
  showUpper = false,
}: {
  readonly showLower?: boolean;
  readonly showUpper?: boolean;
}) {
  const [lowerOpen, setLowerOpen] = useState(false);
  const [upperDismissed, setUpperDismissed] = useState(false);
  return (
    <>
      <button onClick={() => setLowerOpen(true)}>Open stack</button>
      {lowerOpen && showLower && (
        <ModalLayer name="Lower" onDismiss={() => setLowerOpen(false)} />
      )}
      {showUpper && !upperDismissed && (
        <ModalLayer name="Upper" onDismiss={() => setUpperDismissed(true)} />
      )}
    </>
  );
}

describe('dialog keyboard interaction', () => {
  it('keeps the latest modal owner through StrictMode setup and cleanup', async () => {
    const user = userEvent.setup();
    const view = render(
      <StrictMode>
        <StackHarness />
      </StrictMode>,
    );
    const trigger = screen.getByRole('button', { name: 'Open stack' });
    await user.click(trigger);
    const lowerAction = screen.getByRole('button', { name: 'Lower action' });
    view.rerender(
      <StrictMode>
        <StackHarness showUpper />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Upper action' }),
    );
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(lowerAction);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal focus when a background modal unmounts and preserves the original trigger', async () => {
    const user = userEvent.setup();
    const view = render(
      <StrictMode>
        <StackHarness />
      </StrictMode>,
    );
    const trigger = screen.getByRole('button', { name: 'Open stack' });
    await user.click(trigger);
    view.rerender(
      <StrictMode>
        <StackHarness showUpper />
      </StrictMode>,
    );
    const upperAction = screen.getByRole('button', { name: 'Upper action' });
    view.rerender(
      <StrictMode>
        <StackHarness showLower={false} showUpper />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(upperAction);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close Upper' }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('enters focus, wraps Tab and Shift+Tab, skips unavailable controls, and restores its trigger', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <FocusHarness />
      </StrictMode>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Last' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Last' }),
    );
    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('contains focus when every action becomes disabled', async () => {
    const user = userEvent.setup();
    const view = render(<FocusHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    view.rerender(<FocusHarness disabled />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('keeps account edits open while busy, then resets and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const view = render(<AccountSecurityPanel />);
    const trigger = screen.getByRole('button', { name: '账号安全' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '修改密码' }));
    const password = screen.getByLabelText('当前密码');
    expect(document.activeElement).toBe(password);
    await user.type(password, 'not-a-real-password');
    auth.busy = true;
    view.rerender(<AccountSecurityPanel />);
    expect(document.activeElement).toBe(password);
    expect(
      (screen.getByRole('button', { name: '返回' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    auth.busy = false;
    view.rerender(<AccountSecurityPanel />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    expect(screen.queryByLabelText('当前密码')).toBeNull();
  });

  it('focuses the server origin, skips read-only save and restores the settings trigger', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: {
        backendTarget: {
          get: vi.fn().mockResolvedValue({
            ok: true,
            value: {
              origin: 'https://demo.example.com',
              source: 'environment',
              readOnly: true,
            },
          }),
          save: vi.fn(),
        },
      },
    });
    render(<BackendTargetSettings />);
    await screen.findByText('https://demo.example.com');
    const trigger = screen.getByRole('button', { name: '配置服务器' });
    await user.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByLabelText('HTTPS 服务地址'),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '取消' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }),
    );
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });

  it('does not dismiss or escape keyboard focus during server relaunch', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'woShell', {
      configurable: true,
      value: {
        backendTarget: {
          get: vi.fn().mockResolvedValue({
            ok: true,
            value: {
              origin: 'https://demo.example.com',
              source: 'stored',
              readOnly: false,
            },
          }),
          save: vi.fn().mockResolvedValue({ ok: true, value: null }),
        },
      },
    });
    render(<BackendTargetSettings />);
    await screen.findByText('https://demo.example.com');
    await user.click(screen.getByRole('button', { name: '配置服务器' }));
    await user.clear(screen.getByLabelText('HTTPS 服务地址'));
    await user.type(
      screen.getByLabelText('HTTPS 服务地址'),
      'https://next.example.com',
    );
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '正在重启' })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it.each(['acquiring', 'picking', 'capturing'] as const)(
    'cancels %s through Escape and returns to the share control',
    async (state) => {
      const user = userEvent.setup();
      render(<PickerHarness state={state} />);
      const trigger = screen.getByRole('button', { name: 'Share' });
      await user.click(trigger);
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(
        true,
      );
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );
});
