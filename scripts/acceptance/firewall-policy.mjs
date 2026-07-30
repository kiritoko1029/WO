import { isIP } from 'node:net';
import { resolve } from 'node:path';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FIREWALL_CONFIGURATION_FIELDS = Object.freeze([
  'turnAddress',
  'turnUdpPort',
  'turnTlsPort',
  'turnRelayMinPort',
  'turnRelayMaxPort',
  'controllerAddress',
  'controllerPort',
]);

export const FIREWALL_RULE_IDS = Object.freeze([
  'dns-udp',
  'dns-tcp',
  'https',
  'controller',
  'turn-udp',
  'turn-tcp',
  'turn-tls',
  'turn-relay',
]);

function hasExactFirewallRuleIds(value) {
  return (
    Array.isArray(value) &&
    value.length === FIREWALL_RULE_IDS.length &&
    new Set(value).size === FIREWALL_RULE_IDS.length &&
    FIREWALL_RULE_IDS.every((ruleId) => value.includes(ruleId))
  );
}

export class FirewallPolicyError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'FirewallPolicyError';
    this.code = code;
    this.detail = detail;
  }
}

function safePort(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST', { field: name });
  }
  return value;
}

function safeAbsolutePath(value, name) {
  if (typeof value !== 'string' || resolve(value) !== value) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST', { field: name });
  }
  return value;
}

function requireExactFields(value, expected) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
}

export function validateFirewallConfiguration(value) {
  requireExactFields(value, FIREWALL_CONFIGURATION_FIELDS);
  if (isIP(value.turnAddress) === 0 || isIP(value.controllerAddress) === 0) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
  const turnUdpPort = safePort(value.turnUdpPort, 'turnUdpPort');
  const turnTlsPort = safePort(value.turnTlsPort, 'turnTlsPort');
  const turnRelayMinPort = safePort(value.turnRelayMinPort, 'turnRelayMinPort');
  const turnRelayMaxPort = safePort(value.turnRelayMaxPort, 'turnRelayMaxPort');
  if (
    turnUdpPort === turnTlsPort ||
    turnRelayMinPort > turnRelayMaxPort ||
    [turnUdpPort, turnTlsPort].some(
      (port) => port >= turnRelayMinPort && port <= turnRelayMaxPort,
    )
  ) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST', {
      field: 'turnRelayRange',
    });
  }
  return Object.freeze({
    turnAddress: value.turnAddress,
    turnUdpPort,
    turnTlsPort,
    turnRelayMinPort,
    turnRelayMaxPort,
    controllerAddress: value.controllerAddress,
    controllerPort: safePort(value.controllerPort, 'controllerPort'),
  });
}

export function validateFirewallRequest(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !['win32', 'darwin'].includes(value.platform) ||
    !RUN_ID_PATTERN.test(value.runId ?? '')
  ) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
  const expected = [
    'platform',
    'runId',
    ...FIREWALL_CONFIGURATION_FIELDS,
    'desktopExecutable',
    'stateFile',
  ];
  requireExactFields(value, expected);
  const firewall = validateFirewallConfiguration(
    Object.fromEntries(
      FIREWALL_CONFIGURATION_FIELDS.map((field) => [field, value[field]]),
    ),
  );
  return Object.freeze({
    platform: value.platform,
    runId: value.runId,
    ...firewall,
    desktopExecutable: safeAbsolutePath(
      value.desktopExecutable,
      'desktopExecutable',
    ),
    stateFile: safeAbsolutePath(value.stateFile, 'stateFile'),
  });
}

export function buildFirewallInvocation(repositoryRoot, input, action) {
  const request = validateFirewallRequest(input);
  if (!['install', 'remove', 'status'].includes(action)) {
    throw new FirewallPolicyError('INVALID_FIREWALL_ACTION');
  }
  if (request.platform === 'win32') {
    return Object.freeze({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: Object.freeze([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'AllSigned',
        '-File',
        resolve(repositoryRoot, 'scripts/acceptance/firewall/windows.ps1'),
        '-Action',
        action,
        '-RunId',
        request.runId,
        '-TurnAddress',
        request.turnAddress,
        '-TurnUdpPort',
        String(request.turnUdpPort),
        '-TurnTlsPort',
        String(request.turnTlsPort),
        '-TurnRelayMinPort',
        String(request.turnRelayMinPort),
        '-TurnRelayMaxPort',
        String(request.turnRelayMaxPort),
        '-ControllerAddress',
        request.controllerAddress,
        '-ControllerPort',
        String(request.controllerPort),
        '-DesktopExecutable',
        request.desktopExecutable,
        '-StateFile',
        request.stateFile,
      ]),
      shell: false,
    });
  }
  return Object.freeze({
    command: '/bin/bash',
    args: Object.freeze([
      resolve(repositoryRoot, 'scripts/acceptance/firewall/macos.sh'),
      action,
      request.runId,
      request.turnAddress,
      String(request.turnUdpPort),
      String(request.turnTlsPort),
      String(request.turnRelayMinPort),
      String(request.turnRelayMaxPort),
      request.controllerAddress,
      String(request.controllerPort),
      request.desktopExecutable,
      request.stateFile,
    ]),
    shell: false,
  });
}

export function verifyFirewallInstallEvidence(value) {
  const failures = [];
  if (value?.elevated !== true) failures.push('NOT_ELEVATED');
  if (value?.watchdogArmed !== true) failures.push('WATCHDOG_NOT_ARMED');
  if (value?.installed !== true) failures.push('RULES_NOT_INSTALLED');
  if (!hasExactFirewallRuleIds(value?.manifestRules)) {
    failures.push('RULE_MANIFEST_INCOMPLETE');
  }
  const expectedRuleCount =
    FIREWALL_RULE_IDS.length + (value?.platform === 'darwin' ? 1 : 0);
  if (
    !['win32', 'darwin'].includes(value?.platform) ||
    !hasExactFirewallRuleIds(value?.rules) ||
    value?.ruleCount !== expectedRuleCount
  ) {
    failures.push('RULE_STATUS_INCOMPLETE');
  }
  if (value?.defaultBlockInstalled !== true) {
    failures.push('DEFAULT_BLOCK_NOT_INSTALLED');
  }
  return Object.freeze({ pass: failures.length === 0, failures });
}

export function verifyFirewallCleanupEvidence(value) {
  const failures = [];
  if (value?.elevated !== true) failures.push('NOT_ELEVATED');
  if (value?.removed !== true) failures.push('RULES_NOT_REMOVED');
  if (
    !Array.isArray(value?.residualRules) ||
    value.residualRules.length !== 0 ||
    value?.residualRuleCount !== 0
  ) {
    failures.push('RULES_STILL_INSTALLED');
  }
  if (
    typeof value?.policyHashBefore !== 'string' ||
    value.policyHashBefore.length !== 64 ||
    value.policyHashAfter !== value.policyHashBefore
  ) {
    failures.push('POLICY_NOT_RESTORED');
  }
  return Object.freeze({ pass: failures.length === 0, failures });
}

export function verifyFirewallEvidence(value) {
  const install = verifyFirewallInstallEvidence(value);
  const cleanup = verifyFirewallCleanupEvidence(value);
  const failures = [...install.failures, ...cleanup.failures];
  return Object.freeze({
    pass: failures.length === 0,
    failures: Object.freeze(failures),
  });
}
