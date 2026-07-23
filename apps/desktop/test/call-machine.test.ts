import { describe, expect, test, vi } from 'vitest';

import {
  createCallMachine,
  type CallRecoveryReason,
} from '../src/renderer/src/state/call-machine.js';

describe('call phase projector', () => {
  test.each([
    [false, 'waiting'],
    [true, 'negotiating'],
  ] as const)(
    'derives its initial phase from peer readiness',
    (peerReady, phase) => {
      const machine = createCallMachine({ peerReady });

      expect(machine.getSnapshot()).toEqual({
        phase,
        recoveryReason: null,
        connectionPath: null,
        revision: 0,
      });
    },
  );

  test('requires negotiation and ICE connectivity before projecting connected', () => {
    const machine = createCallMachine({ peerReady: true });

    const negotiationOnly = machine.dispatch({
      type: 'settle',
      peerReady: true,
      negotiationEstablished: true,
      transportConnected: false,
      connectionPath: null,
    });
    expect(negotiationOnly.phase).toBe('negotiating');

    const connected = machine.dispatch({
      type: 'settle',
      peerReady: true,
      negotiationEstablished: true,
      transportConnected: true,
      connectionPath: 'direct',
    });
    expect(connected).toMatchObject({
      phase: 'connected',
      connectionPath: 'direct',
    });
  });

  test.each([
    'peer',
    'signal',
    'ice',
    'transport',
  ] as const satisfies readonly CallRecoveryReason[])(
    'projects %s recovery without owning the recovery flow',
    (reason) => {
      const machine = createCallMachine({ peerReady: true });
      machine.dispatch({
        type: 'settle',
        peerReady: true,
        negotiationEstablished: true,
        transportConnected: true,
        connectionPath: 'direct',
      });

      expect(machine.dispatch({ type: 'recover', reason })).toMatchObject({
        phase: 'recovering',
        recoveryReason: reason,
      });
    },
  );

  test('returns to waiting when the peer leaves whether or not media was connected', () => {
    // Peer.left means the other member is gone. Recovering / failing ICE after
    // that produced a false "语音连接异常" for the remaining participant.
    const established = createCallMachine({ peerReady: true });
    established.dispatch({
      type: 'settle',
      peerReady: true,
      negotiationEstablished: true,
      transportConnected: true,
      connectionPath: 'direct',
    });
    expect(
      established.dispatch({ type: 'peer-left', wasConnected: true }),
    ).toMatchObject({ phase: 'waiting', recoveryReason: null });

    const initial = createCallMachine({ peerReady: true });
    expect(
      initial.dispatch({ type: 'peer-left', wasConnected: false }),
    ).toMatchObject({ phase: 'waiting', recoveryReason: null });
  });

  test('supports a microphone failure followed by an explicit retry', () => {
    const machine = createCallMachine({ peerReady: false });

    expect(machine.dispatch({ type: 'fail' }).phase).toBe('failed');
    expect(machine.dispatch({ type: 'retry', peerReady: true })).toMatchObject({
      phase: 'negotiating',
      recoveryReason: null,
    });
  });

  test('keeps a failed call failed when a stale peer-left event arrives', () => {
    const machine = createCallMachine({ peerReady: true });
    const failed = machine.dispatch({ type: 'fail' });

    expect(machine.dispatch({ type: 'peer-left', wasConnected: false })).toBe(
      failed,
    );
    expect(machine.dispatch({ type: 'peer-left', wasConnected: true })).toBe(
      failed,
    );
  });

  test('makes closing and closed terminal against stale events', () => {
    const machine = createCallMachine({ peerReady: true });

    expect(machine.dispatch({ type: 'close' }).phase).toBe('closing');
    const closed = machine.dispatch({ type: 'closed' });
    expect(closed.phase).toBe('closed');
    expect(machine.dispatch({ type: 'recover', reason: 'signal' })).toBe(
      closed,
    );
    expect(machine.dispatch({ type: 'retry', peerReady: true })).toBe(closed);
  });

  test('treats repeated facts idempotently and notifies only for real changes', () => {
    const machine = createCallMachine({ peerReady: false });
    const listener = vi.fn();
    machine.subscribe(listener);

    const waiting = machine.getSnapshot();
    expect(
      machine.dispatch({
        type: 'settle',
        peerReady: false,
        negotiationEstablished: false,
        transportConnected: false,
        connectionPath: null,
      }),
    ).toBe(waiting);
    expect(listener).not.toHaveBeenCalled();

    const negotiating = machine.dispatch({ type: 'retry', peerReady: true });
    expect(Object.isFrozen(negotiating)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(machine.dispatch({ type: 'retry', peerReady: true })).toBe(
      negotiating,
    );
    expect(listener).toHaveBeenCalledOnce();
  });

  test('tracks direct/relay independently from the phase revision', () => {
    const machine = createCallMachine({ peerReady: true });
    const connected = machine.dispatch({
      type: 'settle',
      peerReady: true,
      negotiationEstablished: true,
      transportConnected: true,
      connectionPath: 'direct',
    });
    const relay = machine.dispatch({
      type: 'connection-path',
      connectionPath: 'relay',
    });

    expect(relay).toMatchObject({
      phase: 'connected',
      connectionPath: 'relay',
      revision: connected.revision,
    });
    expect(
      createCallMachine({ peerReady: true }).dispatch({
        type: 'connection-path',
        connectionPath: 'relay',
      }).connectionPath,
    ).toBeNull();
  });

  test('has no screen-cleanup API or cancellation generation ownership', () => {
    const machine = createCallMachine({ peerReady: false });

    expect(machine).not.toHaveProperty('acceptShareCleanup');
    expect(machine.getSnapshot()).not.toHaveProperty('generation');
  });
});
