import { describe, expect, test } from 'vitest';

import {
  AcceptanceProtocolError,
  createAcceptanceSession,
  parseAcceptanceEnvelope,
} from '../../scripts/acceptance/protocol.mjs';

function envelope(type, sequence, payload, wallClockMs = 10_000) {
  return {
    version: 1,
    type,
    runId: 'run-1',
    sequence,
    wallClockMs,
    monotonicMs: sequence * 10,
    payload,
  };
}

function session(clock = { value: 10_000 }) {
  return createAcceptanceSession({
    runId: 'run-1',
    token: 'short-lived-secret',
    now: () => clock.value,
    maxClockSkewMs: 100,
    heartbeatTimeoutMs: 1_000,
  });
}

const token = 'short-lived-secret';

describe('acceptance controller/agent protocol', () => {
  test('parses strict envelopes and rejects unexpected fields', () => {
    expect(
      parseAcceptanceEnvelope(
        envelope('agent.register', 1, {
          agentId: 'win-a',
          platform: 'win32',
          architecture: 'x64',
        }),
      ),
    ).toMatchObject({ type: 'agent.register', sequence: 1 });
    expect(() =>
      parseAcceptanceEnvelope({
        ...envelope('run.stop', 1, {}),
        token: 'leak',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MESSAGE' }));
  });

  test('rejects a bad token without advancing sequence', () => {
    const guard = session();
    const message = envelope('agent.register', 1, {
      agentId: 'win-a',
      platform: 'win32',
      architecture: 'x64',
    });
    expect(() => guard.accept(message, 'wrong')).toThrow(
      expect.objectContaining({ code: 'AUTH_FAILED' }),
    );
    expect(guard.getSnapshot().sequence).toBe(0);
  });

  test('rejects replayed sequence and monotonic clocks', () => {
    const guard = session();
    const register = envelope('agent.register', 1, {
      agentId: 'win-a',
      platform: 'win32',
      architecture: 'x64',
    });
    guard.accept(register, token);
    expect(() => guard.accept(register, token)).toThrow(
      expect.objectContaining({ code: 'SEQUENCE_REPLAY' }),
    );
    expect(() =>
      guard.accept(
        {
          ...envelope('capability.report', 2, {
            screenSources: ['window', 'monitor'],
            canInstallFirewall: true,
            canVerifySignature: true,
          }),
          monotonicMs: 10,
        },
        token,
      ),
    ).toThrow(expect.objectContaining({ code: 'MONOTONIC_REPLAY' }));
  });

  test('rejects excessive wall-clock skew', () => {
    const guard = session();
    expect(() =>
      guard.accept(
        envelope(
          'agent.register',
          1,
          { agentId: 'win-a', platform: 'win32', architecture: 'x64' },
          20_000,
        ),
        token,
      ),
    ).toThrow(expect.objectContaining({ code: 'CLOCK_SKEW' }));
  });

  test('fails a lost heartbeat and a step timeout', () => {
    const clock = { value: 10_000 };
    const guard = session(clock);
    guard.accept(
      envelope('agent.register', 1, {
        agentId: 'win-a',
        platform: 'win32',
        architecture: 'x64',
      }),
      token,
    );
    guard.accept(
      envelope('capability.report', 2, {
        screenSources: ['window'],
        canInstallFirewall: true,
        canVerifySignature: true,
      }),
      token,
    );
    guard.accept(
      envelope('run.prepare', 3, {
        packageSha256: 'a'.repeat(64),
        source: 'window',
        path: 'direct',
      }),
      token,
    );
    guard.accept(envelope('run.start', 4, { durationMs: 45_000 }), token);
    guard.beginStep(500);
    clock.value = 10_501;
    expect(() => guard.assertStepDeadline()).toThrow(
      expect.objectContaining({ code: 'STEP_TIMEOUT' }),
    );
    clock.value = 11_001;
    expect(() => guard.assertHeartbeat()).toThrow(
      expect.objectContaining({ code: 'HEARTBEAT_LOST' }),
    );
  });

  test.each([
    ['run.failure', { code: 'APP_FAILED', message: 'app exited' }, 'failed'],
    ['run.cancel', { reason: 'peer failed' }, 'canceling'],
  ])('requires proven cleanup after %s', (type, payload, expectedState) => {
    const guard = session();
    guard.accept(
      envelope('agent.register', 1, {
        agentId: 'win-a',
        platform: 'win32',
        architecture: 'x64',
      }),
      token,
    );
    guard.accept(envelope(type, 2, payload), token);
    expect(guard.getSnapshot().state).toBe(expectedState);
    expect(() =>
      guard.accept(
        envelope('cleanup.ack', 3, {
          restoredFirewall: false,
          childrenStopped: true,
        }),
        token,
      ),
    ).toThrow(expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' }));
  });

  test('accepts cleanup only after cancellation with both proofs true', () => {
    const guard = session();
    guard.accept(
      envelope('agent.register', 1, {
        agentId: 'win-a',
        platform: 'win32',
        architecture: 'x64',
      }),
      token,
    );
    guard.accept(envelope('run.cancel', 2, { reason: 'stop' }), token);
    guard.accept(
      envelope('cleanup.ack', 3, {
        restoredFirewall: true,
        childrenStopped: true,
      }),
      token,
    );
    expect(guard.getSnapshot().state).toBe('cleaned');
  });

  test('exposes a typed protocol error class', () => {
    expect(new AcceptanceProtocolError('TEST')).toMatchObject({ code: 'TEST' });
  });
});
