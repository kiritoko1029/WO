import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(
  require.resolve('electron-builder/package.json'),
);
const appBuilderRequire = createRequire(
  builderRequire.resolve('app-builder-lib/package.json'),
);
const { extractAll } = appBuilderRequire('@electron/asar');
const { getCurrentFuseWire } = appBuilderRequire('@electron/fuses');
const { getPath7za } = appBuilderRequire('./out/toolsets/7zip.js');
const unsignedMarkerName = 'UNSIGNED-DEVELOPMENT.txt';
const textScanOverlapCharacters = 64 * 1024;
const keyExtensions = new Set([
  '.jks',
  '.key',
  '.p8',
  '.p12',
  '.pfx',
  '.pkcs12',
]);
const textExtensions = new Set([
  '',
  '.cjs',
  '.conf',
  '.crt',
  '.css',
  '.env',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.pem',
  '.plist',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const bareNodeBuiltins = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');
const rendererNodeImportPattern = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:node:[a-z0-9_./-]+|(?:${bareNodeBuiltins})(?:/[a-z0-9_./-]+)?)['"]`,
  'iu',
);
const smokeEnvironmentAllowlist = new Set(
  [
    'ALLUSERSPROFILE',
    'APPDATA',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'COMSPEC',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'LOGNAME',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SHELL',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
    'XDG_RUNTIME_DIR',
  ].map((name) => name.toUpperCase()),
);
const nativeEnvironmentAllowlist = new Set(
  [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'WINDIR',
  ].map((name) => name.toUpperCase()),
);
const macNativeTools = Object.freeze({
  codesign: '/usr/bin/codesign',
  ditto: '/usr/bin/ditto',
  hdiutil: '/usr/bin/hdiutil',
  lipo: '/usr/bin/lipo',
  plutil: '/usr/bin/plutil',
  spctl: '/usr/sbin/spctl',
  unzip: '/usr/bin/unzip',
  xcrun: '/usr/bin/xcrun',
});
const windowsNativeTools = Object.freeze({
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  taskkill: 'C:\\Windows\\System32\\taskkill.exe',
});
const trustedSevenZipSha256 = Object.freeze({
  'win32:x64':
    '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3',
});
const macBundleIdentifier = 'cn.wo.desktop';
const macUsageDescriptions = Object.freeze({
  NSMicrophoneUsageDescription: 'WO uses the microphone for voice calls.',
  NSScreenCaptureUsageDescription:
    'WO uses screen capture when you share your desktop.',
});
const requiredMacEntitlements = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.device.audio-input',
]);
const requiredMacInheritedEntitlements = Object.freeze(
  requiredMacEntitlements.filter(
    (value) => value !== 'com.apple.security.device.audio-input',
  ),
);
const macExecutableMagics = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);
const requiredElectronFuses = Object.freeze([
  { index: 0, label: 'RunAsNode', state: 48 },
  { index: 1, label: 'EnableCookieEncryption', state: 49 },
  { index: 2, label: 'EnableNodeOptionsEnvironmentVariable', state: 48 },
  { index: 3, label: 'EnableNodeCliInspectArguments', state: 48 },
  { index: 4, label: 'EnableEmbeddedAsarIntegrityValidation', state: 49 },
  { index: 5, label: 'OnlyLoadAppFromAsar', state: 49 },
]);

function fail(message) {
  throw new Error(message);
}

export function parseArguments(argumentsList) {
  const options = {
    packageDirectory: undefined,
    platform: undefined,
    artifactClass: undefined,
    targetSet: undefined,
    smoke: false,
    expectedWinPublisher: undefined,
    expectedWinThumbprint: undefined,
    expectedMacTeamId: undefined,
    expectedMacBundleId: undefined,
  };
  const seen = new Set();

  for (const argument of argumentsList) {
    let key = argument;
    if (argument.startsWith('--package-dir=')) key = '--package-dir';
    if (argument.startsWith('--platform=')) key = '--platform';
    if (argument.startsWith('--artifact-class=')) key = '--artifact-class';
    if (argument.startsWith('--target-set=')) key = '--target-set';
    if (argument.startsWith('--expected-win-publisher='))
      key = '--expected-win-publisher';
    if (argument.startsWith('--expected-win-thumbprint='))
      key = '--expected-win-thumbprint';
    if (argument.startsWith('--expected-mac-team-id='))
      key = '--expected-mac-team-id';
    if (argument.startsWith('--expected-mac-bundle-id='))
      key = '--expected-mac-bundle-id';
    if (
      ![
        '--package-dir',
        '--platform',
        '--artifact-class',
        '--target-set',
        '--expected-win-publisher',
        '--expected-win-thumbprint',
        '--expected-mac-team-id',
        '--expected-mac-bundle-id',
        '--smoke',
      ].includes(key)
    ) {
      fail(`Unknown argument: ${argument}`);
    }
    if (seen.has(key)) fail(`Duplicate argument: ${key}`);
    seen.add(key);

    if (key === '--package-dir') {
      options.packageDirectory = argument.slice('--package-dir='.length);
    } else if (key === '--platform') {
      options.platform = argument.slice('--platform='.length);
    } else if (key === '--artifact-class') {
      options.artifactClass = argument.slice('--artifact-class='.length);
    } else if (key === '--target-set') {
      options.targetSet = argument.slice('--target-set='.length);
    } else if (key === '--expected-win-publisher') {
      options.expectedWinPublisher = argument.slice(
        '--expected-win-publisher='.length,
      );
    } else if (key === '--expected-win-thumbprint') {
      options.expectedWinThumbprint = argument.slice(
        '--expected-win-thumbprint='.length,
      );
    } else if (key === '--expected-mac-team-id') {
      options.expectedMacTeamId = argument.slice(
        '--expected-mac-team-id='.length,
      );
    } else if (key === '--expected-mac-bundle-id') {
      options.expectedMacBundleId = argument.slice(
        '--expected-mac-bundle-id='.length,
      );
    } else {
      options.smoke = true;
    }
  }

  if (!options.packageDirectory) {
    fail('Missing required argument: --package-dir=PATH');
  }
  if (!['win', 'mac'].includes(options.platform)) {
    fail('Missing or unsupported argument: --platform=win|mac');
  }
  if (!['signed', 'unsigned-development'].includes(options.artifactClass)) {
    fail(
      'Missing or unsupported argument: --artifact-class=signed|unsigned-development',
    );
  }
  if (!['dir', 'artifacts'].includes(options.targetSet)) {
    fail('Missing or unsupported argument: --target-set=dir|artifacts');
  }
  validateReleaseIdentity(options);
  return Object.freeze(options);
}

function normalizedThumbprint(value) {
  return typeof value === 'string'
    ? value.replaceAll(':', '').replaceAll(' ', '').toUpperCase()
    : '';
}

function validateReleaseIdentity(options) {
  if (options.artifactClass !== 'signed') return;
  if (options.platform === 'win') {
    if (
      typeof options.expectedWinPublisher !== 'string' ||
      options.expectedWinPublisher.length === 0 ||
      options.expectedWinPublisher.length > 512 ||
      /[\0\r\n]/u.test(options.expectedWinPublisher)
    ) {
      fail('Signed Windows verification requires an expected publisher');
    }
    if (
      !/^[A-F0-9]{40}$/u.test(
        normalizedThumbprint(options.expectedWinThumbprint),
      )
    ) {
      fail(
        'Signed Windows verification requires an expected certificate thumbprint',
      );
    }
    return;
  }
  if (
    typeof options.expectedMacTeamId !== 'string' ||
    !/^[A-Z0-9]{10}$/u.test(options.expectedMacTeamId)
  ) {
    fail('Signed macOS verification requires an expected Team ID');
  }
  if (
    typeof options.expectedMacBundleId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/u.test(options.expectedMacBundleId) ||
    options.expectedMacBundleId.includes('..')
  ) {
    fail('Signed macOS verification requires an expected bundle ID');
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function relativePathWithin(root, path) {
  const value = relative(root, path);
  return (
    value !== '' &&
    value !== '..' &&
    !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(value)
  );
}

async function entriesBelow(root, directory = root) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // Resolve through realpath only. Comparing unresolved link targets against
      // a non-canonical root (for example /var/folders vs /private/var/folders
      // after hdiutil mount) produces false "escaping/invalid" failures on macOS.
      const realTarget = await realpath(path).catch(() => null);
      if (realTarget === null || !relativePathWithin(root, realTarget)) {
        fail(
          `Package contains an invalid symbolic link: ${relative(root, path)}`,
        );
      }
      entries.push({ path, type: 'link' });
    } else if (entry.isDirectory()) {
      entries.push({ path, type: 'directory' });
      entries.push(...(await entriesBelow(root, path)));
    } else if (entry.isFile()) {
      entries.push({ path, type: 'file' });
    } else {
      fail(`Package contains an unsupported filesystem entry: ${path}`);
    }
  }
  return entries;
}

async function filesBelow(directory) {
  // Canonicalize the walk root so symlink containment checks stay valid when
  // tmpdir()/mount points differ from their realpath form on macOS.
  const root = await realpath(directory);
  return (await entriesBelow(root, root))
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path);
}

async function verifyArtifactMarker(packageDirectory, artifactClass) {
  const markerPath = join(packageDirectory, unsignedMarkerName);
  const hasMarker = await exists(markerPath);
  if (artifactClass === 'unsigned-development') {
    if (!hasMarker) fail('Unsigned-development marker is missing');
    const marker = await readFile(markerPath, 'utf8');
    if (!marker.includes('UNSIGNED_DEVELOPMENT_ONLY')) {
      fail('Unsigned-development marker has invalid contents');
    }
  } else if (hasMarker) {
    fail('Signed package must not contain an unsigned-development marker');
  }
}

function isRendererPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized.startsWith('out/renderer/') ||
    normalized.includes('/out/renderer/')
  );
}

function scanText(source, displayPath, runtimePath) {
  const rules = [
    {
      label: 'acceptance application identifier',
      pattern:
        /\b(?:cn|com|io|org)\.[a-z0-9._-]*acceptance[a-z0-9._-]*\b|(?:appId|setAppUserModelId|CFBundleIdentifier)[^\n]{0,120}\bacceptance\b/iu,
    },
    {
      label: 'fake media switch or entry',
      pattern:
        /use-fake-device-for-media-stream|use-file-for-fake-audio-capture|use-file-for-fake-video-capture|electron\.vite\.acceptance|index\.acceptance|fake-media/iu,
    },
    {
      label: 'diagnostic IPC endpoint',
      pattern:
        /(?:acceptance|e2e|test)[:._/-](?:diagnostics?|media[-._]?stats|stats|counters?|snapshot)|diagnostics?[:._/-](?:snapshot|counters|ipc)/iu,
    },
    {
      label: 'certificate verification bypass',
      pattern:
        /setCertificateVerifyProc|certificate-error|ignore-certificate-errors|allowInsecureLocalhost|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*[:=]\s*false|certificateVerifier/iu,
    },
    {
      label: 'source map reference',
      pattern: /(?:\/\/[#@]|\/\*#)\s*sourceMappingURL\s*=/iu,
    },
    {
      label: 'private key material',
      pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
    },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(source)) {
      fail(`Package contains ${rule.label}: ${displayPath}`);
    }
  }
  if (
    isRendererPath(runtimePath) &&
    ['.cjs', '.js', '.mjs'].includes(extname(runtimePath).toLowerCase()) &&
    rendererNodeImportPattern.test(source)
  ) {
    fail(`Package renderer contains a Node built-in import: ${displayPath}`);
  }

  const extension = extname(runtimePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    const remoteHtmlResource =
      /<(?:audio|embed|iframe|img|link|object|script|source|video)\b[^>]*(?:data|href|poster|src)\s*=\s*['"]?\s*(?:https?:)?\/\//iu;
    if (remoteHtmlResource.test(source)) {
      fail(`Package contains a remote renderer resource: ${displayPath}`);
    }
  }
  if (extension === '.css') {
    const remoteCssResource =
      /(?:url\(\s*['"]?|@import\s+(?:url\()?\s*['"]?)\s*(?:https?:)?\/\//iu;
    if (remoteCssResource.test(source)) {
      fail(`Package contains a remote renderer resource: ${displayPath}`);
    }
  }
}

async function scanTextFile(path, displayPath, runtimePath) {
  const decoder = new StringDecoder('utf8');
  let overlap = '';
  for await (const chunk of createReadStream(path, {
    highWaterMark: 256 * 1024,
  })) {
    const source = overlap + decoder.write(chunk);
    scanText(source, displayPath, runtimePath);
    overlap = source.slice(-textScanOverlapCharacters);
  }
  const finalSource = overlap + decoder.end();
  if (finalSource !== '') scanText(finalSource, displayPath, runtimePath);
}

async function shouldScanTextFile(path, extension) {
  if (!textExtensions.has(extension)) return false;
  if (extension !== '') return true;

  const file = await open(path, 'r');
  try {
    const probe = Buffer.alloc(8 * 1024);
    const { bytesRead } = await file.read(probe, 0, probe.length, 0);
    return !probe.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

async function scanRuntimeDirectory(directory, label) {
  const root = await realpath(directory);
  for (const path of await filesBelow(root)) {
    const runtimePath = relative(root, path).replaceAll('\\', '/');
    const displayPath = `${label}/${runtimePath}`;
    const extension = extname(path).toLowerCase();
    if (runtimePath.startsWith('node_modules/')) {
      fail(
        `Package contains a node_modules runtime dependency: ${displayPath}`,
      );
    }
    if (extension === '.map' || runtimePath.includes('.map.')) {
      fail(`Package contains a source map file: ${displayPath}`);
    }
    if (keyExtensions.has(extension)) {
      fail(`Package contains a private key file: ${displayPath}`);
    }
    if (!(await shouldScanTextFile(path, extension))) continue;
    await scanTextFile(path, displayPath, runtimePath);
  }
}

async function scanPackageDirectory(packageDirectory) {
  const root = await realpath(packageDirectory);
  for (const path of await filesBelow(root)) {
    const runtimePath = relative(root, path).replaceAll('\\', '/');
    const extension = extname(path).toLowerCase();
    if (extension === '.map' || runtimePath.includes('.map.')) {
      fail(`Package contains a source map file: package/${runtimePath}`);
    }
    if (keyExtensions.has(extension)) {
      fail(`Package contains a private key file: package/${runtimePath}`);
    }
    if (!(await shouldScanTextFile(path, extension))) continue;
    await scanTextFile(path, `package/${runtimePath}`, runtimePath);
  }
}

function expectedArchivePaths(platform) {
  return platform === 'win'
    ? ['win-unpacked/resources/app.asar']
    : [
        'mac/WO.app/Contents/Resources/app.asar',
        'mac-arm64/WO.app/Contents/Resources/app.asar',
      ];
}

async function findAsarArchives(packageDirectory) {
  return (await filesBelow(packageDirectory)).filter(
    (path) => basename(path).toLowerCase() === 'app.asar',
  );
}

async function verifyAsarArchives(packageDirectory, platform) {
  const archives = await findAsarArchives(packageDirectory);
  const actualPaths = archives
    .map((path) => relative(packageDirectory, path).replaceAll('\\', '/'))
    .sort();
  const expectedPaths = expectedArchivePaths(platform).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail(
      `Package app.asar matrix is incomplete or unexpected: ${actualPaths.join(', ') || 'none'}`,
    );
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'wo-package-verify-'),
  );
  const versions = new Set();
  try {
    for (const [index, archivePath] of archives.entries()) {
      const extractedDirectory = join(temporaryDirectory, String(index));
      await mkdir(extractedDirectory, { recursive: true });
      extractAll(archivePath, extractedDirectory);
      const packageJsonPath = join(extractedDirectory, 'package.json');
      if (!(await exists(packageJsonPath))) {
        fail(`app.asar is missing package.json: ${archivePath}`);
      }
      let packageJson;
      try {
        packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      } catch {
        fail(`app.asar contains an invalid package.json: ${archivePath}`);
      }
      if (packageJson.main !== 'out/main/index.js') {
        fail(
          `app.asar must use the production main entry out/main/index.js: ${archivePath}`,
        );
      }
      if (
        typeof packageJson.version !== 'string' ||
        !/^[0-9A-Za-z.+-]{1,64}$/u.test(packageJson.version)
      ) {
        fail(`app.asar contains an invalid package version: ${archivePath}`);
      }
      versions.add(packageJson.version);
      await scanRuntimeDirectory(extractedDirectory, `app.asar#${index + 1}`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (versions.size !== 1)
    fail('Packaged architectures use different versions');
  return { archives, version: [...versions][0] };
}

async function requireRegularFile(path, label) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    fail(`Package is missing required ${label}: ${path}`);
  }
}

async function requireDirectory(path, label) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    fail(`Package is missing required ${label}: ${path}`);
  }
}

async function verifyArtifactRootEntries(root, allowedNames) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (allowedNames.has(entry.name)) continue;
    if (
      /^WO-.+\.(?:exe|dmg|zip)(?:\.blockmap)?$/iu.test(entry.name) ||
      /^(?:win(?:-[a-z0-9]+)?-unpacked|mac(?:-[a-z0-9]+)?)$/iu.test(entry.name)
    ) {
      fail(`Package contains an unexpected release artifact: ${entry.name}`);
    }
  }
}

async function verifyArtifactMatrix(options, version, hostArch) {
  const root = options.packageDirectory;
  if (options.platform === 'win') {
    const allowedRootNames = new Set([
      'win-unpacked',
      'builder-debug.yml',
      'builder-effective-config.yaml',
      ...(options.artifactClass === 'unsigned-development'
        ? [unsignedMarkerName]
        : []),
    ]);
    const unpackedExecutable = join(root, 'win-unpacked', 'WO.exe');
    await requireRegularFile(
      unpackedExecutable,
      'Windows x64 unpacked executable',
    );
    const windowsExecutables = [unpackedExecutable];
    const windowsReleaseArtifacts = [];
    const smokeExecutables = [unpackedExecutable];
    if (options.targetSet === 'artifacts') {
      const releaseVersion =
        options.artifactClass === 'unsigned-development'
          ? `${version}-UNSIGNED-DEVELOPMENT`
          : version;
      const setup = join(root, `WO-${releaseVersion}-setup-x64.exe`);
      const portable = join(root, `WO-${releaseVersion}-portable-x64.exe`);
      await requireRegularFile(setup, 'Windows setup x64 release artifact');
      await requireRegularFile(
        portable,
        'Windows portable x64 release artifact',
      );
      windowsExecutables.push(setup, portable);
      windowsReleaseArtifacts.push(setup, portable);
      smokeExecutables.push(portable);
      for (const artifactPath of [setup, portable]) {
        allowedRootNames.add(basename(artifactPath));
        allowedRootNames.add(`${basename(artifactPath)}.blockmap`);
      }
    }
    await verifyArtifactRootEntries(root, allowedRootNames);
    return {
      windowsExecutables,
      windowsElectronExecutable: unpackedExecutable,
      windowsReleaseArtifacts,
      macApps: [],
      macDmgs: [],
      macZips: [],
      smokeExecutables,
    };
  }

  const x64App = join(root, 'mac', 'WO.app');
  const arm64App = join(root, 'mac-arm64', 'WO.app');
  await requireDirectory(x64App, 'macOS x64 application');
  await requireDirectory(arm64App, 'macOS arm64 application');
  const x64Executable = join(x64App, 'Contents', 'MacOS', 'WO');
  const arm64Executable = join(arm64App, 'Contents', 'MacOS', 'WO');
  await requireRegularFile(x64Executable, 'macOS x64 executable');
  await requireRegularFile(arm64Executable, 'macOS arm64 executable');
  const macDmgs = [];
  const macZips = [];
  const allowedRootNames = new Set([
    'mac',
    'mac-arm64',
    'builder-debug.yml',
    'builder-effective-config.yaml',
    ...(options.artifactClass === 'unsigned-development'
      ? [unsignedMarkerName]
      : []),
  ]);
  if (options.targetSet === 'artifacts') {
    const releaseVersion =
      options.artifactClass === 'unsigned-development'
        ? `${version}-UNSIGNED-DEVELOPMENT`
        : version;
    for (const architecture of ['x64', 'arm64']) {
      const dmg = join(root, `WO-${releaseVersion}-mac-${architecture}.dmg`);
      const zip = join(root, `WO-${releaseVersion}-mac-${architecture}.zip`);
      await requireRegularFile(
        dmg,
        `macOS ${architecture} DMG release artifact`,
      );
      await requireRegularFile(
        zip,
        `macOS ${architecture} ZIP release artifact`,
      );
      macDmgs.push({ path: dmg, architecture });
      macZips.push({ path: zip, architecture });
      for (const artifactPath of [dmg, zip]) {
        allowedRootNames.add(basename(artifactPath));
      }
      allowedRootNames.add(`${basename(zip)}.blockmap`);
    }
  }
  await verifyArtifactRootEntries(root, allowedRootNames);
  return {
    windowsExecutables: [],
    windowsElectronExecutable: null,
    windowsReleaseArtifacts: [],
    macApps: [
      { path: x64App, architecture: 'x64' },
      { path: arm64App, architecture: 'arm64' },
    ],
    macDmgs,
    macZips,
    smokeExecutables: [hostArch === 'arm64' ? arm64Executable : x64Executable],
  };
}

async function verifyWindowsX64Executable(path) {
  const handle = await open(path, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (
      dosRead.bytesRead !== dosHeader.length ||
      dosHeader.toString('ascii', 0, 2) !== 'MZ'
    ) {
      fail(`Windows executable has an invalid PE header: ${basename(path)}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 64 * 1024 * 1024) {
      fail(`Windows executable has an invalid PE offset: ${basename(path)}`);
    }
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (
      peRead.bytesRead !== peHeader.length ||
      peHeader.toString('binary', 0, 4) !== 'PE\0\0'
    ) {
      fail(`Windows executable has an invalid PE signature: ${basename(path)}`);
    }
    if (peHeader.readUInt16LE(4) !== 0x8664) {
      fail(`Windows executable is not x64: ${basename(path)}`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyElectronFuses(path, reader) {
  let wire;
  try {
    wire = await reader(path);
  } catch {
    fail(`Electron fuse wire could not be read: ${basename(path)}`);
  }
  if (wire.version !== '1') {
    fail(`Electron fuse wire version is unsupported: ${basename(path)}`);
  }
  for (const fuse of requiredElectronFuses) {
    if (wire[fuse.index] !== fuse.state) {
      fail(
        `Electron fuse ${fuse.label} has an unsafe state: ${basename(path)}`,
      );
    }
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function resolveTrustedSevenZip(dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const override = Object.entries(environment).find(
    ([name, value]) =>
      name.toUpperCase() === 'ELECTRON_BUILDER_7ZIP_PATH' &&
      typeof value === 'string' &&
      value !== '',
  );
  if (override !== undefined) {
    fail('7-Zip executable selection through the environment is forbidden');
  }
  const hostPlatform = dependencies.platform ?? process.platform;
  const hostArchitecture = dependencies.architecture ?? process.arch;
  const expectedHash =
    dependencies.expectedSha256 ??
    trustedSevenZipSha256[`${hostPlatform}:${hostArchitecture}`];
  if (expectedHash === undefined) {
    fail(
      `No trusted 7-Zip binary is pinned for ${hostPlatform}/${hostArchitecture}`,
    );
  }
  const candidate = await (dependencies.getPath7za ?? getPath7za)();
  if (!isAbsolute(candidate)) fail('7-Zip executable path is not absolute');
  await requireRegularFile(candidate, 'trusted 7-Zip executable');
  const canonicalPath = await realpath(candidate);
  if (canonicalPath !== resolve(candidate)) {
    fail('7-Zip executable path is not canonical');
  }
  const actualHash = await (dependencies.hashFile ?? fileSha256)(canonicalPath);
  if (actualHash !== expectedHash) {
    fail('7-Zip executable hash does not match the pinned release tool');
  }
  return canonicalPath;
}

async function extractWindowsArtifactPayload(artifactPath, environment) {
  const directory = await mkdtemp(join(tmpdir(), 'wo-win-artifact-'));
  try {
    const sevenZip = await resolveTrustedSevenZip();
    await runNativeCommand(
      sevenZip,
      [
        'x',
        '-bd',
        '-y',
        `-o${directory}`,
        artifactPath,
        'WO.exe',
        'resources/app.asar',
      ],
      environment,
    );
    const executablePath = join(directory, 'WO.exe');
    const asarPath = join(directory, 'resources', 'app.asar');
    await requireRegularFile(
      executablePath,
      'Windows artifact Electron executable',
    );
    await requireRegularFile(asarPath, 'Windows artifact app.asar');
    return {
      executablePath,
      asarPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyWindowsArtifactPayloads(artifacts, extractor, fuseReader) {
  const unpackedExecutable = artifacts.windowsElectronExecutable;
  const unpackedAsar = join(
    dirname(unpackedExecutable),
    'resources',
    'app.asar',
  );
  await requireRegularFile(unpackedAsar, 'Windows unpacked app.asar');
  await verifyWindowsX64Executable(unpackedExecutable);
  await verifyElectronFuses(unpackedExecutable, fuseReader);
  const [expectedExecutableHash, expectedAsarHash] = await Promise.all([
    fileSha256(unpackedExecutable),
    fileSha256(unpackedAsar),
  ]);

  for (const artifactPath of artifacts.windowsReleaseArtifacts) {
    const payload = await extractor(artifactPath);
    try {
      await verifyWindowsX64Executable(payload.executablePath);
      await verifyElectronFuses(payload.executablePath, fuseReader);
      const [executableHash, asarHash] = await Promise.all([
        fileSha256(payload.executablePath),
        fileSha256(payload.asarPath),
      ]);
      if (
        executableHash !== expectedExecutableHash ||
        asarHash !== expectedAsarHash
      ) {
        fail(
          `Windows artifact payload differs from the unpacked application: ${basename(artifactPath)}`,
        );
      }
    } finally {
      await payload.cleanup();
    }
  }
}

function runNativeCommand(executable, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => {
      output.stdout += value;
    });
    child.stderr.on('data', (value) => {
      output.stderr += value;
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(output);
      else {
        rejectPromise(
          new Error(
            signal
              ? `${basename(executable)} terminated by signal ${signal}`
              : `${basename(executable)} exited with code ${String(code)}`,
          ),
        );
      }
    });
  });
}

async function verifyWindowsSignatures(
  executablePaths,
  runner,
  identity,
  environment,
) {
  for (const path of executablePaths) {
    let result;
    try {
      result = await readWindowsAuthenticodeSignature(
        path,
        runner,
        environment,
      );
    } catch {
      fail(
        `Windows Authenticode signature verification failed: ${basename(path)}`,
      );
    }
    if (
      result.SignerSubject.trim().toLocaleLowerCase('en-US') !==
      identity.publisher.trim().toLocaleLowerCase('en-US')
    ) {
      fail(`Windows Authenticode publisher is unexpected: ${basename(path)}`);
    }
    if (
      normalizedThumbprint(result.SignerThumbprint) !==
      normalizedThumbprint(identity.thumbprint)
    ) {
      fail(
        `Windows Authenticode certificate thumbprint is unexpected: ${basename(path)}`,
      );
    }
  }
}

export async function readWindowsAuthenticodeSignature(
  path,
  runner = runNativeCommand,
  environment = createNativeVerificationEnvironment(process.env),
) {
  const script = [
    '& {',
    'param([Parameter(Mandatory=$true)][string]$path)',
    '$signature = Get-AuthenticodeSignature -LiteralPath $path',
    '$result = [pscustomobject]@{',
    'InputPath = $path;',
    'Status = [string]$signature.Status;',
    'SignerSubject = [string]$signature.SignerCertificate.Subject;',
    'SignerThumbprint = [string]$signature.SignerCertificate.Thumbprint;',
    'TimestampSubject = [string]$signature.TimeStamperCertificate.Subject',
    '}',
    '$result | ConvertTo-Json -Compress',
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) { exit 3 }",
    '}',
  ].join('\n');
  const output = await runner(
    windowsNativeTools.powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script, path],
    trustedWindowsEnvironment(environment),
  );
  let result;
  try {
    result = JSON.parse(output.stdout.trim());
  } catch {
    fail(`Windows Authenticode returned invalid status: ${basename(path)}`);
  }
  if (
    result.InputPath !== path ||
    result.Status !== 'Valid' ||
    typeof result.SignerSubject !== 'string' ||
    result.SignerSubject === '' ||
    typeof result.SignerThumbprint !== 'string' ||
    result.SignerThumbprint === '' ||
    typeof result.TimestampSubject !== 'string' ||
    result.TimestampSubject === ''
  ) {
    fail(`Windows Authenticode signature is incomplete: ${basename(path)}`);
  }
  return Object.freeze(result);
}

function macSignatureValue(details, name) {
  const match = details.match(new RegExp(`^${name}=(.+)$`, 'mu'));
  return match?.[1]?.trim() ?? '';
}

async function readMacInfoPlist(path, runner, environment) {
  const source = await readFile(path, 'utf8').catch(() => null);
  if (source === null) fail(`macOS application is missing Info.plist: ${path}`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    const output = await runner(
      macNativeTools.plutil,
      ['-convert', 'json', '-o', '-', path],
      environment,
    );
    try {
      value = JSON.parse(output.stdout);
    } catch {
      fail(`macOS application Info.plist is invalid: ${path}`);
    }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.CFBundleIdentifier !== macBundleIdentifier ||
    value.NSMicrophoneUsageDescription !==
      macUsageDescriptions.NSMicrophoneUsageDescription ||
    value.NSScreenCaptureUsageDescription !==
      macUsageDescriptions.NSScreenCaptureUsageDescription
  ) {
    fail(
      `macOS application Info.plist has invalid bundle or usage metadata: ${path}`,
    );
  }
}

async function regularFilesWithoutFollowingLinks(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await regularFilesWithoutFollowingLinks(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      fail(`macOS application contains an unsupported entry: ${path}`);
    }
  }
  return files;
}

async function isMacExecutablePayload(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const result = await handle.read(header, 0, header.length, 0);
    return (
      result.bytesRead === header.length &&
      (macExecutableMagics.has(header.readUInt32BE(0)) ||
        macExecutableMagics.has(header.readUInt32LE(0)))
    );
  } finally {
    await handle.close();
  }
}

async function resolveMacFrameworkExecutable(appPath) {
  const canonicalAppPath = await realpath(appPath);
  const frameworkRoot = join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
  );
  const versioned = join(frameworkRoot, 'Versions', 'A', 'Electron Framework');
  const versionedStats = await lstat(versioned).catch(() => null);
  const alias = join(frameworkRoot, 'Electron Framework');
  const aliasStats = await lstat(alias).catch(() => null);
  if (
    aliasStats === null ||
    (!aliasStats.isFile() && !aliasStats.isSymbolicLink())
  ) {
    fail('macOS application is missing its Electron Framework executable');
  }
  const canonical = await realpath(alias).catch(() => null);
  if (canonical === null) {
    fail('macOS application is missing its Electron Framework executable');
  }
  const relativeTarget = relative(canonicalAppPath, canonical);
  if (
    relativeTarget === '' ||
    relativeTarget.split(/[\\/]/u)[0] === '..' ||
    isAbsolute(relativeTarget)
  ) {
    fail('macOS Electron Framework resolves outside the application');
  }
  await requireRegularFile(canonical, 'macOS Electron Framework executable');
  if (versionedStats?.isFile() && !versionedStats.isSymbolicLink()) {
    const canonicalVersioned = await realpath(versioned);
    const [aliasIdentity, versionedIdentity] = await Promise.all([
      stat(canonical),
      stat(canonicalVersioned),
    ]);
    if (
      canonical !== canonicalVersioned &&
      (aliasIdentity.dev !== versionedIdentity.dev ||
        aliasIdentity.ino !== versionedIdentity.ino)
    ) {
      fail(
        'macOS Electron Framework alias does not resolve to the versioned executable',
      );
    }
  }
  return canonical;
}

async function macApplicationPayloads(appPath) {
  const main = join(appPath, 'Contents', 'MacOS', 'WO');
  await requireRegularFile(main, 'macOS application executable');
  const framework = await resolveMacFrameworkExecutable(appPath);
  const payloads = new Set([main, framework]);
  const helperApplications = new Set();
  for (const path of await regularFilesWithoutFollowingLinks(appPath)) {
    const runtimePath = relative(appPath, path).replaceAll('\\', '/');
    const helper =
      /^Contents\/Frameworks\/(.*\.app)\/Contents\/MacOS\/[^/]+$/u.exec(
        runtimePath,
      );
    if (helper !== null) {
      helperApplications.add(
        join(appPath, 'Contents', 'Frameworks', helper[1]),
      );
      payloads.add(path);
    } else if (await isMacExecutablePayload(path)) {
      payloads.add(path);
    }
  }
  return Object.freeze({
    payloads: Object.freeze([...payloads]),
    helperApplications: Object.freeze([...helperApplications]),
  });
}

function hasTruePlistKey(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`, 'u').test(
    source,
  );
}

async function readMacEntitlements(bundlePath, runner, environment) {
  const output = await runner(
    macNativeTools.codesign,
    ['-d', '--entitlements', ':-', bundlePath],
    environment,
  );
  return `${output.stdout}\n${output.stderr}`;
}

function verifyMacEntitlements(source, required, bundlePath) {
  for (const entitlement of required) {
    if (!hasTruePlistKey(source, entitlement)) {
      fail(
        `macOS application is missing required entitlement ${entitlement}: ${basename(bundlePath)}`,
      );
    }
  }
}

function verifyMacRuntimeIdentity(details, identity, bundlePath, bundleId) {
  if (
    /Signature=adhoc/iu.test(details) ||
    /TeamIdentifier=not set/iu.test(details) ||
    !/Authority=Developer ID Application:/iu.test(details)
  ) {
    fail(
      `macOS application is not Developer ID signed: ${basename(bundlePath)}`,
    );
  }
  if (macSignatureValue(details, 'TeamIdentifier') !== identity.teamId) {
    fail(`macOS application Team ID is unexpected: ${basename(bundlePath)}`);
  }
  if (
    bundleId !== null &&
    macSignatureValue(details, 'Identifier') !== bundleId
  ) {
    fail(`macOS application bundle ID is unexpected: ${basename(bundlePath)}`);
  }
  if (!/\bflags=0x[0-9a-f]+\([^\r\n)]*\bruntime\b[^\r\n)]*\)/iu.test(details)) {
    fail(
      `macOS application is missing hardened runtime: ${basename(bundlePath)}`,
    );
  }
}

async function verifyMacApplication(
  app,
  runner,
  identity,
  environment,
  fuseReader,
) {
  await verifyElectronFuses(app.path, fuseReader);
  await readMacInfoPlist(
    join(app.path, 'Contents', 'Info.plist'),
    runner,
    environment,
  );
  const applicationPayloads = await macApplicationPayloads(app.path);
  const executablePath = join(app.path, 'Contents', 'MacOS', 'WO');
  const expectedArchitecture = app.architecture === 'x64' ? 'x86_64' : 'arm64';
  for (const payloadPath of applicationPayloads.payloads) {
    const architecture = await runner(
      macNativeTools.lipo,
      ['-archs', payloadPath],
      environment,
    );
    const actualArchitectures = architecture.stdout.trim().split(/\s+/u);
    if (
      actualArchitectures.length !== 1 ||
      actualArchitectures[0] !== expectedArchitecture
    ) {
      fail(
        `macOS ${app.architecture} application contains a mismatched architecture: ${relative(app.path, payloadPath)}`,
      );
    }
  }

  await runner(
    macNativeTools.codesign,
    ['--verify', '--deep', '--strict', '--verbose=2', app.path],
    environment,
  );
  if (identity === null) return executablePath;

  const details = await runner(
    macNativeTools.codesign,
    ['-dv', '--verbose=4', app.path],
    environment,
  );
  const detailText = `${details.stdout}\n${details.stderr}`;
  verifyMacRuntimeIdentity(detailText, identity, app.path, identity.bundleId);
  verifyMacEntitlements(
    await readMacEntitlements(app.path, runner, environment),
    requiredMacEntitlements,
    app.path,
  );
  for (const helperPath of applicationPayloads.helperApplications) {
    await runner(
      macNativeTools.codesign,
      ['--verify', '--strict', '--verbose=2', helperPath],
      environment,
    );
    const helperDetails = await runner(
      macNativeTools.codesign,
      ['-dv', '--verbose=4', helperPath],
      environment,
    );
    verifyMacRuntimeIdentity(
      `${helperDetails.stdout}\n${helperDetails.stderr}`,
      identity,
      helperPath,
      null,
    );
    verifyMacEntitlements(
      await readMacEntitlements(helperPath, runner, environment),
      requiredMacInheritedEntitlements,
      helperPath,
    );
  }
  await runner(
    macNativeTools.spctl,
    ['--assess', '--type', 'execute', '--verbose=4', app.path],
    environment,
  );
  await runner(
    macNativeTools.xcrun,
    ['stapler', 'validate', app.path],
    environment,
  );
  return executablePath;
}

async function verifyMacZipRoot(directory, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0].name !== 'WO.app' ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink()
  ) {
    fail(`macOS ZIP archive has unexpected top-level content: ${label}`);
  }
}

async function verifyMacDmgRoot(directory, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  const app = entries.find((entry) => entry.name === 'WO.app');
  if (app === undefined || !app.isDirectory() || app.isSymbolicLink()) {
    fail(`macOS DMG archive is missing its application: ${label}`);
  }
  const allowedMetadata = new Map([
    ['.background', 'directory'],
    ['.background.tiff', 'file'],
    ['.DS_Store', 'file'],
    ['.VolumeIcon.icns', 'file'],
  ]);
  for (const entry of entries) {
    if (entry.name === 'WO.app') continue;
    if (entry.name === 'Applications') {
      if (
        !entry.isSymbolicLink() ||
        (await readlink(join(directory, entry.name))) !== '/Applications'
      ) {
        fail(`macOS DMG Applications link is invalid: ${label}`);
      }
      continue;
    }
    const expectedType = allowedMetadata.get(entry.name);
    if (
      expectedType === undefined ||
      entry.isSymbolicLink() ||
      (expectedType === 'directory' && !entry.isDirectory()) ||
      (expectedType === 'file' && !entry.isFile())
    ) {
      fail(`macOS DMG archive has unexpected top-level content: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      await scanRuntimeDirectory(
        join(directory, entry.name),
        `${label}/${entry.name}`,
      );
    }
  }
}

async function verifyMacArtifacts(
  artifacts,
  runner,
  identity,
  environment,
  archiveSmokeRunner,
  hostArchitecture,
  fuseReader,
) {
  const expectedAsarHashes = new Map();
  for (const app of artifacts.macApps) {
    const asarPath = join(app.path, 'Contents', 'Resources', 'app.asar');
    await requireRegularFile(asarPath, `macOS ${app.architecture} app.asar`);
    expectedAsarHashes.set(app.architecture, await fileSha256(asarPath));
    await verifyMacApplication(app, runner, identity, environment, fuseReader);
  }
  for (const dmg of artifacts.macDmgs) {
    if (identity !== null) {
      await runner(
        macNativeTools.xcrun,
        ['stapler', 'validate', dmg.path],
        environment,
      );
      await runner(
        macNativeTools.spctl,
        [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          '--verbose=4',
          dmg.path,
        ],
        environment,
      );
    }
    await runner(macNativeTools.hdiutil, ['verify', dmg.path], environment);
    const mountPoint = await mkdtemp(join(tmpdir(), 'wo-dmg-mount-'));
    let attached = false;
    try {
      await runner(
        macNativeTools.hdiutil,
        [
          'attach',
          '-readonly',
          '-nobrowse',
          '-noautoopen',
          '-mountpoint',
          mountPoint,
          dmg.path,
        ],
        environment,
      );
      attached = true;
      await verifyMacDmgRoot(mountPoint, basename(dmg.path));
      const appPath = join(mountPoint, 'WO.app');
      await requireDirectory(
        appPath,
        `macOS ${dmg.architecture} DMG application`,
      );
      await scanRuntimeDirectory(appPath, `${basename(dmg.path)}/WO.app`);
      const executablePath = await verifyMacApplication(
        { path: appPath, architecture: dmg.architecture },
        runner,
        identity,
        environment,
        fuseReader,
      );
      const asarHash = await fileSha256(
        join(appPath, 'Contents', 'Resources', 'app.asar'),
      );
      if (asarHash !== expectedAsarHashes.get(dmg.architecture)) {
        fail(`macOS DMG app.asar payload differs: ${basename(dmg.path)}`);
      }
      if (
        archiveSmokeRunner !== null &&
        dmg.architecture === hostArchitecture
      ) {
        await archiveSmokeRunner(executablePath);
      }
    } finally {
      if (attached) {
        await runner(
          macNativeTools.hdiutil,
          ['detach', mountPoint],
          environment,
        );
      }
      await rm(mountPoint, { recursive: true, force: true });
    }
  }
  for (const zip of artifacts.macZips) {
    await runner(macNativeTools.unzip, ['-tq', zip.path], environment);
    const extractedDirectory = await mkdtemp(join(tmpdir(), 'wo-zip-verify-'));
    try {
      await runner(
        macNativeTools.ditto,
        ['-x', '-k', zip.path, extractedDirectory],
        environment,
      );
      await verifyMacZipRoot(extractedDirectory, basename(zip.path));
      const appPath = join(extractedDirectory, 'WO.app');
      await requireDirectory(
        appPath,
        `macOS ${zip.architecture} ZIP application`,
      );
      await scanRuntimeDirectory(appPath, `${basename(zip.path)}/WO.app`);
      const executablePath = await verifyMacApplication(
        { path: appPath, architecture: zip.architecture },
        runner,
        identity,
        environment,
        fuseReader,
      );
      const asarHash = await fileSha256(
        join(appPath, 'Contents', 'Resources', 'app.asar'),
      );
      if (asarHash !== expectedAsarHashes.get(zip.architecture)) {
        fail(`macOS ZIP app.asar payload differs: ${basename(zip.path)}`);
      }
      if (
        archiveSmokeRunner !== null &&
        zip.architecture === hostArchitecture
      ) {
        await archiveSmokeRunner(executablePath);
      }
    } finally {
      await rm(extractedDirectory, { recursive: true, force: true });
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

export function createSmokeEnvironment(baseEnvironment, smoke) {
  const environment = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (
      typeof value === 'string' &&
      smokeEnvironmentAllowlist.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return Object.freeze({
    ...environment,
    WO_API_ORIGIN: 'https://localhost',
    WO_PACKAGE_SMOKE: '1',
    WO_PACKAGE_SMOKE_NONCE: smoke.nonce,
    WO_PACKAGE_SMOKE_PATH: smoke.readyPath,
  });
}

export function createNativeVerificationEnvironment(baseEnvironment) {
  const environment = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (
      typeof value === 'string' &&
      nativeEnvironmentAllowlist.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  if (process.platform === 'win32') {
    Object.assign(environment, {
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    });
  }
  return Object.freeze(environment);
}

async function settlesWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function smokeChildIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function trustedWindowsEnvironment(baseEnvironment) {
  return Object.freeze({
    ...baseEnvironment,
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    SystemRoot: 'C:\\Windows',
    SYSTEMROOT: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
  });
}

function mergeTrackedProcesses(...groups) {
  const unique = new Map();
  for (const process of groups.flat()) {
    unique.set(`${String(process.pid)}:${process.creationTicks}`, process);
  }
  return Object.freeze([...unique.values()]);
}

function validatedProcessIdentities(processes, label) {
  if (
    !Array.isArray(processes) ||
    processes.length > 512 ||
    processes.some(
      (process) =>
        typeof process !== 'object' ||
        process === null ||
        !Number.isSafeInteger(process.pid) ||
        process.pid < 1 ||
        typeof process.creationTicks !== 'string' ||
        !/^\d{1,20}$/u.test(process.creationTicks),
    )
  ) {
    fail(`${label} is invalid`);
  }
  return Object.freeze(
    processes.map((process) =>
      Object.freeze({
        pid: process.pid,
        creationTicks: process.creationTicks,
      }),
    ),
  );
}

async function captureWindowsSmokeProcesses(child, dependencies) {
  if (dependencies.captureProcessTree !== undefined) {
    return validatedProcessIdentities(
      await dependencies.captureProcessTree(child.pid),
      'Packaged application process-tree evidence',
    );
  }
  if (
    (dependencies.platform ?? process.platform) !== 'win32' ||
    typeof child.pid !== 'number'
  ) {
    return Object.freeze([]);
  }
  const environment = trustedWindowsEnvironment(
    dependencies.environment ??
      createNativeVerificationEnvironment(process.env),
  );
  const profile = Buffer.from(
    dependencies.windowsProfilePath ?? '',
    'utf8',
  ).toString('base64');
  const expectedRootCreationTicks =
    dependencies.expectedRootCreationTicks ?? '';
  if (!/^\d{0,20}$/u.test(expectedRootCreationTicks)) {
    fail('Packaged application root process identity is invalid');
  }
  const script = [
    `$root = [uint32]${String(child.pid)}`,
    `$expectedRootCreationTicks = '${expectedRootCreationTicks}'`,
    `$profile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${profile}'))`,
    '$all = @(Get-CimInstance Win32_Process)',
    '$ids = [System.Collections.Generic.HashSet[uint32]]::new()',
    '$rootProcess = @($all | Where-Object { [uint32]$_.ProcessId -eq $root } | Select-Object -First 1)',
    'if ($rootProcess.Count -gt 0 -and ($expectedRootCreationTicks.Length -eq 0 -or [string]$rootProcess[0].CreationDate.ToUniversalTime().Ticks -eq $expectedRootCreationTicks)) { [void]$ids.Add($root) }',
    '$changed = $true',
    'while ($changed) {',
    '$changed = $false',
    'foreach ($process in $all) {',
    'if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }',
    '}',
    '}',
    '$selected = @($all | Where-Object {',
    '$ids.Contains([uint32]$_.ProcessId) -or ($profile.Length -gt 0 -and $null -ne $_.CommandLine -and $_.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0)',
    '})',
    '$result = @($selected | ForEach-Object {',
    '[pscustomobject]@{ ProcessId = [uint32]$_.ProcessId; CreationTicks = [string]$_.CreationDate.ToUniversalTime().Ticks }',
    '})',
    '[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))',
  ].join('\n');
  let output;
  try {
    output = await (dependencies.runNativeCommand ?? runNativeCommand)(
      windowsNativeTools.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      environment,
    );
  } catch {
    fail('Could not capture the packaged application process tree');
  }
  let parsed;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    fail('Packaged application process-tree evidence is invalid');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 512 ||
    parsed.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        !Number.isSafeInteger(entry.ProcessId) ||
        entry.ProcessId < 1 ||
        typeof entry.CreationTicks !== 'string' ||
        !/^\d{1,20}$/u.test(entry.CreationTicks),
    )
  ) {
    fail('Packaged application process-tree evidence is invalid');
  }
  return validatedProcessIdentities(
    parsed.map((entry) => ({
      pid: entry.ProcessId,
      creationTicks: entry.CreationTicks,
    })),
    'Packaged application process-tree evidence',
  );
}

async function survivingWindowsSmokeProcesses(trackedProcesses, dependencies) {
  const expected = validatedProcessIdentities(
    trackedProcesses,
    'Packaged application tracked process identities',
  );
  if (expected.length === 0) return expected;
  let survivors;
  if (dependencies.probeProcessIdentities !== undefined) {
    survivors = validatedProcessIdentities(
      await dependencies.probeProcessIdentities(expected),
      'Packaged application surviving process identities',
    );
  } else {
    const environment = trustedWindowsEnvironment(
      dependencies.environment ??
        createNativeVerificationEnvironment(process.env),
    );
    const encodedExpected = Buffer.from(
      JSON.stringify(
        expected.map((process) => ({
          ProcessId: process.pid,
          CreationTicks: process.creationTicks,
        })),
      ),
      'utf8',
    ).toString('base64');
    const script = [
      `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedExpected}'))`,
      '$expected = @(ConvertFrom-Json -InputObject $json)',
      '$survivors = @($expected | ForEach-Object {',
      '$candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ProcessId)"',
      'if ($null -ne $candidate -and [string]$candidate.CreationDate.ToUniversalTime().Ticks -eq [string]$_.CreationTicks) {',
      '[pscustomobject]@{ ProcessId = [uint32]$candidate.ProcessId; CreationTicks = [string]$_.CreationTicks }',
      '}',
      '})',
      '[Console]::Out.Write((ConvertTo-Json -InputObject $survivors -Compress))',
    ].join('\n');
    let output;
    try {
      output = await (dependencies.runNativeCommand ?? runNativeCommand)(
        windowsNativeTools.powershell,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        environment,
      );
    } catch {
      fail('Could not verify packaged application process identities');
    }
    let parsed;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      fail('Packaged application process identity probe is invalid');
    }
    if (!Array.isArray(parsed)) {
      fail('Packaged application process identity probe is invalid');
    }
    survivors = validatedProcessIdentities(
      parsed.map((entry) => ({
        pid: entry.ProcessId,
        creationTicks: entry.CreationTicks,
      })),
      'Packaged application process identity probe',
    );
  }
  const expectedKeys = new Set(
    expected.map(
      (process) => `${String(process.pid)}:${process.creationTicks}`,
    ),
  );
  if (
    survivors.some(
      (process) =>
        !expectedKeys.has(`${String(process.pid)}:${process.creationTicks}`),
    )
  ) {
    fail('Packaged application process identity probe is inconsistent');
  }
  return survivors;
}

async function signalSmokeProcessTree(
  child,
  force,
  dependencies,
  trackedProcesses,
) {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32' && typeof child.pid === 'number') {
    const environment = trustedWindowsEnvironment(
      dependencies.environment ??
        createNativeVerificationEnvironment(process.env),
    );
    const taskkill = windowsNativeTools.taskkill;
    let signaled = false;
    for (const identity of trackedProcesses) {
      const survivors = await survivingWindowsSmokeProcesses(
        [identity],
        dependencies,
      );
      if (survivors.length === 0) continue;
      const args = ['/PID', String(identity.pid), '/T'];
      if (force) args.push('/F');
      try {
        await (dependencies.runNativeCommand ?? runNativeCommand)(
          taskkill,
          args,
          environment,
        );
        signaled = true;
      } catch {
        // The exact identity probe below decides whether anything survived.
      }
    }
    if (signaled || !smokeChildIsRunning(child)) return;
    fail(
      'Could not verify the packaged application process before termination',
    );
  } else if (typeof child.pid === 'number') {
    try {
      const killProcessGroup =
        dependencies.killProcessGroup ??
        ((pid, signal) => process.kill(-pid, signal));
      killProcessGroup(child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      if (!smokeChildIsRunning(child)) return;
    }
  }
  if (smokeChildIsRunning(child)) {
    child.kill(force ? 'SIGKILL' : undefined);
  }
}

async function smokeProcessTreeExists(child, dependencies, trackedProcesses) {
  if (typeof child.pid !== 'number') return smokeChildIsRunning(child);
  if (dependencies.processTreeExists !== undefined) {
    return dependencies.processTreeExists(child.pid, trackedProcesses);
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }
  return (
    (await survivingWindowsSmokeProcesses(trackedProcesses, dependencies))
      .length > 0
  );
}

async function waitForSmokeProcessTreeExit(
  child,
  dependencies,
  trackedProcesses,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      !(await smokeProcessTreeExists(child, dependencies, trackedProcesses))
    ) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

export async function terminateSmokeProcessTree(
  child,
  closePromise,
  dependencies = {},
) {
  const treeExitTimeoutMs = dependencies.treeExitTimeoutMs ?? 5_000;
  const suppliedTrackedProcesses = validatedProcessIdentities(
    dependencies.trackedProcesses ?? [],
    'Packaged application tracked process identities',
  );
  const expectedRootCreationTicks = suppliedTrackedProcesses.find(
    (process) => process.pid === child.pid,
  )?.creationTicks;
  const captured =
    dependencies.processTreeExists === undefined
      ? await captureWindowsSmokeProcesses(child, {
          ...dependencies,
          expectedRootCreationTicks,
        })
      : Object.freeze([]);
  const trackedProcesses = mergeTrackedProcesses(
    suppliedTrackedProcesses,
    captured,
  );
  await signalSmokeProcessTree(child, false, dependencies, trackedProcesses);
  const [closed, treeExited] = await Promise.all([
    settlesWithin(closePromise, treeExitTimeoutMs),
    waitForSmokeProcessTreeExit(
      child,
      dependencies,
      trackedProcesses,
      treeExitTimeoutMs,
    ),
  ]);
  if (!closed || !treeExited) {
    await signalSmokeProcessTree(child, true, dependencies, trackedProcesses);
    const [forcedClosed, forcedTreeExited] = await Promise.all([
      settlesWithin(closePromise, treeExitTimeoutMs),
      waitForSmokeProcessTreeExit(
        child,
        dependencies,
        trackedProcesses,
        treeExitTimeoutMs,
      ),
    ]);
    if (!forcedClosed) {
      fail('Packaged application did not terminate after smoke');
    }
    if (!forcedTreeExited) {
      fail('Packaged application process tree did not terminate after smoke');
    }
  }
  if ((dependencies.platform ?? process.platform) === 'win32') await delay(50);
}

async function runExecutableSmoke(executablePath) {
  const smokeDirectory = await mkdtemp(join(tmpdir(), 'wo-package-smoke-'));
  await chmod(smokeDirectory, 0o700);
  const nonce = randomBytes(32).toString('hex');
  const readyPath = join(smokeDirectory, `ready-${nonce}.txt`);
  const profilePath = join(smokeDirectory, 'profile');
  await mkdir(profilePath, { mode: 0o700 });
  const environment = createSmokeEnvironment(process.env, {
    nonce,
    readyPath,
  });

  let child;
  let closePromise;
  let trackedProcesses = Object.freeze([]);
  try {
    child = spawn(
      executablePath,
      ['--package-smoke-test', `--user-data-dir=${profilePath}`],
      {
        cwd: dirname(executablePath),
        env: environment,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );
    closePromise = new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (code, signal) => {
        resolvePromise({ code, signal });
      });
    });
    trackedProcesses = await captureWindowsSmokeProcesses(child, {
      windowsProfilePath: profilePath,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await exists(readyPath)) {
        const acknowledgement = await readFile(readyPath, 'utf8');
        if (acknowledgement !== `WO_PACKAGE_SMOKE_READY:${nonce}\n`) {
          fail('Packaged application wrote an invalid smoke acknowledgement');
        }
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        fail('Packaged application exited before the ready acknowledgement');
      }
      await delay(25);
    }
    fail(
      'Packaged application did not acknowledge readiness within 15 seconds',
    );
  } finally {
    try {
      if (child && closePromise) {
        await terminateSmokeProcessTree(child, closePromise, {
          trackedProcesses,
          windowsProfilePath: profilePath,
        });
      }
    } finally {
      await rm(smokeDirectory, { recursive: true, force: true });
    }
  }
}

export async function verifyPackage(options, dependencies = {}) {
  validateReleaseIdentity(options);
  const packageDirectory = resolve(options.packageDirectory);
  const normalizedOptions = { ...options, packageDirectory };
  const packageStats = await lstat(packageDirectory).catch(() => null);
  if (!packageStats?.isDirectory() || packageStats.isSymbolicLink()) {
    fail(`Package directory does not exist: ${packageDirectory}`);
  }
  const hostPlatform = dependencies.hostPlatform ?? process.platform;
  const hostArch = dependencies.hostArch ?? process.arch;
  const nativeRunner = dependencies.runNativeCommand ?? runNativeCommand;
  const smokeRunner = dependencies.runExecutableSmoke ?? runExecutableSmoke;
  const fuseReader = dependencies.readElectronFuses ?? getCurrentFuseWire;

  await verifyArtifactMarker(packageDirectory, options.artifactClass);
  const asar = await verifyAsarArchives(packageDirectory, options.platform);
  const artifacts = await verifyArtifactMatrix(
    normalizedOptions,
    asar.version,
    hostArch,
  );
  const nativeEnvironment = createNativeVerificationEnvironment(process.env);
  if (options.platform === 'win') {
    const extractor =
      dependencies.extractWindowsArtifact ??
      ((artifactPath) =>
        extractWindowsArtifactPayload(artifactPath, nativeEnvironment));
    await verifyWindowsArtifactPayloads(artifacts, extractor, fuseReader);
  }
  await scanPackageDirectory(packageDirectory);

  if (options.platform === 'mac') {
    if (hostPlatform !== 'darwin') {
      fail('macOS package verification requires its native host');
    }
    await verifyMacArtifacts(
      artifacts,
      nativeRunner,
      options.artifactClass === 'signed'
        ? {
            teamId: options.expectedMacTeamId,
            bundleId: options.expectedMacBundleId,
          }
        : null,
      nativeEnvironment,
      options.smoke ? smokeRunner : null,
      hostArch === 'arm64' ? 'arm64' : 'x64',
      fuseReader,
    );
  }
  if (options.artifactClass === 'signed' && options.platform === 'win') {
    if (hostPlatform !== 'win32') {
      fail('Signed win verification requires its native host');
    }
    await verifyWindowsSignatures(
      artifacts.windowsExecutables,
      nativeRunner,
      {
        publisher: options.expectedWinPublisher,
        thumbprint: options.expectedWinThumbprint,
      },
      nativeEnvironment,
    );
  }
  if (options.smoke) {
    const expectedHost = options.platform === 'win' ? 'win32' : 'darwin';
    if (hostPlatform !== expectedHost) {
      fail(
        `Executable smoke verification requires a native ${options.platform} host`,
      );
    }
    for (const executablePath of artifacts.smokeExecutables) {
      await smokeRunner(executablePath);
    }
  }
  return Object.freeze({
    archiveCount: asar.archives.length,
    artifactClass: options.artifactClass,
  });
}

export async function main(argumentsList) {
  const options = parseArguments(argumentsList);
  const result = await verifyPackage(options);
  console.info(
    `DESKTOP_PACKAGE_VERIFIED artifact=${
      result.artifactClass === 'unsigned-development'
        ? 'UNSIGNED_DEVELOPMENT_ONLY'
        : 'SIGNED_OS_VERIFIED'
    } archives=${String(result.archiveCount)}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `DESKTOP_PACKAGE_VERIFICATION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
