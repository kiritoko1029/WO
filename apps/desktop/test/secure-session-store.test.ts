import { basename, dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createSecureSessionStore,
  SecureSessionStoreError,
  type SessionFileSystem,
} from '../src/main/secure-session-store.js';

interface FakeFileSystem extends SessionFileSystem {
  readonly files: Map<string, Buffer>;
  readonly operations: string[];
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function createFileSystem(): FakeFileSystem {
  const files = new Map<string, Buffer>();
  const operations: string[] = [];
  return {
    files,
    operations,
    mkdir: vi.fn(async (path) => {
      operations.push(`mkdir:${path}`);
    }),
    writeFile: vi.fn(async (path, contents, options) => {
      operations.push(`write:${path}:${String(options?.mode)}`);
      files.set(path, Buffer.from(contents));
    }),
    rename: vi.fn(async (from, to) => {
      operations.push(`rename:${from}->${to}`);
      const contents = files.get(from);
      if (!contents) throw systemError('ENOENT');
      files.set(to, contents);
      files.delete(from);
    }),
    readFile: vi.fn(async (path) => {
      operations.push(`read:${path}`);
      const contents = files.get(path);
      if (!contents) throw systemError('ENOENT');
      return Buffer.from(contents);
    }),
    unlink: vi.fn(async (path) => {
      operations.push(`unlink:${path}`);
      if (!files.delete(path)) throw systemError('ENOENT');
    }),
  };
}

function createEncryption(available = true) {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) =>
      Buffer.from(`encrypted:${value}`, 'utf8'),
    ),
    decryptString: vi.fn((value: Buffer) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('encrypted:')) throw new Error('corrupt');
      return encoded.slice('encrypted:'.length);
    }),
  };
}

const userDataPath = 'C:\\profiles\\person-a';
const sessionPath = join(userDataPath, 'refresh-token.bin');
const apiOrigin = 'https://rtc.example.cn';

function encryptedPayload(
  refreshToken: string,
  boundOrigin = apiOrigin,
): Buffer {
  return Buffer.from(
    `encrypted:${JSON.stringify({
      version: 1,
      apiOrigin: boundOrigin,
      refreshToken,
    })}`,
    'utf8',
  );
}

describe('secure refresh session store', () => {
  it('fails closed when operating-system encryption is unavailable', async () => {
    const fileSystem = createFileSystem();
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(false),
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.write('secret-refresh-token')).rejects.toThrow(
      SecureSessionStoreError,
    );
    await expect(store.read()).rejects.toThrow(SecureSessionStoreError);
    expect(fileSystem.operations).toEqual([]);
  });

  it('atomically writes only encrypted bytes with private permissions', async () => {
    const fileSystem = createFileSystem();
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await store.write('secret-refresh-token');

    expect(fileSystem.files.get(sessionPath)?.toString('utf8')).toBe(
      encryptedPayload('secret-refresh-token').toString('utf8'),
    );
    expect(fileSystem.operations).toEqual([
      `mkdir:${dirname(sessionPath)}`,
      `write:${join(dirname(sessionPath), `.${basename(sessionPath)}.one.tmp`)}:384`,
      `rename:${join(dirname(sessionPath), `.${basename(sessionPath)}.one.tmp`)}->${sessionPath}`,
    ]);
    expect(fileSystem.operations).not.toContain(`unlink:${sessionPath}`);
  });

  it('reads and decrypts an existing token without exposing ciphertext details', async () => {
    const fileSystem = createFileSystem();
    fileSystem.files.set(sessionPath, encryptedPayload('refresh-from-disk'));
    const encryption = createEncryption();
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption,
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.read()).resolves.toBe('refresh-from-disk');
    expect(encryption.decryptString).toHaveBeenCalledOnce();
  });

  it('returns null for an absent session and fails closed for corrupted ciphertext', async () => {
    const fileSystem = createFileSystem();
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.read()).resolves.toBeNull();
    fileSystem.files.set(sessionPath, Buffer.from('not-ciphertext'));
    await expect(store.read()).rejects.toThrow(SecureSessionStoreError);
  });

  it('deletes local ciphertext and treats an absent file as already clear', async () => {
    const fileSystem = createFileSystem();
    fileSystem.files.set(sessionPath, Buffer.from('encrypted:token'));
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await store.clear();
    await store.clear();

    expect(fileSystem.files.has(sessionPath)).toBe(false);
  });

  it('preserves the prior session and cleans the temporary file after a failed replacement', async () => {
    const fileSystem = createFileSystem();
    fileSystem.files.set(sessionPath, Buffer.from('encrypted:prior'));
    vi.mocked(fileSystem.writeFile).mockRejectedValueOnce(
      systemError('EACCES'),
    );
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.write('replacement')).rejects.toThrow(
      SecureSessionStoreError,
    );

    expect(fileSystem.files.get(sessionPath)?.toString()).toBe(
      'encrypted:prior',
    );
    expect(fileSystem.operations).not.toContain(`unlink:${sessionPath}`);
  });

  it('serializes mutations so the final successful write wins', async () => {
    const fileSystem = createFileSystem();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(fileSystem.rename)
      .mockImplementationOnce(async (from, to) => {
        await firstBlocked;
        const contents = fileSystem.files.get(from);
        if (!contents) throw systemError('ENOENT');
        fileSystem.files.set(to, contents);
        fileSystem.files.delete(from);
      })
      .mockImplementation(async (from, to) => {
        const contents = fileSystem.files.get(from);
        if (!contents) throw systemError('ENOENT');
        fileSystem.files.set(to, contents);
        fileSystem.files.delete(from);
      });
    let suffix = 0;
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => String(++suffix),
    });

    const first = store.write('first');
    const second = store.write('second');
    await vi.waitFor(() => {
      expect(
        fileSystem.files.has(join(userDataPath, '.refresh-token.bin.1.tmp')),
      ).toBe(true);
    });
    expect(
      fileSystem.files.has(join(userDataPath, '.refresh-token.bin.2.tmp')),
    ).toBe(false);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(fileSystem.files.get(sessionPath)?.toString()).toBe(
      encryptedPayload('second').toString(),
    );
  });

  it('rejects a token encrypted for a different canonical API origin', async () => {
    const fileSystem = createFileSystem();
    fileSystem.files.set(
      sessionPath,
      encryptedPayload('token-for-a', 'https://a.example.cn'),
    );
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin: 'https://b.example.cn',
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.read()).rejects.toThrow(SecureSessionStoreError);
  });

  it('rejects legacy naked decrypted tokens without migrating them', async () => {
    const fileSystem = createFileSystem();
    fileSystem.files.set(
      sessionPath,
      Buffer.from('encrypted:legacy-refresh-token', 'utf8'),
    );
    const store = createSecureSessionStore({
      userDataPath,
      apiOrigin,
      encryption: createEncryption(),
      fileSystem,
      randomId: () => 'one',
    });

    await expect(store.read()).rejects.toThrow(SecureSessionStoreError);
    expect(fileSystem.files.get(sessionPath)?.toString()).toBe(
      'encrypted:legacy-refresh-token',
    );
  });
});
