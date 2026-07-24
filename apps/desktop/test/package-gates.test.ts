import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));
const buildPlatformScript = join(
  desktopDirectory,
  'scripts',
  'build-platform.mjs',
);
const verifyPackageScript = join(
  desktopDirectory,
  'scripts',
  'verify-package.mjs',
);
const require = createRequire(import.meta.url);
const builderRequire = createRequire(
  require.resolve('electron-builder/package.json'),
);
const appBuilderRequire = createRequire(
  builderRequire.resolve('app-builder-lib/package.json'),
);
const { createPackage } = appBuilderRequire('@electron/asar') as {
  createPackage(source: string, destination: string): Promise<void>;
};
const temporaryDirectories: string[] = [];
const signedWindowsIdentityArguments = [
  '--expected-win-publisher=CN=WO Release',
  `--expected-win-thumbprint=${'A'.repeat(40)}`,
];

type CommandResult = ReturnType<typeof spawnSync>;

function electronFuseFixture(options: { runAsNode?: boolean } = {}): Buffer {
  const executable = Buffer.alloc(192);
  const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
  const sentinelOffset = 0x60;
  executable.write(sentinel, sentinelOffset, 'ascii');
  const wireOffset = sentinelOffset + sentinel.length;
  executable[wireOffset] = 1;
  executable[wireOffset + 1] = 9;
  const states = [
    options.runAsNode === true ? 49 : 48,
    49,
    48,
    48,
    49,
    49,
    48,
    49,
    49,
  ];
  for (const [index, state] of states.entries()) {
    executable[wireOffset + 2 + index] = state;
  }
  return executable;
}

function peFixture(
  machine: number,
  options: { runAsNode?: boolean } = {},
): Buffer {
  const executable = electronFuseFixture(options);
  executable.write('MZ', 0, 'ascii');
  executable.writeUInt32LE(0x40, 0x3c);
  executable.write('PE\0\0', 0x40, 'binary');
  executable.writeUInt16LE(machine, 0x44);
  return executable;
}

async function appendElectronFuseWire(path: string): Promise<void> {
  await appendFile(path, electronFuseFixture().subarray(0x60));
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function runBuildPlatform(
  args: string[],
  environment: Record<string, string> = {},
): CommandResult {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        ![
          'CSC_LINK',
          'CSC_NAME',
          'WIN_CSC_LINK',
          'WIN_CSC_NAME',
          'CSC_KEY_PASSWORD',
          'WIN_CSC_KEY_PASSWORD',
          'APPLE_ID',
          'APPLE_APP_SPECIFIC_PASSWORD',
          'APPLE_TEAM_ID',
          'APPLE_API_KEY',
          'APPLE_API_KEY_ID',
          'APPLE_API_ISSUER',
          'APPLE_KEYCHAIN',
          'APPLE_KEYCHAIN_PROFILE',
        ].includes(key),
    ),
  ) as Record<string, string>;

  return spawnSync(process.execPath, [buildPlatformScript, ...args], {
    cwd: desktopDirectory,
    encoding: 'utf8',
    env: { ...cleanEnvironment, ...environment },
  });
}

function runVerifier(args: string[]): CommandResult {
  const normalizedArguments = args.some((argument) =>
    argument.startsWith('--target-set='),
  )
    ? args
    : [...args, '--target-set=dir'];
  return spawnSync(
    process.execPath,
    [verifyPackageScript, ...normalizedArguments],
    {
      cwd: desktopDirectory,
      encoding: 'utf8',
    },
  );
}

async function makePackage(
  options: {
    artifactClass?: 'signed' | 'unsigned-development';
    archiveName?: string;
    files?: Record<string, string>;
    outsideFiles?: Record<string, string>;
    main?: string;
    windowsMachine?: number;
    unsafeRunAsNodeFuse?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wo-package-gate-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source');
  const packageDirectory = join(root, 'package');
  const unpackedDirectory = join(packageDirectory, 'win-unpacked');
  const resources = join(unpackedDirectory, 'resources');
  const main = options.main ?? 'out/main/index.js';

  await mkdir(join(source, 'out', 'main'), { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(unpackedDirectory, 'WO.exe'),
    peFixture(options.windowsMachine ?? 0x8664, {
      runAsNode: options.unsafeRunAsNodeFuse,
    }),
  );
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'wo-desktop', version: '0.0.0', main }),
  );
  await writeFile(
    join(source, 'out', 'main', 'index.js'),
    "console.info('WO');",
  );

  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const destination = join(source, relativePath);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }

  await createPackage(
    source,
    join(resources, options.archiveName ?? 'app.asar'),
  );
  for (const [relativePath, contents] of Object.entries(
    options.outsideFiles ?? {},
  )) {
    const destination = join(packageDirectory, relativePath);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  if (
    (options.artifactClass ?? 'unsigned-development') === 'unsigned-development'
  ) {
    await writeFile(
      join(packageDirectory, 'UNSIGNED-DEVELOPMENT.txt'),
      'UNSIGNED_DEVELOPMENT_ONLY\n',
    );
  }
  return packageDirectory;
}

async function makeMacReleasePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wo-mac-package-gate-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source');
  const packageDirectory = join(root, 'package');
  await mkdir(join(source, 'out', 'main'), { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'wo-desktop',
      version: '0.0.0',
      main: 'out/main/index.js',
    }),
  );
  await writeFile(
    join(source, 'out', 'main', 'index.js'),
    "console.info('WO');",
  );

  for (const outputDirectory of ['mac', 'mac-arm64']) {
    const appDirectory = join(packageDirectory, outputDirectory, 'WO.app');
    const architecture = outputDirectory === 'mac' ? 'x86_64' : 'arm64';
    const resources = join(appDirectory, 'Contents', 'Resources');
    const executableDirectory = join(appDirectory, 'Contents', 'MacOS');
    const frameworkDirectory = join(
      appDirectory,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
    );
    const versionedFrameworkDirectory = join(
      frameworkDirectory,
      'Versions',
      'A',
    );
    const helperExecutableDirectory = join(
      appDirectory,
      'Contents',
      'Frameworks',
      'WO Helper.app',
      'Contents',
      'MacOS',
    );
    await mkdir(resources, { recursive: true });
    await mkdir(executableDirectory, { recursive: true });
    await mkdir(versionedFrameworkDirectory, { recursive: true });
    await mkdir(helperExecutableDirectory, { recursive: true });
    await writeFile(
      join(appDirectory, 'Contents', 'Info.plist'),
      JSON.stringify({
        CFBundleIdentifier: 'cn.wo.desktop',
        NSMicrophoneUsageDescription: 'WO uses the microphone for voice calls.',
        NSScreenCaptureUsageDescription:
          'WO uses screen capture when you share your desktop.',
        NSAudioCaptureUsageDescription:
          'WO captures system audio only when you explicitly enable it while sharing.',
      }),
    );
    await createPackage(source, join(resources, 'app.asar'));
    await writeFile(join(executableDirectory, 'WO'), architecture);
    const versionedFrameworkExecutable = join(
      versionedFrameworkDirectory,
      'Electron Framework',
    );
    await writeFile(
      versionedFrameworkExecutable,
      Buffer.concat([
        Buffer.from(`${architecture}\n`, 'utf8'),
        electronFuseFixture(),
      ]),
    );
    await link(
      versionedFrameworkExecutable,
      join(frameworkDirectory, 'Electron Framework'),
    );
    await writeFile(join(helperExecutableDirectory, 'WO Helper'), architecture);
    await writeFile(
      join(appDirectory, 'Contents', 'Frameworks', 'chrome_crashpad_handler'),
      Buffer.concat([
        Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
        Buffer.from(architecture, 'utf8'),
      ]),
    );
  }
  for (const architecture of ['x64', 'arm64']) {
    await writeFile(
      join(packageDirectory, `WO-0.0.0-mac-${architecture}.dmg`),
      'dmg-fixture',
    );
    await writeFile(
      join(packageDirectory, `WO-0.0.0-mac-${architecture}.zip`),
      'zip-fixture',
    );
  }
  return packageDirectory;
}

function runMacArchiveExtraFileFixture(
  packageDirectory: string,
  archive: 'dmg' | 'zip',
): CommandResult {
  const evaluation = `
    import { cp, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
    const fixtureAppFor = (artifactPath) => join(
      process.env.PACKAGE_DIRECTORY,
      artifactPath.includes('arm64') ? 'mac-arm64' : 'mac',
      'WO.app',
    );
    const copyFixtureApp = async (source, destination) => {
      await cp(source, destination, { recursive: true });
      const framework = join(destination, 'Contents', 'Frameworks', 'Electron Framework.framework');
      const alias = join(framework, 'Electron Framework');
      await rm(alias);
      await link(join(framework, 'Versions', 'A', 'Electron Framework'), alias);
    };
    const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
    const runner = async (executable, args) => {
      if (executable.endsWith('/lipo')) {
        return { stdout: (await readFile(args.at(-1), 'utf8')).match(/x86_64|arm64/u)?.[0] ?? '', stderr: '' };
      }
      if (executable.endsWith('/hdiutil') && args[0] === 'attach') {
        const mountPoint = args[args.indexOf('-mountpoint') + 1];
        await mkdir(mountPoint, { recursive: true });
        await copyFixtureApp(fixtureAppFor(args.at(-1)), join(mountPoint, 'WO.app'));
        if (process.env.ARCHIVE_KIND === 'dmg') {
          await writeFile(join(mountPoint, 'AuthKey.p8'), 'PRIVATE_KEY_SECRET');
        }
      }
      if (executable.endsWith('/ditto')) {
        const destination = args.at(-1);
        await mkdir(destination, { recursive: true });
        await copyFixtureApp(fixtureAppFor(args.at(-2)), join(destination, 'WO.app'));
        if (process.env.ARCHIVE_KIND === 'zip') {
          await writeFile(join(destination, 'AuthKey.p8'), 'PRIVATE_KEY_SECRET');
        }
      }
      if (executable.endsWith('/codesign') && args[0] === '-dv') {
        return {
          stdout: '',
          stderr: 'Authority=Developer ID Application: WO (TEAMID1234)\\nIdentifier=cn.wo.desktop\\nTeamIdentifier=TEAMID1234\\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
        };
      }
      if (executable.endsWith('/codesign') && args.includes('--entitlements')) {
        return { stdout: entitlements, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    try {
      await verifier.verifyPackage({
        packageDirectory: process.env.PACKAGE_DIRECTORY,
        platform: 'mac', artifactClass: 'signed', targetSet: 'artifacts', smoke: false,
        expectedMacTeamId: 'TEAMID1234', expectedMacBundleId: 'cn.wo.desktop',
      }, { hostPlatform: 'darwin', hostArch: 'x64', runNativeCommand: runner });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error));
    }
  `;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', evaluation],
    {
      cwd: desktopDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCHIVE_KIND: archive,
        PACKAGE_DIRECTORY: packageDirectory,
        VERIFIER_SCRIPT: verifyPackageScript,
      },
    },
  );
}

function runMacApplicationPolicyFixture(
  packageDirectory: string,
  mode:
    | 'metadata'
    | 'system-audio-metadata'
    | 'runtime'
    | 'entitlements'
    | 'nested-architecture'
    | 'helper-runtime'
    | 'helper-entitlements'
    | 'helper-architecture'
    | 'framework-alias',
): CommandResult {
  const evaluation = `
    import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
    const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
    if (process.env.POLICY_MODE === 'metadata') {
      await writeFile(
        join(process.env.PACKAGE_DIRECTORY, 'mac', 'WO.app', 'Contents', 'Info.plist'),
        JSON.stringify({ CFBundleIdentifier: 'cn.attacker.desktop' }),
      );
    }
    if (process.env.POLICY_MODE === 'system-audio-metadata') {
      const infoPath = join(
        process.env.PACKAGE_DIRECTORY,
        'mac',
        'WO.app',
        'Contents',
        'Info.plist',
      );
      const info = JSON.parse(await readFile(infoPath, 'utf8'));
      delete info.NSAudioCaptureUsageDescription;
      await writeFile(infoPath, JSON.stringify(info));
    }
    if (process.env.POLICY_MODE === 'framework-alias') {
      const framework = join(
        process.env.PACKAGE_DIRECTORY,
        'mac',
        'WO.app',
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
      );
      const alias = join(framework, 'Electron Framework');
      await rm(alias);
      await copyFile(join(framework, 'Versions', 'A', 'Electron Framework'), alias);
    }
    const runner = async (executable, args) => {
      if (executable.endsWith('/lipo')) {
        const path = args.at(-1);
        if (
          process.env.POLICY_MODE === 'nested-architecture' &&
          path.includes('chrome_crashpad_handler')
        ) {
          return { stdout: 'arm64', stderr: '' };
        }
        if (
          process.env.POLICY_MODE === 'helper-architecture' &&
          path.includes('WO Helper')
        ) {
          return { stdout: 'arm64', stderr: '' };
        }
        return {
          stdout: (await readFile(path, 'utf8')).match(/x86_64|arm64/u)?.[0] ?? '',
          stderr: '',
        };
      }
      if (executable.endsWith('/codesign') && args[0] === '-dv') {
        const bundlePath = args.at(-1);
        const flags = (
          process.env.POLICY_MODE === 'runtime' ||
          (process.env.POLICY_MODE === 'helper-runtime' &&
            bundlePath.includes('WO Helper.app'))
        )
          ? ''
          : '\\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded';
        return {
          stdout: '',
          stderr: 'Authority=Developer ID Application: WO (TEAMID1234)\\nIdentifier=cn.wo.desktop\\nTeamIdentifier=TEAMID1234' + flags,
        };
      }
      if (executable.endsWith('/codesign') && args.includes('--entitlements')) {
        const bundlePath = args.at(-1);
        return {
          stdout: (
            process.env.POLICY_MODE === 'entitlements' ||
            (process.env.POLICY_MODE === 'helper-entitlements' &&
              bundlePath.includes('WO Helper.app'))
          ) ? '<plist><dict/></plist>' : entitlements,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    try {
      await verifier.verifyPackage({
        packageDirectory: process.env.PACKAGE_DIRECTORY,
        platform: 'mac', artifactClass: 'signed', targetSet: 'artifacts', smoke: false,
        expectedMacTeamId: 'TEAMID1234', expectedMacBundleId: 'cn.wo.desktop',
      }, { hostPlatform: 'darwin', hostArch: 'x64', runNativeCommand: runner });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error));
    }
  `;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', evaluation],
    {
      cwd: desktopDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PACKAGE_DIRECTORY: packageDirectory,
        POLICY_MODE: mode,
        VERIFIER_SCRIPT: verifyPackageScript,
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('desktop platform package command', () => {
  it('declares the versioned WO room protocol in package metadata', async () => {
    const config = await readFile(
      join(desktopDirectory, 'electron-builder.yml'),
      'utf8',
    );

    expect(config).toMatch(
      /^protocols:\n {2}- name: WO room invite\n {4}schemes:\n {6}- wo$/mu,
    );
  });

  it('rejects unknown arguments', { timeout: 15_000 }, () => {
    const result = runBuildPlatform([
      '--platform=win',
      '--plan',
      '--unsigned-development',
      '--mystery',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/unknown argument.*--mystery/iu);

    const fakeNativeRunner = runVerifier([
      '--package-dir=C:\\not-used',
      '--platform=win',
      '--artifact-class=signed',
      '--target-set=dir',
      '--native-runner=fake',
    ]);
    expect(fakeNativeRunner.status).not.toBe(0);
    expect(commandOutput(fakeNativeRunner)).toMatch(
      /unknown argument.*native-runner/iu,
    );
  });

  it('rejects a macOS package request outside a native macOS runner', () => {
    if (process.platform === 'darwin') return;

    const result = runBuildPlatform([
      '--platform=mac',
      '--unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/macOS.*native macOS runner/iu);
  });

  it('allows a macOS plan with a keychain profile and no explicit keychain path', () => {
    const result = runBuildPlatform(['--platform=mac', '--plan'], {
      CSC_NAME: 'Developer ID Application: WO',
      APPLE_KEYCHAIN_PROFILE: 'wo-notary',
      WO_MAC_TEAM_ID: 'TEAMID1234',
    });

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout as string) as {
      platform: string;
      commands: Array<{ args: string[] }>;
    };
    expect(plan.platform).toBe('mac');
    expect(plan.commands.at(-1)?.args).toContain('--smoke');
    expect(plan.commands.at(-1)?.args).toContain(
      '--expected-mac-team-id=TEAMID1234',
    );
    expect(plan.commands.at(-1)?.args).toContain(
      '--expected-mac-bundle-id=cn.wo.desktop',
    );
    const dmgNotarization = plan.commands.filter((command) =>
      command.args[0]?.endsWith('notarize-dmgs.mjs'),
    );
    expect(dmgNotarization).toHaveLength(1);
    expect(dmgNotarization[0]?.args[1]).toMatch(/^--package-dir=/u);
  });

  it('creates an explicit unsigned-development Windows x64 directory plan', () => {
    const result = runBuildPlatform([
      '--platform=win',
      '--plan',
      '--dir',
      '--unsigned-development',
    ]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout as string) as {
      artifactClass: string;
      architectures: string[];
      targets: string[];
      outputDirectory: string;
      commands: Array<{ args: string[] }>;
    };
    expect(plan.artifactClass).toBe('unsigned-development');
    expect(plan.architectures).toEqual(['x64']);
    expect(plan.targets).toEqual(['dir']);
    expect(plan.outputDirectory).toMatch(/unsigned-development[\\/]win$/u);
    expect(plan.commands.flatMap((command) => command.args)).toContain('--x64');
    expect(result.stdout).not.toMatch(/\brelease\b/iu);
  });

  it('ad-hoc signs unsigned-development macOS packages after applying fuses', () => {
    const unsignedResult = runBuildPlatform([
      '--platform=mac',
      '--plan',
      '--dir',
      '--unsigned-development',
    ]);

    expect(unsignedResult.status).toBe(0);
    const unsignedPlan = JSON.parse(unsignedResult.stdout as string) as {
      commands: Array<{ args: string[] }>;
    };
    expect(unsignedPlan.commands.flatMap((command) => command.args)).toContain(
      '--config.mac.identity=-',
    );

    const signedResult = runBuildPlatform(
      ['--platform=mac', '--plan', '--dir'],
      {
        CSC_NAME: 'Developer ID Application: WO',
        APPLE_KEYCHAIN_PROFILE: 'wo-notary',
        WO_MAC_TEAM_ID: 'TEAMID1234',
      },
    );
    expect(signedResult.status).toBe(0);
    expect(signedResult.stdout).not.toContain('--config.mac.identity=-');
  });

  it('requires a Windows signing identity unless unsigned development is explicit', () => {
    const result = runBuildPlatform(['--platform=win', '--plan']);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/Windows signing identity/iu);
    expect(commandOutput(result)).toContain('--unsigned-development');
  });

  it('rejects Windows certificate-name variables that electron-builder does not consume', () => {
    const result = runBuildPlatform(['--platform=win', '--plan'], {
      WIN_CSC_NAME: 'WO certificate in the Windows store',
    });

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/WIN_CSC_LINK|CSC_LINK/iu);
  });

  it('requires a pinned release identity in addition to signing credentials', () => {
    const windows = runBuildPlatform(['--platform=win', '--plan'], {
      WIN_CSC_LINK: 'certificate.pfx',
    });
    expect(windows.status).not.toBe(0);
    expect(commandOutput(windows)).toMatch(
      /publisher|thumbprint|release identity/iu,
    );

    const mac = runBuildPlatform(['--platform=mac', '--plan'], {
      CSC_NAME: 'Developer ID Application: WO',
      APPLE_KEYCHAIN_PROFILE: 'wo-notary',
    });
    expect(mac.status).not.toBe(0);
    expect(commandOutput(mac)).toMatch(/Team ID|release identity/iu);
  });

  it('marks every unsigned-development distributable filename', () => {
    const result = runBuildPlatform([
      '--platform=win',
      '--plan',
      '--unsigned-development',
    ]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout as string) as {
      commands: Array<{ args: string[] }>;
    };
    const argumentsList = plan.commands.flatMap((command) => command.args);
    expect(argumentsList).toContain(
      '--config.nsis.artifactName=WO-${version}-UNSIGNED-DEVELOPMENT-setup-${arch}.${ext}',
    );
    expect(argumentsList).toContain(
      '--config.portable.artifactName=WO-${version}-UNSIGNED-DEVELOPMENT-portable-${arch}.${ext}',
    );
    expect(result.stdout).not.toMatch(/\brelease\b/iu);
  });

  it('keeps signing secrets out of the generated command plan', () => {
    const result = runBuildPlatform(['--platform=win', '--plan'], {
      WIN_CSC_LINK: 'TOP_SECRET_CERTIFICATE',
      WIN_CSC_KEY_PASSWORD: 'TOP_SECRET_PASSWORD',
      WO_WINDOWS_PUBLISHER_SUBJECT: 'CN=WO Release',
      WO_WINDOWS_CERTIFICATE_THUMBPRINT: 'A'.repeat(40),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('TOP_SECRET_CERTIFICATE');
    expect(result.stdout).not.toContain('TOP_SECRET_PASSWORD');
    const plan = JSON.parse(result.stdout as string) as {
      artifactClass: string;
      targets: string[];
      architectures: string[];
      commands: Array<{ args: string[] }>;
    };
    expect(plan.artifactClass).toBe('signed');
    expect(plan.targets).toEqual(['nsis', 'portable']);
    expect(plan.architectures).toEqual(['x64']);
    const verifyArguments = plan.commands.at(-1)?.args ?? [];
    expect(verifyArguments).toContain('--expected-win-publisher=CN=WO Release');
    expect(verifyArguments).toContain(
      `--expected-win-thumbprint=${'A'.repeat(40)}`,
    );
  });
});

describe('desktop production package verifier', () => {
  it('retries a resource-busy DMG detach before force-cleaning its temporary mount', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const calls = [];
      await verifier.detachMacDiskImage(
        '/tmp/wo-dmg-mount-test',
        async (executable, args) => {
          calls.push({ executable, args });
          if (!args.includes('-force')) {
            throw new Error('hdiutil exited with code 16');
          }
          return { stdout: '', stderr: '' };
        },
        {},
        async () => {},
      );
      process.stdout.write(JSON.stringify(calls));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    const calls = JSON.parse(result.stdout as string) as Array<{
      executable: string;
      args: string[];
    }>;
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () => ({
        executable: '/usr/bin/hdiutil',
        args: ['detach', '/tmp/wo-dmg-mount-test'],
      })),
    );
    expect(calls[4]).toEqual({
      executable: '/usr/bin/hdiutil',
      args: ['detach', '-force', '/tmp/wo-dmg-mount-test'],
    });
  });

  it('does not retry a deterministic DMG detach failure', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      let calls = 0;
      try {
        await verifier.detachMacDiskImage(
          '/tmp/wo-dmg-mount-test',
          async () => {
            calls += 1;
            throw new Error('hdiutil exited with code 1');
          },
          {},
          async () => {},
        );
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(JSON.stringify({
          calls,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout as string)).toEqual({
      calls: 1,
      message: 'hdiutil exited with code 1',
    });
  });

  it('accepts a clean, explicitly marked unsigned-development app.asar', async () => {
    const packageDirectory = await makePackage();
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DESKTOP_PACKAGE_VERIFIED');
    expect(result.stdout).toContain('UNSIGNED_DEVELOPMENT_ONLY');
  });

  it('cryptographically rejects an unsigned executable labeled as signed', async () => {
    if (process.platform !== 'win32') return;

    const packageDirectory = await makePackage({ artifactClass: 'signed' });
    await copyFile(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'),
      join(packageDirectory, 'win-unpacked', 'WO.exe'),
    );
    await appendElectronFuseWire(
      join(packageDirectory, 'win-unpacked', 'WO.exe'),
    );
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=signed',
      ...signedWindowsIdentityArguments,
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/signature|Authenticode|unsigned/iu);
  });

  it('passes a Windows executable path into the native Authenticode scriptblock', () => {
    if (process.platform !== 'win32') return;
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const result = await verifier.readWindowsAuthenticodeSignature(
        'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout as string)).toMatchObject({
      InputPath:
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      Status: 'Valid',
    });
  });

  it('requires every configured Windows release artifact', async () => {
    const packageDirectory = await makePackage();
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
      '--target-set=artifacts',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/setup.*x64|release artifact/iu);
  });

  it('rejects stale release artifacts beside the current Windows matrix', async () => {
    const packageDirectory = await makePackage();
    for (const name of [
      'WO-0.0.0-UNSIGNED-DEVELOPMENT-setup-x64.exe',
      'WO-0.0.0-UNSIGNED-DEVELOPMENT-portable-x64.exe',
      'WO-9.9.9-UNSIGNED-DEVELOPMENT-portable-x64.exe',
    ]) {
      await writeFile(join(packageDirectory, name), peFixture(0x8664));
    }
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
      '--target-set=artifacts',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(
      /unexpected release artifact|9\.9\.9/iu,
    );
  });

  it('rejects stale release artifacts beside the current macOS matrix', async () => {
    const packageDirectory = await makeMacReleasePackage();
    await writeFile(
      join(packageDirectory, 'WO-9.9.9-mac-arm64.dmg'),
      'stale-dmg',
    );
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=mac',
      '--artifact-class=signed',
      '--target-set=artifacts',
      '--expected-mac-team-id=TEAMID1234',
      '--expected-mac-bundle-id=cn.wo.desktop',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(
      /unexpected release artifact|9\.9\.9/iu,
    );
  });

  it('rejects an x86 PE executable labeled as a Windows x64 package', async () => {
    const packageDirectory = await makePackage({ windowsMachine: 0x014c });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/PE|architecture|x64/iu);
  });

  it('rejects an Electron executable whose production fuses drift', async () => {
    const packageDirectory = await makePackage({ unsafeRunAsNodeFuse: true });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/fuse|RunAsNode/iu);
  });

  it('uses native macOS trust tools for both architectures and smokes the host architecture', async () => {
    const packageDirectory = await makeMacReleasePackage();
    const evaluation = `
      import { cp, link, mkdir, readFile, rm } from 'node:fs/promises';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const commands = [];
      const smokeExecutables = [];
      const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
      const fixtureAppFor = (artifactPath) =>
        join(
          process.env.PACKAGE_DIRECTORY,
          artifactPath.includes('arm64') ? 'mac-arm64' : 'mac',
          'WO.app',
        );
      const copyFixtureApp = async (source, destination) => {
        await cp(source, destination, { recursive: true });
        const framework = join(destination, 'Contents', 'Frameworks', 'Electron Framework.framework');
        const alias = join(framework, 'Electron Framework');
        await rm(alias);
        await link(join(framework, 'Versions', 'A', 'Electron Framework'), alias);
      };
      const runNativeCommand = async (executable, args, environment) => {
        commands.push({ executable, args, environment });
        if (executable.endsWith('/lipo')) {
          return {
            stdout: (await readFile(args.at(-1), 'utf8')).match(/x86_64|arm64/u)?.[0] ?? '',
            stderr: '',
          };
        }
        if (executable.endsWith('/hdiutil') && args[0] === 'attach') {
          const mountPoint = args[args.indexOf('-mountpoint') + 1];
          await mkdir(mountPoint, { recursive: true });
          await copyFixtureApp(fixtureAppFor(args.at(-1)), join(mountPoint, 'WO.app'));
        }
        if (executable.endsWith('/ditto')) {
          const destination = args.at(-1);
          await mkdir(destination, { recursive: true });
          await copyFixtureApp(fixtureAppFor(args.at(-2)), join(destination, 'WO.app'));
        }
        if (executable.endsWith('/codesign') && args[0] === '-dv') {
          return {
            stdout: '',
            stderr: 'Authority=Developer ID Application: WO (TEAMID1234)\\nIdentifier=cn.wo.desktop\\nTeamIdentifier=TEAMID1234\\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
          };
        }
        if (executable.endsWith('/codesign') && args.includes('--entitlements')) {
          return { stdout: entitlements, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      await verifier.verifyPackage({
        packageDirectory: process.env.PACKAGE_DIRECTORY,
        platform: 'mac',
        artifactClass: 'signed',
        targetSet: 'artifacts',
        smoke: true,
        expectedMacTeamId: 'TEAMID1234',
        expectedMacBundleId: 'cn.wo.desktop',
      }, {
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        runNativeCommand,
        runExecutableSmoke: async (path) => { smokeExecutables.push(path); },
      });
      process.stdout.write(JSON.stringify({ commands, smokeExecutables }));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          WIN_CSC_LINK: 'TOP_SECRET_CERTIFICATE',
          CSC_KEY_PASSWORD: 'TOP_SECRET_PASSWORD',
          APPLE_API_KEY: '/secret/AuthKey.p8',
          PACKAGE_DIRECTORY: packageDirectory,
          VERIFIER_SCRIPT: verifyPackageScript,
        },
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout as string) as {
      commands: Array<{
        executable: string;
        args: string[];
        environment?: Record<string, string>;
      }>;
      smokeExecutables: string[];
    };
    expect(
      report.commands.every((command) =>
        command.executable.startsWith('/usr/'),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(report.commands.map((command) => command.environment)),
    ).not.toMatch(/TOP_SECRET|WIN_CSC|CSC_KEY|APPLE_API_KEY/iu);
    expect(
      report.commands.filter(
        (command) =>
          command.executable === '/usr/bin/codesign' &&
          command.args[0] === '--verify',
      ),
    ).toHaveLength(12);
    expect(
      report.commands.filter(
        (command) => command.executable === '/usr/sbin/spctl',
      ),
    ).toHaveLength(8);
    expect(
      report.commands.filter(
        (command) =>
          command.executable === '/usr/bin/xcrun' &&
          command.args[0] === 'stapler',
      ),
    ).toHaveLength(8);
    expect(
      report.commands.filter(
        (command) =>
          command.executable === '/usr/sbin/spctl' &&
          command.args.includes('open') &&
          command.args.at(-1)?.endsWith('.dmg'),
      ),
    ).toHaveLength(2);
    expect(
      report.commands.filter(
        (command) =>
          command.executable === '/usr/bin/xcrun' &&
          command.args[0] === 'stapler' &&
          command.args.at(-1)?.endsWith('.dmg'),
      ),
    ).toHaveLength(2);
    expect(
      report.commands.filter(
        (command) => command.executable === '/usr/bin/hdiutil',
      ),
    ).toHaveLength(6);
    expect(
      report.commands.filter(
        (command) => command.executable === '/usr/bin/unzip',
      ),
    ).toHaveLength(2);
    expect(
      report.commands.filter(
        (command) => command.executable === '/usr/bin/ditto',
      ),
    ).toHaveLength(2);
    expect(
      report.commands.filter(
        (command) => command.executable === '/usr/bin/lipo',
      ),
    ).toHaveLength(24);
    expect(report.smokeExecutables).toHaveLength(3);
    expect(
      report.smokeExecutables.map((path) => path.replaceAll('\\', '/')),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/mac-arm64\/WO\.app\/Contents\/MacOS\/WO$/u),
        expect.stringMatching(
          /wo-dmg-mount-[^/]+\/WO\.app\/Contents\/MacOS\/WO$/u,
        ),
        expect.stringMatching(
          /wo-zip-verify-[^/]+\/WO\.app\/Contents\/MacOS\/WO$/u,
        ),
      ]),
    );
  });

  it('rejects a macOS archive whose app.asar differs from the unpacked application', async () => {
    const packageDirectory = await makeMacReleasePackage();
    const evaluation = `
      import { appendFile, cp, link, mkdir, readFile, rm } from 'node:fs/promises';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const fixtureAppFor = (artifactPath) => join(
        process.env.PACKAGE_DIRECTORY,
        artifactPath.includes('arm64') ? 'mac-arm64' : 'mac',
        'WO.app',
      );
      const copyFixtureApp = async (source, destination) => {
        await cp(source, destination, { recursive: true });
        const framework = join(destination, 'Contents', 'Frameworks', 'Electron Framework.framework');
        const alias = join(framework, 'Electron Framework');
        await rm(alias);
        await link(join(framework, 'Versions', 'A', 'Electron Framework'), alias);
      };
      const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
      const runner = async (executable, args) => {
        if (executable.endsWith('/lipo')) {
          return { stdout: (await readFile(args.at(-1), 'utf8')).match(/x86_64|arm64/u)?.[0] ?? '', stderr: '' };
        }
        if (executable.endsWith('/hdiutil') && args[0] === 'attach') {
          const mountPoint = args[args.indexOf('-mountpoint') + 1];
          await mkdir(mountPoint, { recursive: true });
          await copyFixtureApp(fixtureAppFor(args.at(-1)), join(mountPoint, 'WO.app'));
        }
        if (executable.endsWith('/ditto')) {
          const destination = args.at(-1);
          await mkdir(destination, { recursive: true });
          await copyFixtureApp(fixtureAppFor(args.at(-2)), join(destination, 'WO.app'));
          await appendFile(
            join(destination, 'WO.app', 'Contents', 'Resources', 'app.asar'),
            'stale-archive-payload',
          );
        }
        if (executable.endsWith('/codesign') && args[0] === '-dv') {
          return {
            stdout: '',
            stderr: 'Authority=Developer ID Application: WO (TEAMID1234)\\nIdentifier=cn.wo.desktop\\nTeamIdentifier=TEAMID1234\\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
          };
        }
        if (executable.endsWith('/codesign') && args.includes('--entitlements')) {
          return { stdout: entitlements, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      try {
        await verifier.verifyPackage({
          packageDirectory: process.env.PACKAGE_DIRECTORY,
          platform: 'mac', artifactClass: 'signed', targetSet: 'artifacts', smoke: false,
          expectedMacTeamId: 'TEAMID1234', expectedMacBundleId: 'cn.wo.desktop',
        }, { hostPlatform: 'darwin', hostArch: 'x64', runNativeCommand: runner });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PACKAGE_DIRECTORY: packageDirectory,
          VERIFIER_SCRIPT: verifyPackageScript,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/app\.asar|payload|differs/iu);
  });

  it.each(['dmg', 'zip'] as const)(
    'rejects a private key beside the application inside a macOS %s archive',
    async (archive) => {
      const packageDirectory = await makeMacReleasePackage();
      const result = runMacArchiveExtraFileFixture(packageDirectory, archive);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/archive|private key|AuthKey|unexpected/iu);
    },
  );

  it.each([
    ['metadata', /Info\.plist|microphone|screen capture|bundle/iu],
    ['system-audio-metadata', /Info\.plist|usage metadata/iu],
    ['runtime', /hardened|runtime/iu],
    ['entitlements', /entitlement|audio-input/iu],
    ['nested-architecture', /architecture|crashpad/iu],
    ['helper-runtime', /hardened|runtime|Helper/iu],
    ['helper-entitlements', /entitlement|Helper/iu],
    ['helper-architecture', /architecture|Helper/iu],
    ['framework-alias', /Framework alias|versioned executable/iu],
  ] as const)(
    'rejects a macOS app with invalid final %s policy',
    async (mode, expected) => {
      const packageDirectory = await makeMacReleasePackage();
      const result = runMacApplicationPolicyFixture(packageDirectory, mode);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(expected);
    },
  );

  it('rejects a macOS arm64 directory whose Mach-O payload is x64', async () => {
    const packageDirectory = await makeMacReleasePackage();
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
      try {
        await verifier.verifyPackage({
          packageDirectory: process.env.PACKAGE_DIRECTORY,
          platform: 'mac', artifactClass: 'signed', targetSet: 'artifacts', smoke: false,
          expectedMacTeamId: 'TEAMID1234', expectedMacBundleId: 'cn.wo.desktop',
        }, {
          hostPlatform: 'darwin', hostArch: 'x64',
          runNativeCommand: async (executable, args) => {
            if (executable.endsWith('/lipo')) return { stdout: 'x86_64', stderr: '' };
            if (executable.endsWith('/codesign') && args[0] === '-dv') return {
              stdout: '', stderr: 'Authority=Developer ID Application: WO (TEAMID1234)\\nIdentifier=cn.wo.desktop\\nTeamIdentifier=TEAMID1234\\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
            };
            if (executable.endsWith('/codesign') && args.includes('--entitlements')) {
              return { stdout: entitlements, stderr: '' };
            }
            return { stdout: '', stderr: '' };
          },
        });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PACKAGE_DIRECTORY: packageDirectory,
          VERIFIER_SCRIPT: verifyPackageScript,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/arm64|architecture|Mach-O/iu);
  });

  it('rejects a valid Windows signature from an unexpected publisher or certificate', async () => {
    const packageDirectory = await makePackage({ artifactClass: 'signed' });
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      try {
        await verifier.verifyPackage({
          packageDirectory: process.env.PACKAGE_DIRECTORY,
          platform: 'win',
          artifactClass: 'signed',
          targetSet: 'dir',
          smoke: false,
          expectedWinPublisher: 'CN=WO Release',
          expectedWinThumbprint: '${'A'.repeat(40)}',
        }, {
          hostPlatform: 'win32',
          runNativeCommand: async (_executable, args) => ({
            stdout: JSON.stringify({
              InputPath: args.at(-1),
              Status: 'Valid',
              SignerSubject: 'CN=Another Publisher',
              SignerThumbprint: '${'B'.repeat(40)}',
              TimestampSubject: 'CN=Trusted Timestamp',
            }),
            stderr: '',
          }),
        });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PACKAGE_DIRECTORY: packageDirectory,
          VERIFIER_SCRIPT: verifyPackageScript,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/publisher|thumbprint|certificate/iu);
  });

  it('smokes both the unpacked Windows app and the final portable artifact', async () => {
    const packageDirectory = await makePackage();
    await writeFile(
      join(packageDirectory, 'WO-0.0.0-UNSIGNED-DEVELOPMENT-setup-x64.exe'),
      peFixture(0x014c),
    );
    await writeFile(
      join(packageDirectory, 'WO-0.0.0-UNSIGNED-DEVELOPMENT-portable-x64.exe'),
      peFixture(0x014c),
    );
    const evaluation = `
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const smokes = [];
      await verifier.verifyPackage({
        packageDirectory: process.env.PACKAGE_DIRECTORY,
        platform: 'win', artifactClass: 'unsigned-development',
        targetSet: 'artifacts', smoke: true,
      }, {
        hostPlatform: 'win32', hostArch: 'x64',
        extractWindowsArtifact: async () => ({
          executablePath: join(process.env.PACKAGE_DIRECTORY, 'win-unpacked', 'WO.exe'),
          asarPath: join(process.env.PACKAGE_DIRECTORY, 'win-unpacked', 'resources', 'app.asar'),
          cleanup: async () => {},
        }),
        runExecutableSmoke: async (path) => { smokes.push(path); },
      });
      process.stdout.write(JSON.stringify(smokes));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PACKAGE_DIRECTORY: packageDirectory,
          VERIFIER_SCRIPT: verifyPackageScript,
        },
      },
    );

    expect(result.status).toBe(0);
    const smokes = JSON.parse(result.stdout as string) as string[];
    expect(smokes.map((path) => path.replaceAll('\\', '/'))).toEqual([
      expect.stringMatching(/win-unpacked\/WO\.exe$/u),
      expect.stringMatching(/portable-x64\.exe$/u),
    ]);
  });

  it('does not pass signing or unrelated process secrets to the packaged smoke app', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const environment = verifier.createSmokeEnvironment({
        PATH: 'safe-path',
        SystemRoot: 'C:\\\\Windows',
        HOME: '/safe-home',
        WIN_CSC_LINK: 'TOP_SECRET_CERTIFICATE',
        CSC_KEY_PASSWORD: 'TOP_SECRET_PASSWORD',
        APPLE_API_KEY: '/secret/AuthKey.p8',
        APPLE_APP_SPECIFIC_PASSWORD: 'TOP_SECRET_APPLE_PASSWORD',
        INTERNAL_TOKEN: 'TOP_SECRET_TOKEN',
        HTTPS_PROXY: 'http://secret-proxy.invalid',
      }, {
        nonce: '${'b'.repeat(64)}',
        readyPath: 'C:\\\\Temp\\\\ready.txt',
      });
      process.stdout.write(JSON.stringify(environment));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    const environment = JSON.parse(result.stdout as string) as Record<
      string,
      string
    >;
    expect(environment.PATH).toBe('safe-path');
    expect(environment.WO_PACKAGE_SMOKE).toBe('1');
    expect(environment.WO_API_ORIGIN).toBe('https://127.0.0.1:1');
    expect(JSON.stringify(environment)).not.toMatch(
      /TOP_SECRET|WIN_CSC|APPLE_|INTERNAL_TOKEN|HTTPS_PROXY/iu,
    );
  });

  it('rejects an environment-selected 7-Zip executable before resolving the tool', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      let called = false;
      try {
        await verifier.resolveTrustedSevenZip({
          environment: {
            ELECTRON_BUILDER_7ZIP_PATH: 'C:\\\\Attacker\\\\7za.exe',
          },
          getPath7za: async () => {
            called = true;
            return 'C:\\\\Attacker\\\\7za.exe';
          },
        });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(JSON.stringify({
          called,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout as string)).toEqual({
      called: false,
      message: expect.stringMatching(
        /7-?zip.*environment|environment.*7-?zip/iu,
      ),
    });
  });

  it('uses taskkill tree semantics when terminating a Windows smoke process', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const calls = [];
      const child = {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        kill: (signal) => { calls.push({ fallback: signal ?? 'default' }); return true; },
      };
      await verifier.terminateSmokeProcessTree(child, Promise.resolve(), {
        platform: 'win32',
        trackedProcesses: [{ pid: 4321, creationTicks: '100' }],
        probeProcessIdentities: async (identities) => identities,
        environment: { SystemRoot: 'C:\\\\Attacker' },
        processTreeExists: async () => false,
        runNativeCommand: async (executable, args, environment) => {
          calls.push({ executable, args, environment });
          return { stdout: '', stderr: '' };
        },
      });
      process.stdout.write(JSON.stringify(calls));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    const calls = JSON.parse(result.stdout as string) as Array<{
      executable?: string;
      args?: string[];
      fallback?: string;
    }>;
    expect(calls).toEqual([
      expect.objectContaining({
        executable: 'C:\\Windows\\System32\\taskkill.exe',
        args: ['/PID', '4321', '/T'],
      }),
    ]);
  });

  it('terminates a captured Windows grandchild after its parent has closed', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const calls = [];
      const alive = new Set(['9876:200']);
      const child = {
        pid: 4321,
        exitCode: 0,
        signalCode: null,
        kill: () => true,
      };
      await verifier.terminateSmokeProcessTree(child, Promise.resolve(), {
        platform: 'win32',
        captureProcessTree: async () => [
          { pid: 4321, creationTicks: '100' },
          { pid: 9876, creationTicks: '200' },
        ],
        probeProcessIdentities: async (identities) => identities.filter(
          (identity) => alive.has(identity.pid + ':' + identity.creationTicks),
        ),
        runNativeCommand: async (executable, args) => {
          calls.push({ executable, args });
          alive.delete(args[1] + ':200');
          return { stdout: '', stderr: '' };
        },
      });
      process.stdout.write(JSON.stringify(calls));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout as string)).toEqual([
      {
        executable: 'C:\\Windows\\System32\\taskkill.exe',
        args: ['/PID', '9876', '/T'],
      },
    ]);
  });

  it('does not force-kill a Windows PID whose creation identity changed', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const calls = [];
      let gracefulSent = false;
      let forceProbeReached = false;
      const child = {
        pid: 4321,
        exitCode: 0,
        signalCode: null,
        kill: () => true,
      };
      await verifier.terminateSmokeProcessTree(child, Promise.resolve(), {
        platform: 'win32',
        trackedProcesses: [{ pid: 4321, creationTicks: '100' }],
        probeProcessIdentities: async (identities) => {
          if (!gracefulSent) return identities;
          forceProbeReached = true;
          return [];
        },
        processTreeExists: async () => !forceProbeReached,
        treeExitTimeoutMs: 5,
        runNativeCommand: async (executable, args) => {
          calls.push({ executable, args });
          gracefulSent = true;
          return { stdout: '', stderr: '' };
        },
      });
      process.stdout.write(JSON.stringify(calls));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    const calls = JSON.parse(result.stdout as string) as Array<{
      executable: string;
      args: string[];
    }>;
    expect(calls).toEqual([
      {
        executable: 'C:\\Windows\\System32\\taskkill.exe',
        args: ['/PID', '4321', '/T'],
      },
    ]);
    expect(calls.some((call) => call.args.includes('/F'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'executes the native Windows process identity probe',
    () => {
      const evaluation = `
        import { pathToFileURL } from 'node:url';
        const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
        const child = {
          pid: 4_000_000_000,
          exitCode: 0,
          signalCode: null,
          kill: () => true,
        };
        await verifier.terminateSmokeProcessTree(child, Promise.resolve(), {
          platform: 'win32',
          trackedProcesses: [{ pid: child.pid, creationTicks: '100' }],
          treeExitTimeoutMs: 100,
        });
      `;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', evaluation],
        {
          cwd: desktopDirectory,
          encoding: 'utf8',
          env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
        },
      );

      expect(commandOutput(result)).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it('rejects a smoke whose detached process group survives the parent close', () => {
    const evaluation = `
      import { pathToFileURL } from 'node:url';
      const verifier = await import(pathToFileURL(process.env.VERIFIER_SCRIPT).href);
      const signals = [];
      const child = {
        pid: 4321,
        exitCode: 0,
        signalCode: null,
        kill: () => true,
      };
      try {
        await verifier.terminateSmokeProcessTree(child, Promise.resolve(), {
          platform: 'linux',
          processTreeExists: async () => true,
          killProcessGroup: (pid, signal) => signals.push({ pid, signal }),
          treeExitTimeoutMs: 10,
        });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          signals,
        }));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      {
        cwd: desktopDirectory,
        encoding: 'utf8',
        env: { ...process.env, VERIFIER_SCRIPT: verifyPackageScript },
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout as string) as {
      message: string;
      signals: Array<{ pid: number; signal: string }>;
    };
    expect(report.message).toMatch(/process (?:group|tree).*terminate/iu);
    expect(report.signals).toEqual([
      { pid: 4321, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGKILL' },
    ]);
  });

  it.each([
    [
      'acceptance application identifiers',
      'out/main/acceptance.js',
      "app.setAppUserModelId('cn.wo.acceptance');",
      /acceptance application identifier/iu,
    ],
    [
      'fake media switches',
      'out/main/fake-media.js',
      "app.commandLine.appendSwitch('use-fake-device-for-media-stream');",
      /fake media/iu,
    ],
    [
      'diagnostic IPC endpoints',
      'out/main/diagnostics.js',
      "ipcMain.handle('acceptance:diagnostics', snapshot);",
      /diagnostic IPC/iu,
    ],
    [
      'acceptance-only media counter IPC endpoints',
      'out/main/media-counters.js',
      "ipcMain.handle('acceptance:media-stats', counters);",
      /diagnostic IPC/iu,
    ],
    [
      'certificate verification bypasses',
      'out/main/tls.js',
      'session.defaultSession.setCertificateVerifyProc(() => 0);',
      /certificate verification bypass/iu,
    ],
    [
      'certificate callbacks that unconditionally accept',
      'out/main/tls-callback.js',
      'session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0));',
      /certificate verification bypass/iu,
    ],
    [
      'global certificate-error ignore policies',
      'out/main/tls-ignore.js',
      'session.defaultSession.setIgnoreCertificateErrors(true);',
      /certificate verification bypass/iu,
    ],
    [
      'hostname-only certificate verifiers without explicit chain validation',
      'out/main/tls-hostname-only.js',
      `
        const explicitExtraCa = process.env.WO_EXTRA_CA_CERTS;
        const fixedExtraCaHostname = 'api.example.test';
        session.defaultSession.setCertificateVerifyProc((request, callback) => {
          callback(request.hostname === fixedExtraCaHostname ? 0 : -3);
        });
      `,
      /certificate verifier/iu,
    ],
    [
      'integration certificate verifiers',
      'out/main/integration-tls.js',
      'const integrationCertificateVerifier = createPinnedVerifier();',
      /certificate verification bypass/iu,
    ],
    [
      'remote renderer resources',
      'out/renderer/index.html',
      '<script src="https://cdn.example.invalid/app.js"></script>',
      /remote renderer resource/iu,
    ],
    [
      'remote CSS resources',
      'out/renderer/assets/app.css',
      '.avatar { background: url(//cdn.example.invalid/avatar.png); }',
      /remote renderer resource/iu,
    ],
    ['source map files', 'out/main/index.js.map', '{}', /source map/iu],
    [
      'bundled runtime dependencies',
      'node_modules/example/index.js',
      "module.exports = 'unused';",
      /node_modules runtime dependency/iu,
    ],
    [
      'embedded private keys',
      'secrets/client.pem',
      '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      /private key/iu,
    ],
    [
      'encrypted PKCS#8 private keys',
      'secrets/encrypted-client.pem',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nsecret\n-----END ENCRYPTED PRIVATE KEY-----',
      /private key/iu,
    ],
    [
      'renderer Node built-in imports',
      'out/renderer/assets/app.js',
      "import fs from 'node:fs'; console.info(fs);",
      /renderer.*Node|Node built-in/iu,
    ],
    [
      'Apple API private keys',
      'secrets/AuthKey.p8',
      'private-key-bytes',
      /private key/iu,
    ],
  ])('rejects %s', async (_name, path, contents, expectedMessage) => {
    const packageDirectory = await makePackage({ files: { [path]: contents } });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(expectedMessage);
  });

  it('allows a guarded fixed-host extra-CA verifier in the production package', async () => {
    const packageDirectory = await makePackage({
      files: {
        'out/main/extra-ca.js': `
          const configuredExtraCas = loadPem(process.env.WO_EXTRA_CA_CERTS);
          if (configuredExtraCas.length === 0) {
            throw new TypeError('At least one explicit extra CA is required');
          }
          if (configuredApiHostname.length === 0) {
            throw new TypeError('At least one fixed extra CA hostname is required');
          }
          function verifyCertificateChain(certificate, configuredRoot, hostname) {
            const leaf = parseCertificate(certificate);
            return leaf.checkHost(hostname) &&
              leaf.checkIssued(configuredRoot) &&
              leaf.verify(configuredRoot.publicKey);
          }
          if (configuredExtraCas.length > 0) {
            session.defaultSession.setCertificateVerifyProc((request, callback) => {
              const fixedHostname = request.hostname === configuredApiHostname;
              const authorityInvalid =
                request.verificationResult === 'ERR_CERT_AUTHORITY_INVALID';
              const chainValid = verifyCertificateChain(
                request.certificate,
                configuredExtraCas[0],
                request.hostname,
              );
              callback(fixedHostname && authorityInvalid && chainValid ? 0 : -3);
            });
          }
        `,
      },
    });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).toBe(0);
    expect(commandOutput(result)).toMatch(/DESKTOP_PACKAGE_VERIFIED/u);
  });

  it('scans private-key files outside app.asar', async () => {
    const packageDirectory = await makePackage({
      outsideFiles: {
        'resources/AuthKey.p8': 'private-key-bytes',
      },
    });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/private key/iu);
  });

  it('does not text-scan extensionless native binaries', async () => {
    const packageDirectory = await makePackage({
      outsideFiles: {
        'win-unpacked/runtime-binary':
          '\u0000rejectUnauthorized = false\u0000native-runtime',
      },
    });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).toBe(0);
  });

  it('streams sensitive-content scanning for text files larger than 20 MiB', async () => {
    const packageDirectory = await makePackage();
    const largePem = join(packageDirectory, 'resources', 'large-secret.pem');
    await mkdir(join(largePem, '..'), { recursive: true });
    const handle = await open(largePem, 'w');
    try {
      await handle.write(
        '-----BEGIN ENCRYPTED PRIVATE KEY-----\nsecret\n',
        0,
        'utf8',
      );
      await handle.truncate(20 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/private key/iu);
  });

  it('requires the production main entry inside app.asar', async () => {
    const packageDirectory = await makePackage({
      main: 'out/main/index.acceptance.js',
    });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(/production main entry/iu);
  });

  it('enforces unsigned-development artifact marking in both directions', async () => {
    const signedDirectory = await makePackage({ artifactClass: 'signed' });
    const unsignedResult = runVerifier([
      `--package-dir=${signedDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);
    expect(unsignedResult.status).not.toBe(0);
    expect(commandOutput(unsignedResult)).toMatch(
      /unsigned-development marker/iu,
    );

    await writeFile(
      join(signedDirectory, 'UNSIGNED-DEVELOPMENT.txt'),
      'UNSIGNED_DEVELOPMENT_ONLY\n',
    );
    const signedResult = runVerifier([
      `--package-dir=${signedDirectory}`,
      '--platform=win',
      '--artifact-class=signed',
      ...signedWindowsIdentityArguments,
    ]);
    expect(signedResult.status).not.toBe(0);
    expect(commandOutput(signedResult)).toMatch(/signed package.*marker/iu);
  });

  it('rejects missing app.asar archives and unknown arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wo-package-gate-empty-'));
    temporaryDirectories.push(root);
    const missingArchive = runVerifier([
      `--package-dir=${root}`,
      '--platform=win',
      '--artifact-class=signed',
      ...signedWindowsIdentityArguments,
    ]);
    expect(missingArchive.status).not.toBe(0);
    expect(commandOutput(missingArchive)).toMatch(/app\.asar/iu);

    const unknownArgument = runVerifier([
      `--package-dir=${root}`,
      '--platform=win',
      '--artifact-class=signed',
      '--mystery',
    ]);
    expect(unknownArgument.status).not.toBe(0);
    expect(commandOutput(unknownArgument)).toMatch(
      /unknown argument.*--mystery/iu,
    );
  });

  it('requires an archive named exactly app.asar', async () => {
    const packageDirectory = await makePackage({ archiveName: 'fakeapp.asar' });
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
    ]);

    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(
      /app\.asar matrix.*none|incomplete/iu,
    );
  });

  it('rejects a Windows executable that exits before the smoke window', async () => {
    if (process.platform !== 'win32') return;

    const packageDirectory = await makePackage();
    const unpackedDirectory = join(packageDirectory, 'win-unpacked');
    await copyFile(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'),
      join(unpackedDirectory, 'WO.exe'),
    );
    await appendElectronFuseWire(join(unpackedDirectory, 'WO.exe'));

    const startedAt = Date.now();
    const result = runVerifier([
      `--package-dir=${packageDirectory}`,
      '--platform=win',
      '--artifact-class=unsigned-development',
      '--smoke',
    ]);
    expect(result.status).not.toBe(0);
    expect(commandOutput(result)).toMatch(
      /exited before.*ready acknowledgement/iu,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
