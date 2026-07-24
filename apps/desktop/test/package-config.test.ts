import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function readDesktopFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('desktop production package configuration', () => {
  it('declares the workspace package manager for Windows builder discovery', async () => {
    const [desktopPackage, rootPackage] = await Promise.all([
      readDesktopFile('package.json'),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ]);

    expect(JSON.parse(desktopPackage)).toMatchObject({
      packageManager: JSON.parse(rootPackage).packageManager,
    });
  });

  it('uses a fixed identity, asar, and an explicit runtime allowlist', async () => {
    const config = await readDesktopFile('electron-builder.yml');

    expect(config).toMatch(/^appId: cn\.wo\.desktop$/mu);
    expect(config).toMatch(/^productName: WO$/mu);
    expect(config).toMatch(/^asar: true$/mu);
    expect(config).toContain('forceCodeSigning: true');
    expect(config).toMatch(
      /electronFuses:[\s\S]*?runAsNode: false[\s\S]*?enableNodeOptionsEnvironmentVariable: false[\s\S]*?enableNodeCliInspectArguments: false[\s\S]*?enableEmbeddedAsarIntegrityValidation: true[\s\S]*?onlyLoadAppFromAsar: true/u,
    );
    expect(config).toContain('- out/main/**/*');
    expect(config).toContain('- out/preload/**/*');
    expect(config).toContain('- out/renderer/**/*');
    expect(config).toContain('- package.json');
    expect(config).toMatch(/- ['"]!node_modules\/\*\*\/\*['"]/u);
    expect(config).toMatch(/- ['"]!\*\*\/\*\.map['"]/u);
    expect(config).toMatch(/extraMetadata:\s+main: out\/main\/index\.js/u);
  });

  it('defines Windows NSIS and portable artifacts and macOS DMG and ZIP artifacts', async () => {
    const config = await readDesktopFile('electron-builder.yml');

    expect(config).toMatch(
      /win:[\s\S]*?target:[\s\S]*?- nsis[\s\S]*?- portable/u,
    );
    expect(config).toContain('WO-${version}-setup-${arch}.${ext}');
    expect(config).toContain('WO-${version}-portable-${arch}.${ext}');
    expect(config).toMatch(/mac:[\s\S]*?target:[\s\S]*?- dmg[\s\S]*?- zip/u);
    expect(config).toContain('WO-${version}-mac-${arch}.${ext}');
    expect(config).toMatch(
      /dmg:\s+[\s\S]*?sign: true[\s\S]*?writeUpdateInfo: false/u,
    );
  });

  it('hardens signed macOS packages and declares screen and microphone privacy usage', async () => {
    const [config, appEntitlements, inheritedEntitlements] = await Promise.all([
      readDesktopFile('electron-builder.yml'),
      readDesktopFile('build/entitlements.mac.plist'),
      readDesktopFile('build/entitlements.mac.inherit.plist'),
    ]);

    expect(config).toContain('hardenedRuntime: true');
    expect(config).toContain('entitlements: build/entitlements.mac.plist');
    expect(config).toContain(
      'entitlementsInherit: build/entitlements.mac.inherit.plist',
    );
    expect(config).toContain('NSMicrophoneUsageDescription:');
    expect(config).toContain('NSScreenCaptureUsageDescription:');
    expect(config).toContain('NSAudioCaptureUsageDescription:');

    for (const plist of [appEntitlements, inheritedEntitlements]) {
      expect(plist).toContain('com.apple.security.cs.allow-jit');
      expect(plist).toContain(
        'com.apple.security.cs.allow-unsigned-executable-memory',
      );
      expect(plist).toContain(
        'com.apple.security.cs.disable-library-validation',
      );
    }
    expect(appEntitlements).toContain('com.apple.security.device.audio-input');
  });

  it('exposes only explicit signed and unsigned-development package commands', async () => {
    const packageJson = JSON.parse(await readDesktopFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['package:win']).toBe(
      'node scripts/build-platform.mjs --platform=win',
    );
    expect(scripts['package:win:dir']).toBe(
      'node scripts/build-platform.mjs --platform=win --dir',
    );
    expect(scripts['package:win:unsigned-development']).toContain(
      '--unsigned-development',
    );
    expect(scripts['package:mac']).toBe(
      'node scripts/build-platform.mjs --platform=mac',
    );
    expect(scripts['package:mac:unsigned-development']).toContain(
      '--unsigned-development',
    );
    expect(scripts['verify:package']).toBe('node scripts/verify-package.mjs');
    expect(JSON.stringify(scripts)).not.toMatch(
      /CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|API_KEY|password|certificate/iu,
    );
  });
});
