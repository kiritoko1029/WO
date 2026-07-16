import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { parseDotEnv } from './lib.mjs';

export const deployDirectory = resolve(import.meta.dirname, '..');
export const productionProject = 'wo';
export const integrationProject = 'wo-integration';

export function argumentValue(name, defaultValue) {
  const prefix = `${name}=`;
  const argument = process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix));
  return argument === undefined ? defaultValue : argument.slice(prefix.length);
}

export function hasArgument(name) {
  return process.argv.slice(2).includes(name);
}

export function loadDeploymentEnvironment(envFile) {
  return parseDotEnv(readFileSync(envFile, 'utf8'));
}

export function composeArguments(envFile, ...arguments_) {
  return [
    'compose',
    '--project-name',
    productionProject,
    '--env-file',
    envFile,
    '-f',
    resolve(deployDirectory, 'compose.yaml'),
    ...arguments_,
  ];
}

export function integrationComposeArguments(envFile, ...arguments_) {
  return [
    'compose',
    '--project-name',
    integrationProject,
    '--env-file',
    envFile,
    '-f',
    resolve(deployDirectory, 'compose.yaml'),
    '-f',
    resolve(deployDirectory, 'compose.integration.yaml'),
    ...arguments_,
  ];
}

export function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? deployDirectory,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const detail =
      typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(
      `${options.label ?? command} failed${detail.length > 0 ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout ?? '';
}

export async function pipeFileToCommand(
  file,
  command,
  arguments_,
  options = {},
) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? deployDirectory,
      env: options.env ?? process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    createReadStream(file).pipe(child.stdin);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `${options.label ?? command} failed with exit code ${code}`,
          ),
        );
      }
    });
  });
}

export async function pipeCommandToFile(
  command,
  arguments_,
  file,
  options = {},
) {
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(file, { mode: 0o600 });
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? deployDirectory,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.pipe(output);
    child.once('error', reject);
    output.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${options.label ?? command} failed with exit code ${code}`,
          ),
        );
        return;
      }
      output.end(() => resolvePromise());
    });
  });
}

export function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}
