import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { run } from './ops.mjs';

const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const serviceNamePattern = /^[a-z][a-z0-9_-]*$/u;

function assertServiceName(service) {
  if (!serviceNamePattern.test(service)) {
    throw new Error('Runtime Compose service name is invalid');
  }
}

export function requiresRuntimeComposeImageOverride({
  composeOverride,
  integration,
}) {
  return !integration && composeOverride === undefined;
}

export function runtimeComposeImageOverrideSource(service, imageId) {
  assertServiceName(service);
  if (!imageIdPattern.test(imageId)) {
    throw new Error(`${service} container image ID is not immutable`);
  }
  return [
    'services:',
    `  ${service}:`,
    '    build: !reset null',
    `    image: ${imageId}`,
    '    pull_policy: never',
    '',
  ].join('\n');
}

function composeServiceImageId(compose, service, execute) {
  assertServiceName(service);
  const containerIds =
    execute('docker', compose('ps', '--all', '-q', service), {
      label: `${service} Compose container lookup`,
    }).match(/\S+/gu) ?? [];
  if (containerIds.length !== 1) {
    throw new Error(
      `${service} must resolve to exactly one existing Compose container`,
    );
  }
  const imageIds =
    execute('docker', ['inspect', '--format', '{{.Image}}', containerIds[0]], {
      label: `${service} container image inspection`,
    }).match(/\S+/gu) ?? [];
  if (imageIds.length !== 1 || !imageIdPattern.test(imageIds[0])) {
    throw new Error(`${service} container image ID is not immutable`);
  }
  return imageIds[0];
}

export async function withRuntimeComposeImageOverride({
  compose,
  execute = run,
  operation,
  service,
  temporaryRoot = tmpdir(),
}) {
  const imageId = composeServiceImageId(compose, service, execute);
  const workspace = await mkdtemp(
    resolve(temporaryRoot, `wo-${service}-runtime-compose-`),
  );
  try {
    await chmod(workspace, 0o700);
    const overrideFile = resolve(workspace, 'compose.image.override.yaml');
    await writeFile(
      overrideFile,
      runtimeComposeImageOverrideSource(service, imageId),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await chmod(overrideFile, 0o600);
    return await operation(
      (...arguments_) => compose('-f', overrideFile, ...arguments_),
      { imageId, overrideFile },
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
