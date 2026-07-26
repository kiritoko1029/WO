import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, posix, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  argumentValue,
  deploymentProcessEnvironment,
  failureMessage,
  run,
  sha256File,
} from './ops.mjs';
import {
  assertReleaseManifest,
  readAndVerifyReleaseBundle,
  releaseImageDefinitions,
  releaseImageReference,
  releaseManifestChecksumName,
  releaseManifestName,
  releasePlatform,
  releaseServices,
  releaseSourceFiles,
} from './release.mjs';
import {
  deriveReleaseProvenance,
  releaseBuildArguments,
  releaseProvenanceFields,
  validateImageProvenance,
} from './provenance.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const tarBlockSize = 512;
const maximumArchiveJsonSize = 16 * 1024 * 1024;
const maximumLayerEntrySize = 8 * 1024 * 1024 * 1024 - 1;
const maximumLayerPaxSize = 1024 * 1024;
const archiveReadChunkSize = 64 * 1024;
const minimumSignedInt64 = -(1n << 63n);
const maximumSignedInt64 = (1n << 63n) - 1n;

class ArchiveRangeReadError extends Error {}

function buildxArguments(service, archive, provenance, sourceRoot) {
  const definition = releaseImageDefinitions[service];
  return [
    'buildx',
    'build',
    '--no-cache',
    '--pull',
    '--platform',
    `${releasePlatform.os}/${releasePlatform.architecture}`,
    '--provenance=false',
    '--sbom=false',
    '--file',
    resolve(sourceRoot, definition.dockerfile),
    '--tag',
    releaseImageReference(service, provenance.BUILD_VERSION),
    ...releaseBuildArguments(provenance),
    '--output',
    `type=docker,dest=${archive},rewrite-timestamp=true`,
    sourceRoot,
  ];
}

function sameLayers(left, right) {
  return (
    left.length === right.length &&
    left.every((layer, index) => layer === right[index])
  );
}

function parseArchiveJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function archiveConfigHash(configFile) {
  const match =
    /^([a-f0-9]{64})\.json$/u.exec(configFile) ??
    /^blobs\/sha256\/([a-f0-9]{64})$/u.exec(configFile);
  return match?.[1];
}

function tarText(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block
    .subarray(
      offset,
      end === -1 || end > offset + length ? offset + length : end,
    )
    .toString('utf8');
}

function layerTarText(block, offset, length, label) {
  const end = block.indexOf(0, offset);
  const source = block.subarray(
    offset,
    end === -1 || end > offset + length ? offset + length : end,
  );
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(source);
  } catch {
    throw new Error(
      `Release image layer has invalid UTF-8 in tar header ${label}`,
    );
  }
}

function tarOctal(block, offset, length, label) {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]*$/u.test(value)) {
    throw new Error(`Release Docker archive has an invalid ${label}`);
  }
  const parsed = value.length === 0 ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Release Docker archive has an unsafe ${label}`);
  }
  return parsed;
}

function assertTarHeaderChecksum(block) {
  const storedChecksum = tarOctal(block, 148, 8, 'header checksum');
  const checksumBlock = Buffer.from(block);
  checksumBlock.fill(0x20, 148, 156);
  const actualChecksum = [...checksumBlock].reduce(
    (sum, value) => sum + value,
    0,
  );
  if (storedChecksum !== actualChecksum) {
    throw new Error('Release Docker archive header checksum mismatch');
  }
}

function inspectArchiveHeader(block) {
  assertTarHeaderChecksum(block);
  const name = tarText(block, 0, 100);
  const prefix = tarText(block, 345, 155);
  const archivePath = prefix.length > 0 ? `${prefix}/${name}` : name;
  const typeFlag = String.fromCharCode(block[156] ?? 0);
  const regularFile = typeFlag === '\0' || typeFlag === '0';
  const directory = typeFlag === '5';
  if (!regularFile && !directory) {
    throw new Error(
      `Release Docker archive contains an unsafe entry type: ${typeFlag}`,
    );
  }
  if (
    (regularFile && archivePath.endsWith('/')) ||
    (directory && /\/\/+$/u.test(archivePath))
  ) {
    throw new Error(
      `Release Docker archive contains a non-canonical path: ${archivePath}`,
    );
  }
  const normalizedArchivePath =
    directory && archivePath.endsWith('/')
      ? archivePath.slice(0, -1)
      : archivePath;
  if (
    archivePath.length === 0 ||
    archivePath.includes('\\') ||
    /[\p{Cc}]/u.test(archivePath) ||
    !/^[A-Za-z0-9._/-]+$/u.test(archivePath) ||
    posix.isAbsolute(archivePath) ||
    posix.normalize(normalizedArchivePath) !== normalizedArchivePath ||
    archivePath.split('/').some((part) => part === '..')
  ) {
    throw new Error(
      `Release Docker archive contains an unsafe path: ${archivePath}`,
    );
  }

  const size = tarOctal(block, 124, 12, 'entry size');
  if (directory && size !== 0) {
    throw new Error(
      'Release Docker archive directory has a non-zero payload size',
    );
  }
  return {
    archivePath: normalizedArchivePath,
    regularFile,
    size,
  };
}

async function readExactly(handle, buffer, position, label) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new Error(`${label} is truncated`);
    }
    offset += bytesRead;
  }
  return buffer;
}

async function indexReleaseArchive(handle) {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size % tarBlockSize !== 0
  ) {
    throw new Error('Release Docker archive is not a complete tar file');
  }
  const entries = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < metadata.size) {
    const block = Buffer.alloc(tarBlockSize);
    await readExactly(handle, block, offset, 'Release Docker archive header');
    offset += tarBlockSize;
    if (block.every((value) => value === 0)) {
      zeroBlocks += 1;
      continue;
    }
    if (zeroBlocks > 0) {
      throw new Error('Release Docker archive contains data after its end');
    }
    const entry = inspectArchiveHeader(block);
    if (entries.has(entry.archivePath)) {
      throw new Error(
        `Release Docker archive contains a duplicate member: ${entry.archivePath}`,
      );
    }
    const payloadOffset = offset;
    const padding = (tarBlockSize - (entry.size % tarBlockSize)) % tarBlockSize;
    const nextOffset = payloadOffset + entry.size + padding;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > metadata.size) {
      throw new Error(
        `Release Docker archive member is truncated: ${entry.archivePath}`,
      );
    }
    entries.set(entry.archivePath, { ...entry, payloadOffset });
    offset = nextOffset;
  }
  if (zeroBlocks < 2) {
    throw new Error('Release Docker archive has no complete end marker');
  }
  return entries;
}

async function readArchiveMember(handle, entries, name, label) {
  const entry = entries.get(name);
  if (entry === undefined || !entry.regularFile) {
    throw new Error(`${label} is missing or is not a regular file`);
  }
  if (entry.size === 0 || entry.size > maximumArchiveJsonSize) {
    throw new Error(`${label} has an unsafe size`);
  }
  const contents = Buffer.alloc(entry.size);
  return readExactly(handle, contents, entry.payloadOffset, label);
}

function archiveLayerLocation(layerFile) {
  const blobMatch = /^blobs\/sha256\/([a-f0-9]{64})$/u.exec(layerFile);
  if (blobMatch !== null) {
    return { blobHash: blobMatch[1], legacy: false };
  }
  if (/^[a-f0-9]{64}\/layer\.tar$/u.test(layerFile)) {
    return { blobHash: undefined, legacy: true };
  }
  throw new Error(`Release Docker archive layer path is invalid: ${layerFile}`);
}

async function archiveMemberPrefix(handle, entry, length) {
  const prefix = Buffer.alloc(Math.min(entry.size, length));
  return readExactly(
    handle,
    prefix,
    entry.payloadOffset,
    'Release Docker archive layer prefix',
  );
}

function archiveLayerCompression(prefix) {
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    return 'gzip';
  }
  if (
    (prefix[0] === 0x28 &&
      prefix[1] === 0xb5 &&
      prefix[2] === 0x2f &&
      prefix[3] === 0xfd) ||
    (prefix[0] === 0x42 && prefix[1] === 0x5a && prefix[2] === 0x68) ||
    (prefix[0] === 0xfd &&
      prefix[1] === 0x37 &&
      prefix[2] === 0x7a &&
      prefix[3] === 0x58 &&
      prefix[4] === 0x5a &&
      prefix[5] === 0x00)
  ) {
    return 'unsupported';
  }
  return 'identity';
}

function assertSafeLayerTarPath(
  archivePath,
  label = 'path',
  allowTrailingSlash = false,
) {
  const hasTrailingSlash = archivePath.endsWith('/');
  const normalizedArchivePath = hasTrailingSlash
    ? archivePath.slice(0, -1)
    : archivePath;
  const pathParts = normalizedArchivePath.split('/');
  if (
    archivePath.length === 0 ||
    archivePath.includes('\\') ||
    /[\p{Cc}\p{Cf}]/u.test(archivePath) ||
    (hasTrailingSlash && !allowTrailingSlash) ||
    posix.isAbsolute(archivePath) ||
    posix.normalize(normalizedArchivePath) !== normalizedArchivePath ||
    pathParts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(
      `Release image layer contains an unsafe ${label}: ${archivePath}`,
    );
  }
}

function inspectLayerTarHeader(block) {
  assertTarHeaderChecksum(block);
  const magic = block.subarray(257, 263);
  const version = block.subarray(263, 265);
  const posixFormat =
    magic.equals(Buffer.from('ustar\0', 'ascii')) &&
    version.equals(Buffer.from('00', 'ascii'));
  const gnuFormat =
    magic.equals(Buffer.from('ustar ', 'ascii')) &&
    version.equals(Buffer.from([0x20, 0x00]));
  if (!posixFormat && !gnuFormat) {
    throw new Error(
      'Release image layer contains an unsupported tar header format',
    );
  }
  const typeFlag = String.fromCharCode(block[156] ?? 0);
  const allowedTypes = gnuFormat
    ? new Set(['0', '1', '2', '5'])
    : new Set(['0', '1', '2', '5', 'x']);
  if (!allowedTypes.has(typeFlag)) {
    throw new Error(
      `Release image layer contains an unsupported entry type: ${typeFlag}`,
    );
  }
  const name = layerTarText(block, 0, 100, 'name');
  const prefixBytes = block.subarray(345, 500);
  if (gnuFormat && prefixBytes.some((value) => value !== 0)) {
    throw new Error(
      'Release image layer contains an unsupported GNU tar header extension',
    );
  }
  const prefix = posixFormat ? layerTarText(block, 345, 155, 'prefix') : '';
  const archivePath = prefix.length > 0 ? `${prefix}/${name}` : name;
  const size = tarOctal(block, 124, 12, 'layer entry size');
  const linkPath = layerTarText(block, 157, 100, 'link name');
  if (typeFlag !== '1' && typeFlag !== '2' && linkPath.length !== 0) {
    throw new Error(
      `Release image layer ${typeFlag} entry has an unexpected link name`,
    );
  }
  const gnuRootDirectory =
    gnuFormat && typeFlag === '5' && archivePath === './' && size === 0;
  if (!gnuRootDirectory) {
    assertSafeLayerTarPath(archivePath, 'path', typeFlag === '5');
  }
  return {
    archivePath,
    linkPath,
    size,
    typeFlag,
  };
}

function decodeLayerPaxText(source, label) {
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(source);
  } catch {
    throw new Error(`Release image layer has invalid UTF-8 in PAX ${label}`);
  }
}

function validateLayerPaxValue(key, value) {
  if (['linkpath', 'path', 'size'].includes(key)) {
    decodeLayerPaxText(value, `value for ${key}`);
    return;
  }
  if (['atime', 'ctime', 'mtime'].includes(key)) {
    const timestamp = decodeLayerPaxText(value, `value for ${key}`);
    if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(timestamp)) {
      throw new Error(`Release image layer has an invalid PAX ${key} value`);
    }
    const seconds = BigInt(timestamp.split('.', 1)[0]);
    if (seconds < minimumSignedInt64 || seconds > maximumSignedInt64) {
      throw new Error(`Release image layer has an unsafe PAX ${key} value`);
    }
    return;
  }
  if (key === 'gid' || key === 'uid') {
    const identifier = decodeLayerPaxText(value, `value for ${key}`);
    const parsed = Number(identifier);
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(identifier) ||
      !Number.isSafeInteger(parsed)
    ) {
      throw new Error(`Release image layer has an invalid PAX ${key} value`);
    }
    return;
  }
  if (['charset', 'comment', 'gname', 'uname'].includes(key)) {
    const text = decodeLayerPaxText(value, `value for ${key}`);
    if (text.length === 0) {
      throw new Error(`Release image layer has an empty PAX ${key} value`);
    }
    return;
  }
  for (const prefix of ['LIBARCHIVE.xattr.', 'SCHILY.xattr.']) {
    if (key.startsWith(prefix)) {
      if (key.length === prefix.length) {
        throw new Error(
          `Release image layer has an empty PAX xattr name: ${key}`,
        );
      }
      return;
    }
  }
  throw new Error(`Release image layer has an unsupported PAX key: ${key}`);
}

function parseLayerPaxHeader(payload) {
  const values = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const lengthEnd = payload.indexOf(0x20, offset);
    const lengthBytes = payload.subarray(offset, lengthEnd);
    if (
      lengthEnd <= offset ||
      lengthBytes[0] === 0x30 ||
      lengthBytes.some((value) => value < 0x30 || value > 0x39)
    ) {
      throw new Error('Release image layer has an invalid PAX record length');
    }
    const encodedLength = lengthBytes.toString('ascii');
    const recordLength = Number(encodedLength);
    const recordEnd = offset + recordLength;
    if (
      !Number.isSafeInteger(recordLength) ||
      recordEnd > payload.length ||
      recordEnd <= lengthEnd + 3 ||
      payload[recordEnd - 1] !== 0x0a
    ) {
      throw new Error('Release image layer has an invalid PAX record length');
    }
    const separator = payload.indexOf(0x3d, lengthEnd + 1);
    if (separator < 0 || separator >= recordEnd - 1) {
      throw new Error('Release image layer has an invalid PAX record');
    }
    const keyBytes = payload.subarray(lengthEnd + 1, separator);
    if (keyBytes.some((value) => value > 0x7f)) {
      throw new Error('Release image layer has a non-ASCII PAX key');
    }
    const key = keyBytes.toString('ascii');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(key)) {
      throw new Error(`Release image layer has an invalid PAX key: ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Release image layer has a duplicate PAX key: ${key}`);
    }
    if (key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize') {
      throw new Error(
        `Release image layer contains unsupported PAX sparse metadata: ${key}`,
      );
    }
    const value = Buffer.from(payload.subarray(separator + 1, recordEnd - 1));
    validateLayerPaxValue(key, value);
    values.set(key, value);
    offset = recordEnd;
  }
  return values;
}

function paxText(pax, key) {
  const value = pax.get(key);
  return value === undefined
    ? undefined
    : decodeLayerPaxText(value, `value for ${key}`);
}

function layerEntrySize(header, pax) {
  if (['1', '2', '5'].includes(header.typeFlag) && header.size !== 0) {
    throw new Error(
      `Release image layer ${header.typeFlag} entry has a non-zero payload size`,
    );
  }
  if (pax === undefined) {
    if (header.typeFlag === '1') {
      assertSafeLayerTarPath(header.linkPath, 'hardlink path');
    } else if (
      header.typeFlag === '2' &&
      (header.linkPath.length === 0 ||
        header.linkPath.includes('\\') ||
        /[\p{Cc}\p{Cf}]/u.test(header.linkPath) ||
        posix.normalize(header.linkPath) !== header.linkPath)
    ) {
      throw new Error(
        `Release image layer contains an unsafe symlink target: ${header.linkPath}`,
      );
    }
    return header.size;
  }
  const archivePath = paxText(pax, 'path');
  if (archivePath !== undefined) {
    assertSafeLayerTarPath(archivePath, 'PAX path', header.typeFlag === '5');
  }
  const linkPath = paxText(pax, 'linkpath');
  if (linkPath !== undefined) {
    if (header.typeFlag !== '1' && header.typeFlag !== '2') {
      throw new Error(
        'Release image layer has PAX linkpath metadata for a non-link entry',
      );
    }
  }
  const effectiveLinkPath = linkPath ?? header.linkPath;
  if (header.typeFlag === '1') {
    assertSafeLayerTarPath(effectiveLinkPath, 'PAX hardlink path');
  } else if (
    header.typeFlag === '2' &&
    (effectiveLinkPath.length === 0 ||
      effectiveLinkPath.includes('\\') ||
      /[\p{Cc}\p{Cf}]/u.test(effectiveLinkPath) ||
      posix.normalize(effectiveLinkPath) !== effectiveLinkPath)
  ) {
    throw new Error(
      `Release image layer contains an unsafe PAX symlink target: ${effectiveLinkPath}`,
    );
  }
  const encodedSize = paxText(pax, 'size');
  if (encodedSize === undefined) {
    return header.size;
  }
  if (
    header.typeFlag !== '\0' &&
    header.typeFlag !== '0' &&
    header.typeFlag !== '7'
  ) {
    throw new Error(
      'Release image layer has PAX size metadata for a non-regular entry',
    );
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(encodedSize)) {
    throw new Error('Release image layer has an invalid PAX entry size');
  }
  const size = Number(encodedSize);
  if (!Number.isSafeInteger(size) || size > maximumLayerEntrySize) {
    throw new Error('Release image layer has an unsafe PAX entry size');
  }
  return size;
}

function assertZeroTarPadding(source) {
  if (source.some((value) => value !== 0)) {
    throw new Error('Release image layer contains non-zero tar padding');
  }
}

function createLayerTarValidator() {
  let buffered = Buffer.alloc(0);
  let paddingBytes = 0;
  let paxPayloadChunks;
  let paxPayloadSize = 0;
  let pendingPax;
  let payloadBytes = 0;
  let zeroBlocks = 0;
  return new Transform({
    flush(callback) {
      if (pendingPax !== undefined) {
        callback(
          new Error(
            'Release image layer has a PAX header without a following entry',
          ),
        );
        return;
      }
      if (
        payloadBytes !== 0 ||
        paddingBytes !== 0 ||
        paxPayloadChunks !== undefined ||
        buffered.length !== 0 ||
        zeroBlocks < 2
      ) {
        callback(
          new Error('Release image layer is not a complete tar archive'),
        );
        return;
      }
      callback();
    },
    transform(chunk, _encoding, callback) {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length > 0) {
          if (payloadBytes > 0) {
            const consumed = Math.min(payloadBytes, buffered.length);
            if (paxPayloadChunks !== undefined) {
              paxPayloadChunks.push(buffered.subarray(0, consumed));
            }
            buffered = buffered.subarray(consumed);
            payloadBytes -= consumed;
            if (payloadBytes === 0 && paxPayloadChunks !== undefined) {
              pendingPax = parseLayerPaxHeader(
                Buffer.concat(paxPayloadChunks, paxPayloadSize),
              );
              paxPayloadChunks = undefined;
              paxPayloadSize = 0;
            }
            continue;
          }
          if (paddingBytes > 0) {
            const consumed = Math.min(paddingBytes, buffered.length);
            assertZeroTarPadding(buffered.subarray(0, consumed));
            buffered = buffered.subarray(consumed);
            paddingBytes -= consumed;
            continue;
          }
          if (buffered.length < tarBlockSize) {
            break;
          }
          const block = buffered.subarray(0, tarBlockSize);
          buffered = buffered.subarray(tarBlockSize);
          if (block.every((value) => value === 0)) {
            zeroBlocks += 1;
            continue;
          }
          if (zeroBlocks > 0) {
            throw new Error(
              'Release image layer contains data after its tar end marker',
            );
          }
          const header = inspectLayerTarHeader(block);
          if (header.typeFlag === 'x') {
            if (pendingPax !== undefined) {
              throw new Error(
                'Release image layer contains consecutive PAX headers',
              );
            }
            if (header.size === 0 || header.size > maximumLayerPaxSize) {
              throw new Error(
                'Release image layer has an unsafe PAX header size',
              );
            }
            paxPayloadChunks = [];
            paxPayloadSize = header.size;
            payloadBytes = header.size;
            paddingBytes =
              (tarBlockSize - (header.size % tarBlockSize)) % tarBlockSize;
            continue;
          }
          const size = layerEntrySize(header, pendingPax);
          pendingPax = undefined;
          payloadBytes = size;
          paddingBytes = (tarBlockSize - (size % tarBlockSize)) % tarBlockSize;
        }
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
}

export async function* readArchiveRange(handle, start, size, label) {
  const end = start + size;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(end)
  ) {
    throw new Error(`${label} has an unsafe byte range`);
  }

  let position = start;
  while (position < end) {
    const requested = Math.min(archiveReadChunkSize, end - position);
    const buffer = Buffer.allocUnsafe(requested);
    let readResult;
    try {
      readResult = await handle.read(buffer, 0, requested, position);
    } catch (error) {
      // Readable.from treats null/undefined rejections as clean stream closes.
      throw new ArchiveRangeReadError(failureMessage(error), { cause: error });
    }
    const { bytesRead } = readResult;
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead <= 0 ||
      bytesRead > requested
    ) {
      throw new Error(`${label} is truncated`);
    }
    position += bytesRead;
    yield bytesRead === requested ? buffer : buffer.subarray(0, bytesRead);
  }
}

async function hashArchiveLayer(handle, entry, compression, label) {
  const rawHash = createHash('sha256');
  const unpackedHash = createHash('sha256');
  const source = Readable.from(
    readArchiveRange(handle, entry.payloadOffset, entry.size, label),
    {
      highWaterMark: archiveReadChunkSize,
      objectMode: false,
    },
  );
  const rawHasher = new Transform({
    transform(chunk, _encoding, callback) {
      rawHash.update(chunk);
      callback(null, chunk);
    },
  });
  const unpackedHasher = new Writable({
    write(chunk, _encoding, callback) {
      unpackedHash.update(chunk);
      callback();
    },
  });
  let pipelineFailed = false;
  let pipelineError;
  try {
    await pipeline(
      source,
      rawHasher,
      ...(compression === 'gzip' ? [createGunzip()] : []),
      createLayerTarValidator(),
      unpackedHasher,
    );
  } catch (error) {
    pipelineFailed = true;
    pipelineError = error;
  }
  if (pipelineFailed) {
    const cause =
      pipelineError instanceof ArchiveRangeReadError
        ? pipelineError.cause
        : pipelineError;
    throw new Error(
      `${label} is unreadable or corrupt: ${failureMessage(cause)}`,
      { cause },
    );
  }
  return {
    raw: rawHash.digest('hex'),
    unpacked: unpackedHash.digest('hex'),
  };
}

async function verifyArchiveLayer(handle, entries, layerFile, label) {
  const location = archiveLayerLocation(layerFile);
  const entry = entries.get(layerFile);
  if (entry === undefined || !entry.regularFile || entry.size === 0) {
    throw new Error(`${label} is missing, empty, or is not a regular file`);
  }
  const compression = archiveLayerCompression(
    await archiveMemberPrefix(handle, entry, 6),
  );
  if (
    compression === 'unsupported' ||
    (location.legacy && compression !== 'identity')
  ) {
    throw new Error(`${label} uses an unsupported compression format`);
  }
  const hashes = await hashArchiveLayer(handle, entry, compression, label);
  if (location.blobHash !== undefined && hashes.raw !== location.blobHash) {
    throw new Error(`${label} does not match its blob SHA-256`);
  }
  return hashes.unpacked;
}

async function inspectReleaseArchive(
  service,
  archive,
  provenance,
  openArchive = open,
) {
  const archiveMetadata = await lstat(archive);
  if (archiveMetadata.isSymbolicLink() || !archiveMetadata.isFile()) {
    throw new Error(`${service} release archive must be a regular file`);
  }
  const handle = await openArchive(archive, 'r');
  let verificationFailed = false;
  let failure;
  let result;
  try {
    const entries = await indexReleaseArchive(handle);
    const reference = releaseImageReference(service, provenance.BUILD_VERSION);
    const archiveManifest = parseArchiveJson(
      (
        await readArchiveMember(
          handle,
          entries,
          'manifest.json',
          `${service} release archive manifest`,
        )
      ).toString('utf8'),
      `${service} release archive manifest`,
    );
    if (!Array.isArray(archiveManifest) || archiveManifest.length !== 1) {
      throw new Error(
        `${service} release archive must contain exactly one image manifest`,
      );
    }
    const [manifestEntry] = archiveManifest;
    if (
      manifestEntry === null ||
      typeof manifestEntry !== 'object' ||
      Array.isArray(manifestEntry)
    ) {
      throw new Error(`${service} release archive manifest entry is invalid`);
    }
    if (
      !Array.isArray(manifestEntry.RepoTags) ||
      manifestEntry.RepoTags.length !== 1 ||
      manifestEntry.RepoTags[0] !== reference
    ) {
      throw new Error(
        `${service} release archive must contain only the expected image reference`,
      );
    }
    const configFile = manifestEntry.Config;
    const expectedConfigHash =
      typeof configFile === 'string'
        ? archiveConfigHash(configFile)
        : undefined;
    if (expectedConfigHash === undefined) {
      throw new Error(`${service} release archive config filename is invalid`);
    }
    const archiveLayers = manifestEntry.Layers;
    if (
      !Array.isArray(archiveLayers) ||
      archiveLayers.length === 0 ||
      archiveLayers.some(
        (layer) => typeof layer !== 'string' || layer.length === 0,
      )
    ) {
      throw new Error(`${service} release archive layer list is invalid`);
    }

    const configSource = await readArchiveMember(
      handle,
      entries,
      configFile,
      `${service} release archive config`,
    );
    const configHash = createHash('sha256').update(configSource).digest('hex');
    if (expectedConfigHash !== configHash) {
      throw new Error(
        `${service} release archive config filename does not match its SHA-256`,
      );
    }
    const config = parseArchiveJson(
      configSource.toString('utf8'),
      `${service} release archive config`,
    );
    const image = {
      architecture: config?.architecture,
      id: `sha256:${configHash}`,
      labels: config?.config?.Labels ?? {},
      os: config?.os,
    };
    const issues = validateImageProvenance(image, provenance, {
      expectedArchitecture: releasePlatform.architecture,
    });
    if (issues.length > 0) {
      throw new Error(
        `${service} release image provenance is invalid: ${issues.join('; ')}`,
      );
    }
    const rootfsLayers = config?.rootfs?.diff_ids;
    if (
      config?.rootfs?.type !== 'layers' ||
      !Array.isArray(rootfsLayers) ||
      rootfsLayers.length === 0 ||
      rootfsLayers.some(
        (layer) =>
          typeof layer !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(layer),
      )
    ) {
      throw new Error(`${service} release image rootfs layers are invalid`);
    }
    if (archiveLayers.length !== rootfsLayers.length) {
      throw new Error(
        `${service} release archive layer count does not match the image config`,
      );
    }
    const verifiedLayers = new Map();
    for (const [index, layerFile] of archiveLayers.entries()) {
      let unpackedHash = verifiedLayers.get(layerFile);
      if (unpackedHash === undefined) {
        unpackedHash = await verifyArchiveLayer(
          handle,
          entries,
          layerFile,
          `${service} release archive layer ${index + 1}`,
        );
        verifiedLayers.set(layerFile, unpackedHash);
      }
      if (rootfsLayers[index] !== `sha256:${unpackedHash}`) {
        throw new Error(
          `${service} release archive layer ${index + 1} does not match its rootfs diff ID`,
        );
      }
    }
    result = {
      architecture: image.architecture,
      imageId: image.id,
      imageReference: reference,
      rootfsLayers,
    };
  } catch (error) {
    verificationFailed = true;
    failure = error;
  }
  let cleanupFailed = false;
  let cleanupError;
  try {
    await handle.close();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (verificationFailed) {
    if (cleanupFailed) {
      throw new AggregateError(
        [failure, cleanupError],
        `${service} release archive verification and file cleanup failed`,
        { cause: failure },
      );
    }
    throw failure;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  return result;
}

export async function buildImageTwice(
  service,
  outputDirectory,
  provenance,
  execute,
  environment,
  sourceRoot = repositoryRoot,
  openArchive = open,
) {
  const definition = releaseImageDefinitions[service];
  const primary = resolve(outputDirectory, `.${service}.primary.tar`);
  const secondary = resolve(outputDirectory, `.${service}.secondary.tar`);
  const finalArchive = resolve(outputDirectory, definition.archive);
  const inspections = [];

  for (const [round, archive] of [primary, secondary].entries()) {
    execute(
      'docker',
      buildxArguments(service, archive, provenance, sourceRoot),
      {
        cwd: sourceRoot,
        env: environment,
        label: `${service} release build ${round + 1}`,
        stdio: 'inherit',
      },
    );
    inspections.push(
      await inspectReleaseArchive(service, archive, provenance, openArchive),
    );
  }

  if (
    inspections[0].imageId !== inspections[1].imageId ||
    !sameLayers(inspections[0].rootfsLayers, inspections[1].rootfsLayers)
  ) {
    throw new Error(
      `${service} two clean release builds produced different images`,
    );
  }

  const primaryHash = await sha256File(primary);
  const secondaryHash = await sha256File(secondary);
  if (primaryHash !== secondaryHash) {
    throw new Error(
      `${service} two clean release builds produced different archives`,
    );
  }
  const primaryMetadata = await stat(primary);
  await rename(primary, finalArchive);
  await chmod(finalArchive, 0o600);
  await rm(secondary, { force: true });

  return {
    archive: definition.archive,
    sha256: primaryHash,
    size: primaryMetadata.size,
    imageId: inspections[0].imageId,
    reference: inspections[0].imageReference,
    rootfsLayers: inspections[0].rootfsLayers,
    secondaryArchiveSha256: secondaryHash,
  };
}

async function sourceFileHashes(sourceRoot) {
  return Object.fromEntries(
    await Promise.all(
      releaseSourceFiles.map(async (file) => [
        file,
        await sha256File(resolve(sourceRoot, file)),
      ]),
    ),
  );
}

function assertStableReleaseProvenance(initial, final) {
  const changedFields = releaseProvenanceFields.filter(
    (field) => initial[field] !== final[field],
  );
  if (changedFields.length > 0) {
    throw new Error(
      `Release provenance changed during build: ${changedFields.join(', ')}`,
    );
  }
}

export async function createReleaseSourceSnapshot(
  provenance,
  { execute = run, removeWorkspace = rm, temporaryRoot = tmpdir() } = {},
) {
  const workspace = await mkdtemp(resolve(temporaryRoot, 'wo-release-source-'));
  try {
    await chmod(workspace, 0o700);
    const archive = resolve(workspace, 'source.tar');
    const sourceRoot = resolve(workspace, 'source');
    await mkdir(sourceRoot, { mode: 0o700 });
    const environment = deploymentProcessEnvironment({}, process.env);
    execute(
      'git',
      [
        'archive',
        '--format=tar',
        '--output',
        archive,
        provenance.BUILD_REVISION,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        label: 'release source snapshot',
      },
    );
    execute('tar', ['-xf', archive, '-C', sourceRoot], {
      env: environment,
      label: 'release source snapshot extraction',
    });
    await rm(archive, { force: true });
    let cleaned = false;
    return {
      root: sourceRoot,
      cleanup: async () => {
        if (!cleaned) {
          await removeWorkspace(workspace, { force: true, recursive: true });
          cleaned = true;
        }
      },
    };
  } catch (error) {
    let cleanupFailed = false;
    let cleanupError;
    try {
      await removeWorkspace(workspace, { force: true, recursive: true });
    } catch (failure) {
      cleanupFailed = true;
      cleanupError = failure;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        [error, cleanupError],
        'Release source snapshot failed and cleanup was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
}

async function assertOutputDirectoryAbsent(directory) {
  try {
    await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Release output directory already exists: ${directory}`);
}

async function acquireReleaseOutputLock(directory) {
  const lockDirectory = resolve(
    dirname(directory),
    `.${basename(directory)}.release.lock`,
  );
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `Release build already in progress for output directory: ${directory}`,
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) {
      await rmdir(lockDirectory);
      released = true;
    }
  };
}

export async function buildReleaseBundle({
  deriveProvenance = deriveReleaseProvenance,
  execute = run,
  imageBuilder = buildImageTwice,
  outputDirectory,
  sourceSnapshot = createReleaseSourceSnapshot,
  verifyBundle = readAndVerifyReleaseBundle,
} = {}) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new Error('--output-dir is required');
  }
  const directory = resolve(outputDirectory);
  const releaseOutputLock = await acquireReleaseOutputLock(directory);
  let buildFailed = false;
  let failure;
  let result;
  let snapshot;
  let snapshotOpen = false;
  let stagingDirectory;
  try {
    await assertOutputDirectoryAbsent(directory);
    const provenance = deriveProvenance();
    const environment = deploymentProcessEnvironment({}, process.env);
    snapshot = await sourceSnapshot(provenance, { execute });
    snapshotOpen = true;
    stagingDirectory = await mkdtemp(
      resolve(dirname(directory), `.${basename(directory)}.release-partial-`),
    );
    await chmod(stagingDirectory, 0o700);
    const images = {};
    for (const service of releaseServices) {
      images[service] = await imageBuilder(
        service,
        stagingDirectory,
        provenance,
        execute,
        environment,
        snapshot.root,
      );
    }
    const sourceFiles = await sourceFileHashes(snapshot.root);
    const finalProvenance = deriveProvenance();
    assertStableReleaseProvenance(provenance, finalProvenance);
    const manifest = assertReleaseManifest({
      schemaVersion: 1,
      provenance,
      platform: releasePlatform,
      sourceFiles,
      images,
    });
    const manifestFile = resolve(stagingDirectory, releaseManifestName);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const manifestHash = await sha256File(manifestFile);
    await writeFile(
      resolve(stagingDirectory, releaseManifestChecksumName),
      `${manifestHash}  ${releaseManifestName}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await verifyBundle(manifestFile, {
      expectedManifestSha256: manifestHash,
      root: snapshot.root,
    });
    await snapshot.cleanup();
    snapshotOpen = false;
    await assertOutputDirectoryAbsent(directory);
    await rename(stagingDirectory, directory);
    stagingDirectory = undefined;
    result = { directory, manifest, manifestHash, provenance };
  } catch (error) {
    buildFailed = true;
    const cleanupErrors = [];
    if (stagingDirectory !== undefined) {
      try {
        await rm(stagingDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (snapshotOpen && snapshot !== undefined) {
      try {
        await snapshot.cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      failure = new AggregateError(
        [error, ...cleanupErrors],
        'Release build failed and cleanup was incomplete',
        { cause: error },
      );
    } else {
      failure = error;
    }
  }

  let lockCleanupFailed = false;
  let lockCleanupError;
  try {
    await releaseOutputLock();
  } catch (error) {
    lockCleanupFailed = true;
    lockCleanupError = error;
  }
  if (lockCleanupFailed) {
    if (buildFailed) {
      throw new AggregateError(
        [failure, lockCleanupError],
        'Release build failed and output lock cleanup was incomplete',
        { cause: failure },
      );
    }
    throw new AggregateError(
      [lockCleanupError],
      'Release bundle was created but output lock cleanup was incomplete',
      { cause: lockCleanupError },
    );
  }
  if (buildFailed) {
    throw failure;
  }
  process.stdout.write(
    `RELEASE_BUNDLE_CREATED version=${result.provenance.BUILD_VERSION} revision=${result.provenance.BUILD_REVISION} images=${releaseServices.length} platform=linux/amd64 manifest_sha256=${result.manifestHash}\n`,
  );
  return { directory: result.directory, manifest: result.manifest };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  buildReleaseBundle({
    outputDirectory: argumentValue('--output-dir'),
  }).catch((error) => {
    process.stderr.write(`Release build failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
