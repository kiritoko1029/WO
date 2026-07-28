import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectMonitorReport } from './monitor.mjs';
import {
  argumentValue,
  deploymentProcessEnvironment,
  failureMessage,
  hasArgument,
  loadDeploymentEnvironment,
} from './ops.mjs';

const defaultSendmailPath = '/usr/sbin/sendmail';
const sendmailTimeoutMilliseconds = 20_000;
const maximumRecipients = 10;
const maximumEmailAddressLength = 254;
const maximumHostLabelLength = 64;
const emailAddressPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9][A-Za-z0-9.-]*$/u;
const hostLabelPattern = /^[A-Za-z0-9._-]+$/u;
const serviceLabelPattern = /^[a-z0-9_-]+$/u;
const monitorProfiles = new Set(['external-db', 'root-managed-db']);

function requiredEnvironmentValue(environment, field) {
  const value = environment[field]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function validateEmailAddress(value, field) {
  if (
    value.length > maximumEmailAddressLength ||
    !emailAddressPattern.test(value)
  ) {
    throw new Error(`${field} must be a bare email address`);
  }
  return value;
}

function recipientList(value) {
  const recipients = value.split(',').map((recipient) => recipient.trim());
  if (
    recipients.length === 0 ||
    recipients.length > maximumRecipients ||
    recipients.some((recipient) => recipient.length === 0)
  ) {
    throw new Error(
      `WO_MONITOR_ALERT_TO must contain between 1 and ${maximumRecipients} email addresses`,
    );
  }
  return recipients.map((recipient) =>
    validateEmailAddress(recipient, 'WO_MONITOR_ALERT_TO'),
  );
}

function hostLabel(value) {
  if (value.length > maximumHostLabelLength || !hostLabelPattern.test(value)) {
    throw new Error(
      'WO_MONITOR_HOST_LABEL may contain only letters, numbers, dots, underscores, and hyphens',
    );
  }
  return value;
}

export function loadMonitorMailConfiguration(
  mailEnvFile,
  loadEnvironment = loadDeploymentEnvironment,
) {
  if (typeof mailEnvFile !== 'string' || !isAbsolute(mailEnvFile)) {
    throw new Error('--mail-env-file must be an absolute path');
  }
  const environment = loadEnvironment(resolve(mailEnvFile));
  return Object.freeze({
    from: validateEmailAddress(
      requiredEnvironmentValue(environment, 'WO_MONITOR_ALERT_FROM'),
      'WO_MONITOR_ALERT_FROM',
    ),
    host: hostLabel(
      requiredEnvironmentValue(environment, 'WO_MONITOR_HOST_LABEL'),
    ),
    recipients: Object.freeze(
      recipientList(
        requiredEnvironmentValue(environment, 'WO_MONITOR_ALERT_TO'),
      ),
    ),
  });
}

function checkedServiceSummary(checkedServices) {
  if (
    !Array.isArray(checkedServices) ||
    checkedServices.length === 0 ||
    checkedServices.some(
      (service) =>
        typeof service !== 'string' || !serviceLabelPattern.test(service),
    )
  ) {
    return 'unavailable';
  }
  return checkedServices.join(',');
}

function validateMonitorReport(report) {
  if (
    report === null ||
    typeof report !== 'object' ||
    typeof report.healthy !== 'boolean' ||
    !Array.isArray(report.issues) ||
    report.issues.some((issue) => typeof issue !== 'string') ||
    checkedServiceSummary(report.checkedServices) === 'unavailable' ||
    report.healthy !== (report.issues.length === 0)
  ) {
    throw new Error('Monitor report is invalid');
  }
  return report;
}

function alertSubject(kind, host) {
  if (kind === 'test') {
    return `[TEST] WO monitor email: ${host}`;
  }
  if (kind === 'monitor-error') {
    return `WO monitor execution failed: ${host}`;
  }
  return `WO monitor alert: ${host}`;
}

export function monitorEmailMessage(
  { checkedServices, issueCount, kind, profile },
  configuration,
  now = Date.now(),
) {
  if (!monitorProfiles.has(profile)) {
    throw new Error('Monitor email profile is invalid');
  }
  if (!['monitor-error', 'monitor-unhealthy', 'test'].includes(kind)) {
    throw new Error('Monitor email kind is invalid');
  }
  if (
    issueCount !== undefined &&
    (!Number.isSafeInteger(issueCount) || issueCount < 0)
  ) {
    throw new Error('Monitor email issue count is invalid');
  }
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error('Monitor email timestamp is invalid');
  }
  const status =
    kind === 'test'
      ? 'test-alert'
      : kind === 'monitor-error'
        ? 'monitor-execution-failed'
        : 'monitor-unhealthy';
  const issueCountText =
    issueCount === undefined ? 'unavailable' : String(issueCount);
  const lines = [
    `From: ${configuration.from}`,
    `To: ${configuration.recipients.join(', ')}`,
    `Subject: ${alertSubject(kind, configuration.host)}`,
    `Date: ${timestamp.toUTCString()}`,
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'WO production monitor notification',
    '',
    `Host: ${configuration.host}`,
    `Time: ${timestamp.toISOString()}`,
    `Profile: ${profile}`,
    `Status: ${status}`,
    `Checked services: ${checkedServiceSummary(checkedServices)}`,
    `Issue count: ${issueCountText}`,
    '',
    'Issue details are intentionally omitted from email.',
    'Inspect the protected host journal: journalctl -u wo-monitor.service',
    '',
  ];
  return lines.join('\r\n');
}

function deliverWithSendmail(
  message,
  sendmailPath,
  envelopeSender,
  shellEnvironment = process.env,
) {
  if (typeof sendmailPath !== 'string' || !isAbsolute(sendmailPath)) {
    throw new Error('--sendmail-path must be an absolute path');
  }
  const result = spawnSync(sendmailPath, ['-f', envelopeSender, '-t', '-oi'], {
    encoding: 'utf8',
    env: deploymentProcessEnvironment({}, shellEnvironment),
    input: message,
    timeout: sendmailTimeoutMilliseconds,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Email alert delivery failed', {
      cause:
        result.error ??
        new Error('sendmail returned a nonzero or unavailable exit status'),
    });
  }
}

async function sendMonitorEmail(
  alert,
  configuration,
  {
    deliver = deliverWithSendmail,
    now = Date.now(),
    sendmailPath = defaultSendmailPath,
  } = {},
) {
  const message = monitorEmailMessage(alert, configuration, now);
  try {
    await deliver(message, sendmailPath, configuration.from);
  } catch (error) {
    throw new Error('Email alert delivery failed', { cause: error });
  }
}

function monitorOptions(options) {
  return {
    domain: options.domain,
    envFile: options.envFile,
    externalIngressContainerId: options.externalIngressContainerId,
    externalPostgresContainerId: options.externalPostgresContainerId,
    profile: options.profile,
    project: options.project,
    skipWebProbe: options.skipWebProbe,
  };
}

export async function runMonitorEmail(
  {
    mailEnvFile,
    profile = 'root-managed-db',
    project = 'wo',
    testAlert = false,
    ...options
  } = {},
  {
    collectReport = collectMonitorReport,
    deliver,
    loadEnvironment = loadDeploymentEnvironment,
    now = Date.now(),
    sendmailPath = defaultSendmailPath,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  if (!monitorProfiles.has(profile)) {
    throw new Error('--profile must be root-managed-db or external-db');
  }
  const configuration = loadMonitorMailConfiguration(
    mailEnvFile,
    loadEnvironment,
  );
  const mailDependencies = { deliver, now, sendmailPath };
  if (testAlert) {
    await sendMonitorEmail(
      {
        checkedServices: [],
        issueCount: 0,
        kind: 'test',
        profile,
      },
      configuration,
      mailDependencies,
    );
    writeOutput(`MONITOR_TEST_ALERT_SENT host=${configuration.host}\n`);
    return { alertSent: true, exitCode: 0, outcome: 'test-alert' };
  }

  let report;
  try {
    report = validateMonitorReport(
      await collectReport(monitorOptions({ ...options, profile, project })),
    );
  } catch {
    await sendMonitorEmail(
      {
        checkedServices: [],
        kind: 'monitor-error',
        profile,
      },
      configuration,
      mailDependencies,
    );
    writeOutput('MONITOR_RUN_FAILED alert=email-sent\n');
    return { alertSent: true, exitCode: 1, outcome: 'monitor-error' };
  }

  if (report.healthy) {
    writeOutput(
      `MONITOR_OK services=${checkedServiceSummary(report.checkedServices)}\n`,
    );
    return {
      alertSent: false,
      exitCode: 0,
      outcome: 'healthy',
      report,
    };
  }

  await sendMonitorEmail(
    {
      checkedServices: report.checkedServices,
      issueCount: report.issues.length,
      kind: 'monitor-unhealthy',
      profile,
    },
    configuration,
    mailDependencies,
  );
  writeOutput(
    `MONITOR_ISSUE count=${report.issues.length} services=${checkedServiceSummary(report.checkedServices)} alert=email-sent\n`,
  );
  return {
    alertSent: true,
    exitCode: 1,
    outcome: 'monitor-unhealthy',
    report,
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMonitorEmail({
    domain: argumentValue('--domain'),
    envFile: argumentValue('--env-file'),
    externalIngressContainerId: argumentValue(
      '--external-ingress-container-id',
    ),
    externalPostgresContainerId: argumentValue(
      '--external-postgres-container-id',
    ),
    mailEnvFile: argumentValue('--mail-env-file'),
    profile: argumentValue('--profile', 'root-managed-db'),
    project: argumentValue('--project', 'wo'),
    skipWebProbe: hasArgument('--skip-web-probe'),
    testAlert: hasArgument('--test-alert'),
  })
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `Monitor email wrapper failed (${failureMessage(error)})\n`,
      );
      process.exitCode = 1;
    });
}
