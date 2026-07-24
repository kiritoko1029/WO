import { useEffect, useState } from 'react';
import { Moon, Sun, SunMoon } from 'lucide-react';

import {
  applyTheme,
  cycleThemePreference,
  readThemePreference,
  themePreferenceLabel,
  writeThemePreference,
  type ThemePreference,
  type ThemeState,
} from '../theme.js';

function ThemeIcon({ preference }: { readonly preference: ThemePreference }) {
  if (preference === 'dark') return <Moon size={16} aria-hidden="true" />;
  if (preference === 'light') return <Sun size={16} aria-hidden="true" />;
  return <SunMoon size={16} aria-hidden="true" />;
}

export function ThemeFab({
  contained = false,
}: {
  readonly contained?: boolean;
}) {
  const [state, setState] = useState<ThemeState>(() =>
    applyTheme(readThemePreference()),
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      setState((current) =>
        current.preference === 'system' ? applyTheme('system') : current,
      );
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  const cycle = () => {
    const next = cycleThemePreference(state.preference);
    writeThemePreference(next);
    setState(applyTheme(next));
  };

  const label = themePreferenceLabel(state.preference);
  const resolvedLabel = state.resolved === 'dark' ? '深色' : '浅色';

  return (
    <div
      className={
        contained
          ? 'theme-fab-host theme-fab-host--contained'
          : 'theme-fab-host theme-fab-host--fixed'
      }
      data-od-id="theme-fab"
    >
      <button
        type="button"
        className="theme-fab"
        aria-label={`切换主题，当前：${label}（生效 ${resolvedLabel}）`}
        title={`主题：${label} · 点击切换`}
        onClick={cycle}
      >
        <ThemeIcon preference={state.preference} />
      </button>
    </div>
  );
}
