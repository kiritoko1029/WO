import { notarize } from '@electron/notarize';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function environmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = value.trim();
  if (normalized.length > 2_048 || /[\0\r\n]/u.test(normalized)) {
    fail(`Notarization environment ${name} is invalid`);
  }
  return normalized;
}

function completeStrategy(values, label) {
  const present = values.filter((value) => value !== null).length;
  if (present !== 0 && present !== values.length) {
    fail(`${label} notarization credentials are incomplete`);
  }
  return present === values.length;
}

export function notarizationCredentials(environment = process.env) {
  const keychainProfile = environmentValue(
    environment,
    'APPLE_KEYCHAIN_PROFILE',
  );
  const keychain = environmentValue(environment, 'APPLE_KEYCHAIN');
  if (keychain !== null && keychainProfile === null) {
    fail('Keychain notarization credentials are incomplete');
  }

  const appleApiKey = environmentValue(environment, 'APPLE_API_KEY');
  const appleApiKeyId = environmentValue(environment, 'APPLE_API_KEY_ID');
  const appleApiIssuer = environmentValue(environment, 'APPLE_API_ISSUER');
  const appleId = environmentValue(environment, 'APPLE_ID');
  const appleIdPassword = environmentValue(
    environment,
    'APPLE_APP_SPECIFIC_PASSWORD',
  );
  const teamId = environmentValue(environment, 'APPLE_TEAM_ID');
  if (keychainProfile !== null) {
    if (
      [appleApiKey, appleApiKeyId, appleApiIssuer].every(
        (value) => value !== null,
      ) ||
      [appleId, appleIdPassword, teamId].every((value) => value !== null)
    ) {
      fail(
        'Exactly one complete Apple notarization credential strategy is required',
      );
    }
    return Object.freeze({
      keychainProfile,
      ...(keychain === null ? {} : { keychain }),
    });
  }

  const hasApiKey = completeStrategy(
    [appleApiKey, appleApiKeyId, appleApiIssuer],
    'App Store Connect API key',
  );
  const hasAppleId = completeStrategy(
    [appleId, appleIdPassword, teamId],
    'Apple ID',
  );
  const strategyCount = Number(hasApiKey) + Number(hasAppleId);
  if (strategyCount !== 1) {
    fail(
      'Exactly one complete Apple notarization credential strategy is required',
    );
  }
  if (hasApiKey) {
    if (
      !isAbsolute(appleApiKey) ||
      !/^[A-Z0-9]{10}$/u.test(appleApiKeyId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        appleApiIssuer,
      )
    ) {
      fail('App Store Connect API key notarization credentials are invalid');
    }
    return Object.freeze({ appleApiKey, appleApiKeyId, appleApiIssuer });
  }

  const expectedTeamId = environmentValue(environment, 'WO_MAC_TEAM_ID');
  if (
    !/^[A-Z0-9]{10}$/u.test(teamId) ||
    expectedTeamId === null ||
    teamId.toUpperCase() !== expectedTeamId.toUpperCase()
  ) {
    fail(
      'Apple ID notarization Team ID does not match the pinned release identity',
    );
  }
  return Object.freeze({ appleId, appleIdPassword, teamId });
}

function parseArguments(argumentsList) {
  if (
    argumentsList.length !== 1 ||
    !argumentsList[0].startsWith('--package-dir=')
  ) {
    fail('Expected exactly one --package-dir argument');
  }
  const packageDirectory = resolve(
    argumentsList[0].slice('--package-dir='.length),
  );
  return Object.freeze({ packageDirectory });
}

async function distributableDmgs(packageDirectory) {
  const root = await lstat(packageDirectory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) {
    fail('The macOS package directory is invalid');
  }
  const matches = [];
  const versions = new Set();
  for (const entry of await readdir(packageDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.name.toLocaleLowerCase('en-US').endsWith('.dmg')) continue;
    const match = /^WO-([0-9A-Za-z.+-]{1,64})-mac-(x64|arm64)\.dmg$/u.exec(
      entry.name,
    );
    if (match === null || match[1].includes('UNSIGNED-DEVELOPMENT')) {
      fail(`Unexpected macOS DMG artifact: ${entry.name}`);
    }
    const path = join(packageDirectory, entry.name);
    const stats = await lstat(path).catch(() => null);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !stats?.isFile() ||
      stats.size === 0
    ) {
      fail(`Invalid macOS DMG artifact: ${entry.name}`);
    }
    versions.add(match[1]);
    matches.push(Object.freeze({ path, architecture: match[2] }));
  }
  if (
    matches.length !== 2 ||
    versions.size !== 1 ||
    new Set(matches.map((artifact) => artifact.architecture)).size !== 2
  ) {
    fail('Expected exactly one x64 and one arm64 DMG for a single version');
  }
  return Object.freeze(
    [...matches].sort((left, right) =>
      left.architecture.localeCompare(right.architecture, 'en-US'),
    ),
  );
}

export async function notarizeDmgArtifacts(options, dependencies = {}) {
  const credentials = notarizationCredentials(
    dependencies.environment ?? process.env,
  );
  const notarizeArtifact = dependencies.notarizeArtifact ?? notarize;
  const artifacts = await distributableDmgs(resolve(options.packageDirectory));
  for (const artifact of artifacts) {
    await notarizeArtifact({ appPath: artifact.path, ...credentials });
  }
  return artifacts;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await notarizeDmgArtifacts(options);
  } catch (error) {
    console.error(
      `MAC_DMG_NOTARIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
