import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  requiresRuntimeComposeImageOverride,
  withRuntimeComposeImageOverride,
} from '../../deploy/scripts/runtime-compose-override.mjs';

const temporaryDirectories: string[] = [];
const imageId = `sha256:${'a'.repeat(64)}`;

async function temporaryRoot() {
  const directory = await mkdtemp(
    resolve(tmpdir(), 'wo-runtime-compose-contract-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function compose(...arguments_: string[]) {
  return ['compose', '--project-name', 'wo', ...arguments_];
}

function imageLookup(image = imageId) {
  return vi.fn((_command: string, arguments_: string[]) => {
    if (arguments_.includes('ps')) {
      return 'caddy-container\n';
    }
    if (arguments_[0] === 'inspect') {
      return `${image}\n`;
    }
    throw new Error(`Unexpected command: ${arguments_.join(' ')}`);
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('runtime Compose image override', () => {
  test('requires automatic binding only for production without an explicit override', () => {
    expect(
      requiresRuntimeComposeImageOverride({
        composeOverride: undefined,
        integration: false,
      }),
    ).toBe(true);
    expect(
      requiresRuntimeComposeImageOverride({
        composeOverride: undefined,
        integration: true,
      }),
    ).toBe(false);
    expect(
      requiresRuntimeComposeImageOverride({
        composeOverride: '/rollback/compose.yaml',
        integration: false,
      }),
    ).toBe(false);
  });

  test.each([
    ['an absent container', ''],
    ['multiple containers', 'first-container\nsecond-container\n'],
  ])('rejects %s', async (_label, containerIds) => {
    const execute = vi.fn(() => containerIds);
    const operation = vi.fn();

    await expect(
      withRuntimeComposeImageOverride({
        compose,
        execute,
        operation,
        service: 'caddy',
        temporaryRoot: await temporaryRoot(),
      }),
    ).rejects.toThrow(/exactly one existing Compose container/u);
    expect(operation).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual(
      compose('ps', '--all', '-q', 'caddy'),
    );
  });

  test('rejects a mutable or malformed inspected image identity', async () => {
    const operation = vi.fn();

    await expect(
      withRuntimeComposeImageOverride({
        compose,
        execute: imageLookup('wo-caddy:unresolved'),
        operation,
        service: 'caddy',
        temporaryRoot: await temporaryRoot(),
      }),
    ).rejects.toThrow(/image ID is not immutable/u);
    expect(operation).not.toHaveBeenCalled();
  });

  test('adds a locked immutable override to helper commands and removes it', async () => {
    const root = await temporaryRoot();
    const execute = imageLookup();
    let overrideFile = '';

    const result = await withRuntimeComposeImageOverride({
      compose,
      execute,
      operation: async (runtimeCompose, runtime) => {
        overrideFile = runtime.overrideFile;
        expect(runtime.imageId).toBe(imageId);
        expect(runtimeCompose('run', '--rm', 'caddy')).toEqual(
          compose('-f', overrideFile, 'run', '--rm', 'caddy'),
        );
        expect((await stat(overrideFile)).mode & 0o777).toBe(0o600);
        expect(await readFile(overrideFile, 'utf8')).toBe(
          [
            'services:',
            '  caddy:',
            '    build: !reset null',
            `    image: ${imageId}`,
            '    pull_policy: never',
            '',
          ].join('\n'),
        );
        return 'complete';
      },
      service: 'caddy',
      temporaryRoot: root,
    });

    expect(result).toBe('complete');
    expect(execute.mock.calls[0]?.[1]).toEqual(
      compose('ps', '--all', '-q', 'caddy'),
    );
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'inspect',
      '--format',
      '{{.Image}}',
      'caddy-container',
    ]);
    await expect(stat(overrideFile)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  test('removes the override workspace when the wrapped operation fails', async () => {
    const root = await temporaryRoot();
    let overrideFile = '';

    await expect(
      withRuntimeComposeImageOverride({
        compose,
        execute: imageLookup(),
        operation: (_runtimeCompose, runtime) => {
          overrideFile = runtime.overrideFile;
          throw new Error('helper failed');
        },
        service: 'caddy',
        temporaryRoot: root,
      }),
    ).rejects.toThrow('helper failed');

    await expect(stat(overrideFile)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
