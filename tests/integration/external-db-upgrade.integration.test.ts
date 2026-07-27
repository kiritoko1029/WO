import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import {
  createExternalDatabaseNames,
  retainExternalUpgradeRollbackResources,
  runExternalDatabaseUpgrade,
} from '../../deploy/scripts/external-db-upgrade.mjs';

const enabled = process.env.WO_RUN_EXTERNAL_DB_UPGRADE_INTEGRATION === '1';
const postgresImage =
  process.env.WO_EXTERNAL_DB_UPGRADE_POSTGRES_IMAGE ??
  'postgres:17.10-alpine3.23';
const postgresAdmin = 'release_admin';
const postgresPassword = 'integration-only-external-upgrade-password';
const postgresSystemDatabase = 'postgres';
const targetDatabase = 'wo';
const databaseOwner = 'wo_db_owner';
const applicationRole = 'wo_app';
const objectOwner = 'wo_object_owner';
const observerRole = 'wo_observer';
const containerName = `wo-external-upgrade-${process.pid}-${randomBytes(4).toString('hex')}`;
const ingressContainerName = `${containerName}-ingress`;
const temporaryDirectories: string[] = [];

function run(
  command: string,
  arguments_: string[],
  { timeout = 120_000 }: { timeout?: number } = {},
) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    const detail =
      result.error?.message ?? (result.stderr || result.stdout).trim();
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function postgresSqlAs(
  role: string,
  database: string,
  sql: string,
  { tuplesOnly = false }: { tuplesOnly?: boolean } = {},
) {
  return run('docker', [
    'exec',
    '--user',
    'postgres',
    containerName,
    'psql',
    '--username',
    role,
    '--dbname',
    database,
    '--set',
    'ON_ERROR_STOP=1',
    ...(tuplesOnly ? ['--tuples-only', '--no-align'] : []),
    '--command',
    sql,
  ]);
}

function postgresSql(
  database: string,
  sql: string,
  options: { tuplesOnly?: boolean } = {},
) {
  return postgresSqlAs(postgresAdmin, database, sql, options);
}

function sqlIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseOid(database: string) {
  return postgresSql(
    postgresSystemDatabase,
    `SELECT oid::text FROM pg_database WHERE datname = ${sqlLiteral(database)}`,
    { tuplesOnly: true },
  );
}

function upgradeDatabaseNames() {
  return postgresSql(
    postgresSystemDatabase,
    "SELECT datname FROM pg_database WHERE datname LIKE 'wo_upgrade_%' ORDER BY datname",
    { tuplesOnly: true },
  )
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

function ingressRunning() {
  return (
    run('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      ingressContainerName,
    ]) === 'true'
  );
}

function resetTargetDatabase() {
  const databases = new Set([...upgradeDatabaseNames(), targetDatabase]);
  for (const database of databases) {
    postgresSql(
      postgresSystemDatabase,
      `DROP DATABASE IF EXISTS ${sqlIdentifier(database)} WITH (FORCE)`,
    );
  }
  postgresSql(
    postgresSystemDatabase,
    `CREATE DATABASE ${sqlIdentifier(targetDatabase)} OWNER ${sqlIdentifier(
      databaseOwner,
    )} TEMPLATE template0 CONNECTION LIMIT 7`,
  );
  postgresSql(
    postgresSystemDatabase,
    `
SET ROLE ${sqlIdentifier(databaseOwner)};
REVOKE ALL PRIVILEGES ON DATABASE ${sqlIdentifier(targetDatabase)} FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${sqlIdentifier(
      targetDatabase,
    )} TO ${sqlIdentifier(applicationRole)};
GRANT CONNECT ON DATABASE ${sqlIdentifier(
      targetDatabase,
    )} TO ${sqlIdentifier(observerRole)} WITH GRANT OPTION;
RESET ROLE;
ALTER DATABASE ${sqlIdentifier(targetDatabase)} SET statement_timeout TO '17s';
ALTER ROLE ${sqlIdentifier(applicationRole)} IN DATABASE ${sqlIdentifier(
      targetDatabase,
    )} SET lock_timeout TO '3s';
`,
  );
  postgresSql(
    targetDatabase,
    `
GRANT USAGE, CREATE ON SCHEMA public TO ${sqlIdentifier(
      applicationRole,
    )}, ${sqlIdentifier(objectOwner)};
SET ROLE ${sqlIdentifier(applicationRole)};
CREATE TABLE boundary_probe (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO boundary_probe VALUES (1, 'before-upgrade');
RESET ROLE;
SET ROLE ${sqlIdentifier(objectOwner)};
CREATE TABLE ownership_probe (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO ownership_probe VALUES (1, 'owned-separately');
RESET ROLE;
GRANT SELECT ON TABLE ownership_probe TO ${sqlIdentifier(applicationRole)};
`,
  );
}

function migratedColumnCount(database: string) {
  return Number(
    postgresSql(
      database,
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'boundary_probe' AND column_name = 'migrated'",
      { tuplesOnly: true },
    ),
  );
}

function assertDatabaseSemantics(database: string, migrated: boolean) {
  expect(
    postgresSql(
      postgresSystemDatabase,
      `SELECT pg_get_userbyid(datdba) || ':' || datconnlimit::text FROM pg_database WHERE datname = ${sqlLiteral(
        database,
      )}`,
      { tuplesOnly: true },
    ),
  ).toBe(`${databaseOwner}:7`);
  expect(
    postgresSqlAs(
      applicationRole,
      database,
      'SHOW statement_timeout; SHOW lock_timeout',
      { tuplesOnly: true },
    ),
  ).toBe('17s\n3s');
  expect(
    postgresSql(
      database,
      `
SELECT
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.boundary_probe'::regclass)
  || ':' ||
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.ownership_probe'::regclass)
  || ':' ||
  has_table_privilege(${sqlLiteral(
    applicationRole,
  )}, 'public.ownership_probe', 'SELECT')::text
`,
      { tuplesOnly: true },
    ),
  ).toBe(`${applicationRole}:${objectOwner}:true`);
  expect(
    postgresSql(
      postgresSystemDatabase,
      `
SELECT count(*)
FROM pg_database AS database
CROSS JOIN LATERAL aclexplode(
  COALESCE(database.datacl, acldefault('d', database.datdba))
) AS acl
JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE database.datname = ${sqlLiteral(database)}
  AND grantor.rolname = ${sqlLiteral(databaseOwner)}
  AND grantee.rolname = ${sqlLiteral(observerRole)}
  AND acl.privilege_type = 'CONNECT'
  AND acl.is_grantable
`,
      { tuplesOnly: true },
    ),
  ).toBe('1');
  expect(migratedColumnCount(database)).toBe(migrated ? 1 : 0);
  const dataQuery = migrated
    ? "SELECT value || ':' || migrated::text FROM boundary_probe WHERE id = 1"
    : 'SELECT value FROM boundary_probe WHERE id = 1';
  expect(
    postgresSqlAs(applicationRole, database, dataQuery, {
      tuplesOnly: true,
    }),
  ).toBe(migrated ? 'before-upgrade:true' : 'before-upgrade');
}

function assertApplicationRoleCannotConnect() {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '--user',
      'postgres',
      containerName,
      'psql',
      '--username',
      applicationRole,
      '--dbname',
      targetDatabase,
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'SELECT 1',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status).not.toBe(0);
}

type FixtureOptions = {
  failIngressRestore?: boolean;
  failReleaseActivation?: boolean;
  failRollbackSmoke?: boolean;
};

async function createFixture(options: FixtureOptions = {}) {
  const backupRoot = await mkdtemp(
    resolve(tmpdir(), 'wo-external-db-integration-backup-'),
  );
  temporaryDirectories.push(backupRoot);
  const workspace = await mkdtemp(
    resolve(tmpdir(), 'wo-external-db-integration-workspace-'),
  );
  temporaryDirectories.push(workspace);
  const transactionId = randomBytes(12).toString('hex');
  const names = createExternalDatabaseNames(transactionId);
  const originalDatabaseOid = databaseOid(targetDatabase);
  let stagingDatabaseOid: string | undefined;
  const postgresContainerId = run('docker', [
    'inspect',
    '--format',
    '{{.Id}}',
    containerName,
  ]);
  const ingressContainerId = run('docker', [
    'inspect',
    '--format',
    '{{.Id}}',
    ingressContainerName,
  ]);
  const expectedPostgresSystemIdentifier = postgresSql(
    postgresSystemDatabase,
    'SELECT system_identifier FROM pg_control_system()',
    { tuplesOnly: true },
  );
  const postgresImageId = run('docker', [
    'inspect',
    '--format',
    '{{.Image}}',
    containerName,
  ]);
  const ingressImageId = run('docker', [
    'inspect',
    '--format',
    '{{.Image}}',
    ingressContainerName,
  ]);
  const releaseImages = {
    coturn: { imageId: `sha256:${'c'.repeat(64)}` },
    server: { imageId: `sha256:${'d'.repeat(64)}` },
  };
  const rollbackImages = {
    coturn: {
      containerId: 'e'.repeat(64),
      imageId: `sha256:${'e'.repeat(64)}`,
      imageReference: 'wo-coturn:old',
    },
    server: {
      containerId: 'f'.repeat(64),
      imageId: `sha256:${'f'.repeat(64)}`,
      imageReference: 'wo-server:old',
    },
  };
  const ingressRestoreFailure = new Error('injected ingress restore failure');
  const rollbackSmokeFailure = new Error('injected rollback smoke failure');

  return {
    dependencies: {
      makeTemporaryDirectory: async (prefix: string) => {
        assertApplicationRoleCannotConnect();
        return mkdtemp(prefix);
      },
      randomTransactionId: () => transactionId,
    },
    expected: {
      ingressRestoreFailure,
      names,
      originalDatabaseOid,
      postgresImageId,
      rollbackSmokeFailure,
    },
    options: {
      activateServices: async ({ label }: { label: string }) => {
        if (label === 'External database staging migration activation') {
          postgresSqlAs(
            applicationRole,
            names.staging,
            'ALTER TABLE boundary_probe ADD COLUMN migrated boolean NOT NULL DEFAULT false; UPDATE boundary_probe SET migrated = true',
          );
        }
        if (
          options.failReleaseActivation &&
          label === 'External database release activation'
        ) {
          throw new Error('injected release activation failure');
        }
      },
      applicationRole,
      assertRunningServices: async () => {},
      backupRoot,
      databaseName: targetDatabase,
      execute: (
        command: string,
        arguments_: string[],
        commandOptions: { label?: string } = {},
      ) => {
        if (
          options.failIngressRestore &&
          commandOptions.label === 'External ingress maintenance restore'
        ) {
          throw ingressRestoreFailure;
        }
        return run(command, arguments_);
      },
      expectedIngressImageId: ingressImageId,
      expectedPostgresMajor: 17,
      expectedPostgresSystemIdentifier,
      ingressContainerId,
      postgresAdmin,
      postgresContainerId,
      releaseImages,
      releaseOverride: resolve(workspace, 'release.compose.yaml'),
      restoreImageTags: async () => {},
      rollbackImages,
      rollbackOverride: resolve(workspace, 'rollback.compose.yaml'),
      runSmoke: async (label: string) => {
        if (label === 'External database staging migration smoke') {
          stagingDatabaseOid = databaseOid(names.staging);
          expect(stagingDatabaseOid).not.toBe(originalDatabaseOid);
          expect(databaseOid(targetDatabase)).toBe(originalDatabaseOid);
          assertDatabaseSemantics(names.staging, true);
        }
        if (label === 'External database post-apply smoke') {
          expect(databaseOid(targetDatabase)).toBe(stagingDatabaseOid);
          assertDatabaseSemantics(targetDatabase, true);
        }
        if (label === 'External database rollback smoke') {
          expect(databaseOid(targetDatabase)).toBe(originalDatabaseOid);
          if (stagingDatabaseOid !== undefined) {
            expect(databaseOid(names.failed)).toBe(stagingDatabaseOid);
          }
          assertDatabaseSemantics(targetDatabase, false);
          if (options.failRollbackSmoke) {
            throw rollbackSmokeFailure;
          }
        }
      },
      stopServices: async () => {},
      workspace,
    },
  };
}

async function readEvidence(directory: string) {
  const databaseFile = resolve(directory, 'postgres.dump');
  const manifestFile = resolve(directory, 'manifest.json');
  const checksumsFile = resolve(directory, 'SHA256SUMS');
  const resultFile = resolve(directory, 'result.json');
  const databaseBytes = await readFile(databaseFile);
  const databaseSha256 = createHash('sha256')
    .update(databaseBytes)
    .digest('hex');
  const [manifest, checksums, result] = await Promise.all([
    readFile(manifestFile, 'utf8').then((value) => JSON.parse(value)),
    readFile(checksumsFile, 'utf8'),
    readFile(resultFile, 'utf8').then((value) => JSON.parse(value)),
  ]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const file of [databaseFile, manifestFile, checksumsFile, resultFile]) {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  expect(manifest.dump.sha256).toBe(databaseSha256);
  expect(manifest.dump.size).toBe(databaseBytes.length);
  expect(checksums).toBe(`${databaseSha256}  postgres.dump\n`);
  expect(result.databaseSha256).toBe(databaseSha256);
  return { databaseSha256, manifest, result };
}

describe.skipIf(!enabled)(
  'external database upgrade against PostgreSQL 17',
  () => {
    beforeAll(() => {
      run(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          containerName,
          '--pull',
          'never',
          '--env',
          `POSTGRES_USER=${postgresAdmin}`,
          '--env',
          `POSTGRES_PASSWORD=${postgresPassword}`,
          '--env',
          `POSTGRES_DB=${postgresSystemDatabase}`,
          '--health-cmd',
          `pg_isready --username ${postgresAdmin} --dbname ${postgresSystemDatabase}`,
          '--health-interval',
          '1s',
          '--health-timeout',
          '3s',
          '--health-retries',
          '30',
          postgresImage,
        ],
        { timeout: 120_000 },
      );
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = run('docker', [
          'inspect',
          '--format',
          '{{if .State.Health}}{{.State.Health.Status}}{{end}}',
          containerName,
        ]);
        if (status === 'healthy') {
          break;
        }
        if (status === 'unhealthy') {
          throw new Error('PostgreSQL integration container is unhealthy');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        if (attempt === 59) {
          throw new Error(
            'PostgreSQL integration container did not become healthy',
          );
        }
      }
      postgresSql(
        postgresSystemDatabase,
        `
CREATE ROLE ${sqlIdentifier(databaseOwner)} NOLOGIN;
CREATE ROLE ${sqlIdentifier(applicationRole)} LOGIN NOSUPERUSER;
CREATE ROLE ${sqlIdentifier(objectOwner)} NOLOGIN;
CREATE ROLE ${sqlIdentifier(observerRole)} NOLOGIN;
`,
      );
      run('docker', [
        'run',
        '--detach',
        '--name',
        ingressContainerName,
        '--pull',
        'never',
        '--entrypoint',
        '/bin/sh',
        postgresImage,
        '-c',
        "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done",
      ]);
    }, 120_000);

    afterAll(() => {
      spawnSync('docker', [
        'rm',
        '--force',
        '--volumes',
        ingressContainerName,
        containerName,
      ]);
    });

    beforeEach(() => {
      if (!ingressRunning()) {
        run('docker', ['start', ingressContainerName]);
      }
      resetTargetDatabase();
    });

    afterEach(async () => {
      await Promise.all(
        temporaryDirectories
          .splice(0)
          .map((directory) => rm(directory, { force: true, recursive: true })),
      );
    });

    test('preserves data, owners, ACLs, GUCs, OIDs, and evidence on commit', async () => {
      const fixture = await createFixture();

      const result = await runExternalDatabaseUpgrade(
        fixture.options,
        fixture.dependencies,
      );

      expect(result.identity.imageId).toBe(fixture.expected.postgresImageId);
      expect(databaseOid(targetDatabase)).not.toBe(
        fixture.expected.originalDatabaseOid,
      );
      expect(upgradeDatabaseNames()).toEqual([]);
      expect(ingressRunning()).toBe(true);
      assertDatabaseSemantics(targetDatabase, true);
      const evidence = await readEvidence(result.backupDirectory);
      expect(evidence.result).toMatchObject({
        status: 'applied',
        databaseOids: {
          previous: fixture.expected.originalDatabaseOid,
        },
      });
      expect(evidence.manifest).toMatchObject({
        schemaVersion: 1,
        database: {
          allowConnections: true,
          applicationRole,
          icuRules: null,
          owner: databaseOwner,
          roleSettings: expect.arrayContaining([
            { roleName: null, settings: ['statement_timeout=17s'] },
            { roleName: applicationRole, settings: ['lock_timeout=3s'] },
          ]),
        },
      });
      expect(evidence.manifest.database.acl).toEqual(
        expect.arrayContaining([
          {
            grantable: true,
            grantor: databaseOwner,
            grantee: observerRole,
            privilege: 'CONNECT',
          },
        ]),
      );
    }, 120_000);

    test('restores the original database and writes complete rollback evidence', async () => {
      const fixture = await createFixture({ failReleaseActivation: true });
      let failure: unknown;

      try {
        await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        cause: expect.objectContaining({
          message: 'injected release activation failure',
        }),
      });
      expect(retainExternalUpgradeRollbackResources(failure)).toBe(false);
      expect(databaseOid(targetDatabase)).toBe(
        fixture.expected.originalDatabaseOid,
      );
      expect(upgradeDatabaseNames()).toEqual([]);
      expect(ingressRunning()).toBe(true);
      assertDatabaseSemantics(targetDatabase, false);
      const backupDirectory = (failure as { backupDirectory: string })
        .backupDirectory;
      const evidence = await readEvidence(backupDirectory);
      expect(evidence.result).toMatchObject({
        status: 'rollback-completed',
        backupAvailable: true,
      });
    }, 120_000);

    test('retains the failed database and evidence when rollback smoke fails', async () => {
      const fixture = await createFixture({
        failReleaseActivation: true,
        failRollbackSmoke: true,
      });
      let failure: unknown;

      try {
        await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect(retainExternalUpgradeRollbackResources(failure)).toBe(true);
      expect((failure as AggregateError).errors).toContain(
        fixture.expected.rollbackSmokeFailure,
      );
      expect(databaseOid(targetDatabase)).toBe(
        fixture.expected.originalDatabaseOid,
      );
      expect(databaseOid(fixture.expected.names.failed)).not.toBe('');
      expect(ingressRunning()).toBe(false);
      const backupDirectory = (failure as { backupDirectory: string })
        .backupDirectory;
      const evidence = await readEvidence(backupDirectory);
      expect(evidence.result).toMatchObject({
        status: 'rollback-incomplete',
        backupAvailable: true,
      });
      expect(evidence.result.rollbackErrors).toContain(
        'injected rollback smoke failure',
      );
    }, 120_000);

    test('retains the failed database when ingress restoration fails', async () => {
      const fixture = await createFixture({
        failIngressRestore: true,
        failReleaseActivation: true,
      });
      let failure: unknown;

      try {
        await runExternalDatabaseUpgrade(fixture.options, fixture.dependencies);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect(retainExternalUpgradeRollbackResources(failure)).toBe(true);
      expect((failure as AggregateError).errors).toContain(
        fixture.expected.ingressRestoreFailure,
      );
      expect(databaseOid(targetDatabase)).toBe(
        fixture.expected.originalDatabaseOid,
      );
      expect(databaseOid(fixture.expected.names.failed)).not.toBe('');
      expect(ingressRunning()).toBe(false);
      const backupDirectory = (failure as { backupDirectory: string })
        .backupDirectory;
      const evidence = await readEvidence(backupDirectory);
      expect(evidence.result).toMatchObject({
        status: 'rollback-incomplete',
        backupAvailable: true,
      });
      expect(evidence.result.rollbackErrors).toContain(
        'injected ingress restore failure',
      );
    }, 120_000);
  },
);
