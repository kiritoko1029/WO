import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { describe, expect, test } from 'vitest';
import { preProcessFile } from 'typescript';

import { releaseSourceFiles } from '../../deploy/scripts/release.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function repositoryLocalMjsImports(file: string) {
  const absoluteFile = resolve(repositoryRoot, file);
  return preProcessFile(readFileSync(absoluteFile, 'utf8'), true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter(
      (specifier) => specifier.startsWith('.') && specifier.endsWith('.mjs'),
    )
    .map((specifier) => {
      const importedFile = resolve(dirname(absoluteFile), specifier);
      const repositoryRelativePath = relative(repositoryRoot, importedFile);
      if (
        repositoryRelativePath === '..' ||
        repositoryRelativePath.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `Release-bound import resolves outside the repository: ${specifier}`,
        );
      }
      return repositoryRelativePath.split(sep).join('/');
    });
}

function releaseBoundModuleClosure() {
  const closure = new Set(
    releaseSourceFiles.filter((file) => file.endsWith('.mjs')),
  );
  const pending = [...closure];
  for (const file of pending) {
    for (const importedFile of repositoryLocalMjsImports(file)) {
      if (closure.has(importedFile)) {
        continue;
      }
      closure.add(importedFile);
      pending.push(importedFile);
    }
  }
  return [...closure].sort();
}

describe('release source file contract', () => {
  test('binds every production release and operational entrypoint', () => {
    const manifestFiles = new Set(releaseSourceFiles);
    const productionEntrypoints = [
      'deploy/scripts/apply-release.mjs',
      'deploy/scripts/backup.mjs',
      'deploy/scripts/build-release.mjs',
      'deploy/scripts/compose.mjs',
      'deploy/scripts/monitor.mjs',
      'deploy/scripts/preflight.mjs',
      'deploy/scripts/restore.mjs',
      'deploy/scripts/smoke.mjs',
      'deploy/scripts/upgrade.mjs',
    ];

    expect(
      productionEntrypoints.filter((file) => !manifestFiles.has(file)),
    ).toEqual([]);
  });

  test('binds the transitive local imports of every release-bound module', () => {
    const manifestFiles = new Set(releaseSourceFiles);
    const missingFiles = releaseBoundModuleClosure().filter(
      (file) => !manifestFiles.has(file),
    );

    expect(missingFiles).toEqual([]);
  });

  test('classifies every deploy script as release-bound or local-bootstrap-only', () => {
    const localBootstrapOnly = new Set([
      'deploy/scripts/export-local-ca.mjs',
      'deploy/scripts/init-integration-cert.mjs',
      'deploy/scripts/init-secrets.mjs',
    ]);
    const manifestFiles = new Set(releaseSourceFiles);
    const unclassified = readdirSync(
      resolve(repositoryRoot, 'deploy', 'scripts'),
    )
      .filter((file) => file.endsWith('.mjs') || file.endsWith('.sh'))
      .map((file) => `deploy/scripts/${file}`)
      .filter(
        (file) => !manifestFiles.has(file) && !localBootstrapOnly.has(file),
      );

    expect(unclassified).toEqual([]);
    for (const file of localBootstrapOnly) {
      expect(manifestFiles.has(file), file).toBe(false);
    }
  });
});
