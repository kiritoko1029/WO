import { lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import type { SecureSessionStore } from './secure-session-store.js';

const smokeFlag = '--package-smoke-test';
const smokeDirectoryPattern = /^wo-package-smoke-[A-Za-z0-9_-]{6,80}$/u;
const smokeNoncePattern = /^[a-f0-9]{64}$/u;

export interface PackageSmokeRequest {
  readonly nonce: string;
  readonly readyPath: string;
  readonly temporaryRoot: string;
}

export interface PackageSmokeRequestInput {
  readonly argumentsList: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly temporaryRoot: string;
}

export interface PackageSmokeRenderer {
  executeJavaScript(script: string): Promise<unknown>;
}

export interface PackageSmokeRendererWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export function createPackageSmokeSessionStore(): SecureSessionStore {
  return Object.freeze({
    read: () => Promise.resolve(null),
    write: () =>
      Promise.reject(
        new Error('Package smoke cannot persist authentication sessions'),
      ),
    clear: () => Promise.resolve(),
  });
}

const rendererReadinessExpression = `(() => {
  const desktop = globalThis.desktop;
  return document.readyState === 'complete' &&
    typeof desktop?.auth?.refresh === 'function' &&
    document.querySelector('#root > *') !== null &&
    document.querySelector('.startup-shell') === null;
})()`;

const rendererSecurityExpression = `(async () => {
  let policy = '';
  try {
    const response = await fetch(globalThis.location.href, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    policy = response.headers.get('content-security-policy') ?? '';
  } catch {
    policy = '';
  }
  let wasmCompiled = false;
  try {
    await WebAssembly.compile(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    wasmCompiled = true;
  } catch {
    wasmCompiled = false;
  }
  let evalBlocked = false;
  try {
    (0, eval)('1 + 1');
  } catch {
    evalBlocked = true;
  }
  let functionConstructorBlocked = false;
  try {
    new Function('return 1')();
  } catch {
    functionConstructorBlocked = true;
  }
  let rnnoiseChunkLoaded = false;
  try {
    const moduleScripts = [
      ...document.querySelectorAll('script[type="module"][src]'),
    ];
    if (moduleScripts.length !== 1) throw new Error('Invalid module entry');
    const entryUrl = new URL(moduleScripts[0].src);
    if (entryUrl.origin !== location.origin) {
      throw new Error('Module entry is cross-origin');
    }
    const entryResponse = await fetch(entryUrl.href, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!entryResponse.ok) throw new Error('Module entry is unavailable');
    const entrySource = await entryResponse.text();
    const chunkPaths = [
      ...new Set(
        [...entrySource.matchAll(/\\.\\/rnnoise-[A-Za-z0-9_-]+\\.js/gu)].map(
          (match) => match[0],
        ),
      ),
    ];
    if (chunkPaths.length !== 1) throw new Error('Invalid RNNoise chunk');
    const chunkUrl = new URL(chunkPaths[0], entryUrl);
    if (
      chunkUrl.origin !== location.origin ||
      !/^\\/assets\\/rnnoise-[A-Za-z0-9_-]+\\.js$/u.test(chunkUrl.pathname)
    ) {
      throw new Error('RNNoise chunk is cross-origin');
    }
    const chunk = await import(chunkUrl.href);
    rnnoiseChunkLoaded =
      typeof chunk.Rnnoise === 'function' &&
      typeof chunk.Rnnoise.load === 'function';
  } catch {
    rnnoiseChunkLoaded = false;
  }
  return {
    locationOrigin: location.origin,
    locationProtocol: location.protocol,
    policy,
    wasmCompiled,
    evalBlocked,
    functionConstructorBlocked,
    rnnoiseChunkLoaded,
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

export async function waitForPackageSmokeRendererReady(
  renderer: PackageSmokeRenderer,
  options: PackageSmokeRendererWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  do {
    if (
      (await renderer.executeJavaScript(rendererReadinessExpression)) === true
    ) {
      return;
    }
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);
  throw new Error('Packaged renderer did not reach normal readiness');
}

export async function verifyPackageSmokeRendererSecurity(
  renderer: PackageSmokeRenderer,
): Promise<void> {
  const result = await renderer.executeJavaScript(rendererSecurityExpression);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('policy' in result) ||
    typeof result.policy !== 'string' ||
    !result.policy.includes("'wasm-unsafe-eval'") ||
    result.policy.includes("'unsafe-eval'") ||
    !('locationOrigin' in result) ||
    result.locationOrigin !== 'wo-app://bundle' ||
    !('locationProtocol' in result) ||
    result.locationProtocol !== 'wo-app:' ||
    !('wasmCompiled' in result) ||
    result.wasmCompiled !== true ||
    !('evalBlocked' in result) ||
    result.evalBlocked !== true ||
    !('functionConstructorBlocked' in result) ||
    result.functionConstructorBlocked !== true ||
    !('rnnoiseChunkLoaded' in result) ||
    result.rnnoiseChunkLoaded !== true
  ) {
    throw new Error('Packaged renderer security probe failed');
  }
}

function isDirectChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(child) &&
    !/[\\/]/u.test(child)
  );
}

export function resolvePackageSmokeRequest(
  input: PackageSmokeRequestInput,
): PackageSmokeRequest | null {
  const flagCount = input.argumentsList.filter(
    (argument) => argument === smokeFlag,
  ).length;
  const environmentRequested = [
    input.environment.WO_PACKAGE_SMOKE,
    input.environment.WO_PACKAGE_SMOKE_NONCE,
    input.environment.WO_PACKAGE_SMOKE_PATH,
  ].some((value) => value !== undefined);

  if (flagCount === 0 && !environmentRequested) return null;
  if (
    flagCount !== 1 ||
    input.environment.WO_PACKAGE_SMOKE !== '1' ||
    input.environment.WO_PACKAGE_SMOKE_NONCE === undefined ||
    input.environment.WO_PACKAGE_SMOKE_PATH === undefined
  ) {
    throw new Error(
      'Package smoke requires the complete flag and environment activation',
    );
  }

  const nonce = input.environment.WO_PACKAGE_SMOKE_NONCE;
  if (!smokeNoncePattern.test(nonce)) {
    throw new Error('Package smoke nonce is invalid');
  }

  const readyPath = input.environment.WO_PACKAGE_SMOKE_PATH;
  if (
    !isAbsolute(readyPath) ||
    /[\0\r\n]/u.test(readyPath) ||
    resolve(readyPath) !== readyPath
  ) {
    throw new Error('Package smoke acknowledgement path is invalid');
  }
  const temporaryRoot = resolve(input.temporaryRoot);
  const requestDirectory = dirname(readyPath);
  if (
    !isDirectChild(temporaryRoot, requestDirectory) ||
    !smokeDirectoryPattern.test(basename(requestDirectory)) ||
    basename(readyPath) !== `ready-${nonce}.txt`
  ) {
    throw new Error(
      'Package smoke acknowledgement path must be inside its temporary directory',
    );
  }

  return Object.freeze({ nonce, readyPath, temporaryRoot });
}

export async function writePackageSmokeReady(
  request: PackageSmokeRequest,
): Promise<void> {
  const requestDirectory = dirname(request.readyPath);
  const directoryStats = await lstat(requestDirectory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error('Package smoke directory must not be a symbolic link');
  }
  if (!directoryStats.isDirectory()) {
    throw new Error('Package smoke acknowledgement parent is not a directory');
  }
  if (process.platform !== 'win32' && (directoryStats.mode & 0o077) !== 0) {
    throw new Error('Package smoke directory permissions are too broad');
  }

  const [realTemporaryRoot, realRequestDirectory] = await Promise.all([
    realpath(request.temporaryRoot),
    realpath(requestDirectory),
  ]);
  if (
    !isDirectChild(realTemporaryRoot, realRequestDirectory) ||
    !smokeDirectoryPattern.test(basename(realRequestDirectory)) ||
    basename(request.readyPath) !== `ready-${request.nonce}.txt`
  ) {
    throw new Error('Package smoke acknowledgement escaped its temporary root');
  }

  await writeFile(
    request.readyPath,
    `WO_PACKAGE_SMOKE_READY:${request.nonce}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      flush: true,
    },
  );
}
