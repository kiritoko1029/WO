import type { CallConnectionStatus } from '../state/call-store.js';

const labels: Record<CallConnectionStatus, string> = {
  waiting: '等待对方加入',
  connecting: '正在建立语音连接',
  connected: '语音已连接',
  relay: '语音已连接（中继）',
  reconnecting: '正在重新连接',
  error: '语音连接异常',
};

export function ConnectionStatus({
  status,
}: {
  readonly status: CallConnectionStatus;
}) {
  return (
    <>
      <span className={`connection-dot ${status}`} />
      <strong>{labels[status]}</strong>
    </>
  );
}
