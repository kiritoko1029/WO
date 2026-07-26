import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  assertBackupEvidence,
  validateApplyModeState,
} from '../../deploy/scripts/apply-release.mjs';
import {
  loadAndVerifyReleaseBundle,
  readAndVerifyReleaseBundle,
  releaseImageDefinitions,
  releaseImageOverrideSource,
  releaseImageReference,
  releaseManifestChecksumName,
  releaseManifestName,
  releasePlatform,
  releaseServices,
  releaseSourceFiles,
  validateReleaseManifest,
} from '../../deploy/scripts/release.mjs';
import { expectedOciLabels } from '../../deploy/scripts/provenance.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const temporaryDirectories: string[] = [];
const provenance = Object.freeze({
  BUILD_CREATED: '2026-07-24T18:31:47Z',
  BUILD_REVISION: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
  BUILD_VERSION: '2026.07.24-b88a10f0867c',
  SOURCE_DATE_EPOCH: '1784917907',
});

function sha256(source: string | Buffer) {
  return createHash('sha256').update(source).digest('hex');
}

function imageId(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function validManifest() {
  return {
    schemaVersion: 1,
    provenance,
    platform: releasePlatform,
    sourceFiles: Object.fromEntries(
      releaseSourceFiles.map((file, index) => [
        file,
        String((index % 9) + 1).repeat(64),
      ]),
    ),
    images: Object.fromEntries(
      releaseServices.map((service, index) => [
        service,
        {
          archive: releaseImageDefinitions[service].archive,
          sha256: String(index + 1).repeat(64),
          size: index + 1,
          imageId: imageId(String.fromCharCode(97 + index)),
          reference: releaseImageReference(service, provenance.BUILD_VERSION),
          rootfsLayers: [imageId(String.fromCharCode(100 + index))],
          secondaryArchiveSha256: String(index + 1).repeat(64),
        },
      ]),
    ),
  };
}

async function createBundle() {
  const directory = await mkdtemp(resolve(tmpdir(), 'wo-release-contract-'));
  temporaryDirectories.push(directory);
  const sourceRoot = resolve(directory, 'source');
  const bundleDirectory = resolve(directory, 'bundle');
  await mkdir(sourceRoot);
  await mkdir(bundleDirectory);

  const sourceFiles: Record<string, string> = {};
  for (const file of releaseSourceFiles) {
    const absolute = resolve(sourceRoot, file);
    await mkdir(dirname(absolute), { recursive: true });
    const contents = `source:${file}\n`;
    await writeFile(absolute, contents);
    sourceFiles[file] = sha256(contents);
  }

  const manifest = validManifest();
  manifest.sourceFiles = sourceFiles;
  for (const [index, service] of releaseServices.entries()) {
    const contents = Buffer.from(`archive:${service}\n`);
    await writeFile(
      resolve(bundleDirectory, releaseImageDefinitions[service].archive),
      contents,
    );
    manifest.images[service] = {
      ...manifest.images[service],
      sha256: sha256(contents),
      size: contents.length,
      imageId: imageId(String.fromCharCode(97 + index)),
      rootfsLayers: [imageId(String.fromCharCode(100 + index))],
      secondaryArchiveSha256: sha256(contents),
    };
  }
  const manifestFile = resolve(bundleDirectory, releaseManifestName);
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestFile, manifestSource);
  const manifestHash = sha256(manifestSource);
  await writeFile(
    resolve(bundleDirectory, releaseManifestChecksumName),
    `${manifestHash}  ${releaseManifestName}\n`,
  );
  return { bundleDirectory, manifest, manifestFile, manifestHash, sourceRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('release manifest contract', () => {
  test('accepts only the exact three-image linux/amd64 schema', () => {
    expect(validateReleaseManifest(validManifest())).toEqual([]);
    expect(
      validateReleaseManifest({
        ...validManifest(),
        unexpected: true,
      }).join('\n'),
    ).toMatch(/unexpected or missing fields/i);
    expect(
      validateReleaseManifest({
        ...validManifest(),
        platform: { architecture: 'arm64', os: 'linux' },
      }).join('\n'),
    ).toMatch(/linux\/amd64/i);

    const duplicate = validManifest();
    duplicate.images.coturn.imageId = duplicate.images.server.imageId;
    expect(validateReleaseManifest(duplicate).join('\n')).toMatch(
      /unique image IDs/i,
    );

    const unstableArchive = validManifest();
    unstableArchive.images.server.secondaryArchiveSha256 = 'f'.repeat(64);
    expect(validateReleaseManifest(unstableArchive).join('\n')).toMatch(
      /archive SHA-256 values differ/i,
    );
  });

  test('rejects array-typed hashes and image IDs that coerce to valid strings', () => {
    const arraySourceHash = validManifest();
    arraySourceHash.sourceFiles['deploy/compose.yaml'] = [
      '1'.repeat(64),
    ] as unknown as string;
    expect(validateReleaseManifest(arraySourceHash).join('\n')).toMatch(
      /Release source hash is invalid: deploy\/compose\.yaml/iu,
    );

    const arrayImageId = validManifest();
    arrayImageId.images.server.imageId = [
      arrayImageId.images.server.imageId,
    ] as unknown as string;
    expect(validateReleaseManifest(arrayImageId).join('\n')).toMatch(
      /server release image ID is invalid/iu,
    );

    const arrayArchiveHash = validManifest();
    arrayArchiveHash.images.server.sha256 = [
      '2'.repeat(64),
    ] as unknown as string;
    arrayArchiveHash.images.server.secondaryArchiveSha256 = [
      '2'.repeat(64),
    ] as unknown as string;
    expect(validateReleaseManifest(arrayArchiveHash).join('\n')).toMatch(
      /server release archive SHA-256 is invalid/iu,
    );
  });

  test('reports malformed provenance as issues instead of throwing', () => {
    expect(
      validateReleaseManifest({
        ...validManifest(),
        provenance: { ...provenance, BUILD_VERSION: 5 },
      }).join('\n'),
    ).toMatch(/BUILD_VERSION is required/i);
    expect(
      validateReleaseManifest({
        ...validManifest(),
        provenance: null,
      }).join('\n'),
    ).toMatch(/release provenance must be an object/i);
    expect(
      validateReleaseManifest({
        ...validManifest(),
        provenance: undefined,
      }).join('\n'),
    ).toMatch(/release provenance must be an object/i);
  });

  test('renders immutable no-pull overrides for only selected services', () => {
    const images = Object.fromEntries(
      releaseServices.map((service, index) => [
        service,
        { imageId: imageId(String.fromCharCode(97 + index)) },
      ]),
    );
    const source = releaseImageOverrideSource(images, ['server', 'coturn']);
    expect(source).not.toContain('caddy:');
    expect(source.match(/build: !reset null/gu)).toHaveLength(2);
    expect(source.match(/pull_policy: never/gu)).toHaveLength(2);
    expect(() =>
      releaseImageOverrideSource(images, ['server', 'server']),
    ).toThrow(/selection/i);
  });

  test('binds manifest, deployment files, archive size, and archive hashes', async () => {
    const bundle = await createBundle();
    await expect(
      readAndVerifyReleaseBundle(bundle.manifestFile, {
        expectedManifestSha256: bundle.manifestHash,
        root: bundle.sourceRoot,
      }),
    ).resolves.toMatchObject({ manifest: bundle.manifest });
    await expect(
      readAndVerifyReleaseBundle(bundle.manifestFile, {
        expectedManifestSha256: 'f'.repeat(64),
        root: bundle.sourceRoot,
      }),
    ).rejects.toThrow(/expected SHA-256/i);

    await writeFile(
      resolve(bundle.bundleDirectory, releaseImageDefinitions.server.archive),
      'tampered',
    );
    await expect(
      readAndVerifyReleaseBundle(bundle.manifestFile, {
        expectedManifestSha256: bundle.manifestHash,
        root: bundle.sourceRoot,
      }),
    ).rejects.toThrow(/server release archive size mismatch/i);
  });

  test('loads every verified Docker archive and rejects the wrong host architecture', async () => {
    const bundle = await createBundle();
    const loaded: string[] = [];
    const execute = (_command: string, arguments_: string[]) => {
      if (arguments_[0] === 'version') {
        return JSON.stringify({
          Arch: 'amd64',
          Os: 'linux',
          Version: '26.1.3',
        });
      }
      if (arguments_[1] === 'load') {
        loaded.push(arguments_.at(-1)!);
        return '';
      }
      const reference = arguments_.at(-1)!;
      const service = releaseServices.find(
        (candidate) =>
          bundle.manifest.images[candidate].reference === reference,
      )!;
      const expected = bundle.manifest.images[service];
      return JSON.stringify([
        {
          Architecture: 'amd64',
          Config: { Labels: expectedOciLabels(provenance) },
          Id: expected.imageId,
          Os: 'linux',
          RootFS: { Layers: expected.rootfsLayers },
        },
      ]);
    };
    await expect(
      loadAndVerifyReleaseBundle(bundle.manifestFile, {
        archiveLoader: async (archive: string) => {
          loaded.push(archive);
        },
        execute,
        expectedManifestSha256: bundle.manifestHash,
        root: bundle.sourceRoot,
      }),
    ).resolves.toMatchObject({
      images: {
        caddy: { architecture: 'amd64' },
        coturn: { architecture: 'amd64' },
        server: { architecture: 'amd64' },
      },
    });
    expect(loaded).toHaveLength(3);

    let loadAttempted = false;
    await expect(
      loadAndVerifyReleaseBundle(bundle.manifestFile, {
        archiveLoader: async () => {
          loadAttempted = true;
        },
        execute: (_command: string, arguments_: string[]) => {
          if (arguments_[0] === 'version') {
            return JSON.stringify({
              Arch: 'arm64',
              Os: 'linux',
              Version: '29.0.0',
            });
          }
          return '';
        },
        expectedManifestSha256: bundle.manifestHash,
        root: bundle.sourceRoot,
      }),
    ).rejects.toThrow(/linux\/amd64 Docker server/i);
    expect(loadAttempted).toBe(false);
  });

  test('build command pins platform, clean builds, and Docker archives', () => {
    const source = readFileSync(
      resolve(root, 'deploy', 'scripts', 'build-release.mjs'),
      'utf8',
    );
    expect(source).toContain("'--no-cache'");
    expect(source).toContain("'--pull'");
    expect(source).toContain('releasePlatform.os');
    expect(source).toContain('type=docker');
    expect(source).toContain('rewrite-timestamp=true');
    expect(source).toContain("'--provenance=false'");
    expect(source).toContain("'--sbom=false'");
  });
});

describe('release apply guardrails', () => {
  test('requires an explicit initial or complete upgrade state', () => {
    expect(() =>
      validateApplyModeState('initial', { coturn: '', server: '' }),
    ).not.toThrow();
    expect(() =>
      validateApplyModeState('initial', {
        coturn: '',
        server: 'container-server',
      }),
    ).toThrow(/absent/i);
    expect(() =>
      validateApplyModeState('upgrade', {
        coturn: 'container-coturn',
        server: 'container-server',
      }),
    ).not.toThrow();
    expect(() =>
      validateApplyModeState('upgrade', {
        coturn: '',
        server: 'container-server',
      }),
    ).toThrow(/both release services/i);
  });

  test('requires fresh, secure, checksum-bound PostgreSQL backup evidence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wo-backup-evidence-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const dump = Buffer.from('postgres-backup');
    await writeFile(resolve(directory, 'postgres.dump'), dump);
    await writeFile(
      resolve(directory, 'SHA256SUMS'),
      `${sha256(dump)}  postgres.dump\n`,
    );
    await expect(
      assertBackupEvidence(directory, {
        ancestorValidator: async () => [],
        requireRootOwner: false,
      }),
    ).resolves.toBe(await realpath(directory));
    await writeFile(resolve(directory, 'postgres.dump'), 'tampered');
    await expect(
      assertBackupEvidence(directory, {
        ancestorValidator: async () => [],
        requireRootOwner: false,
      }),
    ).rejects.toThrow(/checksum mismatch/i);
  });
});
