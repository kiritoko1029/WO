import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { canonicalHttpsOrigin } from './runtime-config.js';

export const DEFAULT_BACKEND_ORIGIN = 'https://localhost';

export type BackendTargetSource = 'environment' | 'stored' | 'default';

export interface BackendTargetSnapshot {
  readonly origin: string;
  readonly source: BackendTargetSource;
  readonly readOnly: boolean;
}

export interface BackendTargetStore {
  current(): Readonly<BackendTargetSnapshot>;
  save(origin: string): void;
}

export interface BackendTargetFileSystem {
  mkdirSync(
    path: string,
    options: { readonly recursive: true; readonly mode: number },
  ): unknown;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(
    path: string,
    contents: string,
    options: {
      readonly encoding: 'utf8';
      readonly flag: 'wx';
      readonly mode: number;
    },
  ): unknown;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

export interface BackendTargetStoreOptions {
  readonly userDataPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fileSystem?: BackendTargetFileSystem;
  readonly randomId?: () => string;
}

export class BackendTargetStoreError extends Error {
  readonly code?: 'INVALID_STATE' | 'VALIDATION_ERROR';

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly code?: 'INVALID_STATE' | 'VALIDATION_ERROR';
    },
  ) {
    super(message, options);
    this.name = 'BackendTargetStoreError';
    this.code = options?.code;
  }
}

const nodeFileSystem: BackendTargetFileSystem = {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
};

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function snapshot(
  origin: string,
  source: BackendTargetSource,
): Readonly<BackendTargetSnapshot> {
  return Object.freeze({
    origin,
    source,
    readOnly: source === 'environment',
  });
}

function parseStoredBackendTarget(value: string): string {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !('version' in parsed) ||
    !('origin' in parsed) ||
    parsed.version !== 1 ||
    typeof parsed.origin !== 'string'
  ) {
    throw new TypeError('Stored backend target is invalid');
  }
  return canonicalHttpsOrigin(parsed.origin);
}

export function createBackendTargetStore(
  options: BackendTargetStoreOptions,
): Readonly<BackendTargetStore> {
  if (options.userDataPath.trim() === '') {
    throw new TypeError('userDataPath is required');
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const createId = options.randomId ?? randomUUID;
  const targetPath = join(options.userDataPath, 'backend-target.json');
  const environmentOrigin = options.environment.WO_API_ORIGIN;
  let current: Readonly<BackendTargetSnapshot>;

  if (environmentOrigin !== undefined) {
    current = snapshot(canonicalHttpsOrigin(environmentOrigin), 'environment');
  } else {
    try {
      current = snapshot(
        parseStoredBackendTarget(fileSystem.readFileSync(targetPath, 'utf8')),
        'stored',
      );
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new BackendTargetStoreError(
          'Stored backend target cannot be read',
          { cause: error },
        );
      }
      current = snapshot(DEFAULT_BACKEND_ORIGIN, 'default');
    }
  }

  return Object.freeze({
    current: () => current,
    save: (origin: string) => {
      if (current.readOnly) {
        throw new BackendTargetStoreError(
          'Backend target is managed by WO_API_ORIGIN',
          { code: 'INVALID_STATE' },
        );
      }
      let canonicalOrigin: string;
      try {
        canonicalOrigin = canonicalHttpsOrigin(origin);
      } catch (error) {
        throw new BackendTargetStoreError('Backend target is invalid', {
          cause: error,
          code: 'VALIDATION_ERROR',
        });
      }
      const id = createId();
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
        throw new BackendTargetStoreError('Invalid temporary file identity');
      }
      const temporaryPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.${id}.tmp`,
      );
      try {
        fileSystem.mkdirSync(dirname(targetPath), {
          recursive: true,
          mode: 0o700,
        });
        fileSystem.writeFileSync(
          temporaryPath,
          `${JSON.stringify({ version: 1, origin: canonicalOrigin })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        fileSystem.renameSync(temporaryPath, targetPath);
      } catch (error) {
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {
          // Preserve the original persistence failure.
        }
        throw new BackendTargetStoreError('Backend target cannot be stored', {
          cause: error,
        });
      }
      current = snapshot(canonicalOrigin, 'stored');
    },
  });
}
