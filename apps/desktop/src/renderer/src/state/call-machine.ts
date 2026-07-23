export type CallState =
  | 'waiting'
  | 'negotiating'
  | 'connected'
  | 'recovering'
  | 'failed'
  | 'closing'
  | 'closed';

export type CallRecoveryReason = 'peer' | 'signal' | 'ice' | 'transport';
export type CallConnectionPath = 'direct' | 'relay';

export interface CallMachineSnapshot {
  readonly phase: CallState;
  readonly recoveryReason: CallRecoveryReason | null;
  readonly connectionPath: CallConnectionPath | null;
  readonly revision: number;
}

export type CallEvent =
  | Readonly<{
      type: 'settle';
      peerReady: boolean;
      negotiationEstablished: boolean;
      transportConnected: boolean;
      connectionPath: CallConnectionPath | null;
    }>
  | Readonly<{ type: 'negotiate' }>
  | Readonly<{ type: 'recover'; reason: CallRecoveryReason }>
  | Readonly<{ type: 'peer-left'; wasConnected: boolean }>
  | Readonly<{ type: 'retry'; peerReady: boolean }>
  | Readonly<{ type: 'fail' }>
  | Readonly<{
      type: 'connection-path';
      connectionPath: CallConnectionPath;
    }>
  | Readonly<{ type: 'close' }>
  | Readonly<{ type: 'closed' }>;

export interface CallMachine {
  getSnapshot(): CallMachineSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(event: CallEvent): CallMachineSnapshot;
}

export interface CallMachineOptions {
  readonly peerReady: boolean;
}

function snapshot(
  phase: CallState,
  recoveryReason: CallRecoveryReason | null,
  connectionPath: CallConnectionPath | null,
  revision: number,
): CallMachineSnapshot {
  return Object.freeze({
    phase,
    recoveryReason,
    connectionPath,
    revision,
  });
}

export function createCallMachine(options: CallMachineOptions): CallMachine {
  if (typeof options.peerReady !== 'boolean') {
    throw new TypeError('peerReady must be a boolean');
  }
  const listeners = new Set<() => void>();
  let current = snapshot(
    options.peerReady ? 'negotiating' : 'waiting',
    null,
    null,
    0,
  );

  const replace = (
    phase: CallState,
    recoveryReason: CallRecoveryReason | null,
    connectionPath: CallConnectionPath | null,
  ): CallMachineSnapshot => {
    if (
      phase === current.phase &&
      recoveryReason === current.recoveryReason &&
      connectionPath === current.connectionPath
    ) {
      return current;
    }
    const phaseChanged =
      phase !== current.phase || recoveryReason !== current.recoveryReason;
    current = snapshot(
      phase,
      recoveryReason,
      connectionPath,
      current.revision + (phaseChanged ? 1 : 0),
    );
    for (const listener of listeners) listener();
    return current;
  };

  const dispatch = (event: CallEvent): CallMachineSnapshot => {
    if (current.phase === 'closed') return current;
    if (current.phase === 'closing' && event.type !== 'closed') return current;

    switch (event.type) {
      case 'settle': {
        if (current.phase === 'failed') return current;
        if (!event.peerReady) return replace('waiting', null, null);
        if (event.negotiationEstablished && event.transportConnected) {
          return replace('connected', null, event.connectionPath);
        }
        return replace('negotiating', null, null);
      }
      case 'negotiate':
        return current.phase === 'failed' || current.phase === 'recovering'
          ? current
          : replace('negotiating', null, null);
      case 'recover':
        return current.phase === 'failed'
          ? current
          : replace('recovering', event.reason, current.connectionPath);
      case 'peer-left':
        // Peer departed the room intentionally (or disconnected long enough
        // that the server emitted peer.left). Always return to waiting so the
        // remaining member does not enter ICE recovery / "语音连接异常".
        // wasConnected is retained on the event for analytics/tests only.
        void event.wasConnected;
        return current.phase === 'failed'
          ? current
          : replace('waiting', null, null);
      case 'retry':
        return replace(event.peerReady ? 'negotiating' : 'waiting', null, null);
      case 'fail':
        return replace('failed', null, null);
      case 'connection-path':
        return current.phase === 'connected'
          ? replace('connected', null, event.connectionPath)
          : current;
      case 'close':
        return replace('closing', null, null);
      case 'closed':
        return replace('closed', null, null);
      default:
        throw new TypeError('Unknown call event');
    }
  };

  return Object.freeze({
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
  });
}
