import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

import { semverAtLeast } from './lib.mjs';
import { deploymentProcessEnvironment, run, sha256File } from './ops.mjs';
import {
  validateImageProvenance,
  validateReleaseProvenance,
} from './provenance.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const sha256Pattern = /^[a-f0-9]{64}$/u;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const minimumDockerVersion = '26.0.0';

export const releaseManifestName = 'release-manifest.json';
export const releaseManifestChecksumName = 'release-manifest.sha256';
export const releasePlatform = Object.freeze({
  architecture: 'amd64',
  os: 'linux',
});
export const releaseServices = Object.freeze(['caddy', 'server', 'coturn']);
export const releaseSourceFiles = Object.freeze([
  'deploy/compose.yaml',
  'deploy/compose.turn-host.yaml',
  'deploy/scripts/apply-release.mjs',
  'deploy/scripts/backup.mjs',
  'deploy/scripts/build-release.mjs',
  'deploy/scripts/compose.mjs',
  'deploy/scripts/external-db-upgrade.mjs',
  'deploy/scripts/lib.mjs',
  'deploy/scripts/monitor.mjs',
  'deploy/scripts/ops.mjs',
  'deploy/scripts/preflight.mjs',
  'deploy/scripts/provenance.mjs',
  'deploy/scripts/release.mjs',
  'deploy/scripts/restore.mjs',
  'deploy/scripts/runtime-compose-override.mjs',
  'deploy/scripts/smoke.mjs',
  'deploy/scripts/upgrade.mjs',
  'deploy/scripts/validate-build-metadata.sh',
  'docker-compose.yml',
  'docker-compose.external-db.yml',
]);
export const releaseImageDefinitions = Object.freeze({
  caddy: Object.freeze({
    archive: 'caddy.docker.tar',
    dockerfile: 'deploy/caddy/Dockerfile',
    repository: 'wo-caddy',
  }),
  server: Object.freeze({
    archive: 'server.docker.tar',
    dockerfile: 'apps/server/Dockerfile',
    repository: 'wo-server',
  }),
  coturn: Object.freeze({
    archive: 'coturn.docker.tar',
    dockerfile: 'deploy/coturn/Dockerfile',
    repository: 'wo-coturn',
  }),
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateExactKeys(value, expected, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    issues.push(`${label} has unexpected or missing fields`);
    return false;
  }
  return true;
}

export function releaseImageReference(service, version) {
  const definition = releaseImageDefinitions[service];
  if (definition === undefined) {
    throw new Error(`Unknown release service: ${service}`);
  }
  return `${definition.repository}:${version}`;
}

export function validateReleaseManifest(manifest) {
  const issues = [];
  if (
    !validateExactKeys(
      manifest,
      ['schemaVersion', 'provenance', 'platform', 'sourceFiles', 'images'],
      'Release manifest',
      issues,
    )
  ) {
    return issues;
  }
  if (manifest.schemaVersion !== 1) {
    issues.push('Release manifest schemaVersion must be 1');
  }
  if (
    validateExactKeys(
      manifest.provenance,
      ['BUILD_CREATED', 'BUILD_REVISION', 'BUILD_VERSION', 'SOURCE_DATE_EPOCH'],
      'Release provenance',
      issues,
    )
  ) {
    issues.push(...validateReleaseProvenance(manifest.provenance));
  }
  if (
    validateExactKeys(
      manifest.platform,
      ['architecture', 'os'],
      'Release platform',
      issues,
    ) &&
    (manifest.platform.architecture !== releasePlatform.architecture ||
      manifest.platform.os !== releasePlatform.os)
  ) {
    issues.push('Release platform must be linux/amd64');
  }
  if (
    validateExactKeys(
      manifest.sourceFiles,
      releaseSourceFiles,
      'Release sourceFiles',
      issues,
    )
  ) {
    for (const file of releaseSourceFiles) {
      const sourceHash = manifest.sourceFiles[file];
      if (typeof sourceHash !== 'string' || !sha256Pattern.test(sourceHash)) {
        issues.push(`Release source hash is invalid: ${file}`);
      }
    }
  }
  if (
    validateExactKeys(
      manifest.images,
      releaseServices,
      'Release images',
      issues,
    )
  ) {
    for (const service of releaseServices) {
      const image = manifest.images[service];
      if (
        !validateExactKeys(
          image,
          [
            'archive',
            'sha256',
            'size',
            'imageId',
            'reference',
            'rootfsLayers',
            'secondaryArchiveSha256',
          ],
          `${service} release image`,
          issues,
        )
      ) {
        continue;
      }
      if (image.archive !== releaseImageDefinitions[service].archive) {
        issues.push(`${service} release archive name is invalid`);
      }
      if (
        typeof image.sha256 !== 'string' ||
        !sha256Pattern.test(image.sha256)
      ) {
        issues.push(`${service} release archive SHA-256 is invalid`);
      }
      if (
        typeof image.secondaryArchiveSha256 !== 'string' ||
        !sha256Pattern.test(image.secondaryArchiveSha256)
      ) {
        issues.push(`${service} secondary archive SHA-256 is invalid`);
      }
      if (image.sha256 !== image.secondaryArchiveSha256) {
        issues.push(`${service} release archive SHA-256 values differ`);
      }
      if (!Number.isSafeInteger(image.size) || image.size <= 0) {
        issues.push(`${service} release archive size is invalid`);
      }
      if (
        typeof image.imageId !== 'string' ||
        !imageIdPattern.test(image.imageId)
      ) {
        issues.push(`${service} release image ID is invalid`);
      }
      if (
        image.reference !==
        releaseImageReference(service, manifest.provenance?.BUILD_VERSION)
      ) {
        issues.push(`${service} release image reference is invalid`);
      }
      if (
        !Array.isArray(image.rootfsLayers) ||
        image.rootfsLayers.length === 0 ||
        image.rootfsLayers.some(
          (layer) => typeof layer !== 'string' || !imageIdPattern.test(layer),
        )
      ) {
        issues.push(`${service} release rootfs layer list is invalid`);
      }
    }
    const imageIds = releaseServices.map(
      (service) => manifest.images[service]?.imageId,
    );
    if (new Set(imageIds).size !== imageIds.length) {
      issues.push('Release images must use unique image IDs');
    }
  }
  return issues;
}

export function assertReleaseManifest(manifest) {
  const issues = validateReleaseManifest(manifest);
  if (issues.length > 0) {
    throw new Error(`Release manifest is invalid: ${issues.join('; ')}`);
  }
  return manifest;
}

async function assertRegularFile(file, label) {
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file without symbolic links`);
  }
  return metadata;
}

function assertInsideDirectory(directory, file, label) {
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  if (!file.startsWith(prefix)) {
    throw new Error(`${label} resolves outside the release directory`);
  }
}

function parseManifestChecksum(source) {
  const match = /^([a-f0-9]{64}) {2}release-manifest\.json\n?$/u.exec(source);
  if (match === null) {
    throw new Error('Release manifest checksum file is invalid');
  }
  return match[1];
}

export async function readAndVerifyReleaseBundle(
  manifestFile,
  { expectedManifestSha256, root = repositoryRoot } = {},
) {
  const resolvedManifest = resolve(manifestFile);
  if (basename(resolvedManifest) !== releaseManifestName) {
    throw new Error(`Release manifest must be named ${releaseManifestName}`);
  }
  await assertRegularFile(resolvedManifest, 'Release manifest');
  const bundleDirectory = await realpath(dirname(resolvedManifest));
  const canonicalManifest = await realpath(resolvedManifest);
  assertInsideDirectory(bundleDirectory, canonicalManifest, 'Release manifest');
  const checksumFile = resolve(bundleDirectory, releaseManifestChecksumName);
  await assertRegularFile(checksumFile, 'Release manifest checksum');
  const expectedManifestHash = parseManifestChecksum(
    await readFile(checksumFile, 'utf8'),
  );
  const actualManifestHash = await sha256File(canonicalManifest);
  if (actualManifestHash !== expectedManifestHash) {
    throw new Error('Release manifest checksum mismatch');
  }
  if (expectedManifestSha256 !== undefined) {
    if (!sha256Pattern.test(expectedManifestSha256)) {
      throw new Error('Expected release manifest SHA-256 is invalid');
    }
    if (actualManifestHash !== expectedManifestSha256) {
      throw new Error('Release manifest does not match the expected SHA-256');
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, 'utf8'));
  } catch {
    throw new Error('Release manifest is not valid JSON');
  }
  assertReleaseManifest(manifest);

  for (const file of releaseSourceFiles) {
    const sourceFile = resolve(root, file);
    await assertRegularFile(sourceFile, `Release-bound source file ${file}`);
    if ((await sha256File(sourceFile)) !== manifest.sourceFiles[file]) {
      throw new Error(`Release-bound source file checksum mismatch: ${file}`);
    }
  }

  for (const service of releaseServices) {
    const image = manifest.images[service];
    const archive = resolve(bundleDirectory, image.archive);
    await assertRegularFile(archive, `${service} release archive`);
    const canonicalArchive = await realpath(archive);
    assertInsideDirectory(
      bundleDirectory,
      canonicalArchive,
      `${service} release archive`,
    );
    const metadata = await lstat(canonicalArchive);
    if (metadata.size !== image.size) {
      throw new Error(`${service} release archive size mismatch`);
    }
    if ((await sha256File(canonicalArchive)) !== image.sha256) {
      throw new Error(`${service} release archive checksum mismatch`);
    }
  }
  return { directory: bundleDirectory, manifest };
}

function parsedImageInspection(source, label) {
  let inspections;
  try {
    inspections = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid Docker inspection JSON`);
  }
  if (!Array.isArray(inspections) || inspections.length !== 1) {
    throw new Error(`${label} is incomplete`);
  }
  return inspections[0];
}

export function inspectReleaseImage(
  service,
  reference,
  provenance,
  {
    execute = run,
    expected = undefined,
    expectedArchitecture = releasePlatform.architecture,
    environment = deploymentProcessEnvironment({}, process.env),
  } = {},
) {
  const inspection = parsedImageInspection(
    execute('docker', ['image', 'inspect', reference], {
      env: environment,
      label: `${service} release image inspection`,
    }),
    `${service} release image inspection`,
  );
  const image = {
    architecture: inspection.Architecture,
    id: inspection.Id,
    labels: inspection.Config?.Labels ?? {},
    os: inspection.Os,
  };
  const issues = validateImageProvenance(image, provenance, {
    expectedArchitecture,
  });
  if (issues.length > 0) {
    throw new Error(
      `${service} release image provenance is invalid: ${issues.join('; ')}`,
    );
  }
  const rootfsLayers = inspection.RootFS?.Layers;
  if (
    !Array.isArray(rootfsLayers) ||
    rootfsLayers.length === 0 ||
    rootfsLayers.some(
      (layer) => typeof layer !== 'string' || !imageIdPattern.test(layer),
    )
  ) {
    throw new Error(`${service} release image rootfs layers are invalid`);
  }
  if (
    expected !== undefined &&
    (image.id !== expected.imageId ||
      reference !== expected.reference ||
      rootfsLayers.length !== expected.rootfsLayers.length ||
      rootfsLayers.some(
        (layer, index) => layer !== expected.rootfsLayers[index],
      ))
  ) {
    throw new Error(
      `${service} loaded image differs from the release manifest`,
    );
  }
  return {
    architecture: image.architecture,
    imageId: image.id,
    imageReference: reference,
    rootfsLayers,
  };
}

function dockerServer(source) {
  let server;
  try {
    server = JSON.parse(source);
  } catch {
    throw new Error('Docker server information is invalid');
  }
  if (
    !isRecord(server) ||
    typeof server.Version !== 'string' ||
    server.Os !== releasePlatform.os ||
    server.Arch !== releasePlatform.architecture
  ) {
    throw new Error('Release apply requires a linux/amd64 Docker server');
  }
  if (!semverAtLeast(server.Version, minimumDockerVersion)) {
    throw new Error(
      `Docker Engine ${minimumDockerVersion} or newer is required`,
    );
  }
  return server;
}

function sha256FileHandle(handle) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream('', {
      autoClose: false,
      fd: handle.fd,
      start: 0,
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

function sameFileMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function loadVerifiedArchive(archive, expected, service, environment) {
  const handle = await open(archive, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.size)) {
      throw new Error(`${service} release archive changed before load`);
    }
    if ((await sha256FileHandle(handle)) !== expected.sha256) {
      throw new Error(`${service} release archive changed before load`);
    }
    const result = spawnSync('docker', ['image', 'load'], {
      encoding: 'utf8',
      env: environment,
      stdio: [handle.fd, 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      const detail =
        typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(
        `${service} release archive load failed${detail.length > 0 ? `: ${detail}` : ''}`,
      );
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileMetadata(before, after)) {
      throw new Error(`${service} release archive changed during load`);
    }
  } finally {
    await handle.close();
  }
}

export async function loadAndVerifyReleaseBundle(
  manifestFile,
  {
    archiveLoader = loadVerifiedArchive,
    execute = run,
    expectedManifestSha256,
    root = repositoryRoot,
    shellEnvironment = process.env,
  } = {},
) {
  const bundle = await readAndVerifyReleaseBundle(manifestFile, {
    expectedManifestSha256,
    root,
  });
  const environment = deploymentProcessEnvironment({}, shellEnvironment);
  dockerServer(
    execute('docker', ['version', '--format', '{{json .Server}}'], {
      env: environment,
      label: 'Docker server inspection',
    }),
  );
  const images = {};
  for (const service of releaseServices) {
    const expected = bundle.manifest.images[service];
    await archiveLoader(
      resolve(bundle.directory, expected.archive),
      expected,
      service,
      environment,
    );
    images[service] = inspectReleaseImage(
      service,
      expected.reference,
      bundle.manifest.provenance,
      { environment, execute, expected },
    );
  }
  return { ...bundle, images };
}

export function releaseImageOverrideSource(
  images,
  selectedServices = releaseServices,
) {
  if (
    !Array.isArray(selectedServices) ||
    selectedServices.length === 0 ||
    new Set(selectedServices).size !== selectedServices.length ||
    selectedServices.some((service) => !releaseServices.includes(service))
  ) {
    throw new Error('Release image selection is invalid');
  }
  const lines = ['services:'];
  for (const service of selectedServices) {
    const imageId = images?.[service]?.imageId;
    if (!imageIdPattern.test(imageId ?? '')) {
      throw new Error(`${service} release image ID is not immutable`);
    }
    lines.push(
      `  ${service}:`,
      '    build: !reset null',
      `    image: ${imageId}`,
      '    pull_policy: never',
    );
  }
  return `${lines.join('\n')}\n`;
}
