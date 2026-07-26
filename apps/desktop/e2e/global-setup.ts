import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const acceptanceOutput = join(desktopDirectory, 'out-acceptance');
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const composeArguments = [
  'compose',
  '--project-name',
  'wo-integration',
  '--env-file',
  join(repositoryDirectory, 'deploy', '.env.integration'),
  '-f',
  join(repositoryDirectory, 'deploy', 'compose.yaml'),
  '-f',
  join(repositoryDirectory, 'deploy', 'compose.integration.yaml'),
];
const requiredServices = new Set(['caddy', 'coturn', 'postgres', 'server']);

async function exportCaddyAuthority(): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      join(repositoryDirectory, 'deploy', 'scripts', 'export-local-ca.mjs'),
      `--env-file=${join(repositoryDirectory, 'deploy', '.env.integration')}`,
    ],
    { cwd: repositoryDirectory, timeout: 60_000, windowsHide: true },
  );
}

async function healthyStack(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      docker,
      [...composeArguments, 'ps', '--format', 'json'],
      { cwd: repositoryDirectory, windowsHide: true },
    );
    const services = stdout
      .split(/\r?\n/gu)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return (
      services.length === requiredServices.size &&
      services.every(
        (service) =>
          typeof service.Service === 'string' &&
          requiredServices.has(service.Service) &&
          service.State === 'running' &&
          service.Health === 'healthy',
      )
    );
  } catch {
    return false;
  }
}

async function downStack(): Promise<void> {
  await execFileAsync(
    docker,
    [...composeArguments, 'down', '--remove-orphans'],
    {
      cwd: repositoryDirectory,
      windowsHide: true,
      timeout: 60_000,
    },
  );
}

export default async function globalSetup(): Promise<
  (() => Promise<void>) | undefined
> {
  const reuseStack = process.env.WO_E2E_REUSE_STACK === '1';
  const existingStack = await healthyStack();
  if (!existingStack && reuseStack) {
    throw new Error(
      'WO_E2E_REUSE_STACK=1 requires the existing wo-integration stack to be healthy',
    );
  }

  let createdStack = false;
  try {
    if (!existingStack) {
      await execFileAsync(
        docker,
        [...composeArguments, 'up', '-d', '--build', '--wait'],
        {
          cwd: repositoryDirectory,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          timeout: 600_000,
        },
      );
      createdStack = true;
      if (!(await healthyStack())) {
        throw new Error('wo-integration did not become healthy');
      }
    }
    // The acceptance build inlines the current CA pin from root.crt, so the
    // export must complete before the bundle is built.
    await exportCaddyAuthority();
    await execFileAsync(pnpm, ['run', 'build:acceptance'], {
      cwd: desktopDirectory,
      windowsHide: true,
    });
  } catch (error) {
    if (createdStack) {
      await downStack().catch(() => undefined);
    }
    await rm(acceptanceOutput, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    try {
      if (createdStack) {
        await downStack();
      }
    } finally {
      await rm(acceptanceOutput, { recursive: true, force: true });
    }
  };
}
