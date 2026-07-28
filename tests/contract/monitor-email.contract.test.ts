import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  loadMonitorMailConfiguration,
  monitorEmailMessage,
  runMonitorEmail,
} from '../../deploy/scripts/monitor-email.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const postgresContainerId = 'a'.repeat(64);
const ingressContainerId = 'b'.repeat(64);
const now = Date.parse('2026-07-28T04:00:00.000Z');
const mailEnvironment = Object.freeze({
  WO_MONITOR_ALERT_FROM: 'wo-monitor@example.com',
  WO_MONITOR_ALERT_TO: 'operator@example.com, owner@example.com',
  WO_MONITOR_HOST_LABEL: 'wo-production',
});
const baseOptions = Object.freeze({
  envFile: '/opt/wo/.env',
  externalIngressContainerId: ingressContainerId,
  externalPostgresContainerId: postgresContainerId,
  mailEnvFile: '/etc/wo-monitor/mail.env',
  profile: 'external-db',
});

function dependencies(overrides = {}) {
  return {
    deliver: vi.fn(),
    loadEnvironment: vi.fn(() => mailEnvironment),
    now,
    writeOutput: vi.fn(),
    ...overrides,
  };
}

describe('monitor email contract', () => {
  test('does not send email for a healthy monitor result', async () => {
    const collectReport = vi.fn(async () => ({
      checkedServices: ['coturn', 'ingress', 'postgres', 'server'],
      healthy: true,
      issues: [],
    }));
    const context = dependencies({ collectReport });

    const result = await runMonitorEmail(baseOptions, context);

    expect(result).toMatchObject({
      alertSent: false,
      exitCode: 0,
      outcome: 'healthy',
    });
    expect(context.deliver).not.toHaveBeenCalled();
    expect(context.writeOutput).toHaveBeenCalledWith(
      'MONITOR_OK services=coturn,ingress,postgres,server\n',
    );
  });

  test('sends only a sanitized summary for an unhealthy result', async () => {
    const sensitiveIssue =
      'postgres inspection failed: token=TOP_SECRET env=/opt/wo/.env';
    const collectReport = vi.fn(async () => ({
      checkedServices: ['coturn', 'ingress', 'postgres', 'server'],
      healthy: false,
      issues: [sensitiveIssue],
    }));
    const context = dependencies({ collectReport });

    const result = await runMonitorEmail(baseOptions, context);

    expect(result).toMatchObject({
      alertSent: true,
      exitCode: 1,
      outcome: 'monitor-unhealthy',
    });
    expect(context.deliver).toHaveBeenCalledTimes(1);
    const [message, sendmailPath, envelopeSender] =
      context.deliver.mock.calls[0];
    expect(sendmailPath).toBe('/usr/sbin/sendmail');
    expect(envelopeSender).toBe('wo-monitor@example.com');
    expect(message).toContain('Subject: WO monitor alert: wo-production');
    expect(message).toContain('Status: monitor-unhealthy');
    expect(message).toContain(
      'Checked services: coturn,ingress,postgres,server',
    );
    expect(message).toContain('Issue count: 1');
    expect(message).not.toContain(sensitiveIssue);
    expect(message).not.toContain('TOP_SECRET');
    expect(message).not.toContain('/opt/wo/.env');
    expect(context.writeOutput).toHaveBeenCalledWith(
      'MONITOR_ISSUE count=1 services=coturn,ingress,postgres,server alert=email-sent\n',
    );
  });

  test('converts a thrown monitor failure into a generic email', async () => {
    const collectReport = vi.fn(async () => {
      throw new Error('smtp-token=TOP_SECRET');
    });
    const context = dependencies({ collectReport });

    const result = await runMonitorEmail(baseOptions, context);

    expect(result).toMatchObject({
      alertSent: true,
      exitCode: 1,
      outcome: 'monitor-error',
    });
    const [message] = context.deliver.mock.calls[0];
    expect(message).toContain(
      'Subject: WO monitor execution failed: wo-production',
    );
    expect(message).toContain('Status: monitor-execution-failed');
    expect(message).toContain('Issue count: unavailable');
    expect(message).not.toContain('TOP_SECRET');
    expect(context.writeOutput).toHaveBeenCalledWith(
      'MONITOR_RUN_FAILED alert=email-sent\n',
    );
  });

  test('converts an inconsistent monitor report into a generic email', async () => {
    const context = dependencies({
      collectReport: vi.fn(async () => ({
        checkedServices: ['server'],
        healthy: true,
        issues: ['contradictory issue'],
      })),
    });

    const result = await runMonitorEmail(baseOptions, context);

    expect(result).toMatchObject({
      alertSent: true,
      exitCode: 1,
      outcome: 'monitor-error',
    });
    const [message] = context.deliver.mock.calls[0];
    expect(message).toContain('Status: monitor-execution-failed');
    expect(message).not.toContain('contradictory issue');
  });

  test('test alert bypasses every Docker and certificate probe', async () => {
    const collectReport = vi.fn();
    const context = dependencies({ collectReport });

    const result = await runMonitorEmail(
      { ...baseOptions, testAlert: true },
      context,
    );

    expect(result).toEqual({
      alertSent: true,
      exitCode: 0,
      outcome: 'test-alert',
    });
    expect(collectReport).not.toHaveBeenCalled();
    const [message] = context.deliver.mock.calls[0];
    expect(message).toContain(
      'Subject: [TEST] WO monitor email: wo-production',
    );
    expect(message).toContain('Status: test-alert');
  });

  test('rejects header injection before sending or monitoring', async () => {
    const collectReport = vi.fn();
    const context = dependencies({
      collectReport,
      loadEnvironment: vi.fn(() => ({
        ...mailEnvironment,
        WO_MONITOR_ALERT_TO: 'operator@example.com\nBcc: attacker@example.com',
      })),
    });

    await expect(runMonitorEmail(baseOptions, context)).rejects.toThrow(
      'WO_MONITOR_ALERT_TO must be a bare email address',
    );
    expect(collectReport).not.toHaveBeenCalled();
    expect(context.deliver).not.toHaveBeenCalled();
  });

  test('wraps mail transport failures without exposing transport output', async () => {
    const transportError = new Error('password=TOP_SECRET');
    const context = dependencies({
      collectReport: vi.fn(async () => ({
        checkedServices: ['server'],
        healthy: false,
        issues: ['server is unavailable'],
      })),
      deliver: vi.fn(() => {
        throw transportError;
      }),
    });

    const failure = await runMonitorEmail(baseOptions, context).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Email alert delivery failed');
    expect(failure.message).not.toContain('TOP_SECRET');
    expect(failure.cause).toBe(transportError);
  });

  test('requires an absolute mail configuration path', () => {
    expect(() =>
      loadMonitorMailConfiguration('mail.env', () => mailEnvironment),
    ).toThrow('--mail-env-file must be an absolute path');
  });

  test('formats only validated summary fields', () => {
    const configuration = loadMonitorMailConfiguration(
      '/etc/wo-monitor/mail.env',
      () => mailEnvironment,
    );

    const message = monitorEmailMessage(
      {
        checkedServices: ['server', 'invalid service'],
        issueCount: 2,
        kind: 'monitor-unhealthy',
        profile: 'external-db',
      },
      configuration,
      now,
    );

    expect(message).toContain('Checked services: unavailable');
    expect(message).not.toContain('invalid service');
  });
});

describe('monitor systemd contract', () => {
  const service = readFileSync(
    resolve(repositoryRoot, 'deploy/systemd/wo-monitor.service'),
    'utf8',
  );
  const timer = readFileSync(
    resolve(repositoryRoot, 'deploy/systemd/wo-monitor.timer'),
    'utf8',
  );
  const monitorEnvironment = readFileSync(
    resolve(repositoryRoot, 'deploy/systemd/monitor.env.example'),
    'utf8',
  );
  const mailEnvironmentExample = readFileSync(
    resolve(repositoryRoot, 'deploy/systemd/mail.env.example'),
    'utf8',
  );

  test('pins the production env file and both external container identities', () => {
    expect(service).toContain('EnvironmentFile=/etc/wo-monitor/monitor.env');
    expect(service).toContain('--env-file=${WO_MONITOR_ENV_FILE}');
    expect(service).toContain('--mail-env-file=${WO_MONITOR_MAIL_ENV_FILE}');
    expect(service).toContain('--profile=external-db');
    expect(service).toContain(
      '--external-postgres-container-id=${WO_MONITOR_POSTGRES_CONTAINER_ID}',
    );
    expect(service).toContain(
      '--external-ingress-container-id=${WO_MONITOR_INGRESS_CONTAINER_ID}',
    );
    expect(monitorEnvironment).toContain('WO_MONITOR_ENV_FILE=/opt/wo/.env');
  });

  test('runs every five minutes without embedding mail credentials', () => {
    expect(timer).toContain('OnUnitActiveSec=5min');
    expect(timer).toContain('Persistent=true');
    expect(service).not.toMatch(/SMTP_(?:PASSWORD|TOKEN)|APP_PASSWORD/u);
    expect(monitorEnvironment).not.toMatch(
      /SMTP_(?:PASSWORD|TOKEN)|APP_PASSWORD/u,
    );
    expect(mailEnvironmentExample).not.toMatch(
      /SMTP_(?:PASSWORD|TOKEN)|APP_PASSWORD/u,
    );
  });
});
