import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  buildFirewallInvocation,
  validateFirewallRequest,
  verifyFirewallEvidence,
} from '../../scripts/acceptance/firewall-policy.mjs';

const root = resolve('.');

function request(platform = 'win32') {
  return {
    platform,
    runId: 'run-1080p60-1',
    turnAddress: '203.0.113.20',
    turnUdpPort: 3478,
    turnTlsPort: 5349,
    controllerAddress: '203.0.113.10',
    controllerPort: 9443,
    desktopExecutable: resolve(
      'artifacts',
      platform === 'win32' ? 'WO.exe' : 'WO',
    ),
    stateFile: resolve('runs', 'run-1080p60-1', 'firewall-state.json'),
  };
}

describe('acceptance firewall policy', () => {
  test.each(['win32', 'darwin'])(
    'builds a shell-free %s invocation',
    (platform) => {
      const invocation = buildFirewallInvocation(
        root,
        request(platform),
        'install',
      );
      expect(invocation.shell).toBe(false);
      expect(invocation.args).toContain('run-1080p60-1');
      expect(invocation.args).toContain('203.0.113.20');
      expect(invocation.args).toContain('203.0.113.10');
      expect(JSON.stringify(invocation)).not.toContain('token');
    },
  );

  test.each([
    ['command injection', { runId: 'run; Remove-Item C:\\' }],
    ['hostname instead of resolved IP', { turnAddress: 'turn.example.test' }],
    ['relative executable', { desktopExecutable: 'WO.exe' }],
    ['invalid port', { turnUdpPort: 0 }],
    ['unexpected field', { token: 'secret' }],
  ])('rejects %s', (_name, change) => {
    expect(() => validateFirewallRequest({ ...request(), ...change })).toThrow(
      expect.objectContaining({ code: 'INVALID_FIREWALL_REQUEST' }),
    );
  });

  test('requires install, watchdog, exact manifest, removal, and hash restoration', () => {
    const evidence = {
      elevated: true,
      watchdogArmed: true,
      installed: true,
      rules: ['dns-udp', 'dns-tcp', 'https', 'turn-udp', 'turn-tls'],
      removed: true,
      policyHashBefore: 'a'.repeat(64),
      policyHashAfter: 'a'.repeat(64),
    };
    expect(verifyFirewallEvidence(evidence)).toEqual({
      pass: true,
      failures: [],
    });
    expect(
      verifyFirewallEvidence({
        ...evidence,
        watchdogArmed: false,
        policyHashAfter: 'b'.repeat(64),
      }),
    ).toMatchObject({
      pass: false,
      failures: expect.arrayContaining([
        'WATCHDOG_NOT_ARMED',
        'POLICY_NOT_RESTORED',
      ]),
    });
  });
});
