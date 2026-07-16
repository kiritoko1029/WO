import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notarizationCredentials,
  notarizeDmgArtifacts,
} from '../scripts/notarize-dmgs.mjs';

const temporaryDirectories: string[] = [];

async function packageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wo-notarize-dmg-'));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  for (const architecture of ['x64', 'arm64']) {
    await writeFile(
      join(directory, `WO-1.2.3-mac-${architecture}.dmg`),
      `signed-${architecture}`,
    );
  }
  await writeFile(join(directory, 'WO-1.2.3-mac-x64.zip'), 'zip');
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('final macOS DMG notarization', () => {
  it('submits and staples exactly one DMG for each architecture', async () => {
    const directory = await packageDirectory();
    const notarizeArtifact = vi.fn().mockResolvedValue(undefined);

    const artifacts = await notarizeDmgArtifacts(
      { packageDirectory: directory },
      {
        environment: { APPLE_KEYCHAIN_PROFILE: 'wo-notary' },
        notarizeArtifact,
      },
    );

    expect(artifacts.map((artifact) => artifact.architecture)).toEqual([
      'arm64',
      'x64',
    ]);
    expect(notarizeArtifact).toHaveBeenCalledTimes(2);
    expect(notarizeArtifact.mock.calls).toEqual(
      expect.arrayContaining([
        [
          {
            appPath: join(directory, 'WO-1.2.3-mac-x64.dmg'),
            keychainProfile: 'wo-notary',
          },
        ],
        [
          {
            appPath: join(directory, 'WO-1.2.3-mac-arm64.dmg'),
            keychainProfile: 'wo-notary',
          },
        ],
      ]),
    );
    expect(JSON.stringify(notarizeArtifact.mock.calls)).not.toContain('.zip');
  });

  it('rejects a stale, duplicate, unsigned, or incomplete DMG matrix', async () => {
    const stale = await packageDirectory();
    await writeFile(join(stale, 'WO-9.9.9-mac-x64.dmg'), 'stale');
    await expect(
      notarizeDmgArtifacts(
        { packageDirectory: stale },
        {
          environment: { APPLE_KEYCHAIN_PROFILE: 'wo-notary' },
          notarizeArtifact: vi.fn(),
        },
      ),
    ).rejects.toThrow(/exactly one|single version/iu);

    const unsigned = await packageDirectory();
    await rm(join(unsigned, 'WO-1.2.3-mac-arm64.dmg'));
    await writeFile(
      join(unsigned, 'WO-1.2.3-UNSIGNED-DEVELOPMENT-mac-arm64.dmg'),
      'unsigned',
    );
    await expect(
      notarizeDmgArtifacts(
        { packageDirectory: unsigned },
        {
          environment: { APPLE_KEYCHAIN_PROFILE: 'wo-notary' },
          notarizeArtifact: vi.fn(),
        },
      ),
    ).rejects.toThrow(/unexpected|unsigned/iu);

    const missing = await packageDirectory();
    await rm(join(missing, 'WO-1.2.3-mac-arm64.dmg'));
    await expect(
      notarizeDmgArtifacts(
        { packageDirectory: missing },
        {
          environment: { APPLE_KEYCHAIN_PROFILE: 'wo-notary' },
          notarizeArtifact: vi.fn(),
        },
      ),
    ).rejects.toThrow(/one x64 and one arm64/iu);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink in place of a DMG artifact',
    async () => {
      const directory = await packageDirectory();
      const arm64 = join(directory, 'WO-1.2.3-mac-arm64.dmg');
      await rm(arm64);
      await symlink('WO-1.2.3-mac-x64.dmg', arm64);

      await expect(
        notarizeDmgArtifacts(
          { packageDirectory: directory },
          {
            environment: { APPLE_KEYCHAIN_PROFILE: 'wo-notary' },
            notarizeArtifact: vi.fn(),
          },
        ),
      ).rejects.toThrow(/invalid.*DMG/iu);
    },
  );

  it('requires one complete credential strategy and pins Apple ID teams', () => {
    expect(
      notarizationCredentials({
        APPLE_API_KEY: resolve('AuthKey_ABCDEFGHIJ.p8'),
        APPLE_API_KEY_ID: 'ABCDEFGHIJ',
        APPLE_API_ISSUER: '00000000-0000-4000-8000-000000000001',
      }),
    ).toMatchObject({ appleApiKeyId: 'ABCDEFGHIJ' });
    expect(
      notarizationCredentials({
        APPLE_ID: 'release@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret',
        APPLE_TEAM_ID: 'TEAMID1234',
        WO_MAC_TEAM_ID: 'TEAMID1234',
      }),
    ).toMatchObject({ teamId: 'TEAMID1234' });
    expect(() =>
      notarizationCredentials({ APPLE_API_KEY_ID: 'ABCDEFGHIJ' }),
    ).toThrow(/incomplete/iu);
    expect(() =>
      notarizationCredentials({
        APPLE_ID: 'release@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret',
        APPLE_TEAM_ID: 'OTHERID123',
        WO_MAC_TEAM_ID: 'TEAMID1234',
      }),
    ).toThrow(/pinned release identity/iu);
    expect(() =>
      notarizationCredentials({
        APPLE_KEYCHAIN_PROFILE: 'wo-notary',
        APPLE_API_KEY: resolve('AuthKey_ABCDEFGHIJ.p8'),
        APPLE_API_KEY_ID: 'ABCDEFGHIJ',
        APPLE_API_ISSUER: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow(/exactly one/iu);
  });
});
