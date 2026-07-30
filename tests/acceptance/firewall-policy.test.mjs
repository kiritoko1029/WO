import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  buildFirewallInvocation,
  FIREWALL_RULE_IDS,
  validateFirewallConfiguration,
  validateFirewallRequest,
  verifyFirewallCleanupEvidence,
  verifyFirewallEvidence,
  verifyFirewallInstallEvidence,
} from '../../scripts/acceptance/firewall-policy.mjs';

const root = resolve('.');

function request(platform = 'win32') {
  return {
    platform,
    runId: 'run-1080p60-1',
    turnAddress: '203.0.113.20',
    turnUdpPort: 3478,
    turnTlsPort: 5349,
    turnRelayMinPort: 49160,
    turnRelayMaxPort: 49359,
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
      expect(invocation.args).toContain('49160');
      expect(invocation.args).toContain('49359');
      expect(JSON.stringify(invocation)).not.toContain('token');
    },
  );

  test.each([
    ['command injection', { runId: 'run; Remove-Item C:\\' }],
    ['hostname instead of resolved IP', { turnAddress: 'turn.example.test' }],
    ['relative executable', { desktopExecutable: 'WO.exe' }],
    ['invalid port', { turnUdpPort: 0 }],
    [
      'descending relay range',
      { turnRelayMinPort: 49360, turnRelayMaxPort: 49359 },
    ],
    ['overlapping relay range', { turnRelayMinPort: 3478 }],
    ['duplicate TURN listeners', { turnTlsPort: 3478 }],
    ['unexpected field', { token: 'secret' }],
  ])('rejects %s', (_name, change) => {
    expect(() => validateFirewallRequest({ ...request(), ...change })).toThrow(
      expect.objectContaining({ code: 'INVALID_FIREWALL_REQUEST' }),
    );
  });

  test('shares the exact bounded TURN configuration contract with the agent', () => {
    const source = request();
    const firewall = {
      turnAddress: source.turnAddress,
      turnUdpPort: source.turnUdpPort,
      turnTlsPort: source.turnTlsPort,
      turnRelayMinPort: source.turnRelayMinPort,
      turnRelayMaxPort: source.turnRelayMaxPort,
      controllerAddress: source.controllerAddress,
      controllerPort: source.controllerPort,
    };
    expect(validateFirewallConfiguration(firewall)).toEqual(firewall);
    expect(() =>
      validateFirewallConfiguration({
        ...firewall,
        turnRelayMaxPort: 70_000,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_FIREWALL_REQUEST' }));
  });

  test('platform rules allow the relay range before applying the default block', async () => {
    const [agent, macos, windows] = await Promise.all([
      readFile(resolve('scripts/acceptance/agent.mjs'), 'utf8'),
      readFile(resolve('scripts/acceptance/firewall/macos.sh'), 'utf8'),
      readFile(resolve('scripts/acceptance/firewall/windows.ps1'), 'utf8'),
    ]);
    const relayRule =
      'pass out quick proto udp from any to $turn_address port $turn_relay_min_port:$turn_relay_max_port label "${label_prefix}turn-relay"';
    expect(macos).toContain(
      'pass out quick proto tcp from any to $turn_address port $turn_udp_port label "${label_prefix}turn-tcp"',
    );
    expect(macos).toContain(relayRule);
    expect(macos.indexOf(relayRule)).toBeLessThan(
      macos.indexOf(
        'block drop out quick proto { tcp udp } from any to any label "${label_prefix}default-block"',
      ),
    );
    expect(macos).not.toContain('pfctl -E >/dev/null 2>&1 || true');
    expect(macos.indexOf('after="$(policy_hash)"')).toBeLessThan(
      macos.indexOf(
        '/bin/rm -f "${state_file}.rules" "${state_file}.pf.conf" "$state_file"',
      ),
    );
    expect(windows).toContain('port = "$TurnRelayMinPort-$TurnRelayMaxPort"');
    expect(windows).toContain(
      "suffix = 'turn-tcp'; protocol = 'TCP'; port = $TurnUdpPort",
    );
    expect(windows).toContain("if ($Action -eq 'status')");
    expect(agent).toContain(
      "buildFirewallInvocation(REPOSITORY_ROOT, request, 'status')",
    );
  });

  test('requires install, watchdog, exact manifest, removal, and hash restoration', () => {
    const evidence = {
      platform: 'win32',
      elevated: true,
      watchdogArmed: true,
      installed: true,
      manifestRules: FIREWALL_RULE_IDS,
      rules: FIREWALL_RULE_IDS,
      ruleCount: FIREWALL_RULE_IDS.length,
      defaultBlockInstalled: true,
      removed: true,
      residualRules: [],
      residualRuleCount: 0,
      policyHashBefore: 'a'.repeat(64),
      policyHashAfter: 'a'.repeat(64),
    };
    expect(verifyFirewallInstallEvidence(evidence)).toEqual({
      pass: true,
      failures: [],
    });
    expect(verifyFirewallCleanupEvidence(evidence)).toEqual({
      pass: true,
      failures: [],
    });
    expect(verifyFirewallEvidence(evidence)).toEqual({
      pass: true,
      failures: [],
    });
    expect(
      verifyFirewallEvidence({
        ...evidence,
        watchdogArmed: false,
        manifestRules: FIREWALL_RULE_IDS.slice(0, -1),
        residualRules: ['turn-udp'],
        residualRuleCount: 1,
        policyHashAfter: 'b'.repeat(64),
      }),
    ).toMatchObject({
      pass: false,
      failures: expect.arrayContaining([
        'WATCHDOG_NOT_ARMED',
        'RULE_MANIFEST_INCOMPLETE',
        'RULES_STILL_INSTALLED',
        'POLICY_NOT_RESTORED',
      ]),
    });
  });

  test('accepts unordered actual rules but rejects duplicate and partial status', () => {
    const evidence = {
      platform: 'darwin',
      elevated: true,
      watchdogArmed: true,
      installed: true,
      manifestRules: FIREWALL_RULE_IDS,
      rules: [...FIREWALL_RULE_IDS].reverse(),
      ruleCount: FIREWALL_RULE_IDS.length + 1,
      defaultBlockInstalled: true,
    };
    expect(verifyFirewallInstallEvidence(evidence)).toEqual({
      pass: true,
      failures: [],
    });
    expect(
      verifyFirewallInstallEvidence({
        ...evidence,
        rules: [...FIREWALL_RULE_IDS.slice(0, -1), 'turn-udp'],
      }),
    ).toMatchObject({
      pass: false,
      failures: expect.arrayContaining(['RULE_STATUS_INCOMPLETE']),
    });
  });
});
