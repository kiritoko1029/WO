import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));
const builderCli = fileURLToPath(
  new URL('../node_modules/electron-builder/out/cli/cli.js', import.meta.url),
);
const viteCli = fileURLToPath(
  new URL(
    '../node_modules/electron-vite/bin/electron-vite.js',
    import.meta.url,
  ),
);
const verifyBuildScript = fileURLToPath(
  new URL('./verify-build.mjs', import.meta.url),
);
const verifyPackageScript = fileURLToPath(
  new URL('./verify-package.mjs', import.meta.url),
);
const notarizeDmgScript = fileURLToPath(
  new URL('./notarize-dmgs.mjs', import.meta.url),
);
const macBundleId = 'cn.wo.desktop';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argumentsList) {
  const options = {
    platform: undefined,
    directoryOnly: false,
    unsignedDevelopment: false,
    planOnly: false,
  };
  const seen = new Set();

  for (const argument of argumentsList) {
    const key = argument.startsWith('--platform=') ? '--platform' : argument;
    if (
      !['--platform', '--dir', '--unsigned-development', '--plan'].includes(key)
    ) {
      fail(`Unknown argument: ${argument}`);
    }
    if (seen.has(key)) fail(`Duplicate argument: ${key}`);
    seen.add(key);

    if (key === '--platform') {
      options.platform = argument.slice('--platform='.length);
    } else if (key === '--dir') {
      options.directoryOnly = true;
    } else if (key === '--unsigned-development') {
      options.unsignedDevelopment = true;
    } else if (key === '--plan') {
      options.planOnly = true;
    }
  }

  if (!options.platform) fail('Missing required argument: --platform=win|mac');
  if (!['win', 'mac'].includes(options.platform)) {
    fail(`Unsupported platform: ${options.platform}`);
  }
  if (
    options.platform === 'mac' &&
    process.platform !== 'darwin' &&
    !options.planOnly
  ) {
    fail('macOS packages require a native macOS runner');
  }
  return options;
}

function hasEnvironmentValue(name) {
  return (
    typeof process.env[name] === 'string' && process.env[name].trim() !== ''
  );
}

function hasEveryEnvironmentValue(names) {
  return names.every(hasEnvironmentValue);
}

function requireEnvironmentValue(name, label) {
  if (!hasEnvironmentValue(name)) fail(`${label} is required`);
  return process.env[name].trim();
}

function windowsReleaseIdentity() {
  const publisher = requireEnvironmentValue(
    'WO_WINDOWS_PUBLISHER_SUBJECT',
    'A pinned Windows publisher subject',
  );
  if (publisher.length > 512 || /[\0\r\n]/u.test(publisher)) {
    fail('The pinned Windows publisher subject is invalid');
  }
  const thumbprint = requireEnvironmentValue(
    'WO_WINDOWS_CERTIFICATE_THUMBPRINT',
    'A pinned Windows certificate thumbprint',
  )
    .replaceAll(':', '')
    .replaceAll(' ', '')
    .toUpperCase();
  if (!/^[A-F0-9]{40}$/u.test(thumbprint)) {
    fail('The pinned Windows certificate thumbprint is invalid');
  }
  return Object.freeze({ publisher, thumbprint });
}

function macReleaseIdentity() {
  const teamId = requireEnvironmentValue(
    'WO_MAC_TEAM_ID',
    'A pinned macOS Team ID',
  ).toUpperCase();
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    fail('The pinned macOS Team ID is invalid');
  }
  return Object.freeze({ teamId, bundleId: macBundleId });
}

function assertSigningEnvironment(platform) {
  if (platform === 'win') {
    const identityNames = ['WIN_CSC_LINK', 'CSC_LINK'];
    if (!identityNames.some(hasEnvironmentValue)) {
      fail(
        'A Windows signing identity is required. Configure WIN_CSC_LINK/CSC_LINK, or use --unsigned-development for a non-distributable build.',
      );
    }
    return windowsReleaseIdentity();
  }

  if (!['CSC_LINK', 'CSC_NAME'].some(hasEnvironmentValue)) {
    fail(
      'A macOS signing identity is required. Configure CSC_LINK or CSC_NAME, or use --unsigned-development for a non-distributable build.',
    );
  }
  const hasAppleId = hasEveryEnvironmentValue([
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]);
  const hasApiKey = hasEveryEnvironmentValue([
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
  ]);
  const hasKeychainProfile = hasEnvironmentValue('APPLE_KEYCHAIN_PROFILE');
  if (!hasAppleId && !hasApiKey && !hasKeychainProfile) {
    fail(
      'macOS signed packages require complete Apple notarization credentials',
    );
  }
  return macReleaseIdentity();
}

function assertManagedOutputDirectory(path) {
  const relativePath = relative(desktopDirectory, path);
  if (
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    !relativePath.startsWith(`dist${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    fail(
      `Refusing to manage output outside the desktop dist directory: ${path}`,
    );
  }
}

function createPlan(options, releaseIdentity) {
  const artifactClass = options.unsignedDevelopment
    ? 'unsigned-development'
    : 'signed';
  const architectures = options.platform === 'mac' ? ['x64', 'arm64'] : ['x64'];
  const targets = options.directoryOnly
    ? ['dir']
    : options.platform === 'mac'
      ? ['dmg', 'zip']
      : ['nsis', 'portable'];
  const outputDirectory = join('dist', artifactClass, options.platform);
  const absoluteOutputDirectory = resolve(desktopDirectory, outputDirectory);
  assertManagedOutputDirectory(absoluteOutputDirectory);

  const builderArguments = [
    builderCli,
    '--config=electron-builder.yml',
    options.platform === 'mac' ? '--mac' : '--win',
    ...architectures.map((architecture) => `--${architecture}`),
    ...(options.directoryOnly ? ['--dir'] : []),
    `--config.directories.output=${outputDirectory}`,
  ];
  if (options.unsignedDevelopment) {
    builderArguments.push('--config.forceCodeSigning=false');
    if (options.platform === 'mac') {
      builderArguments.push(
        '--config.mac.identity=null',
        '--config.mac.notarize=false',
        '--config.mac.artifactName=WO-${version}-UNSIGNED-DEVELOPMENT-mac-${arch}.${ext}',
      );
    } else {
      builderArguments.push(
        '--config.win.signExecutable=false',
        '--config.nsis.artifactName=WO-${version}-UNSIGNED-DEVELOPMENT-setup-${arch}.${ext}',
        '--config.portable.artifactName=WO-${version}-UNSIGNED-DEVELOPMENT-portable-${arch}.${ext}',
      );
    }
  }

  const verifyArguments = [
    verifyPackageScript,
    `--package-dir=${absoluteOutputDirectory}`,
    `--platform=${options.platform}`,
    `--artifact-class=${artifactClass}`,
    `--target-set=${options.directoryOnly ? 'dir' : 'artifacts'}`,
    '--smoke',
  ];
  if (releaseIdentity !== null) {
    if (options.platform === 'win') {
      verifyArguments.push(
        `--expected-win-publisher=${releaseIdentity.publisher}`,
        `--expected-win-thumbprint=${releaseIdentity.thumbprint}`,
      );
    } else {
      verifyArguments.push(
        `--expected-mac-team-id=${releaseIdentity.teamId}`,
        `--expected-mac-bundle-id=${releaseIdentity.bundleId}`,
      );
    }
  }

  const commands = [
    { executable: process.execPath, args: [viteCli, 'build'] },
    { executable: process.execPath, args: [verifyBuildScript] },
    { executable: process.execPath, args: builderArguments },
    ...(options.platform === 'mac' &&
    !options.directoryOnly &&
    !options.unsignedDevelopment
      ? [
          {
            executable: process.execPath,
            args: [
              notarizeDmgScript,
              `--package-dir=${absoluteOutputDirectory}`,
            ],
          },
        ]
      : []),
    {
      executable: process.execPath,
      args: verifyArguments,
    },
  ];

  return {
    artifactClass,
    platform: options.platform,
    architectures,
    targets,
    outputDirectory,
    markerPath: options.unsignedDevelopment
      ? join(outputDirectory, 'UNSIGNED-DEVELOPMENT.txt')
      : null,
    commands,
  };
}

function runCommand(command) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.args, {
      cwd: desktopDirectory,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            signal
              ? `Package command terminated by signal ${signal}`
              : `Package command exited with code ${String(code)}`,
          ),
        );
      }
    });
  });
}

async function executePlan(plan) {
  const absoluteOutputDirectory = resolve(
    desktopDirectory,
    plan.outputDirectory,
  );
  assertManagedOutputDirectory(absoluteOutputDirectory);
  await rm(absoluteOutputDirectory, { recursive: true, force: true });

  for (const [index, command] of plan.commands.entries()) {
    if (index === plan.commands.length - 1 && plan.markerPath) {
      await mkdir(absoluteOutputDirectory, { recursive: true });
      await writeFile(
        resolve(desktopDirectory, plan.markerPath),
        'UNSIGNED_DEVELOPMENT_ONLY\nDo not distribute this artifact.\n',
      );
    }
    await runCommand(command);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const releaseIdentity = options.unsignedDevelopment
    ? null
    : assertSigningEnvironment(options.platform);
  const plan = createPlan(options, releaseIdentity);
  if (options.planOnly) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else {
    if (options.unsignedDevelopment) {
      console.info(
        'UNSIGNED_DEVELOPMENT_ONLY: this package is not distributable',
      );
    }
    await executePlan(plan);
  }
} catch (error) {
  console.error(
    `DESKTOP_PACKAGE_BUILD_FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
