// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ThemeFab } from '../src/renderer/src/components/ThemeFab.js';
import { THEME_STORAGE_KEY } from '../src/renderer/src/theme.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-pref');
  document.documentElement.style.colorScheme = '';
});

describe('ThemeFab', () => {
  it('cycles preference with one corner button and persists wo-theme', async () => {
    const user = userEvent.setup();
    render(<ThemeFab />);

    const button = screen.getByRole('button', { name: /切换主题/u });
    expect(button.getAttribute('title')).toMatch(/自适应/u);

    await user.click(button);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePref).toBe('light');
    expect(button.getAttribute('title')).toMatch(/浅色/u);

    await user.click(button);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(button.getAttribute('title')).toMatch(/深色/u);
  });
});
