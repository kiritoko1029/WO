import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  collectMonitorReport,
  runMonitor,
} from '../../deploy/scripts/monitor.mjs';

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const turnCertificatePem = readFileSync(
  resolve(import.meta.dirname, '..', 'fixtures', 'deploy-turn-cert.pem'),
);
const turnCertificate = new X509Certificate(turnCertificatePem);
const freshNow = Date.parse(turnCertificate.validFrom) + 60 * 60 * 1_000;
const expiringNow =
  Date.parse(turnCertificate.validTo) - 3 * millisecondsPerDay;
const expectedExpiryDays = Math.floor(
  (Date.parse(turnCertificate.validTo) - expiringNow) / millisecondsPerDay,
);
const externalPostgresContainerId = 'a'.repeat(64);
const externalIngressContainerId = 'b'.repeat(64);
const temporaryDirectories: string[] = [];

type InspectionOverride = {
  health?: string;
  healthAbsent?: boolean;
  id?: string;
  logType?: string;
  memory?: number;
  oomKilled?: boolean;
  restartCount?: number;
  running?: boolean;
};

function inspectionFor(override: InspectionOverride = {}) {
  return JSON.stringify({
    ...(override.id === undefined ? {} : { Id: override.id }),
    HostConfig: {
      LogConfig: {
        Config: { 'max-file': '5', 'max-size': '10m' },
        Type: override.logType ?? 'json-file',
      },
      Memory: override.memory ?? 512 * 1024 * 1024,
    },
    RestartCount: override.restartCount ?? 0,
    State: {
      ...(override.healthAbsent === true
        ? {}
        : { Health: { Status: override.health ?? 'healthy' } }),
      OOMKilled: override.oomKilled ?? false,
      Running: override.running ?? true,
    },
  });
}

function createExecute({
  diskUsagePercent = 40,
  inspections = {},
  missingService,
}: {
  diskUsagePercent?: number;
  inspections?: Record<string, InspectionOverride>;
  missingService?: string;
} = {}) {
  return (command: string, arguments_: string[]) => {
    if (command === 'df') {
      return [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        `/dev/disk 1000 400 600 ${diskUsagePercent}% ${arguments_.at(-1)}`,
      ].join('\n');
    }
    if (arguments_[0] === 'ps') {
      const service =
        arguments_
          .find((argument) => argument.includes('compose.service='))
          ?.split('=')
          .at(-1) ?? '';
      return service === missingService ? '' : `${service}-container-id\n`;
    }
    const containerId = arguments_.at(-1) ?? '';
    const externalService =
      containerId === externalPostgresContainerId
        ? 'postgres'
        : containerId === externalIngressContainerId
          ? 'ingress'
          : undefined;
    const service = externalService ?? containerId.replace('-container-id', '');
    return inspectionFor({
      ...(externalService === undefined ? {} : { id: containerId }),
      ...inspections[service],
    });
  };
}

async function createEnvFile() {
  const directory = await mkdtemp(resolve(tmpdir(), 'wo-monitor-contract-'));
  temporaryDirectories.push(directory);
  const envFile = resolve(directory, '.env');
  await writeFile(
    envFile,
    'APP_DOMAIN=rtc.example.test\nDEPLOY_SECRET_DIR=/opt/wo/deploy/secrets\n',
  );
  return envFile;
}

const environmentWithSecrets = () => ({
  APP_DOMAIN: 'rtc.example.test',
  DEPLOY_SECRET_DIR: '/opt/wo/deploy/secrets',
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('monitor read-only report contract', () => {
  test('reports fully healthy across all four services with valid certificates', async () => {
    const envFile = await createEnvFile();
    const readPaths: string[] = [];
    const report = await collectMonitorReport(
      { envFile, now: freshNow },
      {
        execute: createExecute(),
        loadEnvironment: environmentWithSecrets,
        readCertificate: async (file: string) => {
          readPaths.push(file);
          return turnCertificatePem;
        },
        webProbe: async () => 60,
      },
    );
    expect(report.checkedServices).toEqual([
      'caddy',
      'coturn',
      'postgres',
      'server',
    ]);
    expect(report.issues).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(readPaths).toEqual(['/opt/wo/deploy/secrets/turn_tls_cert.pem']);
  });

  test('uses explicit external identities without Compose lookups for external services', async () => {
    const envFile = await createEnvFile();
    const execute = vi.fn(createExecute());
    const report = await collectMonitorReport(
      {
        envFile,
        externalIngressContainerId,
        externalPostgresContainerId,
        now: freshNow,
        profile: 'external-db',
      },
      {
        execute,
        loadEnvironment: environmentWithSecrets,
        readCertificate: async () => turnCertificatePem,
        webProbe: async () => 60,
      },
    );

    expect(report.checkedServices).toEqual([
      'coturn',
      'ingress',
      'postgres',
      'server',
    ]);
    expect(report.issues).toEqual([]);
    expect(report.healthy).toBe(true);
    const composeLookups = execute.mock.calls
      .filter(([, arguments_]) => arguments_[0] === 'ps')
      .map(([, arguments_]) =>
        arguments_.find((argument) =>
          argument.includes('com.docker.compose.service='),
        ),
      );
    expect(composeLookups).toEqual([
      'label=com.docker.compose.service=coturn',
      'label=com.docker.compose.service=server',
    ]);
    expect(execute).toHaveBeenCalledWith(
      'docker',
      ['inspect', '--format', '{{json .}}', externalIngressContainerId],
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledWith(
      'docker',
      ['inspect', '--format', '{{json .}}', externalPostgresContainerId],
      expect.any(Object),
    );
  });

  test.each([
    {
      name: 'missing external PostgreSQL identity',
      options: {
        externalIngressContainerId,
        profile: 'external-db',
      },
      message:
        '--external-postgres-container-id must be a complete container ID',
    },
    {
      name: 'short external ingress identity',
      options: {
        externalIngressContainerId: 'short-id',
        externalPostgresContainerId,
        profile: 'external-db',
      },
      message:
        '--external-ingress-container-id must be a complete container ID',
    },
    {
      name: 'unsupported profile',
      options: { profile: 'unsupported' },
      message: '--profile must be root-managed-db or external-db',
    },
    {
      name: 'external identities on the root-managed profile',
      options: {
        externalIngressContainerId,
        externalPostgresContainerId,
        profile: 'root-managed-db',
      },
      message:
        'External container IDs are valid only for the external-db profile',
    },
  ])('rejects $name before running probes', async ({ message, options }) => {
    const envFile = await createEnvFile();
    const execute = vi.fn(createExecute());

    await expect(
      collectMonitorReport(
        { envFile, now: freshNow, skipWebProbe: true, ...options },
        {
          execute,
          loadEnvironment: environmentWithSecrets,
          readCertificate: async () => turnCertificatePem,
        },
      ),
    ).rejects.toThrow(message);
    expect(execute).not.toHaveBeenCalled();
  });

  test('reports an external container identity mismatch', async () => {
    const envFile = await createEnvFile();
    const report = await collectMonitorReport(
      {
        envFile,
        externalIngressContainerId,
        externalPostgresContainerId,
        now: freshNow,
        profile: 'external-db',
        skipWebProbe: true,
      },
      {
        execute: createExecute({
          inspections: { ingress: { id: 'c'.repeat(64) } },
        }),
        loadEnvironment: environmentWithSecrets,
        readCertificate: async () => turnCertificatePem,
      },
    );

    expect(report.healthy).toBe(false);
    expect(report.issues).toContain(
      'ingress container identity does not match configured ID',
    );
  });

  test('flags unhealthy containers, restarts, OOM, missing healthcheck, and missing limits', async () => {
    const envFile = await createEnvFile();
    const report = await collectMonitorReport(
      { envFile, now: freshNow, skipWebProbe: true },
      {
        execute: createExecute({
          inspections: {
            caddy: { healthAbsent: true, logType: 'none', memory: 0 },
            coturn: { restartCount: 12 },
            postgres: { logType: 'none', memory: 0 },
            server: { health: 'unhealthy', oomKilled: true },
          },
        }),
        loadEnvironment: environmentWithSecrets,
        readCertificate: async () => {
          throw new Error('certificate file is unreadable');
        },
      },
    );
    const joined = report.issues.join('\n');
    expect(report.healthy).toBe(false);
    expect(joined).toMatch(/caddy healthcheck is not configured/iu);
    expect(joined).not.toMatch(/caddy (log rotation|memory) /iu);
    expect(joined).toMatch(/server container health is unhealthy/iu);
    expect(joined).toMatch(/server container was OOM killed/iu);
    expect(joined).toMatch(/coturn restart count is 12/iu);
    expect(joined).toMatch(/postgres log rotation limits are missing/iu);
    expect(joined).toMatch(/postgres memory limit is missing/iu);
    expect(joined).toMatch(/TURN certificate check failed/iu);
  });

  test('flags missing containers, full disks, and both certificate expiries', async () => {
    const envFile = await createEnvFile();
    const report = await collectMonitorReport(
      { envFile, now: expiringNow },
      {
        execute: createExecute({
          diskUsagePercent: 97,
          missingService: 'coturn',
        }),
        loadEnvironment: environmentWithSecrets,
        readCertificate: async () => turnCertificatePem,
        webProbe: async () => 3,
      },
    );
    const joined = report.issues.join('\n');
    expect(report.healthy).toBe(false);
    expect(joined).toMatch(/coturn must have exactly one container, found 0/iu);
    expect(joined).toMatch(/disk usage for \/ is 97%/iu);
    expect(joined).toContain(
      `TURN certificate expires in ${expectedExpiryDays} days`,
    );
    expect(joined).toMatch(/Web certificate expires in 3 days/iu);
  });

  test('rejects relative secret directories and missing env file input', async () => {
    const envFile = await createEnvFile();
    const report = await collectMonitorReport(
      { envFile, now: freshNow, skipWebProbe: true },
      {
        execute: createExecute(),
        loadEnvironment: () => ({ DEPLOY_SECRET_DIR: 'relative/secrets' }),
        readCertificate: async () => {
          throw new Error('unreachable');
        },
      },
    );
    expect(report.issues.join('\n')).toMatch(
      /DEPLOY_SECRET_DIR must be an absolute path/iu,
    );
    await expect(collectMonitorReport({}, {})).rejects.toThrow(
      /--env-file is required/iu,
    );
  });

  test('runMonitor exposes the documented exit-code and output alerting contract', async () => {
    const envFile = await createEnvFile();
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const previousExitCode = process.exitCode;
    try {
      await runMonitor(
        { envFile, now: freshNow },
        {
          execute: createExecute(),
          loadEnvironment: environmentWithSecrets,
          readCertificate: async () => turnCertificatePem,
          webProbe: async () => 60,
        },
      );
      expect(process.exitCode).toBe(previousExitCode);
      expect(writes.join('')).toContain(
        'MONITOR_OK services=caddy,coturn,postgres,server',
      );

      writes.length = 0;
      await runMonitor(
        { envFile, now: freshNow, skipWebProbe: true },
        {
          execute: createExecute({
            inspections: { server: { health: 'unhealthy' } },
          }),
          loadEnvironment: environmentWithSecrets,
          readCertificate: async () => turnCertificatePem,
        },
      );
      expect(process.exitCode).toBe(1);
      expect(writes.join('')).toContain(
        'MONITOR_ISSUE server container health is unhealthy',
      );
    } finally {
      stdoutSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
