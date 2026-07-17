export type ConnectionMode = 'server' | 'lan';

export function ConnectionModeSelector({
  mode,
  onChange,
}: {
  readonly mode: ConnectionMode;
  readonly onChange: (mode: ConnectionMode) => void;
}) {
  return (
    <div
      className="segmented connection-mode"
      role="tablist"
      aria-label="连接方式"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'server'}
        className={mode === 'server' ? 'active' : undefined}
        onClick={() => onChange('server')}
      >
        中心服务
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'lan'}
        className={mode === 'lan' ? 'active' : undefined}
        onClick={() => onChange('lan')}
      >
        可信局域网
      </button>
    </div>
  );
}
