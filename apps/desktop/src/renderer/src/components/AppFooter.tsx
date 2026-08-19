import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';

import { APP_VERSION, SOURCE_REPOSITORY_URL } from '@wo/protocol';

import { createRendererShellConfigApi } from '../api/shell-config-api.js';

/**
 * Version badge and source-repository entry, shown under the auth and home
 * screens of both clients. The web build renders a plain same-tab-safe
 * anchor; the desktop build routes through the allowlisted
 * `desktop:shell:open-external` IPC channel.
 */
export function AppFooter() {
  const shellApi = useMemo(
    () =>
      typeof window !== 'undefined' && window.woShell !== undefined
        ? createRendererShellConfigApi(window.woShell)
        : null,
    [],
  );

  return (
    <footer className="app-footer">
      <span className="app-footer-version">WO v{APP_VERSION}</span>
      {shellApi === null ? (
        <a
          className="app-footer-link"
          href={SOURCE_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ExternalLink size={14} aria-hidden="true" />
          GitHub
        </a>
      ) : (
        <button
          type="button"
          className="app-footer-link"
          title="在浏览器打开源码仓库"
          onClick={() => {
            void shellApi.openExternal(SOURCE_REPOSITORY_URL).catch(() => {
              // Opening the repository is best-effort; a failed IPC handshake
              // must never break the screen.
            });
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
          GitHub
        </button>
      )}
    </footer>
  );
}
