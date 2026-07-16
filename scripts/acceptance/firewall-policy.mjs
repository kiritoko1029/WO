import { isIP } from 'node:net';
import { resolve } from 'node:path';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

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

export function validateFirewallRequest(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !['win32', 'darwin'].includes(value.platform) ||
    !RUN_ID_PATTERN.test(value.runId ?? '') ||
    isIP(value.turnAddress) === 0 ||
    isIP(value.controllerAddress) === 0
  ) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
  const expected = [
    'platform',
    'runId',
    'turnAddress',
    'turnUdpPort',
    'turnTlsPort',
    'controllerAddress',
    'controllerPort',
    'desktopExecutable',
    'stateFile',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new FirewallPolicyError('INVALID_FIREWALL_REQUEST');
  }
  return Object.freeze({
    platform: value.platform,
    runId: value.runId,
    turnAddress: value.turnAddress,
    turnUdpPort: safePort(value.turnUdpPort, 'turnUdpPort'),
    turnTlsPort: safePort(value.turnTlsPort, 'turnTlsPort'),
    controllerAddress: value.controllerAddress,
    controllerPort: safePort(value.controllerPort, 'controllerPort'),
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
      request.controllerAddress,
      String(request.controllerPort),
      request.desktopExecutable,
      request.stateFile,
    ]),
    shell: false,
  });
}

export function verifyFirewallEvidence(value) {
  const failures = [];
  if (value?.elevated !== true) failures.push('NOT_ELEVATED');
  if (value?.watchdogArmed !== true) failures.push('WATCHDOG_NOT_ARMED');
  if (value?.installed !== true) failures.push('RULES_NOT_INSTALLED');
  if (!Array.isArray(value?.rules) || value.rules.length < 5) {
    failures.push('RULE_MANIFEST_INCOMPLETE');
  }
  if (value?.removed !== true) failures.push('RULES_NOT_REMOVED');
  if (
    typeof value?.policyHashBefore !== 'string' ||
    value.policyHashBefore.length !== 64 ||
    value.policyHashAfter !== value.policyHashBefore
  ) {
    failures.push('POLICY_NOT_RESTORED');
  }
  return Object.freeze({ pass: failures.length === 0, failures });
}
