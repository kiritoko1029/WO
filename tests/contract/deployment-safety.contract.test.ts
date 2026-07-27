import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  checkBackupDirectory,
  checkPortConflicts,
  integrationEdgePorts,
  parseReservedPortRanges,
  validateRootOwnedDirectoryAncestors,
  validateTurnStateEmptyDirectory,
  validateTurnHostKernelState,
} from '../../deploy/scripts/preflight.mjs';
import { applyRelease } from '../../deploy/scripts/apply-release.mjs';
import {
  deploymentOperationLockEnvironmentField,
  deploymentOperationProcessEnvironment,
  failureMessage,
  pipeCommandToFile,
  pipeFileToCommand,
  releaseApplyLockDirectoryName,
  withDeploymentOperationLock,
} from '../../deploy/scripts/ops.mjs';
import {
  inspectCaddyArchive,
  withRestoreRuntimeImageOverrides,
} from '../../deploy/scripts/restore.mjs';
import {
  acquireRollbackImageLeases,
  assertRollbackComposeRuntimeEquivalent,
  assertRunningReleaseImages,
  captureRollbackImages,
  combineUpgradeCleanupFailures,
  createRollbackOverride,
  createRollbackWorkspace,
  inspectBuiltReleaseImages,
  normalizeCoturnPortBindings,
  normalizeCoturnRollbackMounts,
  postgresMajorFromImage,
  releaseImageOverrideSource,
  releaseRollbackImageLeases,
  releaseRollbackResources,
  releaseRollbackWorkspace,
  restoreImageTags,
  rollbackComposeEquivalenceOverrideSource,
  rollbackComposeLegacyPlatformOverrideSource,
  rollbackOverrideSource,
  throwUpgradeCleanupFailures,
  validateCoturnRollbackMountSources,
} from '../../deploy/scripts/upgrade.mjs';

const temporaryDirectories: string[] = [];
const deployRoot = resolve(import.meta.dirname, '..', '..', 'deploy');
const rollbackImageId = `sha256:${'a'.repeat(64)}`;
const rollbackImages = Object.fromEntries(
  ['caddy', 'server', 'postgres', 'coturn'].map((service) => [
    service,
    { imageId: rollbackImageId },
  ]),
);
const rollbackEnvironment = Object.freeze({
  TURN_EXTERNAL_IP: '203.0.113.10',
  TURN_INTERNAL_IP: '',
  TURN_LISTEN_PORT: '3478',
  TURN_REALM: 'turn.example.test',
  TURN_RELAY_MAX_PORT: '49160',
  TURN_RELAY_MIN_PORT: '49160',
  TURN_TLS_LISTEN_PORT: '5349',
});
const rollbackHealthcheck = Object.freeze({
  interval: 60_000_000_000,
  retries: 3,
  startInterval: 0,
  startPeriod: 10_000_000_000,
  test: [
    'CMD-SHELL',
    'exec /usr/local/bin/turn-healthcheck /run/secrets/turn_shared_secret "$TURN_LISTEN_PORT"',
  ],
  timeout: 5_000_000_000,
});
const releaseProvenance = Object.freeze({
  BUILD_CREATED: '2026-07-24T18:31:47Z',
  BUILD_REVISION: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
  BUILD_VERSION: '2026.07.24-b88a10f0867c',
  SOURCE_DATE_EPOCH: '1784917907',
});

function rollbackContainerInspection({
  composeConfigHash,
  containerId,
  imageId,
  imageReference,
  labelOverrides = {},
  service,
}: {
  composeConfigHash: string;
  containerId: string;
  imageId: string;
  imageReference: string;
  labelOverrides?: Readonly<Record<string, string>>;
  service: string;
}): string {
  return JSON.stringify({
    Config: {
      Image: imageReference,
      Labels: {
        'com.docker.compose.config-hash': composeConfigHash,
        'com.docker.compose.container-number': '1',
        'com.docker.compose.oneoff': 'False',
        'com.docker.compose.project': 'wo',
        'com.docker.compose.service': service,
        ...labelOverrides,
      },
    },
    Id: containerId,
    Image: imageId,
    State: { Running: true },
  });
}

function rollbackImageInspection({
  architecture = 'amd64',
  imageId,
  os = 'linux',
}: {
  architecture?: string;
  imageId: string;
  os?: string;
}): string {
  return JSON.stringify([
    {
      Architecture: architecture,
      Id: imageId,
      Os: os,
    },
  ]);
}

function tarHeader(name: string, type: '0' | '2' | '5', size = 0): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function archive(entries: Array<[string, '0' | '2' | '5']>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'wo-archive-test-'));
  temporaryDirectories.push(directory);
  const file = resolve(directory, 'archive.tgz');
  const tar = Buffer.concat([
    ...entries.map(([name, type]) => tarHeader(name, type)),
    Buffer.alloc(1024),
  ]);
  await writeFile(file, gzipSync(tar));
  return file;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function renderRollback(
  coturnBoundary: Parameters<typeof rollbackOverrideSource>[1],
  targetHostMode: boolean,
  selectedServices?: string[],
  images = rollbackImages,
) {
  const directory = await mkdtemp(resolve(tmpdir(), 'wo-rollback-test-'));
  temporaryDirectories.push(directory);
  const rollbackFile = resolve(directory, 'rollback.compose.yaml');
  await writeFile(
    rollbackFile,
    rollbackOverrideSource(images, coturnBoundary, {
      selectedServices,
    }),
  );
  const composeFiles = ['-f', resolve(deployRoot, 'compose.yaml')];
  if (targetHostMode) {
    composeFiles.push('-f', resolve(deployRoot, 'compose.turn-host.yaml'));
  }
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      'wo-rollback-contract',
      ...composeFiles,
      '-f',
      rollbackFile,
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACME_EMAIL: 'operator@example.test',
        APP_DOMAIN: 'rtc.example.test',
        BUILD_CREATED: '2026-07-24T18:31:47Z',
        BUILD_REVISION: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        BUILD_VERSION: '2026.07.24-aaaaaaaaaaaa',
        POSTGRES_DB: 'wo',
        POSTGRES_USER: 'wo',
        PUBLIC_IPV4: '203.0.113.10',
        SOURCE_DATE_EPOCH: '1784917907',
        TURN_HOST: 'turn.example.test',
        TURN_INTERNAL_IP: targetHostMode ? '172.24.52.219' : '',
        TURN_NETWORK_MODE: targetHostMode ? 'host' : 'bridge',
        TURN_PORT: '3478',
        TURN_REALM: 'turn.example.test',
        TURN_RELAY_MAX_PORT: targetHostMode ? '49509' : '49200',
        TURN_RELAY_MIN_PORT: '49160',
        TURN_STATE_EMPTY_DIR: '/var/empty/wo-turn',
        TURN_TLS_PORT: '5349',
        TURN_URLS:
          'stun:turn.example.test:3478,turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp',
      },
    },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe('deployment filesystem safety', () => {
  test('serializes destructive operations while allowing validated nested ownership', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'wo-operation-lock-test-'));
    temporaryDirectories.push(root);
    const lockDirectory = resolve(root, releaseApplyLockDirectoryName);
    const envFile = resolve(root, '.env');
    await writeFile(envFile, `BACKUP_DIR=${root}\n`);
    let conflictingOperationCalled = false;

    await withDeploymentOperationLock(root, async ({ token }) => {
      await expect(access(lockDirectory)).resolves.toBeUndefined();
      await expect(
        withDeploymentOperationLock(root, () => {
          conflictingOperationCalled = true;
        }),
      ).rejects.toThrow(/release apply lock already exists/i);
      expect(conflictingOperationCalled).toBe(false);

      await expect(
        withDeploymentOperationLock(
          root,
          ({ token: nestedToken }) => nestedToken,
          { token },
        ),
      ).resolves.toBe(token);
      expect(
        deploymentOperationProcessEnvironment(token, {})[
          deploymentOperationLockEnvironmentField
        ],
      ).toBe(token);
    });

    await expect(access(lockDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const productionLockDirectory = resolve(
      deployRoot,
      releaseApplyLockDirectoryName,
    );
    await withDeploymentOperationLock(deployRoot, async ({ token }) => {
      const nestedRestore = spawnSync(
        process.execPath,
        [
          resolve(deployRoot, 'scripts', 'restore.mjs'),
          `--env-file=${envFile}`,
          `--backup-dir=${resolve(root, 'missing')}`,
          '--confirm-restore',
        ],
        {
          encoding: 'utf8',
          env: deploymentOperationProcessEnvironment(token),
        },
      );
      expect(nestedRestore.status).toBe(1);
      expect(nestedRestore.stderr).not.toMatch(
        /release apply lock already exists/i,
      );
      await expect(access(productionLockDirectory)).resolves.toBeUndefined();
    });
    await expect(access(productionLockDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    let undefinedRejectionObserved = false;
    try {
      await withDeploymentOperationLock(root, () => {
        throw undefined;
      });
    } catch (error) {
      undefinedRejectionObserved = true;
      expect(error).toBeUndefined();
    }
    expect(undefinedRejectionObserved).toBe(true);
    await expect(access(lockDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const operationError = new Error('operation failed');
    const cleanupError = new Error('lock cleanup failed');
    let aggregateFailure: unknown;
    try {
      await withDeploymentOperationLock(
        root,
        () => {
          throw operationError;
        },
        {
          removeLockDirectory: async () => {
            throw cleanupError;
          },
        },
      );
    } catch (error) {
      aggregateFailure = error;
    }
    expect(aggregateFailure).toBeInstanceOf(AggregateError);
    expect(
      ((aggregateFailure as AggregateError).errors as Error[]).map(
        ({ message }) => message,
      ),
    ).toEqual(['operation failed', 'lock cleanup failed']);
    expect((aggregateFailure as AggregateError).cause).toBe(operationError);
    await rm(lockDirectory, { force: true, recursive: true });

    await mkdir(lockDirectory, { mode: 0o700 });
    let forgedReentryCalled = false;
    await expect(
      withDeploymentOperationLock(
        root,
        () => {
          forgedReentryCalled = true;
        },
        { token: 'a'.repeat(64) },
      ),
    ).rejects.toThrow(/release apply lock already exists/i);
    expect(forgedReentryCalled).toBe(false);
  });

  test('preserves undefined when deployment lock cleanup alone fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'wo-operation-lock-test-'));
    temporaryDirectories.push(root);
    let cleanupCalled = false;
    let rejectionObserved = false;
    let rejection: unknown = Symbol('operation resolved');

    try {
      await withDeploymentOperationLock(root, () => 'operation result', {
        removeLockDirectory: async () => {
          cleanupCalled = true;
          throw undefined;
        },
      });
    } catch (error) {
      rejectionObserved = true;
      rejection = error;
    }

    expect(cleanupCalled).toBe(true);
    expect(rejectionObserved).toBe(true);
    expect(rejection).toBeUndefined();
  });

  test('uses the production apply lock by default without invoking Docker', async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), 'wo-default-apply-lock-test-'),
    );
    temporaryDirectories.push(root);
    const lockDirectory = resolve(deployRoot, releaseApplyLockDirectoryName);
    const stopAfterLock = new Error('stop after observing production lock');
    let commandExecuted = false;
    let lockObserved = false;

    await expect(access(lockDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      applyRelease(
        {
          confirmApply: true,
          envFile: resolve(root, '.env'),
          execute: () => {
            commandExecuted = true;
            return '';
          },
          expectedManifestSha256: 'a'.repeat(64),
          manifestFile: resolve(root, 'release-manifest.json'),
          mode: 'initial',
          profileName: 'external-db',
          rollbackRoot: root,
        },
        {
          assertRollbackRoot: async (directory: string) => directory,
          loadEnvironment: () => ({
            DEPLOY_SECRET_DIR: resolve(root, 'secrets'),
            DEPLOY_SMOKE_EMAILS:
              'smoke-one@example.test,smoke-two@example.test,smoke-three@example.test',
            DEPLOY_SMOKE_PASSWORD: 'correct-horse-battery-staple',
          }),
          readReleaseBundle: async () => {
            await expect(access(lockDirectory)).resolves.toBeUndefined();
            lockObserved = true;
            throw stopAfterLock;
          },
        },
      ),
    ).rejects.toBe(stopAfterLock);

    expect(lockObserved).toBe(true);
    expect(commandExecuted).toBe(false);
    await expect(access(lockDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('rejects every destructive CLI entry before lock-conflict side effects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'wo-entry-lock-test-'));
    temporaryDirectories.push(root);
    const envFile = resolve(root, '.env');
    const alternateBackupRoot = resolve(root, 'alternate-backups');
    const alternateEnvFile = resolve(root, '.env.alternate');
    const lockDirectory = resolve(deployRoot, releaseApplyLockDirectoryName);
    await mkdir(alternateBackupRoot);
    await writeFile(envFile, `BACKUP_DIR=${root}\n`);
    await writeFile(alternateEnvFile, `BACKUP_DIR=${alternateBackupRoot}\n`);
    const cleanEnvironment = { ...process.env };
    Reflect.deleteProperty(
      cleanEnvironment,
      deploymentOperationLockEnvironmentField,
    );

    await mkdir(lockDirectory, { mode: 0o700 });
    try {
      for (const [script, selectedEnvFile, arguments_] of [
        ['backup.mjs', envFile, []],
        [
          'restore.mjs',
          alternateEnvFile,
          ['--confirm-restore', `--backup-dir=${resolve(root, 'missing')}`],
        ],
        ['upgrade.mjs', envFile, []],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          [
            resolve(deployRoot, 'scripts', script),
            `--env-file=${selectedEnvFile}`,
            ...arguments_,
          ],
          { encoding: 'utf8', env: cleanEnvironment },
        );
        expect(result.status, `${script}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toMatch(/release apply lock already exists/i);
        expect((await readdir(root)).sort()).toEqual(
          ['.env', '.env.alternate', 'alternate-backups'].sort(),
        );
      }
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test('pins every service before a standalone restore operation starts', async () => {
    type Compose = (...arguments_: string[]) => string[];
    const capturedServices: string[] = [];
    const compose: Compose = (...arguments_) => ['compose', ...arguments_];
    const result = await withRestoreRuntimeImageOverrides({
      compose,
      operation: (selectedCompose: Compose) => {
        expect(capturedServices).toEqual([
          'caddy',
          'server',
          'postgres',
          'coturn',
        ]);
        return selectedCompose('up', '-d', '--wait');
      },
      withOverride: async ({
        compose: selectedCompose,
        operation,
        service,
      }: {
        compose: Compose;
        operation: (compose: Compose) => string[] | Promise<string[]>;
        service: string;
      }) => {
        capturedServices.push(service);
        return operation((...arguments_) =>
          selectedCompose('-f', `${service}.override.yaml`, ...arguments_),
        );
      },
    });

    expect(result).toEqual([
      'compose',
      '-f',
      'caddy.override.yaml',
      '-f',
      'server.override.yaml',
      '-f',
      'postgres.override.yaml',
      '-f',
      'coturn.override.yaml',
      'up',
      '-d',
      '--wait',
    ]);
  });

  test('parses only explicit PostgreSQL image majors', () => {
    expect(postgresMajorFromImage('postgres:17.10-alpine3.23')).toBe(17);
    expect(() => postgresMajorFromImage('postgres:latest')).toThrow(/major/i);
  });

  test('rejects an unbounded port plan before allocating its relay range', async () => {
    await expect(
      checkPortConflicts({
        TURN_PORT: '3478',
        TURN_TLS_PORT: '5349',
        TURN_RELAY_MIN_PORT: '1',
        TURN_RELAY_MAX_PORT: '4294967295',
      }),
    ).resolves.toEqual([
      'Port conflict check requires a valid bounded TURN port plan',
    ]);
  });

  test('requires host relay ports overlapping ephemeral ports to be reserved', () => {
    const environment = {
      TURN_INTERNAL_IP: '172.24.52.219',
      TURN_PORT: '3478',
      TURN_RELAY_MIN_PORT: '49160',
      TURN_RELAY_MAX_PORT: '49509',
      TURN_TLS_PORT: '5349',
    };
    const interfaceMap = {
      eth0: [
        {
          address: '172.24.52.219',
          family: 'IPv4',
          internal: false,
          netmask: '255.255.255.0',
          cidr: '172.24.52.219/24',
          mac: '00:00:00:00:00:00',
          scopeid: 0,
        },
      ],
    };
    expect(parseReservedPortRanges('1000,49160-49200,49201-49509')).toEqual([
      [1000, 1000],
      [49160, 49200],
      [49201, 49509],
    ]);
    expect(parseReservedPortRanges('invalid')).toBeNull();
    expect(
      validateTurnHostKernelState(environment, {
        interfaceMap,
        ephemeralPortRange: '32768 60999',
        reservedPorts: '49160-49509',
      }),
    ).toEqual([]);
    expect(
      validateTurnHostKernelState(environment, {
        interfaceMap,
        ephemeralPortRange: '32768 60999',
        reservedPorts: '49160-49200',
      }).join('\n'),
    ).toMatch(/ip_local_reserved_ports/);
    expect(
      validateTurnHostKernelState(environment, {
        interfaceMap: {},
        ephemeralPortRange: '32768 60999',
        reservedPorts: '49160-49509',
      }).join('\n'),
    ).toMatch(/local IPv4 interface/);
    expect(
      validateTurnHostKernelState(
        {
          ...environment,
          TURN_PORT: '50000',
        },
        {
          interfaceMap,
          ephemeralPortRange: '32768 60999',
          reservedPorts: '49160-49509',
        },
      ).join('\n'),
    ).toMatch(/ip_local_reserved_ports/);
  });

  test('rejects a writable ancestor of the TURN host state directory', async () => {
    const metadata = (mode: number) => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode,
      uid: 0,
    });
    const metadataByPath = new Map([
      ['/', metadata(0o755)],
      ['/opt', metadata(0o755)],
      ['/opt/wo', metadata(0o775)],
    ]);
    await expect(
      validateRootOwnedDirectoryAncestors('/opt/wo/coturn-empty', {
        metadataLookup: async (path: string) => metadataByPath.get(path)!,
      }),
    ).resolves.toEqual([
      'TURN_STATE_EMPTY_DIR ancestors must be root-owned directories without symbolic links or group/other write access',
    ]);
  });

  test('validates the reusable empty TURN state directory contract', async () => {
    const directoryMetadata = (mode = 0o755) => ({
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      mode,
      uid: 0,
    });
    await expect(
      validateTurnStateEmptyDirectory('/opt/wo/coturn-empty', {
        ancestorValidator: async () => [],
        directoryEntries: async () => [],
        linkDetector: async () => false,
        metadataLookup: async () => directoryMetadata(),
      }),
    ).resolves.toEqual([]);
    await expect(
      validateTurnStateEmptyDirectory('/opt/wo/coturn-empty', {
        ancestorValidator: async () => [],
        directoryEntries: async () => ['unexpected-state'],
        linkDetector: async () => false,
        metadataLookup: async () => directoryMetadata(),
      }),
    ).resolves.toEqual(['TURN_STATE_EMPTY_DIR must be empty']);
    await expect(
      validateTurnStateEmptyDirectory('/opt/wo/coturn-empty', {
        metadataLookup: async () => {
          const error = new Error('missing');
          Object.assign(error, { code: 'ENOENT' });
          throw error;
        },
      }),
    ).resolves.toEqual(['TURN_STATE_EMPTY_DIR is not usable (ENOENT)']);
  });

  test.each([
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a string', 'metadata lookup failed', 'metadata lookup failed'],
    ['a plain object', { reason: 'lookup failed' }, '[object Object]'],
    ['an unprintable object', Object.create(null), 'Unprintable error'],
  ])(
    'safely reports TURN state metadata rejection from %s',
    async (_description, rejection, expectedMessage) => {
      await expect(
        validateTurnStateEmptyDirectory('/opt/wo/coturn-empty', {
          metadataLookup: async () => {
            throw rejection;
          },
        }),
      ).resolves.toEqual([
        `TURN_STATE_EMPTY_DIR is not usable (${expectedMessage})`,
      ]);
    },
  );

  test('rejects a missing host rollback source before writing its override', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-rollback-order-test-'),
    );
    temporaryDirectories.push(directory);
    const missingStateDirectory = resolve(directory, 'missing-state');
    const mounts = normalizeCoturnRollbackMounts(
      [
        {
          Destination: '/var/lib/coturn',
          Propagation: 'rprivate',
          RW: false,
          Source: missingStateDirectory,
          Type: 'bind',
        },
      ],
      true,
    );
    await expect(
      validateCoturnRollbackMountSources(mounts, { hostMode: true }),
    ).rejects.toThrow(/host rollback state source is unsafe/i);

    let snapshotAttempted = false;
    await expect(
      createRollbackOverride(directory, rollbackImages, {
        boundaryCapture: () => ({
          healthcheck: rollbackHealthcheck,
          hostMode: true,
          mounts,
          ports: [],
          turnEnvironment: {
            ...rollbackEnvironment,
            TURN_INTERNAL_IP: '172.24.52.210',
          },
        }),
        mountSnapshotter: async () => {
          snapshotAttempted = true;
          return mounts;
        },
      }),
    ).rejects.toThrow(/host rollback state source is unsafe/i);
    expect(snapshotAttempted).toBe(false);
    await expect(
      access(resolve(directory, 'rollback.compose.yaml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves non-Error rollback mount validation failures', async () => {
    const invalidFailures = [
      undefined,
      null,
      'metadata failure',
      { reason: 'metadata failure' },
    ];
    const mounts = [
      {
        source: '/safe/coturn-state',
        target: '/var/lib/coturn',
        type: 'bind',
      },
      {
        source: '/safe/turnserver.conf',
        target: '/etc/coturn/turnserver.wo.conf',
        type: 'bind',
      },
    ];

    for (const mount of mounts) {
      for (const invalidFailure of invalidFailures) {
        let failure: unknown;
        try {
          await validateCoturnRollbackMountSources([mount], {
            ancestorValidator: async () => [],
            metadataLookup: async () => {
              throw invalidFailure;
            },
          });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('invalid metadata');
        expect(Object.hasOwn(failure as Error, 'cause')).toBe(true);
        expect((failure as Error).cause).toBe(invalidFailure);
      }
    }
  });

  test('removes the rollback workspace when preparation fails', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'wo-rollback-parent-test-'));
    temporaryDirectories.push(parent);
    let workspace: string | undefined;
    await expect(
      createRollbackWorkspace(rollbackImages, {
        createOverride: async (directory: string) => {
          workspace = directory;
          await writeFile(resolve(directory, 'sensitive-snapshot'), 'snapshot');
          throw new Error('rollback prerequisite failed');
        },
        workspaceRoot: parent,
      }),
    ).rejects.toThrow(/prerequisite failed/i);
    expect(workspace).toBeTypeOf('string');
    await expect(access(workspace!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves preparation and cleanup failures together', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'wo-rollback-errors-test-'));
    temporaryDirectories.push(parent);
    const preparationError = new Error('original preparation failure');
    const cleanupError = new Error('cleanup failure');
    let failure: unknown;
    try {
      await createRollbackWorkspace(rollbackImages, {
        createOverride: async () => {
          throw preparationError;
        },
        removeDirectory: async () => {
          throw cleanupError;
        },
        workspaceRoot: parent,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(['original preparation failure', 'cleanup failure']);
    expect((failure as AggregateError).cause).toBe(preparationError);
  });

  test('retains rollback snapshots that may still back container bind mounts', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'wo-rollback-retain-test-'));
    temporaryDirectories.push(parent);
    const workspace = await mkdtemp(resolve(parent, 'upgrade-'));
    await writeFile(resolve(workspace, 'turnserver.rollback.conf'), 'config');

    await expect(releaseRollbackWorkspace(workspace, true)).resolves.toBe(
      false,
    );
    await expect(
      access(resolve(workspace, 'turnserver.rollback.conf')),
    ).resolves.toBeUndefined();

    await expect(releaseRollbackWorkspace(workspace, false)).resolves.toBe(
      true,
    );
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('surfaces rollback workspace release failures', async () => {
    await expect(
      releaseRollbackWorkspace('/safe/rollback/workspace', false, {
        removeDirectory: async () => {
          throw new Error('cleanup failed');
        },
      }),
    ).rejects.toThrow('cleanup failed');
  });

  test('surfaces cleanup failure without hiding the upgrade failure', () => {
    const upgradeError = new Error('release activation failed');
    const cleanupError = new Error('image lease cleanup failed');
    const failure = combineUpgradeCleanupFailures(upgradeError, cleanupError);

    expect(failure.message).toContain(upgradeError.message);
    expect(failure.message).toContain(cleanupError.message);
    expect(failure.errors).toEqual([upgradeError, cleanupError]);
    expect(failure.cause).toBe(upgradeError);
  });

  test('distinguishes undefined upgrade and cleanup failures from success', () => {
    let upgradeFailureObserved = false;
    try {
      throwUpgradeCleanupFailures({
        cleanupError: undefined,
        cleanupFailed: false,
        upgradeError: undefined,
        upgradeFailed: true,
      });
    } catch (error) {
      upgradeFailureObserved = true;
      expect(error).toBeUndefined();
    }
    expect(upgradeFailureObserved).toBe(true);

    let cleanupFailureObserved = false;
    try {
      throwUpgradeCleanupFailures({
        cleanupError: undefined,
        cleanupFailed: true,
        upgradeError: undefined,
        upgradeFailed: false,
      });
    } catch (error) {
      cleanupFailureObserved = true;
      expect(error).toBeUndefined();
    }
    expect(cleanupFailureObserved).toBe(true);

    let combinedFailure: unknown;
    try {
      throwUpgradeCleanupFailures({
        cleanupError: undefined,
        cleanupFailed: true,
        upgradeError: undefined,
        upgradeFailed: true,
      });
    } catch (error) {
      combinedFailure = error;
    }
    expect(combinedFailure).toBeInstanceOf(AggregateError);
    expect((combinedFailure as AggregateError).errors).toEqual([
      undefined,
      undefined,
    ]);
    expect(Object.hasOwn(combinedFailure as AggregateError, 'cause')).toBe(
      true,
    );
    expect((combinedFailure as AggregateError).cause).toBeUndefined();
  });

  test('formats arbitrary deployment failures without masking them', () => {
    expect(failureMessage(new Error('typed failure'))).toBe('typed failure');
    const symbolMessage = new Error('placeholder');
    Object.defineProperty(symbolMessage, 'message', {
      value: Symbol('typed failure'),
    });
    expect(failureMessage(symbolMessage)).toBe('Symbol(typed failure)');
    const nonCoercibleMessage = new Error('placeholder');
    Object.defineProperty(nonCoercibleMessage, 'message', {
      value: Object.create(null),
    });
    expect(failureMessage(nonCoercibleMessage)).toBe('Unprintable error');
    expect(failureMessage(undefined)).toBe('undefined');
    expect(failureMessage(null)).toBe('null');
    expect(failureMessage('primitive failure')).toBe('primitive failure');
    expect(failureMessage({ reason: 'object failure' })).toBe(
      '[object Object]',
    );
    expect(failureMessage(Object.create(null))).toBe('Unprintable error');
  });

  test('waits for complete binary dump output and restore input streams', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wo-piped-io-test-'));
    temporaryDirectories.push(directory);
    const dump = resolve(directory, 'postgres.dump');
    const restored = resolve(directory, 'restored.dump');
    const expected = Buffer.alloc(2 * 1024 * 1024, 0x5a);

    await pipeCommandToFile(
      process.execPath,
      [
        '--eval',
        `process.stdout.write(Buffer.alloc(${expected.length}, 0x5a))`,
      ],
      dump,
      { label: 'Binary dump fixture' },
    );
    expect(await readFile(dump)).toEqual(expected);

    await pipeFileToCommand(
      dump,
      process.execPath,
      [
        '--eval',
        "const fs = require('node:fs'); process.stdin.pipe(fs.createWriteStream(process.argv[1]))",
        restored,
      ],
      { label: 'Binary restore fixture' },
    );
    expect(await readFile(restored)).toEqual(expected);
  }, 30_000);

  test('rejects a missing piped restore input without an unhandled stream error', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-piped-input-error-test-'),
    );
    temporaryDirectories.push(directory);

    await expect(
      pipeFileToCommand(
        resolve(directory, 'missing.dump'),
        process.execPath,
        ['--eval', 'process.stdin.resume()'],
        { label: 'Missing restore input fixture' },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([
    ['undefined', 'throw undefined;', 'undefined'],
    ['null', 'throw null;', 'null'],
    [
      'a string',
      "throw 'preflight dependency rejected';",
      'preflight dependency rejected',
    ],
    [
      'a null-prototype object',
      'throw Object.create(null);',
      'Unprintable error',
    ],
  ])(
    'reports %s from the real preflight CLI and exits nonzero',
    async (_description, thrownSource, expectedMessage) => {
      const root = await mkdtemp(resolve(tmpdir(), 'wo-preflight-cli-test-'));
      temporaryDirectories.push(root);
      const preload = resolve(root, 'reject-argument-read.mjs');
      await writeFile(
        preload,
        `process.argv.slice = () => { ${thrownSource} };\n`,
      );

      const result = spawnSync(
        process.execPath,
        ['--import', preload, resolve(deployRoot, 'scripts', 'preflight.mjs')],
        { encoding: 'utf8' },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(
        `Preflight failed (${expectedMessage})`,
      );
    },
  );

  test.each([
    ['undefined', 'throw undefined;', 'undefined'],
    ['null', 'throw null;', 'null'],
    [
      'a string',
      "throw 'compose dependency rejected';",
      'compose dependency rejected',
    ],
    [
      'a null-prototype object',
      'throw Object.create(null);',
      'Unprintable error',
    ],
  ])(
    'reports %s from the real Compose CLI and exits nonzero',
    async (_description, thrownSource, expectedMessage) => {
      const root = await mkdtemp(resolve(tmpdir(), 'wo-compose-cli-test-'));
      temporaryDirectories.push(root);
      const preload = resolve(root, 'reject-argument-read.mjs');
      await writeFile(
        preload,
        `process.argv.slice = () => { ${thrownSource} };\n`,
      );

      const result = spawnSync(
        process.execPath,
        ['--import', preload, resolve(deployRoot, 'scripts', 'compose.mjs')],
        { encoding: 'utf8' },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(`Compose failed (${expectedMessage})`);
    },
  );

  test('preserves arbitrary failures caught inside the real preflight checks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'wo-preflight-check-test-'));
    temporaryDirectories.push(root);
    const preload = resolve(root, 'reject-docker-spawn.mjs');
    await writeFile(
      preload,
      [
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'childProcess.spawnSync = () => { throw null; };',
        'syncBuiltinESMExports();',
        '',
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        resolve(deployRoot, 'scripts', 'preflight.mjs'),
        `--env-file=${resolve(deployRoot, '.env.integration')}`,
        '--integration',
        '--allow-non-linux',
        '--allow-running',
      ],
      { encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ERROR: null');
    expect(result.stderr).not.toContain('Preflight failed');
  });

  test('restores mutable rollback tags without tagging immutable references', () => {
    const images = {
      caddy: {
        imageId: `sha256:${'a'.repeat(64)}`,
        imageReference: 'wo-caddy:stable',
      },
      server: {
        imageId: `sha256:${'b'.repeat(64)}`,
        imageReference: `registry.example.test/wo-server@sha256:${'1'.repeat(64)}`,
      },
      postgres: {
        imageId: `sha256:${'c'.repeat(64)}`,
        imageReference: `sha256:${'2'.repeat(64)}`,
      },
      coturn: {
        imageId: `sha256:${'d'.repeat(64)}`,
        imageReference: 'registry.example.test/wo-coturn:stable',
      },
    };
    const calls: string[][] = [];

    restoreImageTags(images, ['caddy', 'server', 'postgres', 'coturn'], {
      execute: (_command: string, arguments_: string[]) => {
        calls.push(arguments_);
        return '';
      },
    });

    expect(calls).toEqual([
      ['image', 'tag', images.caddy.imageId, images.caddy.imageReference],
      ['image', 'tag', images.coturn.imageId, images.coturn.imageReference],
    ]);
    expect(calls.flat()).not.toContain(images.server.imageReference);
    expect(calls.flat()).not.toContain(images.postgres.imageReference);
  });

  test('captures, leases, and releases selected rollback services in order', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-selected-image-test-'),
    );
    temporaryDirectories.push(directory);
    const envFile = resolve(directory, '.env');
    await writeFile(envFile, '');
    const selectedServices = ['server', 'coturn'];
    const imageIds = {
      coturn: `sha256:${'d'.repeat(64)}`,
      server: `sha256:${'b'.repeat(64)}`,
    };
    const containerIds = {
      coturn: '2'.repeat(64),
      server: '1'.repeat(64),
    };
    const composeConfigHashes = {
      coturn: '4'.repeat(64),
      server: '3'.repeat(64),
    };
    const calls: string[][] = [];
    const execute = (_command: string, arguments_: string[]) => {
      calls.push(arguments_);
      if (arguments_[0] === 'compose') {
        const service = arguments_.at(-1) as keyof typeof containerIds;
        return `${containerIds[service]}\n`;
      }
      if (arguments_[0] === 'image' && arguments_[1] === 'inspect') {
        return rollbackImageInspection({ imageId: arguments_[2]! });
      }
      if (arguments_[0] === 'inspect') {
        const containerId = arguments_.at(-1)!;
        const service = (
          Object.keys(containerIds) as Array<keyof typeof containerIds>
        ).find((candidate) => containerIds[candidate] === containerId);
        if (service === undefined) {
          throw new Error(`Unexpected rollback container ${containerId}`);
        }
        return rollbackContainerInspection({
          composeConfigHash: composeConfigHashes[service],
          containerId,
          imageId: imageIds[service],
          imageReference: `wo-${service}:stable`,
          service,
        });
      }
      return '';
    };
    const images = captureRollbackImages(envFile, {
      execute,
      selectedServices,
    });

    expect(Object.keys(images)).toEqual(selectedServices);
    expect(
      calls.map((arguments_) => {
        if (arguments_[0] === 'compose') {
          return `compose:${arguments_.at(-1)}`;
        }
        return `${arguments_[0]}:${arguments_[1]}`;
      }),
    ).toEqual([
      'compose:server',
      'inspect:--format',
      'image:inspect',
      'compose:coturn',
      'inspect:--format',
      'image:inspect',
    ]);
    expect(
      calls
        .filter(([command]) => command === 'compose')
        .map((arguments_) => arguments_.slice(-4)),
    ).toEqual([
      ['ps', '--all', '-q', 'server'],
      ['ps', '--all', '-q', 'coturn'],
    ]);
    expect(
      calls
        .filter(([command]) => command === 'inspect')
        .map((arguments_) => arguments_.at(-1)),
    ).toEqual([containerIds.server, containerIds.coturn]);
    expect(
      calls
        .filter(
          ([command, action]) => command === 'image' && action === 'inspect',
        )
        .map((arguments_) => arguments_.at(-1)),
    ).toEqual([imageIds.server, imageIds.coturn]);
    expect(images).toMatchObject({
      coturn: {
        architecture: 'amd64',
        composeConfigHash: composeConfigHashes.coturn,
        containerId: containerIds.coturn,
        os: 'linux',
      },
      server: {
        architecture: 'amd64',
        composeConfigHash: composeConfigHashes.server,
        containerId: containerIds.server,
        os: 'linux',
      },
    });

    calls.length = 0;
    const leasedImages = acquireRollbackImageLeases(images, {
      execute,
      leaseReferenceFactory: (service: string) =>
        `wo-rollback-lease:test-${service}`,
      selectedServices,
    });
    expect(calls).toEqual([
      ['image', 'tag', imageIds.server, 'wo-rollback-lease:test-server'],
      ['image', 'tag', imageIds.coturn, 'wo-rollback-lease:test-coturn'],
    ]);

    calls.length = 0;
    expect(
      releaseRollbackImageLeases(leasedImages, false, {
        execute,
        selectedServices,
      }),
    ).toBe(true);
    expect(calls).toEqual([
      ['image', 'rm', 'wo-rollback-lease:test-coturn'],
      ['image', 'rm', 'wo-rollback-lease:test-server'],
    ]);
  });

  test.each([
    ['project', { 'com.docker.compose.project': 'unexpected-project' }],
    ['service', { 'com.docker.compose.service': 'coturn' }],
    ['one-off state', { 'com.docker.compose.oneoff': 'True' }],
    ['container number', { 'com.docker.compose.container-number': '2' }],
    ['config hash', { 'com.docker.compose.config-hash': 'not-a-hash' }],
  ])(
    'rejects a rollback container with mismatched Compose %s',
    (_boundary, labelOverrides) => {
      const containerId = '1'.repeat(64);
      const imageId = `sha256:${'a'.repeat(64)}`;

      expect(() =>
        captureRollbackImages('/safe/.env', {
          composeArgumentsForProfile: (
            _envFile: string,
            ...arguments_: string[]
          ) => ['compose', ...arguments_],
          execute: (_command: string, arguments_: string[]) => {
            if (arguments_[0] === 'compose') {
              return `${containerId}\n`;
            }
            return rollbackContainerInspection({
              composeConfigHash: '2'.repeat(64),
              containerId,
              imageId,
              imageReference: 'wo-server:stable',
              labelOverrides,
              service: 'server',
            });
          },
          selectedServices: ['server'],
        }),
      ).toThrow(
        'server rollback container and Compose boundary cannot be pinned safely',
      );
    },
  );

  test.each([
    [
      'image ID',
      {
        Architecture: 'amd64',
        Id: `sha256:${'b'.repeat(64)}`,
        Os: 'linux',
      },
    ],
    [
      'operating system',
      {
        Architecture: 'amd64',
        Id: `sha256:${'a'.repeat(64)}`,
        Os: 'windows',
      },
    ],
    [
      'architecture',
      {
        Architecture: 'arm64',
        Id: `sha256:${'a'.repeat(64)}`,
        Os: 'linux',
      },
    ],
  ])('rejects a rollback image with mismatched %s', (_boundary, image) => {
    const containerId = '1'.repeat(64);
    const imageId = `sha256:${'a'.repeat(64)}`;

    expect(() =>
      captureRollbackImages('/safe/.env', {
        composeArgumentsForProfile: (
          _envFile: string,
          ...arguments_: string[]
        ) => ['compose', ...arguments_],
        execute: (_command: string, arguments_: string[]) => {
          if (arguments_[0] === 'compose') {
            return `${containerId}\n`;
          }
          if (arguments_[0] === 'inspect') {
            return rollbackContainerInspection({
              composeConfigHash: '2'.repeat(64),
              containerId,
              imageId,
              imageReference: 'wo-server:stable',
              service: 'server',
            });
          }
          if (arguments_[0] === 'image' && arguments_[1] === 'inspect') {
            return JSON.stringify([image]);
          }
          throw new Error(
            `Unexpected Docker arguments: ${arguments_.join(' ')}`,
          );
        },
        selectedServices: ['server'],
      }),
    ).toThrow(
      'server rollback image identity and platform cannot be pinned safely',
    );
  });

  test('fails closed when the rollback server Compose hash differs from the captured runtime', () => {
    const envFile = '/safe/.env';
    const equivalenceOverride = '/safe/rollback-equivalence.compose.yaml';
    const legacyPlatformOverride =
      '/safe/rollback-legacy-platform.compose.yaml';
    const rollbackOverride = '/safe/rollback.compose.yaml';
    const capturedHash = 'a'.repeat(64);
    const renderedHash = 'b'.repeat(64);
    const calls: string[][] = [];

    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        envFile,
        rollbackOverride,
        { server: { composeConfigHash: capturedHash } },
        {
          composeArgumentsForProfile: (
            actualEnvFile: string,
            ...arguments_: string[]
          ) => {
            expect(actualEnvFile).toBe(envFile);
            return ['compose', ...arguments_];
          },
          execute: (
            command: string,
            arguments_: string[],
            options: { label?: string },
          ) => {
            calls.push(arguments_);
            expect(command).toBe('docker');
            expect(options.label).toMatch(
              /^Server rollback(?: legacy platform)? Compose runtime equivalence$/u,
            );
            return `server ${renderedHash}\n`;
          },
          equivalenceOverride,
          legacyPlatformOverride,
        },
      ),
    ).toThrow(
      'Server rollback runtime configuration differs from the running Compose boundary',
    );
    expect(calls).toEqual([
      [
        'compose',
        '-f',
        rollbackOverride,
        '-f',
        equivalenceOverride,
        'config',
        '--hash',
        'server',
      ],
      [
        'compose',
        '-f',
        rollbackOverride,
        '-f',
        equivalenceOverride,
        '-f',
        legacyPlatformOverride,
        'config',
        '--hash',
        'server',
      ],
    ]);
  });

  test('rejects malformed primary Compose hash output without using the legacy fallback', () => {
    const capturedHash = 'a'.repeat(64);
    const calls: string[][] = [];

    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        '/safe/rollback.compose.yaml',
        { server: { composeConfigHash: capturedHash } },
        {
          composeArgumentsForProfile: (
            _envFile: string,
            ...arguments_: string[]
          ) => ['compose', ...arguments_],
          equivalenceOverride: '/safe/rollback-equivalence.compose.yaml',
          execute: (_command: string, arguments_: string[]) => {
            calls.push(arguments_);
            return calls.length === 1
              ? 'unexpected Compose output\n'
              : `server ${capturedHash}\n`;
          },
          legacyPlatformOverride: '/safe/rollback-legacy-platform.compose.yaml',
        },
      ),
    ).toThrow(
      'Server rollback runtime configuration differs from the running Compose boundary',
    );
    expect(calls).toHaveLength(1);
  });

  test('normalizes only the rollback image reference before comparing the Compose hash', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-rollback-equivalence-test-'),
    );
    temporaryDirectories.push(directory);
    const baseCompose = resolve(directory, 'compose.yaml');
    const rollbackOverride = resolve(directory, 'rollback.compose.yaml');
    const driftedRollbackOverride = resolve(
      directory,
      'rollback-drift.compose.yaml',
    );
    const equivalenceOverride = resolve(
      directory,
      'rollback-equivalence.compose.yaml',
    );
    const imageReference = 'example/server:stable';
    const imageId = `sha256:${'a'.repeat(64)}`;
    await writeFile(
      baseCompose,
      [
        'services:',
        '  server:',
        `    image: ${imageReference}`,
        '    environment:',
        '      POSTGRES_HOST: db.example.test',
        '',
      ].join('\n'),
    );
    await writeFile(
      rollbackOverride,
      rollbackOverrideSource({ server: { imageId } }, undefined, {
        selectedServices: ['server'],
      }),
    );
    await writeFile(
      driftedRollbackOverride,
      [
        rollbackOverrideSource({ server: { imageId } }, undefined, {
          selectedServices: ['server'],
        }).trimEnd(),
        '    environment:',
        '      POSTGRES_HOST: changed.example.test',
        '',
      ].join('\n'),
    );
    await writeFile(
      equivalenceOverride,
      rollbackComposeEquivalenceOverrideSource({
        server: { imageReference },
      }),
    );

    const compose = (...arguments_: string[]) => [
      'compose',
      '--project-name',
      'wo-rollback-equivalence-contract',
      '-f',
      baseCompose,
      ...arguments_,
    ];
    const execute = (_command: string, arguments_: string[]) => {
      const result = spawnSync('docker', arguments_, { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Docker Compose hash probe failed');
      }
      return result.stdout;
    };
    const capturedRow = execute(
      'docker',
      compose('config', '--hash', 'server'),
    ).trim();
    const capturedHash = /^server ([a-f0-9]{64})$/u.exec(capturedRow)?.[1];
    expect(capturedHash).toMatch(/^[a-f0-9]{64}$/u);
    const images = { server: { composeConfigHash: capturedHash } };

    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        rollbackOverride,
        images,
        {
          composeArgumentsForProfile: (_envFile, ...arguments_) =>
            compose(...arguments_),
          equivalenceOverride,
          execute,
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        driftedRollbackOverride,
        images,
        {
          composeArgumentsForProfile: (_envFile, ...arguments_) =>
            compose(...arguments_),
          equivalenceOverride,
          execute,
        },
      ),
    ).toThrow(
      'Server rollback runtime configuration differs from the running Compose boundary',
    );
  });

  test('accepts a legacy running hash only after resetting the newly pinned server platform', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-rollback-legacy-platform-test-'),
    );
    temporaryDirectories.push(directory);
    const legacyCompose = resolve(directory, 'legacy.compose.yaml');
    const currentCompose = resolve(directory, 'current.compose.yaml');
    const rollbackOverride = resolve(directory, 'rollback.compose.yaml');
    const driftedRollbackOverride = resolve(
      directory,
      'rollback-drift.compose.yaml',
    );
    const equivalenceOverride = resolve(
      directory,
      'rollback-equivalence.compose.yaml',
    );
    const legacyPlatformOverride = resolve(
      directory,
      'rollback-legacy-platform.compose.yaml',
    );
    const imageReference = 'example/server:stable';
    const imageId = `sha256:${'a'.repeat(64)}`;
    const environment = [
      '    environment:',
      '      POSTGRES_HOST: db.example.test',
    ];
    await writeFile(
      legacyCompose,
      [
        'services:',
        '  server:',
        `    image: ${imageReference}`,
        ...environment,
        '',
      ].join('\n'),
    );
    await writeFile(
      currentCompose,
      [
        'services:',
        '  server:',
        `    image: ${imageReference}`,
        '    platform: linux/amd64',
        ...environment,
        '',
      ].join('\n'),
    );
    await writeFile(
      rollbackOverride,
      rollbackOverrideSource({ server: { imageId } }, undefined, {
        selectedServices: ['server'],
      }),
    );
    await writeFile(
      driftedRollbackOverride,
      [
        rollbackOverrideSource({ server: { imageId } }, undefined, {
          selectedServices: ['server'],
        }).trimEnd(),
        '    environment:',
        '      POSTGRES_HOST: changed.example.test',
        '',
      ].join('\n'),
    );
    await writeFile(
      equivalenceOverride,
      rollbackComposeEquivalenceOverrideSource({
        server: { imageReference },
      }),
    );
    await writeFile(
      legacyPlatformOverride,
      rollbackComposeLegacyPlatformOverrideSource(),
    );

    const compose = (file: string, ...arguments_: string[]) => [
      'compose',
      '--project-name',
      'wo-rollback-legacy-platform-contract',
      '-f',
      file,
      ...arguments_,
    ];
    const calls: string[][] = [];
    const execute = (_command: string, arguments_: string[]) => {
      calls.push(arguments_);
      const result = spawnSync('docker', arguments_, { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Docker Compose hash probe failed');
      }
      return result.stdout;
    };
    const capturedRow = execute(
      'docker',
      compose(legacyCompose, 'config', '--hash', 'server'),
    ).trim();
    const capturedHash = /^server ([a-f0-9]{64})$/u.exec(capturedRow)?.[1];
    expect(capturedHash).toMatch(/^[a-f0-9]{64}$/u);
    const currentRow = execute(
      'docker',
      compose(currentCompose, 'config', '--hash', 'server'),
    ).trim();
    const currentHash = /^server ([a-f0-9]{64})$/u.exec(currentRow)?.[1];
    expect(currentHash).toMatch(/^[a-f0-9]{64}$/u);
    calls.length = 0;
    const options = {
      composeArgumentsForProfile: (_envFile: string, ...arguments_: string[]) =>
        compose(currentCompose, ...arguments_),
      equivalenceOverride,
      execute,
      legacyPlatformOverride,
    };

    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        rollbackOverride,
        { server: { composeConfigHash: currentHash } },
        options,
      ),
    ).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(legacyPlatformOverride);

    calls.length = 0;
    const images = { server: { composeConfigHash: capturedHash } };
    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        rollbackOverride,
        images,
        options,
      ),
    ).not.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain(legacyPlatformOverride);
    expect(calls[1]).toContain(legacyPlatformOverride);

    calls.length = 0;
    expect(() =>
      assertRollbackComposeRuntimeEquivalent(
        '/safe/.env',
        driftedRollbackOverride,
        images,
        options,
      ),
    ).toThrow(
      'Server rollback runtime configuration differs from the running Compose boundary',
    );
    expect(calls).toHaveLength(2);
  });

  test('cleans acquired rollback image leases after partial acquisition failure', () => {
    const images = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        {
          imageId: `sha256:${String(index + 1).repeat(64)}`,
          imageReference: `wo-${service}:stable`,
        },
      ]),
    );
    const calls: string[][] = [];

    expect(() =>
      acquireRollbackImageLeases(images, {
        execute: (_command: string, arguments_: string[]) => {
          calls.push(arguments_);
          if (
            arguments_[1] === 'tag' &&
            arguments_.at(-1) === 'wo-rollback-lease:test-postgres'
          ) {
            throw new Error('postgres lease failed');
          }
          return '';
        },
        leaseReferenceFactory: (service: string) =>
          `wo-rollback-lease:test-${service}`,
      }),
    ).toThrow('postgres lease failed');
    expect(calls).toEqual([
      ['image', 'tag', images.caddy.imageId, 'wo-rollback-lease:test-caddy'],
      ['image', 'tag', images.server.imageId, 'wo-rollback-lease:test-server'],
      [
        'image',
        'tag',
        images.postgres.imageId,
        'wo-rollback-lease:test-postgres',
      ],
      ['image', 'rm', 'wo-rollback-lease:test-server'],
      ['image', 'rm', 'wo-rollback-lease:test-caddy'],
    ]);
  });

  test('preserves acquisition and cleanup failures while removing remaining leases', () => {
    const images = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        {
          imageId: `sha256:${String(index + 1).repeat(64)}`,
          imageReference: `wo-${service}:stable`,
        },
      ]),
    );
    const acquisitionError = new Error('postgres lease failed');
    const cleanupError = new Error('server lease cleanup failed');
    const calls: string[][] = [];
    let failure: unknown;

    try {
      acquireRollbackImageLeases(images, {
        execute: (_command: string, arguments_: string[]) => {
          calls.push(arguments_);
          if (arguments_.at(-1) === 'wo-rollback-lease:test-postgres') {
            throw acquisitionError;
          }
          if (
            arguments_[1] === 'rm' &&
            arguments_.at(-1) === 'wo-rollback-lease:test-server'
          ) {
            throw cleanupError;
          }
          return '';
        },
        leaseReferenceFactory: (service: string) =>
          `wo-rollback-lease:test-${service}`,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      acquisitionError,
      cleanupError,
    ]);
    expect((failure as AggregateError).cause).toBe(acquisitionError);
    expect(calls.slice(-2)).toEqual([
      ['image', 'rm', 'wo-rollback-lease:test-server'],
      ['image', 'rm', 'wo-rollback-lease:test-caddy'],
    ]);
  });

  test('releases rollback image leases only with a removable workspace', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wo-image-lease-test-'));
    temporaryDirectories.push(directory);
    const envFile = resolve(directory, '.env');
    await writeFile(envFile, '');
    const imageIds = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        `sha256:${String(index + 5).repeat(64)}`,
      ]),
    );
    const imageReferences = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service) => [
        service,
        `wo-${service}:stable`,
      ]),
    );
    const containerIds = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        String(index + 1).repeat(64),
      ]),
    );
    const composeConfigHashes = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        String(index + 1).repeat(64),
      ]),
    );
    const calls: string[][] = [];
    const execute = (_command: string, arguments_: string[]) => {
      calls.push(arguments_);
      if (arguments_[0] === 'compose') {
        return `${containerIds[arguments_.at(-1)!]}\n`;
      }
      if (arguments_[0] === 'image' && arguments_[1] === 'inspect') {
        return rollbackImageInspection({ imageId: arguments_[2]! });
      }
      if (arguments_[0] === 'inspect') {
        const containerId = arguments_.at(-1)!;
        const service = Object.keys(containerIds).find(
          (candidate) => containerIds[candidate] === containerId,
        );
        if (service === undefined) {
          throw new Error(`Unexpected rollback container ${containerId}`);
        }
        return rollbackContainerInspection({
          composeConfigHash: composeConfigHashes[service],
          containerId,
          imageId: imageIds[service],
          imageReference: imageReferences[service],
          service,
        });
      }
      return '';
    };
    const images = captureRollbackImages(envFile, { execute });
    expect(calls.filter(([command]) => command === 'compose')).toHaveLength(4);
    expect(calls.filter(([command]) => command === 'inspect')).toHaveLength(4);
    expect(
      calls.filter(
        ([command, action]) => command === 'image' && action === 'inspect',
      ),
    ).toHaveLength(4);
    const captureCalls = calls.length;
    const leasedImages = acquireRollbackImageLeases(images, {
      execute,
      leaseReferenceFactory: (service: string) =>
        `wo-rollback-lease:test-${service}`,
    });
    expect(
      calls.slice(captureCalls).every(([command, action]) => {
        return command === 'image' && action === 'tag';
      }),
    ).toBe(true);
    expect(
      new Set(
        Object.values(leasedImages).map(({ leaseReference }) => leaseReference),
      ).size,
    ).toBe(4);
    const acquisitionCalls = calls.length;
    let removedWorkspace: string | undefined;

    await expect(
      releaseRollbackResources(
        '/safe/rollback/workspace',
        leasedImages,
        false,
        {
          execute,
          removeDirectory: async () => {
            throw new Error('workspace cleanup failed');
          },
        },
      ),
    ).rejects.toThrow('workspace cleanup failed');
    expect(calls).toHaveLength(acquisitionCalls);

    await expect(
      releaseRollbackResources('/safe/rollback/workspace', leasedImages, true, {
        execute,
        removeDirectory: async (directory: string) => {
          removedWorkspace = directory;
        },
      }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(acquisitionCalls);
    expect(removedWorkspace).toBeUndefined();

    await expect(
      releaseRollbackResources(
        '/safe/rollback/workspace',
        leasedImages,
        false,
        {
          execute,
          removeDirectory: async (directory: string) => {
            removedWorkspace = directory;
          },
        },
      ),
    ).resolves.toBe(true);
    expect(removedWorkspace).toBe('/safe/rollback/workspace');
    expect(calls.slice(acquisitionCalls)).toEqual([
      ['image', 'rm', 'wo-rollback-lease:test-coturn'],
      ['image', 'rm', 'wo-rollback-lease:test-postgres'],
      ['image', 'rm', 'wo-rollback-lease:test-server'],
      ['image', 'rm', 'wo-rollback-lease:test-caddy'],
    ]);
  });

  test('attempts every rollback image lease release before surfacing failures', async () => {
    const images = Object.fromEntries(
      ['caddy', 'server', 'postgres', 'coturn'].map((service, index) => [
        service,
        {
          imageId: `sha256:${String(index + 5).repeat(64)}`,
          imageReference: `wo-${service}:stable`,
          leaseReference: `wo-rollback-lease:test-${service}`,
        },
      ]),
    );
    const cleanupError = new Error('postgres lease cleanup failed');
    const calls: string[][] = [];
    let failure: unknown;

    try {
      await releaseRollbackResources(
        '/safe/rollback/workspace',
        images,
        false,
        {
          execute: (_command: string, arguments_: string[]) => {
            calls.push(arguments_);
            if (arguments_.at(-1) === 'wo-rollback-lease:test-postgres') {
              throw cleanupError;
            }
            return '';
          },
          removeDirectory: async () => {},
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([cleanupError]);
    expect(calls).toEqual([
      ['image', 'rm', 'wo-rollback-lease:test-coturn'],
      ['image', 'rm', 'wo-rollback-lease:test-postgres'],
      ['image', 'rm', 'wo-rollback-lease:test-server'],
      ['image', 'rm', 'wo-rollback-lease:test-caddy'],
    ]);
  });

  test('pins verified release image IDs and rechecks running containers', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wo-release-pin-test-'));
    temporaryDirectories.push(directory);
    const envFile = resolve(directory, '.env');
    await writeFile(envFile, '');
    const imageIds = {
      caddy: `sha256:${'a'.repeat(64)}`,
      server: `sha256:${'b'.repeat(64)}`,
      coturn: `sha256:${'c'.repeat(64)}`,
    };
    const references = {
      caddy: 'wo-caddy:test',
      server: 'wo-server:test',
      coturn: 'wo-coturn:test',
    };
    const execute = (_command: string, arguments_: string[]): string => {
      if (arguments_[0] === 'compose') {
        return JSON.stringify({
          services: Object.fromEntries(
            Object.entries(references).map(([service, image]) => [
              service,
              { image },
            ]),
          ),
        });
      }
      if (arguments_[0] === 'version') {
        return 'amd64\n';
      }
      const reference = arguments_.at(-1)!;
      const service = Object.entries(references).find(
        ([, image]) => image === reference,
      )?.[0] as keyof typeof imageIds;
      return JSON.stringify([
        {
          Architecture: 'amd64',
          Config: {
            Labels: {
              'org.opencontainers.image.created':
                releaseProvenance.BUILD_CREATED,
              'org.opencontainers.image.revision':
                releaseProvenance.BUILD_REVISION,
              'org.opencontainers.image.source':
                'https://github.com/kiritoko1029/WO',
              'org.opencontainers.image.version':
                releaseProvenance.BUILD_VERSION,
            },
          },
          Id: imageIds[service],
          Os: 'linux',
        },
      ]);
    };
    const images = inspectBuiltReleaseImages(envFile, releaseProvenance, {
      execute,
    });
    expect(images).toEqual({
      caddy: {
        architecture: 'amd64',
        imageId: imageIds.caddy,
        imageReference: references.caddy,
      },
      coturn: {
        architecture: 'amd64',
        imageId: imageIds.coturn,
        imageReference: references.coturn,
      },
      server: {
        architecture: 'amd64',
        imageId: imageIds.server,
        imageReference: references.server,
      },
    });
    const override = releaseImageOverrideSource(images);
    for (const imageId of Object.values(imageIds)) {
      expect(override).toContain(`image: ${imageId}`);
    }
    expect(override.match(/build: !reset null/gu)).toHaveLength(3);

    const runningExecute = (_command: string, arguments_: string[]): string => {
      if (arguments_[0] === 'compose') {
        return `container-${arguments_.at(-1)}\n`;
      }
      const service = arguments_
        .at(-1)!
        .replace(/^container-/u, '') as keyof typeof imageIds;
      return `${imageIds[service]}\n`;
    };
    expect(() =>
      assertRunningReleaseImages(
        envFile,
        images,
        ['caddy', 'server', 'coturn'],
        { execute: runningExecute },
      ),
    ).not.toThrow();
    expect(() =>
      assertRunningReleaseImages(envFile, images, ['server'], {
        execute: (_command: string, arguments_: string[]) =>
          arguments_[0] === 'compose'
            ? 'container-server\n'
            : `${imageIds.caddy}\n`,
      }),
    ).toThrow(/does not match the verified release image ID/i);
  });

  test('restores the captured bridge boundary after a host-profile failure', async () => {
    const ports = normalizeCoturnPortBindings({
      '3478/tcp': [{ HostIp: '0.0.0.0', HostPort: '3478' }],
      '3478/udp': [{ HostIp: '0.0.0.0', HostPort: '3478' }],
      '5349/tcp': [{ HostIp: '0.0.0.0', HostPort: '5349' }],
      '5349/udp': [{ HostIp: '0.0.0.0', HostPort: '5349' }],
      '49160/udp': [{ HostIp: '0.0.0.0', HostPort: '49160' }],
    });
    const mounts = normalizeCoturnRollbackMounts(
      [
        {
          Destination: '/run/secrets/turn_shared_secret',
          RW: false,
          Source: '/opt/wo/secrets/turn_shared_secret',
          Type: 'bind',
        },
        {
          Destination: '/opt/wo/turn-entrypoint.sh',
          Propagation: 'rprivate',
          RW: false,
          Source: '/opt/wo/old/deploy/coturn/entrypoint.sh',
          Type: 'bind',
        },
        {
          Destination: '/etc/coturn/turnserver.wo.conf',
          Propagation: 'rprivate',
          RW: false,
          Source: '/opt/wo/old/deploy/coturn/turnserver.conf',
          Type: 'bind',
        },
        {
          Destination: '/var/lib/coturn',
          Name: 'wo_old_turn_state',
          RW: true,
          Type: 'volume',
        },
      ],
      false,
    );
    const configuration = await renderRollback(
      {
        healthcheck: rollbackHealthcheck,
        hostMode: false,
        mounts,
        ports,
        turnEnvironment: rollbackEnvironment,
      },
      true,
    );
    const coturn = configuration.services.coturn;
    expect(coturn.network_mode).not.toBe('host');
    expect(Object.keys(coturn.networks ?? {})).toEqual(['turn_edge']);
    expect(coturn.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          read_only: true,
          source: '/opt/wo/old/deploy/coturn/entrypoint.sh',
          target: '/opt/wo/turn-entrypoint.sh',
          type: 'bind',
        }),
        expect.objectContaining({
          read_only: true,
          source: '/opt/wo/old/deploy/coturn/turnserver.conf',
          target: '/etc/coturn/turnserver.wo.conf',
          type: 'bind',
        }),
        expect.objectContaining({
          source: 'coturn_rollback_state',
          target: '/var/lib/coturn',
          type: 'volume',
        }),
      ]),
    );
    expect(configuration.volumes.coturn_rollback_state).toMatchObject({
      external: true,
      name: 'wo_old_turn_state',
    });
    expect(
      coturn.ports
        .map(
          ({ target, published, protocol }) =>
            `${published}:${target}/${protocol}`,
        )
        .sort(),
    ).toEqual(
      [
        '3478:3478/tcp',
        '3478:3478/udp',
        '49160:49160/udp',
        '5349:5349/tcp',
        '5349:5349/udp',
      ].sort(),
    );
    expect(coturn.environment.TURN_RELAY_MAX_PORT).toBe('49160');
    expect(coturn.healthcheck.test.join(' ')).toContain('$TURN_LISTEN_PORT');
    expect(coturn.healthcheck.test.join(' ')).not.toContain('TURN_INTERNAL_IP');
  });

  test('creates a server and coturn rollback override with the captured coturn boundary', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'wo-selected-rollback-test-'),
    );
    temporaryDirectories.push(directory);
    const selectedServices = ['server', 'coturn'];
    const images = {
      coturn: {
        containerId: 'old-coturn-container',
        imageId: `sha256:${'d'.repeat(64)}`,
      },
      server: {
        containerId: 'old-server-container',
        imageId: `sha256:${'b'.repeat(64)}`,
      },
    };
    const coturnBoundary = {
      healthcheck: rollbackHealthcheck,
      hostMode: false,
      mounts: [
        {
          propagation: '',
          readOnly: false,
          source: 'wo_old_turn_state',
          target: '/var/lib/coturn',
          type: 'volume',
        },
      ],
      ports: normalizeCoturnPortBindings({
        '3478/tcp': [{ HostIp: '0.0.0.0', HostPort: '3478' }],
        '3478/udp': [{ HostIp: '0.0.0.0', HostPort: '3478' }],
      }),
      turnEnvironment: rollbackEnvironment,
    };
    const override = await createRollbackOverride(directory, images, {
      boundaryCapture: (containerId: string) => {
        expect(containerId).toBe(images.coturn.containerId);
        return coturnBoundary;
      },
      selectedServices,
    });
    const source = await readFile(override, 'utf8');

    expect(source).toBe(
      rollbackOverrideSource(images, coturnBoundary, { selectedServices }),
    );
    expect(source).toMatch(/^ {2}server:$/mu);
    expect(source).toMatch(/^ {2}coturn:$/mu);
    expect(source).not.toMatch(/^ {2}caddy:$/mu);
    expect(source).not.toMatch(/^ {2}postgres:$/mu);

    const configuration = await renderRollback(
      coturnBoundary,
      true,
      selectedServices,
      images,
    );
    const coturn = configuration.services.coturn;
    expect(coturn.image).toBe(images.coturn.imageId);
    expect(coturn.network_mode).not.toBe('host');
    expect(Object.keys(coturn.networks ?? {})).toEqual(['turn_edge']);
    expect(coturn.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocol: 'tcp',
          published: '3478',
          target: 3478,
        }),
        expect.objectContaining({
          protocol: 'udp',
          published: '3478',
          target: 3478,
        }),
      ]),
    );
    expect(configuration.volumes.coturn_rollback_state).toMatchObject({
      external: true,
      name: 'wo_old_turn_state',
    });
  });

  test('restores the captured host boundary after a bridge-profile failure', async () => {
    const stateDirectory = await mkdtemp(
      resolve(await realpath(tmpdir()), 'wo-turn-state-test-'),
    );
    temporaryDirectories.push(stateDirectory);
    const mounts = normalizeCoturnRollbackMounts(
      [
        {
          Destination: '/var/lib/coturn',
          Propagation: 'rprivate',
          RW: false,
          Source: stateDirectory,
          Type: 'bind',
        },
      ],
      true,
    );
    const configuration = await renderRollback(
      {
        healthcheck: {
          ...rollbackHealthcheck,
          test: [
            'CMD-SHELL',
            'exec /usr/local/bin/turn-healthcheck /run/secrets/turn_shared_secret "$TURN_LISTEN_PORT" "$TURN_INTERNAL_IP"',
          ],
        },
        hostMode: true,
        mounts,
        ports: [],
        turnEnvironment: {
          ...rollbackEnvironment,
          TURN_INTERNAL_IP: '172.24.52.210',
          TURN_LISTEN_PORT: '13478',
          TURN_RELAY_MAX_PORT: '49509',
          TURN_TLS_LISTEN_PORT: '15349',
        },
      },
      false,
    );
    const coturn = configuration.services.coturn;
    expect(coturn.network_mode).toBe('host');
    expect(coturn.ports ?? []).toEqual([]);
    expect(coturn.networks ?? {}).toEqual({});
    expect(coturn.volumes).toEqual([
      expect.objectContaining({
        read_only: true,
        source: stateDirectory,
        target: '/var/lib/coturn',
        type: 'bind',
      }),
    ]);
    expect(coturn.environment).toMatchObject({
      TURN_INTERNAL_IP: '172.24.52.210',
      TURN_LISTEN_PORT: '13478',
      TURN_NETWORK_MODE: 'host',
      TURN_RELAY_MAX_PORT: '49509',
      TURN_TLS_LISTEN_PORT: '15349',
    });
    expect(coturn.healthcheck.test.join(' ')).toContain('$TURN_LISTEN_PORT');
    expect(coturn.healthcheck.test.join(' ')).toContain('$TURN_INTERNAL_IP');
  });

  test('rejects unexpected or writable coturn rollback mounts', () => {
    expect(() =>
      normalizeCoturnRollbackMounts(
        [
          {
            Destination: '/etc/passwd',
            Propagation: 'rprivate',
            RW: false,
            Source: '/opt/wo/passwd',
            Type: 'bind',
          },
        ],
        false,
      ),
    ).toThrow(/unexpected mount/i);
    expect(() =>
      normalizeCoturnRollbackMounts(
        [
          {
            Destination: '/opt/wo/turn-entrypoint.sh',
            Propagation: 'rprivate',
            RW: true,
            Source: '/opt/wo/old/entrypoint.sh',
            Type: 'bind',
          },
        ],
        false,
      ),
    ).toThrow(/config mount is unsafe/i);
  });

  test('checks effective integration edge ports with shell precedence', async () => {
    expect(
      integrationEdgePorts(
        {
          WO_INTEGRATION_HTTP_PORT: '18080',
          WO_INTEGRATION_HTTPS_PORT: '18443',
        },
        { WO_INTEGRATION_HTTPS_PORT: '19443' },
      ),
    ).toEqual({ httpPort: '18080', httpsPort: '19443' });
    expect(
      integrationEdgePorts(
        { WO_INTEGRATION_HTTP_PORT: '18080' },
        { WO_INTEGRATION_HTTP_PORT: '' },
      ),
    ).toEqual({ httpPort: '80', httpsPort: '443' });
    await expect(
      checkPortConflicts(
        {
          TURN_PORT: '3478',
          TURN_TLS_PORT: '5349',
          TURN_RELAY_MIN_PORT: '49160',
          TURN_RELAY_MAX_PORT: '49200',
        },
        '127.0.0.1',
        { httpPort: 'invalid', httpsPort: '18443' },
      ),
    ).resolves.toEqual([
      'Port conflict check requires valid HTTP and HTTPS ports',
    ]);
  });

  test('accepts a provisioned backup directory without changing its mode', async () => {
    const root = await mkdtemp(
      resolve(await realpath(tmpdir()), 'wo-backup-test-'),
    );
    temporaryDirectories.push(root);
    const directory = resolve(root, 'backups');
    await mkdir(directory, { mode: 0o755 });
    expect(
      await checkBackupDirectory(directory, { minimumFreeBytesRequired: 0 }),
    ).toEqual([]);
  });

  test('rejects dangerous and symbolic-link backup directories', async () => {
    const root = await mkdtemp(
      resolve(await realpath(tmpdir()), 'wo-backup-test-'),
    );
    temporaryDirectories.push(root);
    const target = resolve(root, 'target');
    const link = resolve(root, 'link');
    await mkdir(target);
    await symlink(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await checkBackupDirectory(link, { minimumFreeBytesRequired: 0 })).join(
        '\n',
      ),
    ).toMatch(/symbolic link/i);
    expect(
      (
        await checkBackupDirectory(resolve(import.meta.dirname, '..', '..'), {
          minimumFreeBytesRequired: 0,
        })
      ).join('\n'),
    ).toMatch(/dangerous/i);
  });

  test('accepts only regular caddy files and directories in restore archives', async () => {
    await expect(
      inspectCaddyArchive(
        await archive([
          ['caddy/', '5'],
          ['caddy/certificates.json', '0'],
        ]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      inspectCaddyArchive(await archive([['../outside', '0']])),
    ).rejects.toThrow(/path/i);
    await expect(
      inspectCaddyArchive(await archive([['caddy/link', '2']])),
    ).rejects.toThrow(/type/i);
  });
});
