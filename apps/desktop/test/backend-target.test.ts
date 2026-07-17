import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  BackendTargetStoreError,
  createBackendTargetStore,
  DEFAULT_BACKEND_ORIGIN,
  type BackendTargetFileSystem,
} from '../src/main/backend-target.js';

function missingFile(): Error & { readonly code: 'ENOENT' } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' as const });
}

function createFileSystem(initial?: Readonly<Record<string, string>>) {
  const files = new Map(Object.entries(initial ?? {}));
  const fileSystem = {
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((path: string) => {
      const value = files.get(path);
      if (value === undefined) throw missingFile();
      return value;
    }),
    writeFileSync: vi.fn(
      (path: string, contents: string, options: { readonly flag: 'wx' }) => {
        if (options.flag === 'wx' && files.has(path)) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
        files.set(path, contents);
      },
    ),
    renameSync: vi.fn((from: string, to: string) => {
      const contents = files.get(from);
      if (contents === undefined) throw missingFile();
      files.set(to, contents);
      files.delete(from);
    }),
    unlinkSync: vi.fn((path: string) => {
      if (!files.delete(path)) throw missingFile();
    }),
  } satisfies BackendTargetFileSystem;
  return { fileSystem, files };
}

const userDataPath = '/profiles/person-a';
const targetPath = join(userDataPath, 'backend-target.json');

describe('backend target store', () => {
  it('loads environment, stored, and default origins in priority order', () => {
    const { fileSystem } = createFileSystem({
      [targetPath]: JSON.stringify({
        version: 1,
        origin: 'https://stored.example.cn',
      }),
    });
    const environmentStore = createBackendTargetStore({
      userDataPath,
      environment: { WO_API_ORIGIN: 'https://managed.example.cn' },
      fileSystem,
    });

    expect(environmentStore.current()).toEqual({
      origin: 'https://managed.example.cn',
      source: 'environment',
      readOnly: true,
    });
    expect(fileSystem.readFileSync).not.toHaveBeenCalled();
    expect(() => environmentStore.save('https://other.example.cn')).toThrow(
      expect.objectContaining<Partial<BackendTargetStoreError>>({
        code: 'INVALID_STATE',
      }),
    );

    const storedStore = createBackendTargetStore({
      userDataPath,
      environment: {},
      fileSystem,
    });
    expect(storedStore.current()).toEqual({
      origin: 'https://stored.example.cn',
      source: 'stored',
      readOnly: false,
    });

    const empty = createFileSystem();
    const defaultStore = createBackendTargetStore({
      userDataPath,
      environment: {},
      fileSystem: empty.fileSystem,
    });
    expect(defaultStore.current()).toEqual({
      origin: DEFAULT_BACKEND_ORIGIN,
      source: 'default',
      readOnly: false,
    });
  });

  it('writes versioned JSON through a same-directory atomic rename', () => {
    const { fileSystem, files } = createFileSystem();
    const store = createBackendTargetStore({
      userDataPath,
      environment: {},
      fileSystem,
      randomId: () => 'write-one',
    });

    store.save('https://wo.example.cn:8443');

    expect(fileSystem.mkdirSync).toHaveBeenCalledWith(userDataPath, {
      recursive: true,
      mode: 0o700,
    });
    expect(fileSystem.writeFileSync).toHaveBeenCalledWith(
      join(userDataPath, '.backend-target.json.write-one.tmp'),
      '{"version":1,"origin":"https://wo.example.cn:8443"}\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    expect(fileSystem.renameSync).toHaveBeenCalledWith(
      join(userDataPath, '.backend-target.json.write-one.tmp'),
      targetPath,
    );
    expect(files.get(targetPath)).toBe(
      '{"version":1,"origin":"https://wo.example.cn:8443"}\n',
    );
    expect([...files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
    expect(store.current()).toEqual({
      origin: 'https://wo.example.cn:8443',
      source: 'stored',
      readOnly: false,
    });
  });

  it.each([
    'not-json',
    '{"version":2,"origin":"https://wo.example.cn"}',
    '{"version":1,"origin":"https://wo.example.cn/path"}',
    '{"version":1,"origin":"https://wo.example.cn","extra":true}',
  ])('strictly rejects malformed stored JSON: %s', (contents) => {
    const { fileSystem } = createFileSystem({ [targetPath]: contents });

    expect(() =>
      createBackendTargetStore({
        userDataPath,
        environment: {},
        fileSystem,
      }),
    ).toThrow(BackendTargetStoreError);
  });

  it('rejects a non-canonical save without replacing stored state', () => {
    const { fileSystem } = createFileSystem();
    const store = createBackendTargetStore({
      userDataPath,
      environment: {},
      fileSystem,
      randomId: () => 'unused',
    });

    expect(() => store.save('http://wo.example.cn')).toThrow(
      expect.objectContaining<Partial<BackendTargetStoreError>>({
        code: 'VALIDATION_ERROR',
      }),
    );
    expect(store.current().origin).toBe(DEFAULT_BACKEND_ORIGIN);
    expect(fileSystem.writeFileSync).not.toHaveBeenCalled();
  });
});
