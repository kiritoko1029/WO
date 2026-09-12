// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoomRoute } from '../src/renderer/src/routes/RoomRoute.js';

vi.mock('../src/renderer/src/state/room-store.js', () => ({
  useRoom: () => ({
    room: { roomCode: '482731', participants: [] },
    busy: false,
    error: null,
    closeRoom: vi.fn(),
  }),
}));
vi.mock('../src/renderer/src/state/call-store.js', () => ({
  useCall: () => ({
    snapshot: {
      screenState: 'idle',
      screenOwner: null,
      error: null,
      screenError: null,
      screenBitrateError: null,
    },
    controller: {},
  }),
}));
vi.mock('../src/renderer/src/components/CallToolbar.js', () => ({
  CallToolbar: () => null,
}));
vi.mock('../src/renderer/src/components/ConnectionStatus.js', () => ({
  ConnectionStatus: () => null,
}));
vi.mock('../src/renderer/src/components/ParticipantSlots.js', () => ({
  ParticipantSlots: () => null,
}));
vi.mock('../src/renderer/src/components/QualityPanel.js', () => ({
  QualityPanel: () => null,
}));
vi.mock('../src/renderer/src/components/ScreenStage.js', () => ({
  ScreenStage: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'woClipboard');
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(window, 'woClipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function clickWithFakeTimers(name: string) {
  // RTL's user-event async wrapper uses real timers; keep timing assertions
  // deterministic while the other tests exercise full user-event interactions.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('room clipboard feedback', () => {
  it('reports a failed room-code copy accessibly and permits retry through the desktop bridge', async () => {
    const user = userEvent.setup();
    Reflect.deleteProperty(navigator, 'clipboard');
    const writeText = installClipboard(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('denied'))
        .mockResolvedValue(undefined),
    );
    render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await user.click(screen.getByRole('button', { name: '复制房间号' }));
    expect(screen.getByRole('alert').textContent).toContain('房间号复制失败');
    expect(screen.queryByRole('button', { name: '已复制房间号' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '复制房间号' }));
    expect(writeText).toHaveBeenLastCalledWith('482731');
    expect(screen.getByRole('status').textContent).toBe('房间号已复制');
    expect(screen.getByRole('alert').textContent).not.toContain(
      '房间号复制失败',
    );
  });

  it('restarts the room-code feedback lifetime on another copy and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    installClipboard();
    const view = render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await clickWithFakeTimers('复制房间号');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await clickWithFakeTimers('已复制房间号');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('button', { name: '已复制房间号' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button', { name: '复制房间号' })).toBeTruthy();
    await clickWithFakeTimers('复制房间号');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires share feedback and clears it when closing and reopening the menu', async () => {
    vi.useFakeTimers();
    installClipboard();
    render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await clickWithFakeTimers('分享房间');
    await clickWithFakeTimers('复制网页链接');
    expect(screen.getByRole('button', { name: '已复制网页链接' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: '复制网页链接' })).toBeTruthy();
    await clickWithFakeTimers('复制客户端链接');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(vi.getTimerCount()).toBe(0);
    await clickWithFakeTimers('分享房间');
    expect(
      screen.queryByRole('button', { name: '已复制客户端链接' }),
    ).toBeNull();
  });

  it('ignores a late copy result from an earlier menu opening', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    installClipboard(vi.fn().mockReturnValue(pending.promise));
    render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await user.click(screen.getByRole('button', { name: '分享房间' }));
    await user.click(screen.getByRole('button', { name: '复制网页链接' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '分享房间' }));
    await act(async () => {
      pending.resolve();
    });
    expect(screen.queryByRole('button', { name: '已复制网页链接' })).toBeNull();
  });

  it('keeps the newest share action feedback when clipboard promises complete out of order', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    installClipboard(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined),
    );
    render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await user.click(screen.getByRole('button', { name: '分享房间' }));
    await user.click(screen.getByRole('button', { name: '复制网页链接' }));
    await user.click(screen.getByRole('button', { name: '复制客户端链接' }));
    await act(async () => {
      pending.resolve();
    });
    expect(
      screen.getByRole('button', { name: '已复制客户端链接' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '已复制网页链接' })).toBeNull();
  });

  it('restores the copy control after the legacy clipboard fallback removes its temporary field', async () => {
    const user = userEvent.setup();
    Reflect.deleteProperty(navigator, 'clipboard');
    installClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const copy = vi.fn(() => {
      document.querySelector('textarea')?.focus();
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: copy,
    });
    render(<RoomRoute serverOrigin="https://wo.example.com" />);
    const button = screen.getByRole('button', { name: '复制房间号' });
    await user.click(button);
    expect(copy).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('button', { name: '已复制房间号' })).toBeTruthy();
  });

  it('does not schedule feedback after a pending copy finishes on an unmounted route', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    installClipboard(vi.fn().mockReturnValue(pending.promise));
    const view = render(<RoomRoute serverOrigin="https://wo.example.com" />);
    await clickWithFakeTimers('复制房间号');
    view.unmount();
    await act(async () => {
      pending.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
