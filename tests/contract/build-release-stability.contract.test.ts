import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildImageTwice,
  buildReleaseBundle,
  createReleaseSourceSnapshot,
  readArchiveRange,
} from '../../deploy/scripts/build-release.mjs';
import {
  releaseImageDefinitions,
  releaseImageReference,
  releaseServices,
  releaseSourceFiles,
} from '../../deploy/scripts/release.mjs';
import { expectedOciLabels } from '../../deploy/scripts/provenance.mjs';

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const stableProvenance = Object.freeze({
  BUILD_CREATED: '2026-07-24T18:31:47Z',
  BUILD_REVISION: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
  BUILD_VERSION: '2026.07.24-b88a10f0867c',
  SOURCE_DATE_EPOCH: '1784917907',
});
const changedProvenance = Object.freeze({
  ...stableProvenance,
  BUILD_REVISION: 'c'.repeat(40),
  BUILD_VERSION: '2026.07.24-cccccccccccc',
});

function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function sha256(source: string | Buffer) {
  return createHash('sha256').update(source).digest('hex');
}

function fakeImage(
  service: keyof typeof releaseImageDefinitions,
  index: number,
  provenance = stableProvenance,
) {
  return {
    archive: releaseImageDefinitions[service].archive,
    sha256: String(index + 1).repeat(64),
    size: index + 1,
    imageId: digest(String.fromCharCode(97 + index)),
    reference: releaseImageReference(service, provenance.BUILD_VERSION),
    rootfsLayers: [digest(String.fromCharCode(100 + index))],
    secondaryArchiveSha256: String(index + 1).repeat(64),
  };
}

async function writeFakeImage(
  service: keyof typeof releaseImageDefinitions,
  index: number,
  directory: string,
  provenance = stableProvenance,
) {
  const contents = Buffer.from(`archive:${service}\n`);
  await writeFile(
    resolve(directory, releaseImageDefinitions[service].archive),
    contents,
  );
  return {
    ...fakeImage(service, index, provenance),
    sha256: sha256(contents),
    size: contents.length,
    secondaryArchiveSha256: sha256(contents),
  };
}

function currentSourceSnapshot(onCleanup = () => {}) {
  return async () => ({
    cleanup: async () => onCleanup(),
    root: repositoryRoot,
  });
}

async function copiedSourceSnapshot(onCleanup = () => {}) {
  const parent = await temporaryRoot();
  const root = resolve(parent, 'source');
  for (const file of releaseSourceFiles) {
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(repositoryRoot, file), target);
  }
  return {
    factory: async () => ({
      cleanup: async () => onCleanup(),
      root,
    }),
    root,
  };
}

function releaseOutputLock(outputDirectory: string) {
  return resolve(
    dirname(outputDirectory),
    `.${basename(outputDirectory)}.release.lock`,
  );
}

type TarEntryType = '0' | '1' | '2' | '5' | 'L' | 'g' | 'x';
type TarFormat = 'gnu' | 'posix';

function writeTarChecksum(header: Buffer) {
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function tarHeader(
  name: string,
  type: TarEntryType,
  size = 0,
  linkName = '',
  format: TarFormat = 'posix',
) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  if (format === 'gnu') {
    header.write('ustar ', 257, 6, 'ascii');
    header[263] = 0x20;
    header[264] = 0x00;
  } else {
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
  }
  writeTarChecksum(header);
  return header;
}

function tarArchive(
  entries: Array<{
    contents?: Buffer;
    linkName?: string;
    name: string;
    type?: TarEntryType;
  }>,
  format: TarFormat = 'posix',
) {
  return Buffer.concat([
    ...entries.flatMap(
      ({ contents = Buffer.alloc(0), linkName = '', name, type = '0' }) => [
        tarHeader(name, type, contents.length, linkName, format),
        contents,
        Buffer.alloc((512 - (contents.length % 512)) % 512),
      ],
    ),
    Buffer.alloc(1024),
  ]);
}

function paxRecord(key: string, value: string | Buffer) {
  const body = Buffer.concat([
    Buffer.from(` ${key}=`),
    typeof value === 'string' ? Buffer.from(value) : value,
    Buffer.from('\n'),
  ]);
  let length = body.length + 1;
  while (true) {
    const record = Buffer.concat([Buffer.from(String(length)), body]);
    const actualLength = record.length;
    if (actualLength === length) {
      return record;
    }
    length = actualLength;
  }
}

function archiveFixture(
  service: keyof typeof releaseImageDefinitions,
  {
    additionalLayerCount = 0,
    architecture = 'amd64',
    bomPaxPath = false,
    consecutivePaxHeaders = false,
    corruptBlobHash = false,
    corruptConfigHash = false,
    corruptDiffId = false,
    corruptGzip = false,
    corruptLayerHeader = false,
    corruptLayerPadding = false,
    corruptOuterHeader = false,
    dataAfterEnd = false,
    directoryLayer = false,
    dotLayerPath = false,
    doubleSlashLayerPath = false,
    duplicateLayer = false,
    emptyPaxXattrName = false,
    gzipLayer = true,
    gnuExtendedHeader = false,
    gnuLayer = false,
    invalidLayerTar = false,
    invalidLayerTarFormat = false,
    invalidLayerTarVersion = false,
    invalidLayerPathUtf8 = false,
    invalidPaxTimestamp = false,
    unsafePaxTimestamp = false,
    largePaxComment = false,
    largeLayer = false,
    legacyConfig = false,
    legacyLayer = false,
    linkPayloadHeader = false,
    malformedPaxLayer = false,
    manifestTrailingSlash = false,
    missingEndMarker = false,
    nonLinkLinkName = false,
    omitLayer = false,
    paxCapabilityLayer = false,
    paxDuplicateKey = false,
    paxHighBitLength = false,
    paxHdrcharset = false,
    paxLayer = false,
    paxRelativeSymlink = false,
    paxSizeMismatch = false,
    paxSizeTooLarge = false,
    paxSparseMetadata = false,
    paxUnknownKey = false,
    paxWithoutTarget = false,
    provenance = stableProvenance,
    relativeLayerPath = false,
    repeatLayerReference = false,
    repoTags = [releaseImageReference(service, provenance.BUILD_VERSION)],
    unsafePaxHardlink = false,
    unsafePaxPath = false,
    nonDirectoryTrailingSlash = false,
    unsupportedInnerExtension = false,
    unsupportedGnuLongName = false,
    unsupportedLayerCompression = false,
  } = {},
) {
  const usePaxLayer =
    bomPaxPath ||
    consecutivePaxHeaders ||
    emptyPaxXattrName ||
    invalidPaxTimestamp ||
    unsafePaxTimestamp ||
    largePaxComment ||
    malformedPaxLayer ||
    paxCapabilityLayer ||
    paxDuplicateKey ||
    paxHighBitLength ||
    paxHdrcharset ||
    paxLayer ||
    paxRelativeSymlink ||
    paxSizeMismatch ||
    paxSizeTooLarge ||
    paxSparseMetadata ||
    paxUnknownKey ||
    paxWithoutTarget ||
    unsafePaxHardlink ||
    unsafePaxPath;
  let paxPayload = Buffer.alloc(0);
  if (paxLayer) {
    paxPayload = Buffer.concat([
      paxRecord(
        'linkpath',
        '/usr/share/ca-certificates/mozilla/NetLock_Arany_=Class_Gold=_Főtanúsítvány.crt',
      ),
      paxRecord(
        'path',
        'etc/ssl/certs/ca-cert-NetLock_Arany_=Class_Gold=_Főtanúsítvány.pem',
      ),
    ]);
  } else if (paxRelativeSymlink) {
    paxPayload = paxRecord('linkpath', '../../shared/target');
  } else if (bomPaxPath) {
    paxPayload = paxRecord('path', '\uFEFFpayload.txt');
  } else if (consecutivePaxHeaders) {
    paxPayload = paxRecord('path', 'payload.txt');
  } else if (emptyPaxXattrName) {
    paxPayload = paxRecord('SCHILY.xattr.', 'value');
  } else if (invalidPaxTimestamp) {
    paxPayload = paxRecord('mtime', 'not-a-timestamp');
  } else if (unsafePaxTimestamp) {
    paxPayload = paxRecord('mtime', '9223372036854775808');
  } else if (largePaxComment) {
    paxPayload = paxRecord('comment', 'a'.repeat(70 * 1024));
  } else if (paxCapabilityLayer) {
    paxPayload = paxRecord(
      'SCHILY.xattr.security.capability',
      Buffer.from([
        0x01, 0x00, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
    );
  } else if (malformedPaxLayer) {
    paxPayload = Buffer.from('99 path=payload.txt\n');
  } else if (paxDuplicateKey) {
    paxPayload = Buffer.concat([
      paxRecord('path', 'payload.txt'),
      paxRecord('path', 'duplicate.txt'),
    ]);
  } else if (paxHighBitLength) {
    paxPayload = Buffer.from(paxRecord('path', 'payload.txt'));
    paxPayload[0] |= 0x80;
  } else if (paxHdrcharset) {
    paxPayload = paxRecord('hdrcharset', 'BINARY');
  } else if (paxSizeMismatch) {
    paxPayload = paxRecord('size', '9999');
  } else if (paxSizeTooLarge) {
    paxPayload = paxRecord('size', String(8 * 1024 * 1024 * 1024));
  } else if (paxSparseMetadata) {
    paxPayload = paxRecord('GNU.sparse.size', '1');
  } else if (paxUnknownKey) {
    paxPayload = paxRecord('VENDOR.unknown', 'value');
  } else if (paxWithoutTarget) {
    paxPayload = paxRecord('path', 'payload.txt');
  } else if (unsafePaxHardlink) {
    paxPayload = paxRecord('linkpath', '../../escape');
  } else if (unsafePaxPath) {
    paxPayload = paxRecord('path', '../../escape');
  }
  const layerEntries = linkPayloadHeader
    ? [
        {
          contents: tarHeader('hidden.txt', '0'),
          linkName: 'target.txt',
          name: 'visible-link',
          type: '2' as const,
        },
      ]
    : unsupportedGnuLongName
      ? [
          {
            contents: Buffer.from('payload.txt\0'),
            name: '././@LongLink',
            type: 'L' as const,
          },
        ]
      : unsupportedInnerExtension
        ? [
            {
              contents: paxRecord('comment', 'unsupported global metadata'),
              name: 'GlobalHead.0',
              type: 'g' as const,
            },
          ]
        : consecutivePaxHeaders
          ? [
              {
                contents: paxPayload,
                name: 'PaxHeaders.0/first',
                type: 'x' as const,
              },
              {
                contents: paxPayload,
                name: 'PaxHeaders.0/second',
                type: 'x' as const,
              },
              {
                contents: Buffer.from('release layer payload\n'),
                name: 'payload.txt',
                type: '0' as const,
              },
            ]
          : usePaxLayer
            ? [
                {
                  contents: paxPayload,
                  name: 'PaxHeaders.0/payload.txt',
                  type: 'x' as const,
                },
                ...(!paxWithoutTarget
                  ? [
                      {
                        contents:
                          paxLayer || paxRelativeSymlink || unsafePaxHardlink
                            ? Buffer.alloc(0)
                            : Buffer.from('release layer payload\n'),
                        linkName:
                          paxLayer || paxRelativeSymlink || unsafePaxHardlink
                            ? '/usr/share/ca-certificates/mozilla/NetLock_Arany_=Class_Gold=_Ftanstvny.crt'
                            : '',
                        name: paxLayer
                          ? 'etc/ssl/certs/ca-cert-NetLock_Arany_=Class_Gold=_Ftanstvny.pem'
                          : 'payload.txt',
                        type:
                          paxLayer || paxRelativeSymlink
                            ? ('2' as const)
                            : unsafePaxHardlink
                              ? ('1' as const)
                              : ('0' as const),
                      },
                    ]
                  : []),
              ]
            : [
                ...(gnuLayer
                  ? [
                      {
                        contents: Buffer.alloc(0),
                        name: './',
                        type: '5' as const,
                      },
                    ]
                  : []),
                {
                  contents: directoryLayer
                    ? Buffer.alloc(0)
                    : largeLayer
                      ? Buffer.alloc(256 * 1024, 0x61)
                      : Buffer.from('release layer payload\n'),
                  linkName: nonLinkLinkName ? 'unexpected-target' : '',
                  name: directoryLayer
                    ? 'directory/'
                    : dotLayerPath
                      ? '.'
                      : relativeLayerPath
                        ? './payload.txt'
                        : doubleSlashLayerPath
                          ? 'directory//payload.txt'
                          : nonDirectoryTrailingSlash
                            ? 'payload.txt/'
                            : 'payload.txt',
                  type: directoryLayer ? ('5' as const) : ('0' as const),
                },
              ];
  let unpackedLayer = invalidLayerTar
    ? Buffer.from('not a tar layer')
    : tarArchive(layerEntries, gnuLayer ? 'gnu' : 'posix');
  if (corruptLayerHeader) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer[100] ^= 1;
  }
  if (corruptLayerPadding) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer[512 + Buffer.byteLength('release layer payload\n')] = 1;
  }
  if (invalidLayerPathUtf8) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer[0] = 0xff;
    writeTarChecksum(unpackedLayer.subarray(0, 512));
  }
  if (invalidLayerTarFormat) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer[257] = 0x78;
    writeTarChecksum(unpackedLayer.subarray(0, 512));
  }
  if (invalidLayerTarVersion) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer.write('00', 263, 2, 'ascii');
    writeTarChecksum(unpackedLayer.subarray(0, 512));
  }
  if (gnuExtendedHeader) {
    unpackedLayer = Buffer.from(unpackedLayer);
    unpackedLayer[512 + 345] = 0x31;
    writeTarChecksum(unpackedLayer.subarray(512, 1024));
  }
  let storedLayer = unsupportedLayerCompression
    ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])
    : gzipLayer
      ? gzipSync(unpackedLayer)
      : unpackedLayer;
  if (corruptGzip) {
    storedLayer = Buffer.from(storedLayer);
    storedLayer[storedLayer.length - 1] ^= 0xff;
  }
  const layerFile = legacyLayer
    ? `${'a'.repeat(64)}/layer.tar`
    : `blobs/sha256/${corruptBlobHash ? 'b'.repeat(64) : sha256(storedLayer)}`;
  const diffId = `sha256:${
    corruptDiffId ? 'c'.repeat(64) : sha256(unpackedLayer)
  }`;
  const additionalLayers = Array.from(
    { length: additionalLayerCount },
    (_, index) => {
      const unpacked = tarArchive([
        {
          contents: Buffer.from(`additional release layer ${index}\n`),
          name: `additional-${index}.txt`,
        },
      ]);
      const stored = gzipLayer ? gzipSync(unpacked) : unpacked;
      return {
        diffId: `sha256:${sha256(unpacked)}`,
        layerFile: `blobs/sha256/${sha256(stored)}`,
        stored,
      };
    },
  );
  const rootfsLayers = repeatLayerReference
    ? [diffId, diffId]
    : [diffId, ...additionalLayers.map((layer) => layer.diffId)];
  const manifestLayers = repeatLayerReference
    ? [layerFile, layerFile]
    : [layerFile, ...additionalLayers.map((layer) => layer.layerFile)];
  const config = JSON.stringify({
    architecture,
    config: { Labels: expectedOciLabels(provenance) },
    os: 'linux',
    rootfs: { diff_ids: rootfsLayers, type: 'layers' },
  });
  const configHash = sha256(config);
  const configFile = legacyConfig
    ? `${corruptConfigHash ? 'd'.repeat(64) : configHash}.json`
    : `blobs/sha256/${corruptConfigHash ? 'd'.repeat(64) : configHash}`;
  const manifest = JSON.stringify([
    {
      Config: configFile,
      Layers: manifestLayers,
      RepoTags: repoTags,
    },
  ]);
  const entries = [
    ...(legacyConfig && legacyLayer
      ? []
      : [
          { name: 'blobs/', type: '5' as const },
          { name: 'blobs/sha256/', type: '5' as const },
        ]),
    {
      contents: Buffer.from(manifest),
      name: manifestTrailingSlash ? 'manifest.json/' : 'manifest.json',
    },
    { contents: Buffer.from(config), name: configFile },
    ...(!omitLayer ? [{ contents: storedLayer, name: layerFile }] : []),
    ...additionalLayers.map((layer) => ({
      contents: layer.stored,
      name: layer.layerFile,
    })),
    ...(duplicateLayer ? [{ contents: storedLayer, name: layerFile }] : []),
  ];
  let archive = tarArchive(entries);
  if (corruptOuterHeader) {
    archive = Buffer.from(archive);
    archive[100] ^= 1;
  }
  if (missingEndMarker) {
    archive = archive.subarray(0, archive.length - 512);
  }
  if (dataAfterEnd) {
    archive = Buffer.concat([archive, tarHeader('after-end', '0')]);
  }
  return {
    archive,
    config,
    configFile,
    diffId,
    layerFile,
    manifest,
    rootfsLayers,
  };
}

function buildxArchiveExecutor(
  archiveContents: Buffer,
  calls: Array<{ arguments_: string[]; command: string }>,
) {
  return buildxArchiveSequenceExecutor(
    [archiveContents, archiveContents],
    calls,
  );
}

function buildxArchiveSequenceExecutor(
  archiveContents: readonly Buffer[],
  calls: Array<{ arguments_: string[]; command: string }>,
) {
  let build = 0;
  return (command: string, arguments_: string[]) => {
    calls.push({ arguments_: [...arguments_], command });
    if (command !== 'docker' || arguments_[0] !== 'buildx') {
      throw new Error(`Unexpected test command: ${arguments_.join(' ')}`);
    }
    const output = arguments_[arguments_.indexOf('--output') + 1];
    const archive = /^type=docker,dest=([^,]+),/u.exec(output)?.[1];
    if (archive === undefined) {
      throw new Error('Missing test archive path');
    }
    const contents = archiveContents[build];
    if (contents === undefined) {
      throw new Error(`Missing test archive contents for build ${build + 1}`);
    }
    build += 1;
    expect(arguments_.at(-1)).toBe(repositoryRoot);
    writeFileSync(archive, contents);
    return '';
  };
}

async function bundlePath() {
  const parent = await mkdtemp(
    resolve(tmpdir(), 'wo-build-release-stability-'),
  );
  temporaryDirectories.push(parent);
  return resolve(parent, 'bundle');
}

async function temporaryRoot() {
  const directory = await mkdtemp(
    resolve(tmpdir(), 'wo-build-release-source-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function expectMissing(path: string) {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function rejectionOf(promise: Promise<unknown>) {
  let rejected = false;
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    rejection = error;
  }
  expect(rejected).toBe(true);
  return rejection;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('release build provenance stability', () => {
  test('creates a bundle only when release provenance remains stable', async () => {
    const outputDirectory = await bundlePath();
    const events: string[] = [];
    const snapshotFixture = await copiedSourceSnapshot(() =>
      events.push('snapshot:cleanup'),
    );
    const deriveProvenance = vi.fn(() => {
      events.push('derive');
      return stableProvenance;
    });
    const imageBuilder = vi.fn(
      async (
        service: keyof typeof releaseImageDefinitions,
        directory: string,
        provenance: typeof stableProvenance,
        _execute: unknown,
        _environment: unknown,
        sourceRoot: string,
      ) => {
        events.push(`build:${service}`);
        await expectMissing(outputDirectory);
        expect(sourceRoot).toBe(snapshotFixture.root);
        return writeFakeImage(
          service,
          releaseServices.indexOf(service),
          directory,
          provenance,
        );
      },
    );
    const sourceSnapshot = vi.fn(snapshotFixture.factory);

    const result = await buildReleaseBundle({
      deriveProvenance,
      execute: () => {
        throw new Error('Docker execution must stay disabled in this test');
      },
      imageBuilder,
      outputDirectory,
      sourceSnapshot,
    });

    expect(deriveProvenance).toHaveBeenCalledTimes(2);
    expect(imageBuilder).toHaveBeenCalledTimes(releaseServices.length);
    expect(events).toEqual([
      'derive',
      ...releaseServices.map((service) => `build:${service}`),
      'derive',
      'snapshot:cleanup',
    ]);
    expect(result.manifest.provenance).toEqual(stableProvenance);
    expect(Object.keys(result.manifest.sourceFiles)).toEqual(
      releaseSourceFiles,
    );
    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
    expect(await readdir(resolve(outputDirectory, '..'))).toEqual(['bundle']);
    for (const service of releaseServices) {
      await expect(
        stat(
          resolve(outputDirectory, releaseImageDefinitions[service].archive),
        ),
      ).resolves.toMatchObject({
        size: Buffer.byteLength(`archive:${service}\n`),
      });
    }
    expect(sourceSnapshot).toHaveBeenCalledOnce();
  });

  test('uses the production source snapshot by default without invoking Docker', async () => {
    const outputDirectory = await bundlePath();
    const snapshotCommands: string[] = [];
    let snapshotRoot: string | undefined;
    const execute = vi.fn((command: string, arguments_: string[]) => {
      snapshotCommands.push(command);
      if (command === 'git') {
        const archive = arguments_[arguments_.indexOf('--output') + 1];
        expect(archive).toBeTypeOf('string');
        writeFileSync(archive!, 'test source archive');
        return '';
      }
      if (command === 'tar') {
        const sourceRoot = arguments_[arguments_.indexOf('-C') + 1];
        expect(sourceRoot).toBeTypeOf('string');
        for (const file of releaseSourceFiles) {
          const target = resolve(sourceRoot!, file);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(resolve(repositoryRoot, file), target);
        }
        return '';
      }
      throw new Error(`Unexpected source snapshot command: ${command}`);
    });
    const imageBuilder = vi.fn(
      async (
        service: keyof typeof releaseImageDefinitions,
        directory: string,
        selectedProvenance: typeof stableProvenance,
        _execute: unknown,
        _environment: unknown,
        sourceRoot: string,
      ) => {
        snapshotRoot = sourceRoot;
        expect(sourceRoot).not.toBe(repositoryRoot);
        return writeFakeImage(
          service,
          releaseServices.indexOf(service),
          directory,
          selectedProvenance,
        );
      },
    );

    await buildReleaseBundle({
      deriveProvenance: () => stableProvenance,
      execute,
      imageBuilder,
      outputDirectory,
      verifyBundle: async () => {},
    });

    expect(snapshotCommands).toEqual(['git', 'tar']);
    expect(execute.mock.calls.map(([command]) => command)).not.toContain(
      'docker',
    );
    expect(imageBuilder).toHaveBeenCalledTimes(releaseServices.length);
    expect(snapshotRoot).toBeTypeOf('string');
    await expectMissing(snapshotRoot!);
  });

  test('rejects a concurrent build before provenance or Docker work starts', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);
    await mkdir(lockDirectory);
    const deriveProvenance = vi.fn(() => stableProvenance);
    const imageBuilder = vi.fn();
    const sourceSnapshot = vi.fn(currentSourceSnapshot());

    await expect(
      buildReleaseBundle({
        deriveProvenance,
        imageBuilder,
        outputDirectory,
        sourceSnapshot,
      }),
    ).rejects.toThrow(/already in progress/i);

    expect(deriveProvenance).not.toHaveBeenCalled();
    expect(imageBuilder).not.toHaveBeenCalled();
    expect(sourceSnapshot).not.toHaveBeenCalled();
    expect(await readdir(resolve(outputDirectory, '..'))).toEqual([
      '.bundle.release.lock',
    ]);
  });

  test('holds the output lock through verification and rejects a second builder', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);
    let enterVerification = () => {};
    let releaseVerification = () => {};
    const verificationEntered = new Promise<void>((resolvePromise) => {
      enterVerification = resolvePromise;
    });
    const verificationGate = new Promise<void>((resolvePromise) => {
      releaseVerification = resolvePromise;
    });
    const firstBuild = buildReleaseBundle({
      deriveProvenance: () => stableProvenance,
      imageBuilder: async (service: keyof typeof releaseImageDefinitions) =>
        fakeImage(service, releaseServices.indexOf(service)),
      outputDirectory,
      sourceSnapshot: currentSourceSnapshot(),
      verifyBundle: async () => {
        enterVerification();
        await verificationGate;
      },
    });

    await verificationEntered;
    const secondProvenance = vi.fn(() => stableProvenance);
    const secondImageBuilder = vi.fn();
    const secondSnapshot = vi.fn(currentSourceSnapshot());
    try {
      expect((await stat(lockDirectory)).isDirectory()).toBe(true);
      await expect(
        buildReleaseBundle({
          deriveProvenance: secondProvenance,
          imageBuilder: secondImageBuilder,
          outputDirectory,
          sourceSnapshot: secondSnapshot,
        }),
      ).rejects.toThrow(/already in progress/i);
      expect(secondProvenance).not.toHaveBeenCalled();
      expect(secondImageBuilder).not.toHaveBeenCalled();
      expect(secondSnapshot).not.toHaveBeenCalled();
    } finally {
      releaseVerification();
      await firstBuild;
    }

    await expectMissing(lockDirectory);
  });

  test('does not replace an output directory created during the build', async () => {
    const outputDirectory = await bundlePath();

    await expect(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: async (service: keyof typeof releaseImageDefinitions) =>
          fakeImage(service, releaseServices.indexOf(service)),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
        verifyBundle: async () => {
          await mkdir(outputDirectory);
        },
      }),
    ).rejects.toThrow(/output directory already exists/i);

    expect(await readdir(resolve(outputDirectory, '..'))).toEqual(['bundle']);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('preserves an undefined build failure when output lock cleanup succeeds', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);

    const caught = await rejectionOf(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: () => Promise.reject(undefined),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    );

    expect(caught).toBeUndefined();
    await expectMissing(lockDirectory);
    await expectMissing(outputDirectory);
  });

  test('preserves undefined as the primary failure when output lock cleanup also fails', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);

    const caught = await rejectionOf(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: async () => {
          await writeFile(resolve(lockDirectory, 'foreign-owner'), 'occupied');
          return Promise.reject(undefined);
        },
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    const cleanupError = aggregate.errors[1];
    expect(aggregate.errors).toEqual([undefined, cleanupError]);
    expect(cleanupError).toMatchObject({ code: 'ENOTEMPTY' });
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    await expectMissing(outputDirectory);
  });

  test('keeps the build failure as cause when inner cleanup also fails', async () => {
    const outputDirectory = await bundlePath();
    const primaryError = new Error('test image build failed');
    const cleanupError = new Error('test source cleanup failed');

    const caught = await rejectionOf(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: () => Promise.reject(primaryError),
        outputDirectory,
        sourceSnapshot: async () => ({
          cleanup: () => Promise.reject(cleanupError),
          root: repositoryRoot,
        }),
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toEqual([primaryError, cleanupError]);
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(primaryError);
    await expectMissing(outputDirectory);
  });

  test('reports both build and output lock cleanup failures', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);
    const primaryError = new Error('test image build failed');

    const caught = await rejectionOf(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: async () => {
          await writeFile(resolve(lockDirectory, 'foreign-owner'), 'occupied');
          throw primaryError;
        },
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    const cleanupError = aggregate.errors[1];
    expect(aggregate.errors).toEqual([primaryError, cleanupError]);
    expect(cleanupError).toMatchObject({ code: 'ENOTEMPTY' });
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(primaryError);
    await expectMissing(outputDirectory);
  });

  test('uses the cleanup failure as cause after an otherwise successful build', async () => {
    const outputDirectory = await bundlePath();
    const lockDirectory = releaseOutputLock(outputDirectory);

    const caught = await rejectionOf(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: (
          service: keyof typeof releaseImageDefinitions,
          directory: string,
          provenance: typeof stableProvenance,
        ) =>
          writeFakeImage(
            service,
            releaseServices.indexOf(service),
            directory,
            provenance,
          ),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
        verifyBundle: async () => {
          await writeFile(resolve(lockDirectory, 'foreign-owner'), 'occupied');
        },
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    const [cleanupError] = aggregate.errors;
    expect(aggregate.errors).toEqual([cleanupError]);
    expect(cleanupError).toMatchObject({ code: 'ENOTEMPTY' });
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(cleanupError);
    await expect(stat(outputDirectory)).resolves.toMatchObject({});
  });

  test('fails closed when the worktree becomes dirty at the final check', async () => {
    const outputDirectory = await bundlePath();
    const deriveProvenance = vi
      .fn()
      .mockReturnValueOnce(stableProvenance)
      .mockImplementationOnce(() => {
        throw new Error('Production release requires a clean Git worktree');
      });

    await expect(
      buildReleaseBundle({
        deriveProvenance,
        imageBuilder: async (service: keyof typeof releaseImageDefinitions) =>
          fakeImage(service, releaseServices.indexOf(service)),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    ).rejects.toThrow(/clean Git worktree/i);
    expect(deriveProvenance).toHaveBeenCalledTimes(2);
  });

  test('rejects a clean commit change during a long build', async () => {
    const outputDirectory = await bundlePath();
    const deriveProvenance = vi
      .fn()
      .mockReturnValueOnce(stableProvenance)
      .mockReturnValueOnce(changedProvenance);

    await expect(
      buildReleaseBundle({
        deriveProvenance,
        imageBuilder: async (service: keyof typeof releaseImageDefinitions) =>
          fakeImage(service, releaseServices.indexOf(service)),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    ).rejects.toThrow(
      /provenance changed during build: BUILD_REVISION, BUILD_VERSION/i,
    );
  });

  test('removes partial output after final provenance validation fails', async () => {
    const outputDirectory = await bundlePath();
    const deriveProvenance = vi
      .fn()
      .mockReturnValueOnce(stableProvenance)
      .mockReturnValueOnce(changedProvenance);

    await expect(
      buildReleaseBundle({
        deriveProvenance,
        imageBuilder: async (
          service: keyof typeof releaseImageDefinitions,
          directory: string,
        ) => {
          await mkdir(directory, { recursive: true });
          await writeFile(resolve(directory, `.${service}.partial`), 'partial');
          return fakeImage(service, releaseServices.indexOf(service));
        },
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    ).rejects.toThrow(/provenance changed during build/i);
    await expectMissing(outputDirectory);
  });

  test('rejects and removes a metadata-only bundle with missing archives', async () => {
    const outputDirectory = await bundlePath();

    await expect(
      buildReleaseBundle({
        deriveProvenance: () => stableProvenance,
        imageBuilder: async (service: keyof typeof releaseImageDefinitions) =>
          fakeImage(service, releaseServices.indexOf(service)),
        outputDirectory,
        sourceSnapshot: currentSourceSnapshot(),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expectMissing(outputDirectory);
    expect(await readdir(resolve(outputDirectory, '..'))).toEqual([]);
  });
});

describe('release build isolation', () => {
  test('checks out the exact release revision into a disposable source snapshot', async () => {
    const root = await temporaryRoot();
    const calls: Array<{
      arguments_: string[];
      command: string;
      cwd?: string;
    }> = [];
    const snapshot = await createReleaseSourceSnapshot(stableProvenance, {
      execute: (
        command: string,
        arguments_: string[],
        options: { cwd?: string } = {},
      ) => {
        calls.push({ arguments_: [...arguments_], command, cwd: options.cwd });
        return '';
      },
      temporaryRoot: root,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: 'git',
      cwd: repositoryRoot,
    });
    expect(calls[0]?.arguments_).toEqual(
      expect.arrayContaining([
        'archive',
        '--format=tar',
        '--output',
        stableProvenance.BUILD_REVISION,
      ]),
    );
    expect(calls[1]).toMatchObject({ command: 'tar' });
    expect((await stat(snapshot.root)).mode & 0o777).toBe(0o700);

    await snapshot.cleanup();
    await expectMissing(snapshot.root);
  });

  test('keeps the source snapshot failure as cause when workspace cleanup also fails', async () => {
    const root = await temporaryRoot();
    const primaryError = new Error('test source snapshot failed');
    const cleanupError = new Error('test workspace cleanup failed');
    const removeWorkspace = vi.fn(() => Promise.reject(cleanupError));

    const caught = await rejectionOf(
      createReleaseSourceSnapshot(stableProvenance, {
        execute: () => {
          throw primaryError;
        },
        removeWorkspace,
        temporaryRoot: root,
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toEqual([primaryError, cleanupError]);
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(primaryError);
    expect(removeWorkspace).toHaveBeenCalledOnce();
    expect(removeWorkspace.mock.calls[0]?.[1]).toEqual({
      force: true,
      recursive: true,
    });
  });

  test.each([
    ['BuildKit gzip blobs', {}],
    ['Moby raw blobs', { gzipLayer: false }],
    ['GNU tar headers with an explicit root directory', { gnuLayer: true }],
    ['USTAR directory entries with a trailing slash', { directoryLayer: true }],
    [
      'legacy raw layer.tar members',
      { gzipLayer: false, legacyConfig: true, legacyLayer: true },
    ],
    ['POSIX PAX Unicode path and linkpath metadata', { paxLayer: true }],
    ['POSIX PAX relative symlink targets', { paxRelativeSymlink: true }],
    ['POSIX PAX binary capability metadata', { paxCapabilityLayer: true }],
    [
      'a POSIX PAX record split across stream chunks',
      { largePaxComment: true },
    ],
    ['repeated layer references', { repeatLayerReference: true }],
  ])(
    'derives image metadata from %s without Docker image commands',
    async (_description, fixtureOptions) => {
      const outputDirectory = await bundlePath();
      await mkdir(outputDirectory);
      const fixture = archiveFixture('server', fixtureOptions);
      const calls: Array<{ arguments_: string[]; command: string }> = [];
      const execute = buildxArchiveExecutor(fixture.archive, calls);

      const image = await buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        execute,
        {},
        repositoryRoot,
      );

      expect(image).toMatchObject({
        imageId: `sha256:${sha256(fixture.config)}`,
        reference: releaseImageReference(
          'server',
          stableProvenance.BUILD_VERSION,
        ),
        rootfsLayers: fixture.rootfsLayers,
      });
      expect(
        calls.filter(
          ({ arguments_, command }) =>
            command === 'docker' && arguments_[0] === 'buildx',
        ),
      ).toHaveLength(2);
      expect(
        calls.filter(
          ({ arguments_, command }) =>
            command === 'docker' && arguments_[0] === 'image',
        ),
      ).toHaveLength(0);
    },
  );

  test('keeps archive range ownership with the caller after downstream cancellation', async () => {
    const root = await temporaryRoot();
    const archive = resolve(root, 'range.bin');
    const contents = Buffer.alloc(128 * 1024, 0x61);
    contents[contents.length - 1] = 0x7a;
    await writeFile(archive, contents);
    const handle = await open(archive, 'r');
    const close = vi.spyOn(handle, 'close');
    const closeListeners = handle.listenerCount('close');

    try {
      const stream = Readable.from(
        readArchiveRange(handle, 0, contents.length, 'test archive range'),
        { highWaterMark: 1, objectMode: false },
      );
      for await (const chunk of stream) {
        expect(chunk).toEqual(contents.subarray(0, chunk.length));
        break;
      }

      expect(stream.destroyed).toBe(true);
      expect(handle.listenerCount('close')).toBe(closeListeners);
      expect(close).not.toHaveBeenCalled();
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(
        probe,
        0,
        probe.length,
        contents.length - 1,
      );
      expect(bytesRead).toBe(1);
      expect(probe[0]).toBe(0x7a);
    } finally {
      await handle.close();
    }

    expect(close).toHaveBeenCalledTimes(1);
  });

  test('continues positional archive reads after partial results', async () => {
    const contents = Buffer.from('partial-read-boundary');
    const positions: number[] = [];
    const handle = {
      read: vi.fn(
        async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          positions.push(position);
          const bytesRead = Math.min(3, length, contents.length - position);
          contents.copy(buffer, offset, position, position + bytesRead);
          return { buffer, bytesRead };
        },
      ),
    };
    const chunks: Buffer[] = [];

    for await (const chunk of readArchiveRange(
      handle,
      0,
      contents.length,
      'partial archive range',
    )) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(contents);
    expect(positions).toEqual([0, 3, 6, 9, 12, 15, 18]);
  });

  test('rejects EOF before the declared archive range', async () => {
    const handle = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ buffer: Buffer.alloc(8), bytesRead: 3 })
        .mockResolvedValueOnce({ buffer: Buffer.alloc(5), bytesRead: 0 }),
    };

    await expect(
      (async () => {
        for await (const chunk of readArchiveRange(
          handle,
          0,
          8,
          'truncated archive range',
        )) {
          expect(chunk).toHaveLength(3);
        }
      })(),
    ).rejects.toThrow(/truncated archive range is truncated/i);
    expect(handle.read).toHaveBeenCalledTimes(2);
    expect(handle.read.mock.calls.map((call) => call[3])).toEqual([0, 3]);
  });

  test('does not accumulate FileHandle listeners across many image layers', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server', { additionalLayerCount: 11 });
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      const image = await buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        buildxArchiveExecutor(fixture.archive, []),
        {},
        repositoryRoot,
      );
      expect(image.rootfsLayers).toHaveLength(12);
      await new Promise<void>((resolvePromise) => {
        setImmediate(resolvePromise);
      });
    } finally {
      process.off('warning', onWarning);
    }

    expect(
      warnings.filter(
        (warning) =>
          warning.name === 'MaxListenersExceededWarning' &&
          /FileHandle/u.test(warning.message),
      ),
    ).toEqual([]);
  });

  test('rejects byte-different archives for the same image metadata', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server');
    const paddedArchive = Buffer.concat([fixture.archive, Buffer.alloc(512)]);
    const calls: Array<{ arguments_: string[]; command: string }> = [];

    await expect(
      buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        buildxArchiveSequenceExecutor([fixture.archive, paddedArchive], calls),
        {},
        repositoryRoot,
      ),
    ).rejects.toThrow(/different archives/i);

    expect(calls).toHaveLength(2);
    await expectMissing(
      resolve(outputDirectory, releaseImageDefinitions.server.archive),
    );
  });

  test('preserves the archive FileHandle when layer validation fails early', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server', {
      corruptLayerHeader: true,
      gzipLayer: false,
      largeLayer: true,
    });
    let caught: unknown;

    try {
      await buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        buildxArchiveExecutor(fixture.archive, []),
        {},
        repositoryRoot,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toMatch(/header checksum/i);
    expect((caught as Error).message).not.toMatch(/EBADF|bad file descriptor/i);
  });

  test.each([
    ['a string', 'layer stream failed', 'layer stream failed'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a null-prototype object', Object.create(null), 'Unprintable error'],
  ])(
    'reports %s rejected by the archive layer stream and closes its handle',
    async (_description, layerRejection, expectedMessage) => {
      const outputDirectory = await bundlePath();
      await mkdir(outputDirectory);
      const fixture = archiveFixture('server');
      const layerName = Buffer.from(fixture.layerFile);
      const layerHeaderOffset = Array.from(
        { length: Math.ceil(fixture.archive.length / 512) },
        (_, index) => index * 512,
      ).find((offset) =>
        fixture.archive
          .subarray(offset, offset + layerName.length)
          .equals(layerName),
      );
      expect(layerHeaderOffset).toBeTypeOf('number');
      const layerPayloadOffset = layerHeaderOffset! + 512;
      let layerPayloadReads = 0;
      let closeCalls = 0;
      const openArchive = vi.fn(async (archivePath: string, flags: string) => {
        const handle = await open(archivePath, flags);
        return {
          close: async () => {
            closeCalls += 1;
            await handle.close();
          },
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            if (position === layerPayloadOffset) {
              layerPayloadReads += 1;
              if (layerPayloadReads === 2) {
                throw layerRejection;
              }
            }
            return handle.read(buffer, offset, length, position);
          },
          stat: () => handle.stat(),
        };
      });

      const caught = await rejectionOf(
        buildImageTwice(
          'server',
          outputDirectory,
          stableProvenance,
          buildxArchiveExecutor(fixture.archive, []),
          {},
          repositoryRoot,
          openArchive,
        ),
      );

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(expectedMessage);
      expect(Object.hasOwn(caught as Error, 'cause')).toBe(true);
      expect((caught as Error).cause).toBe(layerRejection);
      expect(layerPayloadReads).toBe(2);
      expect(closeCalls).toBe(1);
    },
  );

  test('preserves undefined when archive close cleanup alone fails', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server');
    let closeCalls = 0;
    const openArchive = vi.fn(async (archivePath: string, flags: string) => {
      const handle = await open(archivePath, flags);
      return {
        close: async () => {
          closeCalls += 1;
          await handle.close();
          throw undefined;
        },
        read: handle.read.bind(handle),
        stat: handle.stat.bind(handle),
      };
    });

    const caught = await rejectionOf(
      buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        buildxArchiveExecutor(fixture.archive, []),
        {},
        repositoryRoot,
        openArchive,
      ),
    );

    expect(caught).toBeUndefined();
    expect(openArchive).toHaveBeenCalledOnce();
    expect(closeCalls).toBe(1);
  });

  test('preserves undefined as the archive verification cause when close also fails', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server');
    const closeError = new Error('test archive close failed');
    const archiveHandle = {
      close: vi.fn(() => Promise.reject(closeError)),
      stat: vi.fn(() => Promise.reject(undefined)),
    };
    const openArchive = vi.fn(() => Promise.resolve(archiveHandle));

    const caught = await rejectionOf(
      buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        buildxArchiveExecutor(fixture.archive, []),
        {},
        repositoryRoot,
        openArchive,
      ),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toEqual([undefined, closeError]);
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(openArchive).toHaveBeenCalledOnce();
    expect(archiveHandle.close).toHaveBeenCalledOnce();
  });

  test('rejects invalid archive provenance without mutating Docker images', async () => {
    const outputDirectory = await bundlePath();
    await mkdir(outputDirectory);
    const fixture = archiveFixture('server', {
      architecture: 'arm64',
      gzipLayer: false,
      legacyConfig: true,
      legacyLayer: true,
    });
    const calls: Array<{ arguments_: string[]; command: string }> = [];
    const execute = buildxArchiveExecutor(fixture.archive, calls);

    await expect(
      buildImageTwice(
        'server',
        outputDirectory,
        stableProvenance,
        execute,
        {},
        repositoryRoot,
      ),
    ).rejects.toThrow(/architecture/i);

    expect(
      calls.filter(
        ({ arguments_, command }) =>
          command === 'docker' && arguments_[0] === 'image',
      ),
    ).toHaveLength(0);
  });

  test.each([
    ['a missing layer member', { omitLayer: true }, /missing/i],
    ['a mismatched blob digest', { corruptBlobHash: true }, /blob SHA-256/i],
    ['a mismatched rootfs diff ID', { corruptDiffId: true }, /diff ID/i],
    [
      'a mismatched config digest',
      { corruptConfigHash: true },
      /config filename/i,
    ],
    [
      'a duplicate physical layer member',
      { duplicateLayer: true },
      /duplicate member/i,
    ],
    [
      'a non-tar layer payload with self-consistent digests',
      { invalidLayerTar: true },
      /unreadable or corrupt/i,
    ],
    [
      'a corrupt inner tar header',
      { corruptLayerHeader: true },
      /unreadable or corrupt/i,
    ],
    [
      'non-zero inner tar padding',
      { corruptLayerPadding: true },
      /non-zero tar padding/i,
    ],
    [
      'invalid UTF-8 in an inner tar header path',
      { invalidLayerPathUtf8: true },
      /invalid UTF-8 in tar header/i,
    ],
    [
      'an unsupported inner tar magic',
      { invalidLayerTarFormat: true },
      /unsupported tar header format/i,
    ],
    [
      'a mixed GNU magic and POSIX version',
      { gnuLayer: true, invalidLayerTarVersion: true },
      /unsupported tar header format/i,
    ],
    [
      'non-zero old GNU extension fields',
      { gnuExtendedHeader: true, gnuLayer: true },
      /unsupported GNU tar header extension/i,
    ],
    ['an inner tar dot path', { dotLayerPath: true }, /unsafe path/i],
    [
      'an inner tar explicit relative path',
      { relativeLayerPath: true },
      /unsafe path/i,
    ],
    [
      'an inner tar path with an empty component',
      { doubleSlashLayerPath: true },
      /unsafe path/i,
    ],
    [
      'a non-directory inner tar path with a trailing slash',
      { nonDirectoryTrailingSlash: true },
      /unsafe path/i,
    ],
    [
      'a link name on a non-link entry',
      { nonLinkLinkName: true },
      /unexpected link name/i,
    ],
    [
      'a symlink payload that hides a following tar header',
      { linkPayloadHeader: true },
      /non-zero payload size/i,
    ],
    ['a corrupt gzip stream', { corruptGzip: true }, /unreadable or corrupt/i],
    [
      'an unsupported layer compression',
      { unsupportedLayerCompression: true },
      /unsupported compression/i,
    ],
    [
      'an unsupported global PAX inner tar extension',
      { unsupportedInnerExtension: true },
      /unsupported entry type/i,
    ],
    [
      'an unsupported GNU long-name extension',
      { gnuLayer: true, unsupportedGnuLongName: true },
      /unsupported entry type/i,
    ],
    ['an unsafe local PAX path', { unsafePaxPath: true }, /unsafe PAX path/i],
    ['a BOM-prefixed local PAX path', { bomPaxPath: true }, /unsafe PAX path/i],
    [
      'consecutive local PAX headers',
      { consecutivePaxHeaders: true },
      /consecutive PAX headers/i,
    ],
    [
      'a malformed local PAX record length',
      { malformedPaxLayer: true },
      /invalid PAX record length/i,
    ],
    [
      'a high-bit byte masquerading as a PAX length digit',
      { paxHighBitLength: true },
      /invalid PAX record length/i,
    ],
    [
      'duplicate local PAX keys',
      { paxDuplicateKey: true },
      /duplicate PAX key/i,
    ],
    [
      'unsupported PAX sparse metadata',
      { paxSparseMetadata: true },
      /unsupported PAX sparse metadata/i,
    ],
    [
      'an unknown local PAX key',
      { paxUnknownKey: true },
      /unsupported PAX key/i,
    ],
    [
      'an invalid standard PAX timestamp',
      { invalidPaxTimestamp: true },
      /invalid PAX mtime value/i,
    ],
    [
      'an out-of-range standard PAX timestamp',
      { unsafePaxTimestamp: true },
      /unsafe PAX mtime value/i,
    ],
    [
      'unsupported PAX hdrcharset semantics',
      { paxHdrcharset: true },
      /unsupported PAX key/i,
    ],
    [
      'an empty PAX xattr name',
      { emptyPaxXattrName: true },
      /empty PAX xattr name/i,
    ],
    [
      'a local PAX size that exceeds the following payload',
      { paxSizeMismatch: true },
      /not a complete tar archive/i,
    ],
    [
      'a local PAX size above the supported USTAR entry limit',
      { paxSizeTooLarge: true },
      /unsafe PAX entry size/i,
    ],
    [
      'a local PAX hardlink that escapes the layer root',
      { unsafePaxHardlink: true },
      /unsafe PAX hardlink path/i,
    ],
    [
      'a local PAX header without a target entry',
      { paxWithoutTarget: true },
      /without a following entry/i,
    ],
    [
      'a corrupt outer tar header',
      { corruptOuterHeader: true },
      /header checksum/i,
    ],
    [
      'an incomplete outer tar end marker',
      { missingEndMarker: true },
      /end marker/i,
    ],
    [
      'outer tar data after the end marker',
      { dataAfterEnd: true },
      /data after its end/i,
    ],
    [
      'a regular manifest member with a trailing slash',
      { manifestTrailingSlash: true },
      /non-canonical path/i,
    ],
  ])(
    'rejects %s in a real Docker tar archive',
    async (_description, fixtureOptions, expectedError) => {
      const outputDirectory = await bundlePath();
      await mkdir(outputDirectory);
      const fixture = archiveFixture('server', fixtureOptions);
      const calls: Array<{ arguments_: string[]; command: string }> = [];

      await expect(
        buildImageTwice(
          'server',
          outputDirectory,
          stableProvenance,
          buildxArchiveExecutor(fixture.archive, calls),
          {},
          repositoryRoot,
        ),
      ).rejects.toThrow(expectedError);

      expect(
        calls.filter(
          ({ arguments_, command }) =>
            command === 'docker' && arguments_[0] === 'image',
        ),
      ).toHaveLength(0);
    },
  );
});
