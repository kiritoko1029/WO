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

export default async function globalSetup(): Promise<
  (() => Promise<void>) | undefined
> {
  await execFileAsync(pnpm, ['run', 'build:acceptance'], {
    cwd: desktopDirectory,
    windowsHide: true,
  });

  const reuseStack = process.env.WO_E2E_REUSE_STACK === '1';
  if (await healthyStack()) {
    return async () => {
      await rm(acceptanceOutput, { recursive: true, force: true });
    };
  }
  if (reuseStack) {
    await rm(acceptanceOutput, { recursive: true, force: true });
    throw new Error(
      'WO_E2E_REUSE_STACK=1 requires the existing wo-integration stack to be healthy',
    );
  }

  try {
    await execFileAsync(
      docker,
      [...composeArguments, 'up', '-d', '--build', '--wait'],
      {
        cwd: repositoryDirectory,
        windowsHide: true,
        timeout: 180_000,
      },
    );
    if (!(await healthyStack())) {
      throw new Error('wo-integration did not become healthy');
    }
  } catch (error) {
    if (process.env.WO_E2E_REUSE_STACK !== '1') {
      await execFileAsync(
        docker,
        [...composeArguments, 'down', '--remove-orphans'],
        {
          cwd: repositoryDirectory,
          windowsHide: true,
          timeout: 60_000,
        },
      ).catch(() => undefined);
    }
    await rm(acceptanceOutput, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    try {
      if (process.env.WO_E2E_REUSE_STACK !== '1') {
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
    } finally {
      await rm(acceptanceOutput, { recursive: true, force: true });
    }
  };
}
