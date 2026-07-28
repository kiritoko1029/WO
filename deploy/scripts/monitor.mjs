import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import * as tls from 'node:tls';
import { pathToFileURL } from 'node:url';

import {
  argumentValue,
  deploymentProcessEnvironment,
  failureMessage,
  hasArgument,
  loadDeploymentEnvironment,
} from './ops.mjs';

const monitoredServices = Object.freeze([
  'caddy',
  'coturn',
  'postgres',
  'server',
]);
const resourceLimitedServices = Object.freeze(['coturn', 'postgres', 'server']);
const completeContainerIdPattern = /^[a-f0-9]{64}$/u;
const maximumRestartCount = 3;
const maximumDiskUsagePercent = 85;
const minimumCertificateDays = 21;
const probeTimeoutMilliseconds = 8_000;
const subprocessTimeoutMilliseconds = 20_000;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;

function boundedRun(command, arguments_, { env, label } = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env,
    timeout: subprocessTimeoutMilliseconds,
  });
  if (result.error !== undefined) {
    throw new Error(
      `${label ?? command} did not complete: ${failureMessage(result.error)}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().slice(0, 200);
    throw new Error(
      `${label ?? command} failed${detail.length > 0 ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout;
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function certificateDaysRemaining(certificate, now) {
  const expiry = Date.parse(certificate.validTo);
  if (Number.isNaN(expiry)) {
    throw new Error('Certificate expiry timestamp is invalid');
  }
  return Math.floor((expiry - now) / millisecondsPerDay);
}

function webCertificateDaysRemaining(domain, now) {
  return new Promise((resolvePromise, reject) => {
    const socket = tls.connect(
      { host: domain, port: 443, servername: domain },
      () => {
        try {
          const peer = socket.getPeerX509Certificate();
          if (peer === undefined) {
            throw new Error('Web TLS endpoint returned no certificate');
          }
          resolvePromise(certificateDaysRemaining(peer, now));
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
        }
      },
    );
    socket.setTimeout(probeTimeoutMilliseconds, () => {
      socket.destroy();
      reject(new Error('Web TLS probe timed out'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function containerIssues(service, inspection) {
  const issues = [];
  const state = inspection?.State;
  if (state?.Running !== true) {
    issues.push(`${service} container is not running`);
  }
  const health = state?.Health?.Status;
  if (health === undefined) {
    issues.push(`${service} healthcheck is not configured`);
  } else if (health !== 'healthy') {
    issues.push(`${service} container health is ${health}`);
  }
  if (state?.OOMKilled === true) {
    issues.push(`${service} container was OOM killed`);
  }
  const restartCount = inspection?.RestartCount;
  if (!Number.isSafeInteger(restartCount) || restartCount < 0) {
    issues.push(`${service} restart count is unavailable`);
  } else if (restartCount > maximumRestartCount) {
    issues.push(`${service} restart count is ${restartCount}`);
  }
  if (!resourceLimitedServices.includes(service)) {
    return issues;
  }
  const logConfiguration = inspection?.HostConfig?.LogConfig;
  if (
    logConfiguration?.Type !== 'json-file' ||
    typeof logConfiguration?.Config?.['max-size'] !== 'string' ||
    typeof logConfiguration?.Config?.['max-file'] !== 'string'
  ) {
    issues.push(`${service} log rotation limits are missing`);
  }
  if (!(inspection?.HostConfig?.Memory > 0)) {
    issues.push(`${service} memory limit is missing`);
  }
  return issues;
}

function monitorContainerTargets({
  externalIngressContainerId,
  externalPostgresContainerId,
  profile,
  project,
}) {
  if (profile === 'root-managed-db') {
    if (
      externalIngressContainerId !== undefined ||
      externalPostgresContainerId !== undefined
    ) {
      throw new Error(
        'External container IDs are valid only for the external-db profile',
      );
    }
    return monitoredServices.map((service) => ({ project, service }));
  }
  if (profile !== 'external-db') {
    throw new Error('--profile must be root-managed-db or external-db');
  }
  if (!completeContainerIdPattern.test(externalPostgresContainerId ?? '')) {
    throw new Error(
      '--external-postgres-container-id must be a complete container ID',
    );
  }
  if (!completeContainerIdPattern.test(externalIngressContainerId ?? '')) {
    throw new Error(
      '--external-ingress-container-id must be a complete container ID',
    );
  }
  return [
    { project, service: 'coturn' },
    { containerId: externalIngressContainerId, service: 'ingress' },
    { containerId: externalPostgresContainerId, service: 'postgres' },
    { project, service: 'server' },
  ];
}

function collectContainerIssues(targets, execute, environment) {
  const issues = [];
  for (const target of targets) {
    const { service } = target;
    let containerId = target.containerId;
    if (containerId === undefined) {
      let containerIds;
      try {
        containerIds =
          execute(
            'docker',
            [
              'ps',
              '--all',
              '--quiet',
              '--filter',
              `label=com.docker.compose.project=${target.project}`,
              '--filter',
              `label=com.docker.compose.service=${service}`,
            ],
            { env: environment, label: `${service} container lookup` },
          ).match(/\S+/gu) ?? [];
      } catch (error) {
        issues.push(
          `${service} container lookup failed: ${failureMessage(error)}`,
        );
        continue;
      }
      if (containerIds.length !== 1) {
        issues.push(
          `${service} must have exactly one container, found ${containerIds.length}`,
        );
        continue;
      }
      [containerId] = containerIds;
    }
    try {
      const inspection = parseJson(
        execute('docker', ['inspect', '--format', '{{json .}}', containerId], {
          env: environment,
          label: `${service} container inspection`,
        }),
        `${service} container inspection`,
      );
      if (
        target.containerId !== undefined &&
        inspection?.Id !== target.containerId
      ) {
        issues.push(
          `${service} container identity does not match configured ID`,
        );
        continue;
      }
      issues.push(...containerIssues(service, inspection));
    } catch (error) {
      issues.push(
        `${service} container inspection failed: ${failureMessage(error)}`,
      );
    }
  }
  return issues;
}

function diskIssues(execute, environment, paths) {
  const issues = [];
  for (const path of paths) {
    let usagePercent;
    try {
      const rows = execute('df', ['-P', path], {
        env: environment,
        label: `disk usage for ${path}`,
      })
        .trim()
        .split(/\r?\n/u);
      const fields = rows.at(-1)?.split(/\s+/u) ?? [];
      usagePercent = Number((fields[4] ?? '').replace('%', ''));
    } catch (error) {
      issues.push(
        `disk usage check failed for ${path}: ${failureMessage(error)}`,
      );
      continue;
    }
    if (!Number.isSafeInteger(usagePercent) || usagePercent < 0) {
      issues.push(`disk usage is unreadable for ${path}`);
    } else if (usagePercent > maximumDiskUsagePercent) {
      issues.push(`disk usage for ${path} is ${usagePercent}%`);
    }
  }
  return issues;
}

async function turnCertificateIssues(environment, now, readCertificate) {
  const secretDirectory = environment.DEPLOY_SECRET_DIR?.trim() ?? '';
  if (!isAbsolute(secretDirectory)) {
    return ['DEPLOY_SECRET_DIR must be an absolute path'];
  }
  const certificateFile = resolve(secretDirectory, 'turn_tls_cert.pem');
  try {
    const certificate = new X509Certificate(
      await readCertificate(certificateFile),
    );
    const remainingDays = certificateDaysRemaining(certificate, now);
    return remainingDays < minimumCertificateDays
      ? [`TURN certificate expires in ${remainingDays} days`]
      : [];
  } catch (error) {
    return [`TURN certificate check failed: ${failureMessage(error)}`];
  }
}

export async function collectMonitorReport(
  {
    diskPaths = ['/', '/var/lib/docker'],
    domain,
    envFile,
    externalIngressContainerId,
    externalPostgresContainerId,
    now = Date.now(),
    profile = 'root-managed-db',
    project = 'wo',
    skipWebProbe = false,
  } = {},
  {
    execute = boundedRun,
    loadEnvironment = loadDeploymentEnvironment,
    readCertificate = readFile,
    webProbe = webCertificateDaysRemaining,
  } = {},
) {
  if (typeof envFile !== 'string' || envFile.length === 0) {
    throw new Error('--env-file is required');
  }
  const containerTargets = monitorContainerTargets({
    externalIngressContainerId,
    externalPostgresContainerId,
    profile,
    project,
  });
  const environment = loadEnvironment(resolve(envFile));
  const processEnvironment = deploymentProcessEnvironment({}, process.env);
  const issues = [
    ...collectContainerIssues(containerTargets, execute, processEnvironment),
    ...diskIssues(execute, processEnvironment, diskPaths),
    ...(await turnCertificateIssues(environment, now, readCertificate)),
  ];
  if (!skipWebProbe) {
    const webDomain = domain?.trim() || environment.APP_DOMAIN?.trim() || '';
    if (webDomain.length === 0) {
      issues.push('APP_DOMAIN is required for the web certificate probe');
    } else {
      try {
        const remainingDays = await webProbe(webDomain, now);
        if (remainingDays < minimumCertificateDays) {
          issues.push(`Web certificate expires in ${remainingDays} days`);
        }
      } catch (error) {
        issues.push(`Web certificate check failed: ${failureMessage(error)}`);
      }
    }
  }
  return {
    healthy: issues.length === 0,
    issues,
    checkedServices: containerTargets.map(({ service }) => service),
  };
}

export async function runMonitor(options = {}, dependencies = {}) {
  const report = await collectMonitorReport(options, dependencies);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.healthy) {
    process.stdout.write(
      `MONITOR_OK services=${report.checkedServices.join(',')}\n`,
    );
  } else {
    for (const issue of report.issues) {
      process.stdout.write(`MONITOR_ISSUE ${issue}\n`);
    }
  }
  if (!report.healthy) {
    process.exitCode = 1;
  }
  return report;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMonitor({
    domain: argumentValue('--domain'),
    envFile: argumentValue('--env-file'),
    externalIngressContainerId: argumentValue(
      '--external-ingress-container-id',
    ),
    externalPostgresContainerId: argumentValue(
      '--external-postgres-container-id',
    ),
    json: hasArgument('--json'),
    profile: argumentValue('--profile', 'root-managed-db'),
    project: argumentValue('--project', 'wo'),
    skipWebProbe: hasArgument('--skip-web-probe'),
  }).catch((error) => {
    process.stderr.write(`Monitor failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
