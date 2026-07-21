// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  THEME_STORAGE_KEY,
  applyTheme,
  cycleThemePreference,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
  themePreferenceLabel,
  writeThemePreference,
} from '../src/renderer/src/theme.js';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-pref');
  document.documentElement.style.colorScheme = '';
});

describe('theme preference', () => {
  it('defaults to system and cycles 自适应 → 浅色 → 深色', () => {
    expect(normalizeThemePreference(null)).toBe('system');
    expect(themePreferenceLabel('system')).toBe('自适应');
    expect(cycleThemePreference('system')).toBe('light');
    expect(cycleThemePreference('light')).toBe('dark');
    expect(cycleThemePreference('dark')).toBe('system');
  });

  it('resolves system against prefers-color-scheme', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('persists wo-theme and applies html data-theme', () => {
    writeThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readThemePreference()).toBe('dark');

    const state = applyTheme('dark');
    expect(state).toEqual({ preference: 'dark', resolved: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePref).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('updates color-scheme meta for fixed and system preferences', () => {
    let meta = document.querySelector('meta[name="color-scheme"]');
    if (meta === null) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'color-scheme');
      document.head.append(meta);
    }

    applyTheme('light');
    expect(meta.getAttribute('content')).toBe('light');

    applyTheme('system', document.documentElement, true);
    expect(meta.getAttribute('content')).toBe('light dark');
  });

  it('keeps system preference while resolving the effective theme', () => {
    const state = applyTheme('system', document.documentElement, true);
    expect(state.preference).toBe('system');
    expect(state.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePref).toBe('system');
  });
});
