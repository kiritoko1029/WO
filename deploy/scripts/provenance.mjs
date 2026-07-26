import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const revisionPattern = /^[a-f0-9]{40}$/u;
const sourceUrl = 'https://github.com/kiritoko1029/WO';
const integrationProvenanceValues = Object.freeze({
  BUILD_CREATED: '1970-01-01T00:00:01Z',
  BUILD_REVISION: '0000000000000000000000000000000000000000',
  BUILD_VERSION: 'integration',
  SOURCE_DATE_EPOCH: '1',
});

export const releaseProvenanceFields = Object.freeze([
  'BUILD_CREATED',
  'BUILD_REVISION',
  'BUILD_VERSION',
  'SOURCE_DATE_EPOCH',
]);

function normalizedCreated(epoch) {
  const milliseconds = Number(epoch) * 1_000;
  if (
    !/^[0-9]+$/u.test(epoch) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0
  ) {
    throw new Error('Git commit timestamp is invalid');
  }
  try {
    return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
  } catch {
    throw new Error('Git commit timestamp is invalid');
  }
}

function versionFor(created, revision) {
  return `${created.slice(0, 10).replaceAll('-', '.')}-${revision.slice(0, 12)}`;
}

export function validateReleaseProvenance(
  provenance,
  { production = true } = {},
) {
  const issues = [];
  for (const field of releaseProvenanceFields) {
    if (
      typeof provenance?.[field] !== 'string' ||
      provenance[field].length === 0
    ) {
      issues.push(`${field} is required`);
    }
  }
  if (!revisionPattern.test(provenance?.BUILD_REVISION ?? '')) {
    issues.push('BUILD_REVISION must be a full 40-character Git SHA');
  } else if (production && /^0{40}$/u.test(provenance.BUILD_REVISION)) {
    issues.push('BUILD_REVISION cannot be the integration sentinel');
  }
  let expectedCreated;
  try {
    expectedCreated = normalizedCreated(provenance?.SOURCE_DATE_EPOCH ?? '');
  } catch (error) {
    issues.push(error.message);
  }
  if (
    expectedCreated !== undefined &&
    provenance?.BUILD_CREATED !== expectedCreated
  ) {
    issues.push('BUILD_CREATED must equal the Git commit timestamp in UTC');
  }
  const buildVersion =
    typeof provenance?.BUILD_VERSION === 'string'
      ? provenance.BUILD_VERSION
      : undefined;
  if (buildVersion?.trim().length === 0) {
    issues.push('BUILD_VERSION is required');
  } else if (
    production &&
    /^(?:dev|integration|unknown)$/iu.test(buildVersion ?? '')
  ) {
    issues.push('BUILD_VERSION cannot be empty, dev, or unknown');
  } else if (
    production &&
    expectedCreated !== undefined &&
    revisionPattern.test(provenance.BUILD_REVISION) &&
    buildVersion !== versionFor(expectedCreated, provenance.BUILD_REVISION)
  ) {
    issues.push('BUILD_VERSION must be derived from the commit date and SHA');
  }
  if (!production) {
    for (const field of releaseProvenanceFields) {
      if (provenance?.[field] !== integrationProvenanceValues[field]) {
        issues.push(`${field} must use the fixed integration release sentinel`);
      }
    }
  }
  return issues;
}

export function releaseProvenanceFromGitMetadata({
  commitEpoch,
  revision,
  status,
}) {
  if (status.trim().length > 0) {
    throw new Error('Production release requires a clean Git worktree');
  }
  const provenance = Object.freeze({
    BUILD_CREATED: normalizedCreated(commitEpoch.trim()),
    BUILD_REVISION: revision.trim(),
    BUILD_VERSION: '',
    SOURCE_DATE_EPOCH: commitEpoch.trim(),
  });
  const completed = Object.freeze({
    ...provenance,
    BUILD_VERSION: versionFor(
      provenance.BUILD_CREATED,
      provenance.BUILD_REVISION,
    ),
  });
  const issues = validateReleaseProvenance(completed);
  if (issues.length > 0) {
    throw new Error(`Release provenance is invalid: ${issues.join('; ')}`);
  }
  return completed;
}

function runGit(arguments_, root) {
  const result = spawnSync('git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Git provenance command failed: ${arguments_.join(' ')}`);
  }
  return result.stdout.trimEnd();
}

export function deriveReleaseProvenance({
  gitRunner = runGit,
  root = repositoryRoot,
} = {}) {
  return releaseProvenanceFromGitMetadata({
    commitEpoch: gitRunner(['show', '-s', '--format=%ct', 'HEAD'], root),
    revision: gitRunner(['rev-parse', 'HEAD'], root),
    status: gitRunner(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      root,
    ),
  });
}

export const integrationReleaseProvenance = integrationProvenanceValues;

function assertReleaseProvenance(provenance) {
  const issues = validateReleaseProvenance(provenance, {
    production: provenance?.BUILD_VERSION !== 'integration',
  });
  if (issues.length > 0) {
    throw new Error(`Release provenance is invalid: ${issues.join('; ')}`);
  }
}

export function releaseBuildArguments(provenance) {
  assertReleaseProvenance(provenance);
  return releaseProvenanceFields.flatMap((field) => [
    '--build-arg',
    `${field}=${provenance[field]}`,
  ]);
}

export function releaseProvenanceEnvironment(provenance) {
  assertReleaseProvenance(provenance);
  return Object.fromEntries(
    releaseProvenanceFields.map((field) => [field, provenance[field]]),
  );
}

export function expectedOciLabels(provenance) {
  return {
    'org.opencontainers.image.created': provenance.BUILD_CREATED,
    'org.opencontainers.image.revision': provenance.BUILD_REVISION,
    'org.opencontainers.image.source': sourceUrl,
    'org.opencontainers.image.version': provenance.BUILD_VERSION,
  };
}

export function validateImageProvenance(
  image,
  provenance,
  { expectedArchitecture } = {},
) {
  const issues = [];
  if (!/^sha256:[a-f0-9]{64}$/u.test(image?.id ?? '')) {
    issues.push('Image ID is not an immutable SHA-256 identifier');
  }
  if (image?.os !== 'linux') {
    issues.push('Image OS must be linux');
  }
  if (
    typeof expectedArchitecture === 'string' &&
    image?.architecture !== expectedArchitecture
  ) {
    issues.push(
      `Image architecture ${image?.architecture ?? 'unknown'} does not match Docker host ${expectedArchitecture}`,
    );
  }
  for (const [label, expected] of Object.entries(
    expectedOciLabels(provenance),
  )) {
    if (image?.labels?.[label] !== expected) {
      issues.push(`Image label ${label} does not match release provenance`);
    }
  }
  return issues;
}
