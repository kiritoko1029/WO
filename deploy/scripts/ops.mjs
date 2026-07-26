import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { parseDotEnv, turnNetworkMode } from './lib.mjs';
import { releaseProvenanceEnvironment } from './provenance.mjs';

export const deployDirectory = resolve(import.meta.dirname, '..');
export const productionProject = 'wo';
export const integrationProject = 'wo-integration';
export const rootComposeFileNames = Object.freeze([
  'docker-compose.yml',
  'docker-compose.external-db.yml',
]);
export const releaseApplyLockDirectoryName = '.wo-release-apply.lock';
export const deploymentOperationLockEnvironmentField =
  'WO_DEPLOYMENT_OPERATION_LOCK_TOKEN';
const deploymentOperationLockTokenFileName = 'owner-token';
const deploymentOperationLockTokenPattern = /^[a-f0-9]{64}$/u;
const composeShellOverrideFields = new Set([
  'WO_INTEGRATION_HTTP_PORT',
  'WO_INTEGRATION_HTTPS_PORT',
]);
const childProcessShellFields = new Set([
  'COLORTERM',
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_HOST',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'FORCE_COLOR',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

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

export function failureMessage(error) {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return 'Unprintable error';
  }
}

export function loadDeploymentEnvironment(envFile) {
  return parseDotEnv(readFileSync(envFile, 'utf8'));
}

function assertDeploymentOperationLockToken(token) {
  if (!deploymentOperationLockTokenPattern.test(token)) {
    throw new Error('Deployment operation lock token is invalid');
  }
}

function operationLockExistsError(lockDirectory, cause) {
  return new Error(
    `Release apply lock already exists; confirm that no apply, backup, restore, or upgrade is running before removing ${lockDirectory}`,
    { cause },
  );
}

async function assertDeploymentOperationLockOwner(lockDirectory, token) {
  assertDeploymentOperationLockToken(token);
  let recordedToken;
  try {
    recordedToken = (
      await readFile(
        resolve(lockDirectory, deploymentOperationLockTokenFileName),
        'utf8',
      )
    ).trim();
  } catch (error) {
    throw operationLockExistsError(lockDirectory, error);
  }
  if (
    !deploymentOperationLockTokenPattern.test(recordedToken) ||
    !timingSafeEqual(Buffer.from(recordedToken), Buffer.from(token))
  ) {
    throw operationLockExistsError(lockDirectory);
  }
}

export function deploymentOperationProcessEnvironment(
  token,
  environment = process.env,
) {
  assertDeploymentOperationLockToken(token);
  return {
    ...environment,
    [deploymentOperationLockEnvironmentField]: token,
  };
}

export async function withDeploymentOperationLock(
  lockRoot,
  operation,
  {
    removeLockDirectory = rm,
    token = process.env[deploymentOperationLockEnvironmentField],
  } = {},
) {
  const lockDirectory = resolve(lockRoot, releaseApplyLockDirectoryName);
  if (token !== undefined) {
    await assertDeploymentOperationLockOwner(lockDirectory, token);
    return operation({ lockDirectory, token });
  }

  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw operationLockExistsError(lockDirectory, error);
    }
    throw error;
  }

  const ownerToken = randomBytes(32).toString('hex');
  let result;
  let operationFailed = false;
  let operationError;
  try {
    await writeFile(
      resolve(lockDirectory, deploymentOperationLockTokenFileName),
      `${ownerToken}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    result = await operation({ lockDirectory, token: ownerToken });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError;
  try {
    await removeLockDirectory(lockDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed) {
    if (cleanupFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Deployment operation failed and lock cleanup was incomplete: ${lockDirectory}`,
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  return result;
}

export function deploymentProcessEnvironment(
  _environment,
  shellEnvironment = process.env,
) {
  const result = {};
  for (const field of childProcessShellFields) {
    if (
      Object.hasOwn(shellEnvironment, field) &&
      typeof shellEnvironment[field] === 'string'
    ) {
      result[field] = shellEnvironment[field];
    } else {
      delete result[field];
    }
  }
  for (const field of composeShellOverrideFields) {
    if (
      Object.hasOwn(shellEnvironment, field) &&
      typeof shellEnvironment[field] === 'string'
    ) {
      result[field] = shellEnvironment[field];
    }
  }
  return result;
}

export function composeProcessEnvironment(
  arguments_,
  shellEnvironment = process.env,
  releaseProvenance,
) {
  if (arguments_[0] !== 'compose') {
    return shellEnvironment;
  }
  const indexes = arguments_.flatMap((argument, index) =>
    argument === '--env-file' ? [index] : [],
  );
  if (
    indexes.length !== 1 ||
    typeof arguments_[indexes[0] + 1] !== 'string' ||
    arguments_[indexes[0] + 1].length === 0
  ) {
    throw new Error('Docker Compose command must select exactly one env file');
  }
  loadDeploymentEnvironment(arguments_[indexes[0] + 1]);
  const environment = deploymentProcessEnvironment({}, shellEnvironment);
  return releaseProvenance === undefined
    ? environment
    : {
        ...environment,
        ...releaseProvenanceEnvironment(releaseProvenance),
      };
}

export function productionComposeFiles(environment) {
  const files = [resolve(deployDirectory, 'compose.yaml')];
  if (turnNetworkMode(environment) === 'host') {
    files.push(resolve(deployDirectory, 'compose.turn-host.yaml'));
  }
  return files;
}

export function composeArguments(envFile, ...arguments_) {
  const composeFiles = productionComposeFiles(
    loadDeploymentEnvironment(envFile),
  ).flatMap((file) => ['-f', file]);
  return [
    'compose',
    '--project-name',
    productionProject,
    '--env-file',
    envFile,
    ...composeFiles,
    ...arguments_,
  ];
}

export function rootComposeArguments(envFile, rootComposeFile, ...arguments_) {
  if (!rootComposeFileNames.includes(rootComposeFile)) {
    throw new Error('Root Compose file is not allowed');
  }
  const environment = loadDeploymentEnvironment(envFile);
  const files = [resolve(deployDirectory, '..', rootComposeFile)];
  if (turnNetworkMode(environment) === 'host') {
    files.push(resolve(deployDirectory, 'compose.turn-host.yaml'));
  }
  return [
    'compose',
    '--project-name',
    productionProject,
    '--env-file',
    envFile,
    ...files.flatMap((file) => ['-f', file]),
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

function commandEnvironment(
  command,
  arguments_,
  environment,
  composeProvenance,
) {
  return command === 'docker' && arguments_[0] === 'compose'
    ? composeProcessEnvironment(arguments_, environment, composeProvenance)
    : environment;
}

export function run(command, arguments_, options = {}) {
  const environment = commandEnvironment(
    command,
    arguments_,
    options.env ?? process.env,
    options.composeProvenance,
  );
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? deployDirectory,
    encoding: options.encoding ?? 'utf8',
    env: environment,
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
    const environment = commandEnvironment(
      command,
      arguments_,
      options.env ?? process.env,
      options.composeProvenance,
    );
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? deployDirectory,
      env: environment,
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
    const environment = commandEnvironment(
      command,
      arguments_,
      options.env ?? process.env,
      options.composeProvenance,
    );
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? deployDirectory,
      env: environment,
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
