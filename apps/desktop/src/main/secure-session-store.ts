import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SessionEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SessionFileSystem {
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): Promise<unknown>;
  writeFile(
    path: string,
    contents: Uint8Array,
    options?: {
      readonly flag?: string;
      readonly mode?: number;
    },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  readFile(path: string): Promise<Buffer>;
  unlink(path: string): Promise<unknown>;
}

export interface SecureSessionStore {
  read(): Promise<string | null>;
  write(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SecureSessionStoreOptions {
  readonly userDataPath: string;
  readonly apiOrigin: string;
  readonly encryption: SessionEncryption;
  readonly fileSystem?: SessionFileSystem;
  readonly randomId?: () => string;
}

export class SecureSessionStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecureSessionStoreError';
  }
}

const nodeFileSystem: SessionFileSystem = {
  mkdir,
  writeFile,
  rename,
  readFile,
  unlink,
};

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function requireEncryption(encryption: SessionEncryption): void {
  if (!encryption.isEncryptionAvailable()) {
    throw new SecureSessionStoreError(
      'Operating-system credential encryption is unavailable',
    );
  }
}

function canonicalApiOrigin(value: string): string {
  const url = new URL(value);
  if (
    value.length > 2_048 ||
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('apiOrigin must be a canonical HTTPS origin');
  }
  return url.origin;
}

function parseStoredSession(
  decrypted: string,
  expectedApiOrigin: string,
): string {
  const parsed: unknown = JSON.parse(decrypted);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !('version' in parsed) ||
    !('apiOrigin' in parsed) ||
    !('refreshToken' in parsed) ||
    parsed.version !== 1 ||
    parsed.apiOrigin !== expectedApiOrigin ||
    typeof parsed.refreshToken !== 'string' ||
    parsed.refreshToken.length === 0 ||
    parsed.refreshToken.length > 4_096
  ) {
    throw new Error('Invalid stored session');
  }
  return parsed.refreshToken;
}

export function createSecureSessionStore(
  options: SecureSessionStoreOptions,
): SecureSessionStore {
  if (options.userDataPath.trim() === '') {
    throw new TypeError('userDataPath is required');
  }
  const apiOrigin = canonicalApiOrigin(options.apiOrigin);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const createId = options.randomId ?? randomUUID;
  const sessionPath = join(options.userDataPath, 'refresh-token.bin');
  let operationTail = Promise.resolve();

  const exclusive = <Result>(operation: () => Promise<Result>) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const removeIfPresent = async (path: string): Promise<void> => {
    try {
      await fileSystem.unlink(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  };

  return Object.freeze({
    read: () =>
      exclusive(async () => {
        requireEncryption(options.encryption);
        let encrypted: Buffer;
        try {
          encrypted = await fileSystem.readFile(sessionPath);
        } catch (error) {
          if (isMissingFile(error)) return null;
          throw new SecureSessionStoreError('Unable to read secure session', {
            cause: error,
          });
        }

        try {
          const decrypted = options.encryption.decryptString(encrypted);
          return parseStoredSession(decrypted, apiOrigin);
        } catch (error) {
          throw new SecureSessionStoreError(
            'Stored secure session cannot be decrypted',
            { cause: error },
          );
        }
      }),
    write: (refreshToken: string) =>
      exclusive(async () => {
        requireEncryption(options.encryption);
        if (refreshToken.length === 0 || refreshToken.length > 4_096) {
          throw new SecureSessionStoreError('Invalid secure session');
        }

        const id = createId();
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
          throw new SecureSessionStoreError('Invalid temporary file identity');
        }
        const temporaryPath = join(
          dirname(sessionPath),
          `.${basename(sessionPath)}.${id}.tmp`,
        );
        try {
          const encrypted = options.encryption.encryptString(
            JSON.stringify({ version: 1, apiOrigin, refreshToken }),
          );
          await fileSystem.mkdir(dirname(sessionPath), {
            recursive: true,
            mode: 0o700,
          });
          await fileSystem.writeFile(temporaryPath, encrypted, {
            flag: 'wx',
            mode: 0o600,
          });
          await fileSystem.rename(temporaryPath, sessionPath);
        } catch (error) {
          try {
            await removeIfPresent(temporaryPath);
          } catch {
            // Preserve the original persistence failure.
          }
          throw new SecureSessionStoreError('Unable to store secure session', {
            cause: error,
          });
        }
      }),
    clear: () =>
      exclusive(async () => {
        try {
          await removeIfPresent(sessionPath);
        } catch (error) {
          throw new SecureSessionStoreError('Unable to clear secure session', {
            cause: error,
          });
        }
      }),
  });
}
