import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const deploy = resolve(root, 'deploy');
const envFile = resolve(
  process.env.WO_COMPOSE_ENV_FILE ?? resolve(deploy, '.env.integration'),
);
const integrationEnabled = process.env.WO_RUN_COMPOSE_INTEGRATION === '1';
const keepStack = process.env.WO_KEEP_COMPOSE_INTEGRATION === '1';

const composeFiles = [
  '--project-name',
  'wo-integration',
  '--env-file',
  envFile,
  '-f',
  resolve(deploy, 'compose.yaml'),
  '-f',
  resolve(deploy, 'compose.integration.yaml'),
];

function run(command: string, arguments_: string[], timeout = 600_000): string {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

describe.skipIf(!integrationEnabled)('four-service Compose integration', () => {
  let stackStarted = false;

  beforeAll(() => {
    run(process.execPath, [
      resolve(deploy, 'scripts', 'preflight.mjs'),
      `--env-file=${envFile}`,
      '--integration',
      '--allow-non-linux',
    ]);
    run('docker', [
      'compose',
      ...composeFiles,
      'up',
      '-d',
      '--build',
      '--wait',
    ]);
    stackStarted = true;
  }, 600_000);

  afterAll(() => {
    if (stackStarted && !keepStack) {
      run('docker', [
        'compose',
        ...composeFiles,
        'down',
        '-v',
        '--remove-orphans',
      ]);
    }
  }, 120_000);

  test('reports exactly four healthy services with loopback publications', () => {
    const services = run('docker', [
      'compose',
      ...composeFiles,
      'ps',
      '--format',
      'json',
    ])
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line)) as Array<{
      Health: string;
      Name: string;
      Publishers: Array<{ PublishedPort: number; URL?: string }>;
      Service: string;
    }>;
    expect(services.map(({ Service }) => Service).sort()).toEqual([
      'caddy',
      'coturn',
      'postgres',
      'server',
    ]);
    for (const service of services) {
      expect(service.Health, service.Name).toBe('healthy');
      for (const publisher of service.Publishers ?? []) {
        if (publisher.PublishedPort > 0) {
          expect(publisher.URL, service.Name).toBe('127.0.0.1');
        }
      }
    }
  });

  test('passes authenticated signaling smoke through trusted local HTTPS', () => {
    run(process.execPath, [
      resolve(deploy, 'scripts', 'export-local-ca.mjs'),
      `--env-file=${envFile}`,
    ]);
    run(process.execPath, [
      resolve(deploy, 'scripts', 'smoke.mjs'),
      `--env-file=${envFile}`,
      '--base-url=https://rtc.localhost',
      `--ca-file=${resolve(deploy, '.certs', 'caddy-authority', 'root.crt')}`,
      '--integration',
      '--turn-proof',
    ]);
  }, 120_000);
});
