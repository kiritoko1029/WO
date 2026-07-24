import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPackageSmokeSessionStore,
  resolvePackageSmokeRequest,
  verifyPackageSmokeRendererSecurity,
  waitForPackageSmokeRendererReady,
  writePackageSmokeReady,
} from '../src/main/package-smoke.js';

const nonce = 'a'.repeat(64);
const temporaryDirectories: string[] = [];

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wo-smoke-test-root-'));
  temporaryDirectories.push(temporaryRoot);
  const requestDirectory = join(temporaryRoot, 'wo-package-smoke-valid123');
  await mkdir(requestDirectory, { mode: 0o700 });
  const readyPath = join(requestDirectory, `ready-${nonce}.txt`);
  return { temporaryRoot, requestDirectory, readyPath };
}

function smokeEnvironment(readyPath: string) {
  return {
    WO_PACKAGE_SMOKE: '1',
    WO_PACKAGE_SMOKE_NONCE: nonce,
    WO_PACKAGE_SMOKE_PATH: readyPath,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('packaged application smoke request', () => {
  it('uses a non-persistent empty session store without touching OS credentials', async () => {
    const store = createPackageSmokeSessionStore();

    await expect(store.read()).resolves.toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.write('refresh-token')).rejects.toThrow(
      /cannot persist authentication sessions/iu,
    );
  });

  it('does nothing during an ordinary production launch', () => {
    expect(
      resolvePackageSmokeRequest({
        argumentsList: [],
        environment: {},
        temporaryRoot: tmpdir(),
      }),
    ).toBeNull();
  });

  it.each([
    {
      argumentsList: ['--package-smoke-test'],
      environment: {},
    },
    {
      argumentsList: [],
      environment: {
        WO_PACKAGE_SMOKE: '1',
        WO_PACKAGE_SMOKE_NONCE: nonce,
        WO_PACKAGE_SMOKE_PATH: 'C:\\Temp\\ready.txt',
      },
    },
  ])('rejects a partially activated smoke request', (input) => {
    expect(() =>
      resolvePackageSmokeRequest({
        ...input,
        temporaryRoot: tmpdir(),
      }),
    ).toThrow(/complete|flag|environment/iu);
  });

  it('rejects malformed nonces and acknowledgement paths outside the temporary root', async () => {
    const { temporaryRoot, readyPath } = await fixture();

    expect(() =>
      resolvePackageSmokeRequest({
        argumentsList: ['--package-smoke-test'],
        environment: {
          ...smokeEnvironment(readyPath),
          WO_PACKAGE_SMOKE_NONCE: '../not-a-nonce',
        },
        temporaryRoot,
      }),
    ).toThrow(/nonce/iu);

    expect(() =>
      resolvePackageSmokeRequest({
        argumentsList: ['--package-smoke-test'],
        environment: smokeEnvironment(
          join(temporaryRoot, '..', `ready-${nonce}.txt`),
        ),
        temporaryRoot,
      }),
    ).toThrow(/temporary|path/iu);
  });

  it('writes one fixed non-secret acknowledgement through an exclusive file', async () => {
    const { temporaryRoot, readyPath } = await fixture();
    const request = resolvePackageSmokeRequest({
      argumentsList: ['--package-smoke-test'],
      environment: smokeEnvironment(readyPath),
      temporaryRoot,
    });

    expect(request).not.toBeNull();
    await writePackageSmokeReady(request!);
    expect(await readFile(readyPath, 'utf8')).toBe(
      `WO_PACKAGE_SMOKE_READY:${nonce}\n`,
    );
    await expect(writePackageSmokeReady(request!)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('rejects a symlinked acknowledgement directory before writing', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'wo-smoke-test-root-'));
    temporaryDirectories.push(temporaryRoot);
    const target = join(temporaryRoot, 'actual-directory');
    const requestDirectory = join(temporaryRoot, 'wo-package-smoke-linked123');
    await mkdir(target);
    await symlink(target, requestDirectory, 'junction');
    const readyPath = join(requestDirectory, `ready-${nonce}.txt`);
    const request = resolvePackageSmokeRequest({
      argumentsList: ['--package-smoke-test'],
      environment: smokeEnvironment(readyPath),
      temporaryRoot,
    });

    await expect(writePackageSmokeReady(request!)).rejects.toThrow(
      /symbolic/iu,
    );
    expect((await lstat(requestDirectory)).isSymbolicLink()).toBe(true);
  });

  it('allows a safe operating-system alias above the dedicated request directory', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'wo-smoke-real-root-'));
    temporaryDirectories.push(temporaryRoot);
    const aliasRoot = join(tmpdir(), `wo-smoke-root-alias-${Date.now()}`);
    await symlink(temporaryRoot, aliasRoot, 'junction');
    try {
      const requestDirectory = join(aliasRoot, 'wo-package-smoke-aliased123');
      await mkdir(requestDirectory, { mode: 0o700 });
      const readyPath = join(requestDirectory, `ready-${nonce}.txt`);
      const request = resolvePackageSmokeRequest({
        argumentsList: ['--package-smoke-test'],
        environment: smokeEnvironment(readyPath),
        temporaryRoot: aliasRoot,
      });

      await writePackageSmokeReady(request!);
      expect(await readFile(readyPath, 'utf8')).toBe(
        `WO_PACKAGE_SMOKE_READY:${nonce}\n`,
      );
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('waits for preload, React, and normal session restoration before acknowledging readiness', async () => {
    const scripts: string[] = [];
    const results = [false, false, true];

    await waitForPackageSmokeRendererReady(
      {
        executeJavaScript: (script) => {
          scripts.push(script);
          return Promise.resolve(results.shift());
        },
      },
      { timeoutMs: 100, pollIntervalMs: 0 },
    );

    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toMatch(/desktop.*auth.*refresh/isu);
    expect(scripts[0]).toMatch(/#root/iu);
    expect(scripts[0]).toMatch(/startup-shell/iu);
  });

  it('requires packaged CSP to allow WASM while blocking JavaScript evaluation', async () => {
    const scripts: string[] = [];
    await verifyPackageSmokeRendererSecurity({
      executeJavaScript: (script) => {
        scripts.push(script);
        return Promise.resolve({
          locationOrigin: 'wo-app://bundle',
          locationProtocol: 'wo-app:',
          policy: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
          wasmCompiled: true,
          evalBlocked: true,
          functionConstructorBlocked: true,
          rnnoiseChunkLoaded: true,
        });
      },
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('fetch(globalThis.location.href');
    expect(scripts[0]).toContain("headers.get('content-security-policy')");
    expect(scripts[0]).toContain('WebAssembly.compile');
    expect(scripts[0]).toContain("new Function('return 1')");
    expect(scripts[0]).toContain('rnnoise-');
    expect(scripts[0]).toContain('import(chunkUrl.href)');

    await expect(
      verifyPackageSmokeRendererSecurity({
        executeJavaScript: () =>
          Promise.resolve({
            locationOrigin: 'file://',
            locationProtocol: 'file:',
            policy:
              "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
            wasmCompiled: true,
            evalBlocked: false,
            functionConstructorBlocked: false,
            rnnoiseChunkLoaded: false,
          }),
      }),
    ).rejects.toThrow(/security probe/iu);
  });

  it('creates normal app services and a renderer window before acknowledging readiness', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );
    const request = source.indexOf('resolvePackageSmokeRequest({');
    const secureStore = source.lastIndexOf('createSecureSessionStore({');
    const windowCreation = source.indexOf(
      'mainWindow = createMainWindow()',
      secureStore,
    );
    const rendererReady = source.indexOf(
      'waitForPackageSmokeRendererReady(',
      windowCreation,
    );
    const acknowledgement = source.indexOf(
      'writePackageSmokeReady(packageSmokeRequest)',
      rendererReady,
    );
    const securityProbe = source.indexOf(
      'verifyPackageSmokeRendererSecurity(mainWindow.webContents)',
      rendererReady,
    );

    expect(request).toBeGreaterThanOrEqual(0);
    expect(secureStore).toBeGreaterThan(request);
    expect(source).toContain('createPackageSmokeSessionStore()');
    expect(windowCreation).toBeGreaterThan(secureStore);
    expect(rendererReady).toBeGreaterThan(windowCreation);
    expect(securityProbe).toBeGreaterThan(rendererReady);
    expect(acknowledgement).toBeGreaterThan(securityProbe);
    expect(source).toMatch(/app\.quit\(\)/u);
  });
});
