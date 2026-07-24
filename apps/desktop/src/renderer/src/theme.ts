export const THEME_STORAGE_KEY = 'wo-theme';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = 'light' | 'dark';

export type ThemeState = {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
};

const THEME_LABELS: Record<ThemePreference, string> = {
  system: '自适应',
  light: '浅色',
  dark: '深色',
};

export function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : 'system';
}

export function themePreferenceLabel(
  preference: ThemePreference = 'system',
): string {
  return THEME_LABELS[normalizeThemePreference(preference)];
}

export function systemPrefersDark(
  media: Pick<MediaQueryList, 'matches'> | null = readPrefersColorScheme(),
): boolean {
  return media?.matches === true;
}

function readPrefersColorScheme(): Pick<MediaQueryList, 'matches'> | null {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return null;
  }
  return window.matchMedia('(prefers-color-scheme: dark)');
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function readThemePreference(
  storage: Pick<Storage, 'getItem'> | null = safeLocalStorage(),
): ThemePreference {
  if (storage === null) return 'system';
  try {
    return normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory apply still works.
  }
}

export function cycleThemePreference(
  current: ThemePreference,
): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(normalizeThemePreference(current));
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]!;
}

export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
  prefersDark = systemPrefersDark(),
): ThemeState {
  const next = normalizeThemePreference(preference);
  const resolved = resolveTheme(next, prefersDark);
  root.dataset.theme = resolved;
  root.dataset.themePref = next;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta !== null) {
    meta.setAttribute('content', next === 'system' ? 'light dark' : resolved);
  }
  return { preference: next, resolved };
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
