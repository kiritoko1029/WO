import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createExternalDatabaseNames,
  externalDatabaseOverrideSource,
  inspectExternalIngress,
  inspectExternalPostgres,
  retainExternalUpgradeRollbackResources,
  runExternalDatabaseUpgrade,
} from '../../deploy/scripts/external-db-upgrade.mjs';

const postgresContainerId = 'a'.repeat(64);
const postgresImageId = `sha256:${'b'.repeat(64)}`;
const ingressContainerId = 'c'.repeat(64);
const ingressImageId = `sha256:${'d'.repeat(64)}`;
const postgresAdmin = 'release_admin';
const applicationRole = 'wo_app';
const databaseOwner = 'wo_owner';
const postgresSystemIdentifier = '7490136767012577314';
const transactionId = '0123456789abcdef01234567';
const names = createExternalDatabaseNames(transactionId);
const originalDatabaseOid = '10001';
const stagingDatabaseOid = '10002';
const databaseAcl = [
  {
    grantable: true,
    grantor: databaseOwner,
    grantee: databaseOwner,
    privilege: 'CONNECT',
  },
  {
    grantable: true,
    grantor: databaseOwner,
    grantee: databaseOwner,
    privilege: 'CREATE',
  },
  {
    grantable: true,
    grantor: databaseOwner,
    grantee: databaseOwner,
    privilege: 'TEMPORARY',
  },
  {
    grantable: false,
    grantor: databaseOwner,
    grantee: applicationRole,
    privilege: 'CONNECT',
  },
  {
    grantable: false,
    grantor: databaseOwner,
    grantee: applicationRole,
    privilege: 'CREATE',
  },
] as const;
const databaseRoleSettings = [
  { roleName: null, settings: ['statement_timeout=17s'] },
  { roleName: applicationRole, settings: ['lock_timeout=3s'] },
] as const;
const releaseImages = Object.freeze({
  coturn: Object.freeze({ imageId: `sha256:${'e'.repeat(64)}` }),
  server: Object.freeze({ imageId: `sha256:${'f'.repeat(64)}` }),
});
const rollbackImages = Object.freeze({
  coturn: Object.freeze({
    containerId: '1'.repeat(64),
    imageId: `sha256:${'1'.repeat(64)}`,
  }),
  server: Object.freeze({
    containerId: '2'.repeat(64),
    imageId: `sha256:${'2'.repeat(64)}`,
  }),
});

type HarnessOptions = {
  applicationRoleCanLogin?: boolean;
  collisionCountOutput?: string;
  failures?: Map<string, unknown>;
  fenceCountOutputs?: string[];
  ingressHealthStatusesAfterRestart?: string[];
  postMutationFailureEvent?: string;
  postMigrationStagingMetadataOverride?: Record<string, unknown>;
  postQuiesceOriginalMetadataOverride?: Record<string, unknown>;
  stagingMetadataOverride?: Record<string, unknown>;
};

type UpgradeHarness = ReturnType<typeof createHarness>;

function databaseIdentity(
  databaseName: string,
  databaseOid: string,
  override: Record<string, unknown> = {},
) {
  return {
    applicationRole,
    applicationRoleCanLogin: true,
    applicationRoleIsSuperuser: false,
    canCreateDatabase: true,
    currentUser: postgresAdmin,
    databaseAcl,
    databaseAllowConnections: true,
    databaseCollate: 'C',
    databaseConnectionLimit: 7,
    databaseCtype: 'C',
    databaseEncoding: 'UTF8',
    databaseIcuRules: null,
    databaseLocale: null,
    databaseLocaleProvider: 'c',
    databaseName,
    databaseOid,
    databaseOwner,
    databaseRoleSettings,
    databaseTablespace: 'pg_default',
    inRecovery: false,
    isSuperuser: true,
    serverVersionNum: 170_010,
    systemIdentifier: postgresSystemIdentifier,
    ...override,
  };
}

function selectedDatabaseNames(sql: string, databaseOids: Map<string, string>) {
  return [...databaseOids.keys()].filter((databaseName) =>
    sql.includes(`'${databaseName}'`),
  );
}

function createHarness(options: HarnessOptions = {}) {
  const databaseOids = new Map<string, string>([['wo', originalDatabaseOid]]);
  const events: string[] = [];
  const pipeFileCalls: Array<{ arguments_: string[]; label: string }> = [];
  const ingressHealthStatusesAfterRestart = [
    ...(options.ingressHealthStatusesAfterRestart ?? []),
  ];
  const fenceCountOutputs = [...(options.fenceCountOutputs ?? [])];
  let ingressRestarted = false;
  let ingressRunning = true;
  let originalIdentityInspections = 0;
  let stagingMigrationSmokePassed = false;

  const record = (event: string) => {
    events.push(event);
  };
  const fail = (event: string) => {
    if (options.failures?.has(event)) {
      throw options.failures.get(event);
    }
  };
  const emit = (event: string) => {
    record(event);
    fail(event);
  };
  const mutateThenMaybeFail = (event: string, mutate: () => void) => {
    record(event);
    if (options.postMutationFailureEvent === event) {
      mutate();
      fail(event);
      throw new Error(`post-mutation failure at ${event}`);
    }
    fail(event);
    mutate();
  };

  const execute = (
    _command: string,
    arguments_: string[],
    commandOptions: { label?: string } = {},
  ) => {
    const label = commandOptions.label ?? '';
    const event = `execute:${label}`;
    const sql =
      arguments_[arguments_.indexOf('--command') + 1] ??
      arguments_.at(-1) ??
      '';

    if (label === 'External PostgreSQL atomic database activation switch') {
      mutateThenMaybeFail(event, () => {
        databaseOids.delete('wo');
        databaseOids.delete(names.staging);
        databaseOids.set(names.previous, originalDatabaseOid);
        databaseOids.set('wo', stagingDatabaseOid);
      });
      return '';
    }
    if (label === 'External PostgreSQL atomic activation switch recovery') {
      mutateThenMaybeFail(event, () => {
        databaseOids.delete('wo');
        databaseOids.delete(names.previous);
        databaseOids.set(names.staging, stagingDatabaseOid);
        databaseOids.set('wo', originalDatabaseOid);
      });
      return '';
    }
    if (label === 'External PostgreSQL atomic original database rollback') {
      mutateThenMaybeFail(event, () => {
        databaseOids.delete('wo');
        databaseOids.delete(names.previous);
        databaseOids.set(names.failed, stagingDatabaseOid);
        databaseOids.set('wo', originalDatabaseOid);
      });
      return '';
    }

    emit(event);
    if (label === 'External ingress container inspection') {
      const healthStatus =
        ingressRestarted && ingressHealthStatusesAfterRestart.length > 0
          ? ingressHealthStatusesAfterRestart.shift()
          : 'healthy';
      return JSON.stringify({
        Config: { Image: 'openresty:1.27.1.2-alpine' },
        Id: ingressContainerId,
        Image: ingressImageId,
        State: {
          Health: { Status: healthStatus },
          Running: ingressRunning,
        },
      });
    }
    if (label === 'External ingress maintenance fence') {
      ingressRunning = false;
      return '';
    }
    if (label === 'External ingress maintenance restore') {
      ingressRunning = true;
      ingressRestarted = true;
      return '';
    }
    if (label === 'External PostgreSQL container inspection') {
      return JSON.stringify({
        Config: { Image: 'postgres:17.10-alpine3.23' },
        Id: postgresContainerId,
        Image: postgresImageId,
        State: { Health: { Status: 'healthy' }, Running: true },
      });
    }
    if (label === 'External PostgreSQL identity inspection') {
      const databaseName = [...databaseOids.keys()].find((candidate) =>
        sql.includes(`database.datname = '${candidate}'`),
      );
      if (databaseName === undefined) {
        return '';
      }
      const override: Record<string, unknown> = {
        applicationRoleCanLogin: options.applicationRoleCanLogin ?? true,
      };
      if (databaseName === names.staging) {
        Object.assign(
          override,
          options.stagingMetadataOverride,
          stagingMigrationSmokePassed
            ? options.postMigrationStagingMetadataOverride
            : undefined,
        );
      } else if (databaseName === 'wo') {
        originalIdentityInspections += 1;
        if (originalIdentityInspections > 1) {
          Object.assign(override, options.postQuiesceOriginalMetadataOverride);
        }
      }
      return JSON.stringify(
        databaseIdentity(
          databaseName,
          databaseOids.get(databaseName)!,
          override,
        ),
      );
    }
    if (label === 'External PostgreSQL upgrade database collision check') {
      return options.collisionCountOutput ?? '0\n';
    }
    if (label === 'External PostgreSQL staging database creation') {
      databaseOids.set(names.staging, stagingDatabaseOid);
      return '';
    }
    if (label.endsWith('database cleanup')) {
      const databaseName = label.slice(0, -' database cleanup'.length);
      databaseOids.delete(databaseName);
      return '';
    }
    if (label.endsWith('connection fence verification')) {
      return fenceCountOutputs.shift() ?? '0\n';
    }
    if (
      label.includes('OID') ||
      label.includes('layout inspection') ||
      label.includes('cleanup inspection')
    ) {
      return JSON.stringify(
        Object.fromEntries(
          selectedDatabaseNames(sql, databaseOids).map((databaseName) => [
            databaseName,
            databaseOids.get(databaseName),
          ]),
        ),
      );
    }
    return '';
  };

  return {
    activateServices: async ({
      label,
      overrides,
      services,
    }: {
      label: string;
      overrides: string[];
      services: readonly string[];
    }) => {
      emit(
        `activate:${label}:${services.join(',')}:${overrides
          .map((file) => file.split('/').at(-1))
          .join(',')}`,
      );
    },
    assertRunningServices: async (
      images: typeof releaseImages | typeof rollbackImages,
      services: readonly string[],
    ) => {
      const identity = images === releaseImages ? 'release' : 'rollback';
      emit(`assert:${identity}:${services.join(',')}`);
    },
    databaseOids,
    events,
    execute,
    get ingressRunning() {
      return ingressRunning;
    },
    pipeCommand: async (
      _command: string,
      _arguments: string[],
      file: string,
      commandOptions: { label?: string } = {},
    ) => {
      emit(`pipe-command:${commandOptions.label ?? ''}`);
      await writeFile(file, 'verified external database backup');
    },
    pipeFile: async (
      _file: string,
      _command: string,
      arguments_: string[],
      commandOptions: { label?: string } = {},
    ) => {
      const label = commandOptions.label ?? '';
      pipeFileCalls.push({ arguments_, label });
      emit(`pipe-file:${label}`);
    },
    pipeFileCalls,
    restoreImageTags: async (
      _images: typeof rollbackImages,
      services: readonly string[],
    ) => {
      emit(`restore-tags:${services.join(',')}`);
    },
    runSmoke: async (label: string) => {
      emit(`smoke:${label}`);
      if (label === 'External database staging migration smoke') {
        stagingMigrationSmokePassed = true;
      }
    },
    stopServices: async ({
      label,
      services,
    }: {
      expectedImages?: unknown;
      label: string;
      services: readonly string[];
    }) => {
      emit(`stop:${label}:${services.join(',')}`);
    },
  };
}

const temporaryDirectories: string[] = [];

async function createUpgradeFixture(harness: UpgradeHarness) {
  const backupRoot = await mkdtemp(
    resolve(tmpdir(), 'wo-external-upgrade-test-'),
  );
  temporaryDirectories.push(backupRoot);
  const workspace = await mkdtemp(
    resolve(tmpdir(), 'wo-external-workspace-test-'),
  );
  temporaryDirectories.push(workspace);
  return {
    dependencies: {
      now: () => new Date('2026-07-27T03:00:00.000Z'),
      pipeCommand: harness.pipeCommand,
      pipeFile: harness.pipeFile,
      randomTransactionId: () => transactionId,
      waitForIngressHealth: async (milliseconds: number) => {
        harness.events.push(`wait-ingress:${milliseconds}`);
      },
    },
    options: {
      activateServices: harness.activateServices,
      applicationRole,
      assertRunningServices: harness.assertRunningServices,
      backupRoot,
      databaseName: 'wo',
      execute: harness.execute,
      expectedIngressImageId: ingressImageId,
      expectedPostgresMajor: 17,
      expectedPostgresSystemIdentifier: postgresSystemIdentifier,
      ingressContainerId,
      postgresAdmin,
      postgresContainerId,
      releaseImages,
      releaseOverride: resolve(workspace, 'release.compose.yaml'),
      restoreImageTags: harness.restoreImageTags,
      rollbackImages,
      rollbackOverride: resolve(workspace, 'rollback.compose.yaml'),
      runSmoke: harness.runSmoke,
      stopServices: harness.stopServices,
      workspace,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('external database release upgrade', () => {
  test('binds non-superuser application, PostgreSQL, and ingress identities', async () => {
    const harness = createHarness();

    const identity = await inspectExternalPostgres({
      applicationRole,
      databaseName: 'wo',
      execute: harness.execute,
      expectedPostgresMajor: 17,
      expectedPostgresSystemIdentifier: postgresSystemIdentifier,
      postgresAdmin,
      postgresContainerId,
    });
    const ingress = inspectExternalIngress({
      execute: harness.execute,
      expectedIngressImageId: ingressImageId,
      ingressContainerId,
    });

    expect(identity).toMatchObject({
      applicationRole,
      applicationRoleCanLogin: true,
      containerId: postgresContainerId,
      databaseName: 'wo',
      databaseOid: originalDatabaseOid,
      databaseOwner,
      imageId: postgresImageId,
      postgresMajor: 17,
      systemIdentifier: postgresSystemIdentifier,
    });
    expect(identity.databaseAcl).toHaveLength(databaseAcl.length);
    expect(identity.databaseRoleSettings).toHaveLength(
      databaseRoleSettings.length,
    );
    expect(ingress).toMatchObject({
      containerId: ingressContainerId,
      imageId: ingressImageId,
      running: true,
    });
  });

  test('rejects unsafe or mismatched pinned targets before mutation', async () => {
    const harness = createHarness();

    await expect(
      inspectExternalPostgres({
        applicationRole,
        databaseName: 'wo',
        execute: harness.execute,
        expectedPostgresMajor: 16,
        expectedPostgresSystemIdentifier: postgresSystemIdentifier,
        postgresAdmin,
        postgresContainerId,
      }),
    ).rejects.toThrow(/identity, role, major, or writable-primary boundary/i);
    await expect(
      inspectExternalPostgres({
        applicationRole,
        databaseName: 'wo',
        execute: harness.execute,
        expectedPostgresMajor: 17,
        expectedPostgresSystemIdentifier: postgresSystemIdentifier,
        postgresAdmin: 'unsafe-role!',
        postgresContainerId,
      }),
    ).rejects.toThrow(/external-postgres-admin is invalid/i);
    expect(() =>
      inspectExternalIngress({
        execute: harness.execute,
        expectedIngressImageId: `sha256:${'0'.repeat(64)}`,
        ingressContainerId,
      }),
    ).toThrow(/identity, image, or running boundary/i);
  });

  test('rejects a NOLOGIN application role before entering maintenance', async () => {
    const harness = createHarness({ applicationRoleCanLogin: false });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/identity, role, major, or writable-primary boundary/i);

    expect(harness.events).not.toContain(
      'execute:External ingress maintenance fence',
    );
    expect(harness.events).not.toContain(
      'stop:External database pre-upgrade write quiesce:server',
    );
  });

  test('rejects an empty database collision count before maintenance', async () => {
    const harness = createHarness({ collisionCountOutput: '' });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/collision check returned an invalid count/i);

    expect(harness.events).not.toContain(
      'execute:External ingress maintenance fence',
    );
  });

  test('rejects an empty connection-fence count and restores the original boundary', async () => {
    const harness = createHarness({ fenceCountOutputs: [''] });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(
      /connection fence verification returned an invalid count/i,
    );

    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
    expect(harness.ingressRunning).toBe(true);
  });

  test('fences ingress and connections, verifies metadata, atomically switches, and commits', async () => {
    const harness = createHarness({
      ingressHealthStatusesAfterRestart: [
        'starting',
        'starting',
        'healthy',
        'healthy',
      ],
    });
    const fixture = await createUpgradeFixture(harness);

    const result = await runExternalDatabaseUpgrade(
      fixture.options,
      fixture.dependencies,
    );

    expect(result.identity.systemIdentifier).toBe(postgresSystemIdentifier);
    expect(harness.databaseOids).toEqual(new Map([['wo', stagingDatabaseOid]]));
    expect(harness.ingressRunning).toBe(true);
    const ingressStop = harness.events.indexOf(
      'execute:External ingress maintenance fence',
    );
    const serverStop = harness.events.indexOf(
      'stop:External database pre-upgrade write quiesce:server',
    );
    const databaseFence = harness.events.indexOf('execute:wo connection fence');
    const backup = harness.events.indexOf(
      'pipe-command:External PostgreSQL backup',
    );
    const switchIndex = harness.events.indexOf(
      'execute:External PostgreSQL atomic database activation switch',
    );
    const stagingStop = harness.events.indexOf(
      'stop:External database staging server stop:server',
    );
    const finalSmoke = harness.events.indexOf(
      'smoke:External database post-apply smoke',
    );
    const ingressStart = harness.events.indexOf(
      'execute:External ingress maintenance restore',
    );
    expect(ingressStop).toBeLessThan(serverStop);
    expect(serverStop).toBeLessThan(databaseFence);
    expect(databaseFence).toBeLessThan(backup);
    expect(stagingStop).toBeLessThan(switchIndex);
    expect(finalSmoke).toBeLessThan(ingressStart);
    expect(harness.events).toContain('wait-ingress:1000');

    for (const label of [
      'External PostgreSQL backup archive verification',
      'External PostgreSQL staging restore',
    ]) {
      const call = harness.pipeFileCalls.find(
        (candidate) => candidate.label === label,
      );
      expect(call?.arguments_).toEqual(
        expect.arrayContaining(['exec', '--interactive', 'pg_restore']),
      );
      expect(call?.arguments_.indexOf('--interactive')).toBeLessThan(
        call?.arguments_.indexOf(postgresContainerId) ?? -1,
      );
    }
    const resultRecord = JSON.parse(
      await readFile(resolve(result.backupDirectory, 'result.json'), 'utf8'),
    );
    expect(resultRecord).toMatchObject({
      status: 'applied',
      databaseOids: {
        active: stagingDatabaseOid,
        previous: originalDatabaseOid,
      },
      ingressContainerId,
      ingressImageId,
    });
    const manifest = JSON.parse(
      await readFile(resolve(result.backupDirectory, 'manifest.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      database: {
        acl: expect.any(Array),
        applicationRole,
        applicationRoleCanLogin: true,
        containerId: postgresContainerId,
        name: 'wo',
        oid: originalDatabaseOid,
        roleSettings: expect.any(Array),
      },
      dump: { name: 'postgres.dump', size: expect.any(Number) },
      schemaVersion: 1,
    });
    expect(
      await readFile(
        resolve(fixture.options.workspace, 'staging-database.compose.yaml'),
        'utf8',
      ),
    ).toBe(externalDatabaseOverrideSource(names.staging));
    expect((await stat(result.backupDirectory)).mode & 0o777).toBe(0o700);
  });

  test('restores old services and ingress before deleting staging after staging smoke fails', async () => {
    const primary = new Error('staging smoke failed');
    const harness = createHarness({
      failures: new Map([
        ['smoke:External database staging migration smoke', primary],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);
    let failure: unknown;

    try {
      await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ cause: primary });
    expect(retainExternalUpgradeRollbackResources(failure)).toBe(false);
    const rollbackSmoke = harness.events.indexOf(
      'smoke:External database rollback smoke',
    );
    const ingressRestore = harness.events.lastIndexOf(
      'execute:External ingress maintenance restore',
    );
    const stagingCleanup = harness.events.indexOf(
      `execute:${names.staging} database cleanup`,
    );
    expect(rollbackSmoke).toBeGreaterThan(-1);
    expect(ingressRestore).toBeGreaterThan(rollbackSmoke);
    expect(stagingCleanup).toBeGreaterThan(ingressRestore);
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
    expect(harness.ingressRunning).toBe(true);
  });

  test('rolls back by pinned OID and deletes failed only after old smoke and ingress recovery', async () => {
    const primary = new Error('release activation failed');
    const failureEvent =
      'activate:External database release activation:server,coturn:release.compose.yaml';
    const harness = createHarness({
      failures: new Map([[failureEvent, primary]]),
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toMatchObject({ cause: primary });

    const rollbackSwitch = harness.events.indexOf(
      'execute:External PostgreSQL atomic original database rollback',
    );
    const oldActivation = harness.events.indexOf(
      'activate:External database release image rollback:server,coturn:rollback.compose.yaml',
    );
    const rollbackSmoke = harness.events.indexOf(
      'smoke:External database rollback smoke',
    );
    const ingressRestore = harness.events.lastIndexOf(
      'execute:External ingress maintenance restore',
    );
    const failedCleanup = harness.events.indexOf(
      `execute:${names.failed} database cleanup`,
    );
    expect(rollbackSwitch).toBeGreaterThan(-1);
    expect(oldActivation).toBeGreaterThan(rollbackSwitch);
    expect(rollbackSmoke).toBeGreaterThan(oldActivation);
    expect(ingressRestore).toBeGreaterThan(rollbackSmoke);
    expect(failedCleanup).toBeGreaterThan(ingressRestore);
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
  });

  test('does not restore database access when rollback service stop cannot be verified', async () => {
    const primary = new Error('release activation failed');
    const stopFailure = new Error('new server remains running');
    const harness = createHarness({
      failures: new Map([
        [
          'activate:External database release activation:server,coturn:release.compose.yaml',
          primary,
        ],
        [
          'stop:External database rollback service stop:server,coturn',
          stopFailure,
        ],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);
    let failure: unknown;

    try {
      await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(retainExternalUpgradeRollbackResources(failure)).toBe(true);
    expect(harness.events).not.toContain(
      'execute:External PostgreSQL atomic original database rollback',
    );
    expect(harness.events).not.toContain(
      'activate:External database release image rollback:server,coturn:rollback.compose.yaml',
    );
    expect(harness.events).not.toContain(
      `execute:${names.failed} database cleanup`,
    );
    expect(harness.databaseOids).toEqual(
      new Map([
        [names.previous, originalDatabaseOid],
        ['wo', stagingDatabaseOid],
      ]),
    );
    expect(harness.ingressRunning).toBe(false);
  });

  test('retains the failed database when rollback smoke fails', async () => {
    const primary = new Error('release activation failed');
    const rollbackFailure = new Error('rollback smoke failed');
    const harness = createHarness({
      failures: new Map([
        [
          'activate:External database release activation:server,coturn:release.compose.yaml',
          primary,
        ],
        ['smoke:External database rollback smoke', rollbackFailure],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);
    let failure: unknown;

    try {
      await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors).toContain(rollbackFailure);
    expect(retainExternalUpgradeRollbackResources(failure)).toBe(true);
    expect(harness.databaseOids).toEqual(
      new Map([
        [names.failed, stagingDatabaseOid],
        ['wo', originalDatabaseOid],
      ]),
    );
    expect(harness.ingressRunning).toBe(false);
  });

  test('retains the failed database when ingress recovery fails', async () => {
    const primary = new Error('release activation failed');
    const ingressFailure = new Error('ingress start failed');
    const harness = createHarness({
      failures: new Map([
        [
          'activate:External database release activation:server,coturn:release.compose.yaml',
          primary,
        ],
        ['execute:External ingress maintenance restore', ingressFailure],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toMatchObject({ retainRollbackResources: true });

    expect(harness.databaseOids).toEqual(
      new Map([
        [names.failed, stagingDatabaseOid],
        ['wo', originalDatabaseOid],
      ]),
    );
    expect(harness.ingressRunning).toBe(false);
    expect(harness.events).not.toContain(
      `execute:${names.failed} database cleanup`,
    );
  });

  test('recovers a switch that committed before its command reported failure', async () => {
    const switchFailure = new Error('lost switch acknowledgement');
    const event =
      'execute:External PostgreSQL atomic database activation switch';
    const harness = createHarness({
      failures: new Map([[event, switchFailure]]),
      postMutationFailureEvent: event,
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toMatchObject({ cause: switchFailure });

    expect(harness.events).toContain(
      'execute:External PostgreSQL atomic activation switch recovery',
    );
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
    expect(retainExternalUpgradeRollbackResources(switchFailure)).toBe(false);
  });

  test('continues rollback when its atomic rename committed before reporting failure', async () => {
    const primary = new Error('release activation failed');
    const rollbackFailure = new Error('lost rollback acknowledgement');
    const releaseEvent =
      'activate:External database release activation:server,coturn:release.compose.yaml';
    const rollbackEvent =
      'execute:External PostgreSQL atomic original database rollback';
    const harness = createHarness({
      failures: new Map([
        [releaseEvent, primary],
        [rollbackEvent, rollbackFailure],
      ]),
      postMutationFailureEvent: rollbackEvent,
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toMatchObject({ cause: primary });

    expect(harness.events).toContain(
      'execute:External PostgreSQL rollback recovery layout inspection',
    );
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
    expect(harness.ingressRunning).toBe(true);
  });

  test('rejects staging metadata drift before any database switch', async () => {
    const harness = createHarness({
      stagingMetadataOverride: { databaseConnectionLimit: 8 },
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/metadata differs for databaseConnectionLimit/i);

    expect(harness.events).not.toContain(
      'execute:External PostgreSQL atomic database activation switch',
    );
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
  });

  test('rejects metadata drift introduced by migration before switching databases', async () => {
    const harness = createHarness({
      postMigrationStagingMetadataOverride: {
        databaseRoleSettings: [
          ...databaseRoleSettings,
          { roleName: applicationRole, settings: ['statement_timeout=1s'] },
        ],
      },
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/metadata differs for databaseRoleSettings/i);

    expect(harness.events).toContain(
      'smoke:External database staging migration smoke',
    );
    expect(harness.events).not.toContain(
      'execute:External PostgreSQL atomic database activation switch',
    );
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
  });

  test('does not overwrite an unfenced database after post-quiesce identity drift', async () => {
    const harness = createHarness({
      postQuiesceOriginalMetadataOverride: { databaseConnectionLimit: 8 },
    });
    const fixture = await createUpgradeFixture(harness);

    await expect(
      runExternalDatabaseUpgrade(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/changed after write quiesce/i);

    expect(harness.events).not.toContain('execute:wo connection fence');
    expect(harness.events).not.toContain('execute:wo connection limit');
    expect(harness.databaseOids).toEqual(
      new Map([['wo', originalDatabaseOid]]),
    );
    expect(harness.ingressRunning).toBe(true);
  });

  test('does not roll back a committed activation when old database cleanup fails', async () => {
    const cleanupFailure = new Error('old database cleanup failed');
    const harness = createHarness({
      failures: new Map([
        [`execute:${names.previous} database cleanup`, cleanupFailure],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);
    let failure: unknown;

    try {
      await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      activationCommitted: true,
      cause: cleanupFailure,
      retainRollbackResources: true,
    });
    expect(harness.events).not.toContain('restore-tags:server,coturn');
    expect(harness.ingressRunning).toBe(true);
  });

  test('preserves an undefined upgrade failure through complete rollback', async () => {
    const harness = createHarness({
      failures: new Map([
        ['smoke:External database staging migration smoke', undefined],
      ]),
    });
    const fixture = await createUpgradeFixture(harness);
    let failure: unknown;

    try {
      await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(Object.hasOwn(failure as object, 'cause')).toBe(true);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(retainExternalUpgradeRollbackResources(failure)).toBe(false);
  });
});
