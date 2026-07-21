import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LockKeyhole, Server, Settings, X } from 'lucide-react';

import type {
  BackendTargetSnapshot,
  DesktopShellBridge,
} from '../../../preload/types.js';
import { createRendererShellConfigApi } from '../api/shell-config-api.js';

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

function saveErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'VALIDATION_ERROR':
      return '请输入规范的 HTTPS 服务地址';
    case 'INVALID_STATE':
      return '服务地址由环境变量管理';
    default:
      return '保存失败，请重试';
  }
}

function AvailableBackendTargetSettings({
  bridge,
}: {
  readonly bridge: DesktopShellBridge;
}) {
  const api = useMemo(() => createRendererShellConfigApi(bridge), [bridge]);
  const [target, setTarget] = useState<BackendTargetSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api.backendTarget.get().then(
      (next) => {
        if (!active) return;
        setTarget(next);
        setOrigin(next.origin);
        setLoadError(null);
      },
      () => {
        if (active) setLoadError('无法读取服务地址');
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, saving]);

  const showDialog = () => {
    if (target !== null) setOrigin(target.origin);
    setError(loadError);
    setOpen(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (target === null || target.readOnly || saving) return;
    const nextOrigin = origin.trim();
    if (nextOrigin === target.origin) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.backendTarget.save(nextOrigin);
    } catch (saveError) {
      setError(saveErrorMessage(saveError));
      setSaving(false);
    }
  };

  return (
    <div className="backend-target-settings">
      <button
        className="backend-target-trigger"
        type="button"
        aria-label="配置服务器"
        title={target?.origin ?? '服务器'}
        onClick={showDialog}
      >
        <span className="backend-target-icon" aria-hidden="true">
          <Server size={17} />
        </span>
        <span className="backend-target-copy">
          <span>服务器</span>
          <strong>{target?.origin ?? loadError ?? '正在读取'}</strong>
        </span>
        {target?.readOnly ? (
          <LockKeyhole size={16} aria-hidden="true" />
        ) : (
          <Settings size={16} aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          className="backend-target-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setOpen(false);
          }}
        >
          <section
            className="backend-target-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backend-target-title"
          >
            <header>
              <div>
                <h2 id="backend-target-title">服务器</h2>
                {target?.readOnly && <p>由 WO_API_ORIGIN 管理</p>}
              </div>
              <button
                className="source-picker-close"
                type="button"
                title="关闭"
                aria-label="关闭"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                <X size={19} />
              </button>
            </header>
            <form onSubmit={save}>
              <label htmlFor="backend-origin">
                <span>HTTPS 服务地址</span>
                <input
                  id="backend-origin"
                  type="url"
                  value={origin}
                  maxLength={2_048}
                  autoComplete="url"
                  spellCheck={false}
                  readOnly={target?.readOnly ?? true}
                  autoFocus
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </label>
              <div
                className="backend-target-error"
                role="alert"
                aria-live="polite"
              >
                {error}
              </div>
              <footer>
                <button
                  className="source-cancel-button"
                  type="button"
                  disabled={saving}
                  onClick={() => setOpen(false)}
                >
                  取消
                </button>
                <button
                  className="source-start-button"
                  type="submit"
                  disabled={target === null || target.readOnly || saving}
                >
                  {saving ? '正在重启' : '保存'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export function BackendTargetSettings() {
  const bridge = window.woShell;
  return bridge === undefined ? null : (
    <AvailableBackendTargetSettings bridge={bridge} />
  );
}
