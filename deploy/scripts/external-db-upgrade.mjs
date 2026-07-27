import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import {
  failureMessage,
  pipeCommandToFile,
  pipeFileToCommand,
  run,
  sha256File,
} from './ops.mjs';

const containerIdPattern = /^[a-f0-9]{64}$/u;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const postgresIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const postgresOidPattern = /^[0-9]{1,10}$/u;
const postgresSettingNamePattern = /^[A-Za-z][A-Za-z0-9_.]*$/u;
const postgresSystemIdentifierPattern = /^[0-9]{1,20}$/u;
const databaseLocaleProviders = new Map([
  ['b', 'builtin'],
  ['c', 'libc'],
  ['i', 'icu'],
]);
const databasePrivileges = new Set(['CONNECT', 'CREATE', 'TEMPORARY']);
const upgradeServices = Object.freeze(['server', 'coturn']);

function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function postgresExecArguments(
  containerId,
  postgresAdmin,
  command,
  ...arguments_
) {
  return [
    'exec',
    '--user',
    'postgres',
    containerId,
    command,
    '--username',
    postgresAdmin,
    ...arguments_,
  ];
}

function postgresInteractiveExecArguments(
  containerId,
  postgresAdmin,
  command,
  ...arguments_
) {
  const [execCommand, ...execArguments] = postgresExecArguments(
    containerId,
    postgresAdmin,
    command,
    ...arguments_,
  );
  return [execCommand, '--interactive', ...execArguments];
}

function postgresSql(context, sql, label, { inherit = false } = {}) {
  return context.execute(
    'docker',
    postgresExecArguments(
      context.postgresContainerId,
      context.postgresAdmin,
      'psql',
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      sql,
    ),
    {
      label,
      ...(inherit ? { stdio: 'inherit' } : {}),
    },
  );
}

function parseSingleJsonRow(source, label) {
  const rows = source
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length !== 1) {
    throw new Error(`${label} returned an unexpected row count`);
  }
  try {
    return JSON.parse(rows[0]);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

function parseSingleCountRow(source, label) {
  const rows = source
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (
    rows.length !== 1 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(rows[0]) ||
    !Number.isSafeInteger(Number(rows[0]))
  ) {
    throw new Error(`${label} returned an invalid count`);
  }
  return Number(rows[0]);
}

export function assertExternalPostgresUpgradeArguments({
  applicationRole,
  databaseName,
  expectedPostgresMajor,
  expectedPostgresSystemIdentifier,
  postgresAdmin,
  postgresContainerId,
}) {
  if (!postgresIdentifierPattern.test(databaseName ?? '')) {
    throw new Error('External PostgreSQL database name is unsafe');
  }
  if (!postgresIdentifierPattern.test(postgresAdmin ?? '')) {
    throw new Error('--external-postgres-admin is invalid');
  }
  if (!postgresIdentifierPattern.test(applicationRole ?? '')) {
    throw new Error('External PostgreSQL application role is invalid');
  }
  if (!containerIdPattern.test(postgresContainerId ?? '')) {
    throw new Error(
      '--external-postgres-container-id must be a complete container ID',
    );
  }
  if (
    !Number.isInteger(expectedPostgresMajor) ||
    expectedPostgresMajor < 10 ||
    expectedPostgresMajor > 99
  ) {
    throw new Error('--expected-postgres-major is invalid');
  }
  if (
    !postgresSystemIdentifierPattern.test(
      expectedPostgresSystemIdentifier ?? '',
    )
  ) {
    throw new Error('--expected-postgres-system-id is invalid');
  }
}

export function assertExternalIngressUpgradeArguments({
  expectedIngressImageId,
  ingressContainerId,
}) {
  if (!containerIdPattern.test(ingressContainerId ?? '')) {
    throw new Error(
      '--external-ingress-container-id must be a complete container ID',
    );
  }
  if (!imageIdPattern.test(expectedIngressImageId ?? '')) {
    throw new Error('--expected-ingress-image-id is invalid');
  }
}

export function inspectExternalIngress(options) {
  const { execute = run, expectedIngressImageId, ingressContainerId } = options;
  const running = Object.hasOwn(options, 'running') ? options.running : true;
  assertExternalIngressUpgradeArguments({
    expectedIngressImageId,
    ingressContainerId,
  });
  const inspection = parseSingleJsonRow(
    execute(
      'docker',
      ['inspect', '--format', '{{json .}}', ingressContainerId],
      { label: 'External ingress container inspection' },
    ),
    'External ingress container inspection',
  );
  const healthStatus = inspection.State?.Health?.Status;
  const isRunning = inspection.State?.Running;
  if (
    inspection.Id !== ingressContainerId ||
    inspection.Image !== expectedIngressImageId ||
    typeof isRunning !== 'boolean' ||
    (running !== undefined && isRunning !== running) ||
    typeof inspection.Config?.Image !== 'string' ||
    inspection.Config.Image.length === 0 ||
    (running === true &&
      healthStatus !== undefined &&
      healthStatus !== 'healthy')
  ) {
    throw new Error(
      'External ingress container identity, image, or running boundary is invalid',
    );
  }
  return Object.freeze({
    containerId: ingressContainerId,
    imageId: expectedIngressImageId,
    imageReference: inspection.Config.Image,
    running: isRunning,
  });
}

function stopExternalIngress(context, identity) {
  const current = inspectExternalIngress({
    execute: context.execute,
    expectedIngressImageId: identity.imageId,
    ingressContainerId: identity.containerId,
    running: undefined,
  });
  if (current.running) {
    context.execute('docker', ['stop', '--time', '30', identity.containerId], {
      label: 'External ingress maintenance fence',
      stdio: 'inherit',
    });
  }
  inspectExternalIngress({
    execute: context.execute,
    expectedIngressImageId: identity.imageId,
    ingressContainerId: identity.containerId,
    running: false,
  });
}

async function restoreExternalIngress(context, identity) {
  let current = inspectExternalIngress({
    execute: context.execute,
    expectedIngressImageId: identity.imageId,
    ingressContainerId: identity.containerId,
    running: undefined,
  });
  if (!current.running) {
    context.execute('docker', ['start', identity.containerId], {
      label: 'External ingress maintenance restore',
      stdio: 'inherit',
    });
  }
  let healthError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    current = inspectExternalIngress({
      execute: context.execute,
      expectedIngressImageId: identity.imageId,
      ingressContainerId: identity.containerId,
      running: undefined,
    });
    if (!current.running) {
      throw new Error('External ingress stopped while health was recovering');
    }
    try {
      inspectExternalIngress({
        execute: context.execute,
        expectedIngressImageId: identity.imageId,
        ingressContainerId: identity.containerId,
      });
      return;
    } catch (error) {
      healthError = error;
    }
    await context.waitForHealth(1_000);
  }
  throw new Error('External ingress did not become healthy after restart', {
    cause: healthError,
  });
}

export function createExternalDatabaseNames(
  transactionId = randomBytes(12).toString('hex'),
) {
  if (!/^[a-f0-9]{24}$/u.test(transactionId)) {
    throw new Error('External database upgrade transaction ID is invalid');
  }
  return Object.freeze({
    failed: `wo_upgrade_failed_${transactionId}`,
    previous: `wo_upgrade_old_${transactionId}`,
    staging: `wo_upgrade_stage_${transactionId}`,
  });
}

export function externalDatabaseOverrideSource(databaseName) {
  if (!postgresIdentifierPattern.test(databaseName ?? '')) {
    throw new Error('External PostgreSQL staging database name is unsafe');
  }
  return [
    'services:',
    '  server:',
    '    environment:',
    `      POSTGRES_DB: ${JSON.stringify(databaseName)}`,
    '',
  ].join('\n');
}

export async function inspectExternalPostgres({
  applicationRole,
  databaseName,
  execute = run,
  expectedPostgresMajor,
  expectedPostgresSystemIdentifier,
  postgresAdmin,
  postgresContainerId,
}) {
  assertExternalPostgresUpgradeArguments({
    applicationRole,
    databaseName,
    expectedPostgresMajor,
    expectedPostgresSystemIdentifier,
    postgresAdmin,
    postgresContainerId,
  });
  const inspection = parseSingleJsonRow(
    execute(
      'docker',
      ['inspect', '--format', '{{json .}}', postgresContainerId],
      { label: 'External PostgreSQL container inspection' },
    ),
    'External PostgreSQL container inspection',
  );
  if (
    inspection.Id !== postgresContainerId ||
    inspection.State?.Running !== true ||
    inspection.State?.Health?.Status !== 'healthy' ||
    !imageIdPattern.test(inspection.Image ?? '') ||
    typeof inspection.Config?.Image !== 'string' ||
    inspection.Config.Image.length === 0
  ) {
    throw new Error(
      'External PostgreSQL container identity or health boundary is invalid',
    );
  }

  const identityQuery = `
SELECT json_build_object(
  'currentUser', current_user,
  'serverVersionNum', current_setting('server_version_num')::integer,
  'systemIdentifier', control.system_identifier::text,
  'inRecovery', pg_is_in_recovery(),
  'applicationRole', application_role.rolname,
  'applicationRoleIsSuperuser', application_role.rolsuper,
  'applicationRoleCanLogin', application_role.rolcanlogin,
  'databaseOid', database.oid::text,
  'databaseName', database.datname,
  'databaseOwner', pg_get_userbyid(database.datdba),
  'databaseAllowConnections', database.datallowconn,
  'databaseConnectionLimit', database.datconnlimit,
  'databaseEncoding', pg_encoding_to_char(database.encoding),
  'databaseLocaleProvider', database.datlocprovider,
  'databaseCollate', database.datcollate,
  'databaseCtype', database.datctype,
  'databaseLocale', database.datlocale,
  'databaseIcuRules', database.daticurules,
  'databaseTablespace', tablespace.spcname,
  'databaseAcl', (
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'grantor', grantor.rolname,
          'grantee',
          CASE
            WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname
          END,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        ORDER BY
          grantor.rolname,
          CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
          acl.privilege_type,
          acl.is_grantable
      ),
      '[]'::json
    )
    FROM aclexplode(
      COALESCE(database.datacl, acldefault('d', database.datdba))
    ) AS acl
    JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
    LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
  ),
  'databaseRoleSettings', (
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'roleName', setting_role.rolname,
          'settings', role_setting.setconfig
        )
        ORDER BY COALESCE(setting_role.rolname, '')
      ),
      '[]'::json
    )
    FROM pg_db_role_setting AS role_setting
    LEFT JOIN pg_roles AS setting_role
      ON setting_role.oid = role_setting.setrole
    WHERE role_setting.setdatabase = database.oid
  ),
  'isSuperuser', role.rolsuper,
  'canCreateDatabase', role.rolcreatedb
)::text
FROM pg_control_system() AS control
JOIN pg_database AS database ON database.datname = ${sqlLiteral(databaseName)}
JOIN pg_roles AS role ON role.rolname = current_user
JOIN pg_roles AS application_role
  ON application_role.rolname = ${sqlLiteral(applicationRole)}
JOIN pg_tablespace AS tablespace ON tablespace.oid = database.dattablespace
`;
  const context = { execute, postgresAdmin, postgresContainerId };
  const identity = parseSingleJsonRow(
    postgresSql(
      context,
      identityQuery,
      'External PostgreSQL identity inspection',
    ),
    'External PostgreSQL identity inspection',
  );
  const postgresMajor = Math.floor(Number(identity.serverVersionNum) / 10_000);
  const databaseMetadata = normalizeDatabaseMetadata(
    identity,
    'External PostgreSQL database metadata',
  );
  if (
    identity.currentUser !== postgresAdmin ||
    identity.applicationRole !== applicationRole ||
    identity.applicationRoleIsSuperuser !== false ||
    identity.applicationRoleCanLogin !== true ||
    databaseMetadata.databaseName !== databaseName ||
    databaseMetadata.databaseAllowConnections !== true ||
    identity.isSuperuser !== true ||
    identity.canCreateDatabase !== true ||
    identity.inRecovery !== false ||
    postgresMajor !== expectedPostgresMajor ||
    identity.systemIdentifier !== expectedPostgresSystemIdentifier
  ) {
    throw new Error(
      'External PostgreSQL database identity, role, major, or writable-primary boundary is invalid',
    );
  }
  return Object.freeze({
    applicationRole,
    applicationRoleCanLogin: identity.applicationRoleCanLogin,
    containerId: postgresContainerId,
    ...databaseMetadata,
    imageId: inspection.Image,
    imageReference: inspection.Config.Image,
    postgresAdmin,
    postgresMajor,
    serverVersionNumber: Number(identity.serverVersionNum),
    systemIdentifier: identity.systemIdentifier,
  });
}

function normalizeDatabaseAcl(value) {
  if (!Array.isArray(value)) {
    throw new Error('External PostgreSQL database ACL is invalid');
  }
  return Object.freeze(
    value
      .map((entry) => {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          !postgresIdentifierPattern.test(entry.grantor ?? '') ||
          (entry.grantee !== 'PUBLIC' &&
            !postgresIdentifierPattern.test(entry.grantee ?? '')) ||
          !databasePrivileges.has(entry.privilege) ||
          typeof entry.grantable !== 'boolean'
        ) {
          throw new Error('External PostgreSQL database ACL is invalid');
        }
        return Object.freeze({
          grantable: entry.grantable,
          grantor: entry.grantor,
          grantee: entry.grantee,
          privilege: entry.privilege,
        });
      })
      .sort(
        (left, right) =>
          left.grantor.localeCompare(right.grantor) ||
          left.grantee.localeCompare(right.grantee) ||
          left.privilege.localeCompare(right.privilege) ||
          Number(left.grantable) - Number(right.grantable),
      ),
  );
}

function normalizeDatabaseRoleSettings(value) {
  if (!Array.isArray(value)) {
    throw new Error('External PostgreSQL database role settings are invalid');
  }
  return Object.freeze(
    value
      .map((entry) => {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          (entry.roleName !== null &&
            !postgresIdentifierPattern.test(entry.roleName ?? '')) ||
          !Array.isArray(entry.settings)
        ) {
          throw new Error(
            'External PostgreSQL database role settings are invalid',
          );
        }
        const settings = entry.settings.map((setting) => {
          if (typeof setting !== 'string') {
            throw new Error(
              'External PostgreSQL database role settings are invalid',
            );
          }
          const separator = setting.indexOf('=');
          if (
            separator <= 0 ||
            !postgresSettingNamePattern.test(setting.slice(0, separator))
          ) {
            throw new Error(
              'External PostgreSQL database role settings are invalid',
            );
          }
          return setting;
        });
        return Object.freeze({
          roleName: entry.roleName,
          settings: Object.freeze([...settings].sort()),
        });
      })
      .sort((left, right) =>
        (left.roleName ?? '').localeCompare(right.roleName ?? ''),
      ),
  );
}

function normalizeDatabaseMetadata(value, label) {
  const localeProvider = value?.databaseLocaleProvider;
  const databaseLocale = value?.databaseLocale;
  const databaseIcuRules = value?.databaseIcuRules;
  if (
    value === null ||
    typeof value !== 'object' ||
    !postgresOidPattern.test(value.databaseOid ?? '') ||
    !postgresIdentifierPattern.test(value.databaseName ?? '') ||
    !postgresIdentifierPattern.test(value.databaseOwner ?? '') ||
    typeof value.databaseAllowConnections !== 'boolean' ||
    !Number.isInteger(value.databaseConnectionLimit) ||
    value.databaseConnectionLimit < -1 ||
    value.databaseConnectionLimit === 0 ||
    typeof value.databaseEncoding !== 'string' ||
    value.databaseEncoding.length === 0 ||
    !databaseLocaleProviders.has(localeProvider) ||
    typeof value.databaseCollate !== 'string' ||
    value.databaseCollate.length === 0 ||
    typeof value.databaseCtype !== 'string' ||
    value.databaseCtype.length === 0 ||
    !postgresIdentifierPattern.test(value.databaseTablespace ?? '') ||
    (databaseLocale !== null && typeof databaseLocale !== 'string') ||
    (databaseIcuRules !== null && typeof databaseIcuRules !== 'string') ||
    (localeProvider !== 'c' &&
      (typeof databaseLocale !== 'string' || databaseLocale.length === 0))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({
    databaseAcl: normalizeDatabaseAcl(value.databaseAcl),
    databaseAllowConnections: value.databaseAllowConnections,
    databaseCollate: value.databaseCollate,
    databaseConnectionLimit: value.databaseConnectionLimit,
    databaseCtype: value.databaseCtype,
    databaseEncoding: value.databaseEncoding,
    databaseIcuRules,
    databaseLocale,
    databaseLocaleProvider: localeProvider,
    databaseName: value.databaseName,
    databaseOid: value.databaseOid,
    databaseOwner: value.databaseOwner,
    databaseRoleSettings: normalizeDatabaseRoleSettings(
      value.databaseRoleSettings,
    ),
    databaseTablespace: value.databaseTablespace,
  });
}

function assertDatabaseNamesAvailable(context, names) {
  const selected = Object.values(names)
    .map((name) => sqlLiteral(name))
    .join(', ');
  const count = parseSingleCountRow(
    postgresSql(
      context,
      `SELECT count(*) FROM pg_database WHERE datname IN (${selected})`,
      'External PostgreSQL upgrade database collision check',
    ),
    'External PostgreSQL upgrade database collision check',
  );
  if (count !== 0) {
    throw new Error(
      'External PostgreSQL upgrade database names already exist; manual recovery may be pending',
    );
  }
}

async function prepareBackupDirectory(
  backupRoot,
  { changeMode = chmod, makeTemporaryDirectory = mkdtemp } = {},
) {
  const directory = await makeTemporaryDirectory(
    resolve(backupRoot, 'wo-external-db-backup-'),
  );
  await changeMode(directory, 0o700);
  return directory;
}

export async function writeExternalDatabaseBackup(
  directory,
  identity,
  {
    pipeCommand = pipeCommandToFile,
    pipeFile = pipeFileToCommand,
    sha256 = sha256File,
    statFile = stat,
    writeTextFile = writeFile,
    now = () => new Date(),
  } = {},
) {
  const databaseFile = resolve(directory, 'postgres.dump');
  await pipeCommand(
    'docker',
    postgresExecArguments(
      identity.containerId,
      identity.postgresAdmin,
      'pg_dump',
      '--format=custom',
      '--dbname',
      identity.databaseName,
    ),
    databaseFile,
    { label: 'External PostgreSQL backup' },
  );
  const metadata = await statFile(databaseFile);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(
      'External PostgreSQL backup is empty or not a regular file',
    );
  }
  await pipeFile(
    databaseFile,
    'docker',
    postgresInteractiveExecArguments(
      identity.containerId,
      identity.postgresAdmin,
      'pg_restore',
      '--list',
    ),
    { label: 'External PostgreSQL backup archive verification' },
  );
  const databaseSha256 = await sha256(databaseFile);
  const manifest = {
    schemaVersion: 1,
    createdAt: now().toISOString(),
    database: {
      allowConnections: identity.databaseAllowConnections,
      applicationRole: identity.applicationRole,
      applicationRoleCanLogin: identity.applicationRoleCanLogin,
      acl: identity.databaseAcl,
      aclEntryCount: identity.databaseAcl.length,
      collate: identity.databaseCollate,
      connectionLimit: identity.databaseConnectionLimit,
      containerId: identity.containerId,
      ctype: identity.databaseCtype,
      encoding: identity.databaseEncoding,
      imageId: identity.imageId,
      imageReference: identity.imageReference,
      icuRules: identity.databaseIcuRules,
      locale: identity.databaseLocale,
      localeProvider: identity.databaseLocaleProvider,
      name: identity.databaseName,
      oid: identity.databaseOid,
      owner: identity.databaseOwner,
      postgresAdmin: identity.postgresAdmin,
      postgresMajor: identity.postgresMajor,
      roleSettingCount: identity.databaseRoleSettings.length,
      roleSettings: identity.databaseRoleSettings,
      serverVersionNumber: identity.serverVersionNumber,
      systemIdentifier: identity.systemIdentifier,
      tablespace: identity.databaseTablespace,
    },
    dump: {
      name: 'postgres.dump',
      sha256: databaseSha256,
      size: metadata.size,
    },
  };
  await writeTextFile(
    resolve(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  await writeTextFile(
    resolve(directory, 'SHA256SUMS'),
    `${databaseSha256}  postgres.dump\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return Object.freeze({ databaseFile, databaseSha256, directory, manifest });
}

function setDatabaseConnectionLimit(context, database, connectionLimit) {
  if (
    !Number.isInteger(connectionLimit) ||
    connectionLimit < -1 ||
    connectionLimit === 0
  ) {
    throw new Error('External PostgreSQL connection limit is invalid');
  }
  postgresSql(
    context,
    `ALTER DATABASE ${sqlIdentifier(database)} WITH CONNECTION LIMIT ${connectionLimit}`,
    `${database} connection limit`,
    { inherit: true },
  );
}

function fenceDatabaseConnections(context, database) {
  postgresSql(
    context,
    `ALTER DATABASE ${sqlIdentifier(database)} WITH CONNECTION LIMIT 0`,
    `${database} connection fence`,
    { inherit: true },
  );
  terminateDatabaseConnections(context, database);
  const label = `${database} connection fence verification`;
  const remaining = parseSingleCountRow(
    postgresSql(
      context,
      `SELECT count(*) FROM pg_stat_activity WHERE datname = ${sqlLiteral(database)} AND pid <> pg_backend_pid()`,
      label,
    ),
    label,
  );
  if (remaining !== 0) {
    throw new Error(`${database} connection fence is incomplete`);
  }
}

function terminateDatabaseConnections(context, database) {
  postgresSql(
    context,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(database)} AND pid <> pg_backend_pid()`,
    `${database} connection termination`,
    { inherit: true },
  );
}

function renameDatabasesAtomically(context, renames, label) {
  postgresSql(
    context,
    [
      'BEGIN',
      ...renames.map(
        ([from, to]) =>
          `ALTER DATABASE ${sqlIdentifier(from)} RENAME TO ${sqlIdentifier(to)}`,
      ),
      'COMMIT',
    ].join(';\n') + ';',
    label,
    { inherit: true },
  );
}

function databaseOidMapping(context, databaseNames, label) {
  const selected = databaseNames
    .map((database) => sqlLiteral(database))
    .join(', ');
  const mapping = parseSingleJsonRow(
    postgresSql(
      context,
      `SELECT COALESCE(json_object_agg(datname, oid::text ORDER BY datname), '{}'::json)::text FROM pg_database WHERE datname IN (${selected})`,
      label,
    ),
    label,
  );
  if (
    mapping === null ||
    typeof mapping !== 'object' ||
    Object.values(mapping).some(
      (databaseOid) => !postgresOidPattern.test(databaseOid ?? ''),
    )
  ) {
    throw new Error(`${label} returned an invalid database OID mapping`);
  }
  return mapping;
}

function assertDatabaseOidMapping(context, expected, absent, label) {
  const databaseNames = [...Object.keys(expected), ...absent];
  const mapping = databaseOidMapping(context, databaseNames, label);
  if (
    Object.keys(mapping).sort().join(',') !==
      Object.keys(expected).sort().join(',') ||
    Object.entries(expected).some(
      ([database, databaseOid]) => mapping[database] !== databaseOid,
    )
  ) {
    throw new Error(`${label} does not match the pinned database OIDs`);
  }
}

function dropDatabase(context, database) {
  postgresSql(
    context,
    `DROP DATABASE IF EXISTS ${sqlIdentifier(database)} WITH (FORCE)`,
    `${database} database cleanup`,
    { inherit: true },
  );
}

function dropDatabaseByOid(context, database, databaseOid) {
  assertDatabaseOidMapping(
    context,
    { [database]: databaseOid },
    [],
    `${database} database cleanup OID verification`,
  );
  dropDatabase(context, database);
}

function databaseLocaleCreateOptions(identity) {
  const provider = databaseLocaleProviders.get(identity.databaseLocaleProvider);
  const options = [
    `LOCALE_PROVIDER ${provider}`,
    `LC_COLLATE ${sqlLiteral(identity.databaseCollate)}`,
    `LC_CTYPE ${sqlLiteral(identity.databaseCtype)}`,
  ];
  if (identity.databaseLocaleProvider === 'i') {
    options.push(`ICU_LOCALE ${sqlLiteral(identity.databaseLocale)}`);
    if (identity.databaseIcuRules !== null) {
      options.push(`ICU_RULES ${sqlLiteral(identity.databaseIcuRules)}`);
    }
  } else if (identity.databaseLocaleProvider === 'b') {
    options.push(`BUILTIN_LOCALE ${sqlLiteral(identity.databaseLocale)}`);
  }
  return options;
}

function orderDatabaseAclEntries(identity) {
  const availablePrivileges = new Map([
    [identity.databaseOwner, new Set(databasePrivileges)],
    [identity.postgresAdmin, new Set(databasePrivileges)],
  ]);
  const pending = [...identity.databaseAcl];
  const ordered = [];
  while (pending.length > 0) {
    const entryIndex = pending.findIndex((entry) =>
      availablePrivileges.get(entry.grantor)?.has(entry.privilege),
    );
    if (entryIndex === -1) {
      throw new Error(
        'External PostgreSQL database ACL grantor chain cannot be replayed safely',
      );
    }
    const [entry] = pending.splice(entryIndex, 1);
    ordered.push(entry);
    if (entry.grantable && entry.grantee !== 'PUBLIC') {
      const privileges = availablePrivileges.get(entry.grantee) ?? new Set();
      privileges.add(entry.privilege);
      availablePrivileges.set(entry.grantee, privileges);
    }
  }
  return ordered;
}

function restoreDatabaseAcl(context, identity, stagingDatabase) {
  const grantees = new Set([
    'PUBLIC',
    identity.databaseOwner,
    ...identity.databaseAcl.map(({ grantee }) => grantee),
  ]);
  const statements = [
    'BEGIN',
    ...[...grantees].map(
      (grantee) =>
        `REVOKE ALL PRIVILEGES ON DATABASE ${sqlIdentifier(stagingDatabase)} FROM ${
          grantee === 'PUBLIC' ? 'PUBLIC' : sqlIdentifier(grantee)
        }`,
    ),
  ];
  for (const entry of orderDatabaseAclEntries(identity)) {
    statements.push(
      `SET ROLE ${sqlIdentifier(entry.grantor)}`,
      `GRANT ${entry.privilege} ON DATABASE ${sqlIdentifier(stagingDatabase)} TO ${
        entry.grantee === 'PUBLIC' ? 'PUBLIC' : sqlIdentifier(entry.grantee)
      }${entry.grantable ? ' WITH GRANT OPTION' : ''} GRANTED BY ${sqlIdentifier(entry.grantor)}`,
      'RESET ROLE',
    );
  }
  statements.push('COMMIT');
  postgresSql(
    context,
    `${statements.join(';\n')};`,
    'External PostgreSQL staging database ACL restoration',
    { inherit: true },
  );
}

function restoreDatabaseRoleSettings(context, identity, stagingDatabase) {
  const statements = identity.databaseRoleSettings.flatMap(
    ({ roleName, settings }) =>
      settings.map((setting) => {
        const separator = setting.indexOf('=');
        const name = setting.slice(0, separator);
        const value = setting.slice(separator + 1);
        return roleName === null
          ? `ALTER DATABASE ${sqlIdentifier(stagingDatabase)} SET ${name} TO ${sqlLiteral(value)}`
          : `ALTER ROLE ${sqlIdentifier(roleName)} IN DATABASE ${sqlIdentifier(stagingDatabase)} SET ${name} TO ${sqlLiteral(value)}`;
      }),
  );
  if (statements.length === 0) {
    return;
  }
  postgresSql(
    context,
    `${statements.join(';\n')};`,
    'External PostgreSQL staging database role settings restoration',
    { inherit: true },
  );
}

function createStagingDatabase(context, identity, stagingDatabase) {
  postgresSql(
    context,
    [
      `CREATE DATABASE ${sqlIdentifier(stagingDatabase)} WITH`,
      `OWNER ${sqlIdentifier(identity.databaseOwner)}`,
      'TEMPLATE template0',
      `ENCODING ${sqlLiteral(identity.databaseEncoding)}`,
      ...databaseLocaleCreateOptions(identity),
      `TABLESPACE ${sqlIdentifier(identity.databaseTablespace)}`,
      `CONNECTION LIMIT ${identity.databaseConnectionLimit}`,
    ].join(' '),
    'External PostgreSQL staging database creation',
    { inherit: true },
  );
  restoreDatabaseAcl(context, identity, stagingDatabase);
  restoreDatabaseRoleSettings(context, identity, stagingDatabase);
}

function assertDatabaseMetadataEquivalent(original, staging) {
  for (const field of [
    'databaseAcl',
    'databaseAllowConnections',
    'databaseCollate',
    'databaseConnectionLimit',
    'databaseCtype',
    'databaseEncoding',
    'databaseIcuRules',
    'databaseLocale',
    'databaseLocaleProvider',
    'databaseOwner',
    'databaseRoleSettings',
    'databaseTablespace',
  ]) {
    if (JSON.stringify(staging[field]) !== JSON.stringify(original[field])) {
      throw new Error(
        `External PostgreSQL staging database metadata differs for ${field}`,
      );
    }
  }
}

function assertPostgresIdentityUnchanged(original, current) {
  if (JSON.stringify(current) !== JSON.stringify(original)) {
    throw new Error(
      'External PostgreSQL identity or database metadata changed after write quiesce',
    );
  }
}

async function restoreStagingDatabase(
  context,
  identity,
  databaseFile,
  stagingDatabase,
  pipeFile,
) {
  await pipeFile(
    databaseFile,
    'docker',
    postgresInteractiveExecArguments(
      identity.containerId,
      identity.postgresAdmin,
      'pg_restore',
      '--exit-on-error',
      '--single-transaction',
      '--dbname',
      stagingDatabase,
    ),
    { label: 'External PostgreSQL staging restore' },
  );
}

function combinePrimaryAndRecoveryErrors(
  primaryError,
  recoveryErrors,
  message,
) {
  if (recoveryErrors.length === 0) {
    throw primaryError;
  }
  const error = new AggregateError([primaryError, ...recoveryErrors], message, {
    cause: primaryError,
  });
  error.databaseRecoveryIncomplete = true;
  throw error;
}

function databaseRecoveryIncompleteError(primaryError, message) {
  const error = new Error(message, {
    cause: primaryError,
  });
  error.databaseRecoveryIncomplete = true;
  return error;
}

function isDatabaseRecoveryIncomplete(error) {
  try {
    return error?.databaseRecoveryIncomplete === true;
  } catch {
    return true;
  }
}

export function switchToStagingDatabase(
  context,
  databaseName,
  { previous, staging },
  identity,
  stagingIdentity,
) {
  try {
    fenceDatabaseConnections(context, databaseName);
    fenceDatabaseConnections(context, staging);
    renameDatabasesAtomically(
      context,
      [
        [databaseName, previous],
        [staging, databaseName],
      ],
      'External PostgreSQL atomic database activation switch',
    );
    assertDatabaseOidMapping(
      context,
      {
        [databaseName]: stagingIdentity.databaseOid,
        [previous]: identity.databaseOid,
      },
      [staging],
      'External PostgreSQL activation OID verification',
    );
    setDatabaseConnectionLimit(
      context,
      databaseName,
      identity.databaseConnectionLimit,
    );
  } catch (error) {
    const recoveryErrors = [];
    let mapping;
    try {
      mapping = databaseOidMapping(
        context,
        [databaseName, previous, staging],
        'External PostgreSQL activation recovery layout inspection',
      );
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    if (
      mapping?.[databaseName] === stagingIdentity.databaseOid &&
      mapping?.[previous] === identity.databaseOid &&
      mapping?.[staging] === undefined
    ) {
      try {
        fenceDatabaseConnections(context, databaseName);
        renameDatabasesAtomically(
          context,
          [
            [databaseName, staging],
            [previous, databaseName],
          ],
          'External PostgreSQL atomic activation switch recovery',
        );
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    } else if (
      mapping !== undefined &&
      !(
        mapping[databaseName] === identity.databaseOid &&
        mapping[staging] === stagingIdentity.databaseOid &&
        mapping[previous] === undefined
      )
    ) {
      recoveryErrors.push(
        new Error(
          'External PostgreSQL activation recovery layout is ambiguous',
        ),
      );
    }
    try {
      assertDatabaseOidMapping(
        context,
        {
          [databaseName]: identity.databaseOid,
          [staging]: stagingIdentity.databaseOid,
        },
        [previous],
        'External PostgreSQL activation recovery OID verification',
      );
      fenceDatabaseConnections(context, databaseName);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    combinePrimaryAndRecoveryErrors(
      error,
      recoveryErrors,
      'External PostgreSQL activation switch failed and recovery was incomplete',
    );
  }
}

export function rollbackDatabaseSwitch(
  context,
  databaseName,
  { failed, previous, staging },
  identity,
  stagingIdentity,
) {
  try {
    const mapping = databaseOidMapping(
      context,
      [databaseName, failed, previous, staging],
      'External PostgreSQL rollback layout inspection',
    );
    if (
      mapping[databaseName] === stagingIdentity.databaseOid &&
      mapping[previous] === identity.databaseOid &&
      mapping[failed] === undefined &&
      mapping[staging] === undefined
    ) {
      fenceDatabaseConnections(context, databaseName);
      renameDatabasesAtomically(
        context,
        [
          [databaseName, failed],
          [previous, databaseName],
        ],
        'External PostgreSQL atomic original database rollback',
      );
      assertDatabaseOidMapping(
        context,
        {
          [databaseName]: identity.databaseOid,
          [failed]: stagingIdentity.databaseOid,
        },
        [previous, staging],
        'External PostgreSQL rollback OID verification',
      );
      return failed;
    }
    if (
      mapping[databaseName] === identity.databaseOid &&
      mapping[staging] === stagingIdentity.databaseOid &&
      mapping[failed] === undefined &&
      mapping[previous] === undefined
    ) {
      fenceDatabaseConnections(context, databaseName);
      return staging;
    }
    throw new Error('External PostgreSQL rollback layout is ambiguous');
  } catch (error) {
    const recoveryErrors = [];
    let mapping;
    try {
      mapping = databaseOidMapping(
        context,
        [databaseName, failed, previous, staging],
        'External PostgreSQL rollback recovery layout inspection',
      );
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    if (
      mapping?.[databaseName] === identity.databaseOid &&
      mapping?.[failed] === stagingIdentity.databaseOid &&
      mapping?.[previous] === undefined &&
      mapping?.[staging] === undefined
    ) {
      try {
        fenceDatabaseConnections(context, databaseName);
        assertDatabaseOidMapping(
          context,
          {
            [databaseName]: identity.databaseOid,
            [failed]: stagingIdentity.databaseOid,
          },
          [previous, staging],
          'External PostgreSQL rollback recovery OID verification',
        );
        return failed;
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    } else if (mapping !== undefined) {
      recoveryErrors.push(
        new Error('External PostgreSQL rollback recovery layout is ambiguous'),
      );
    }
    combinePrimaryAndRecoveryErrors(
      error,
      recoveryErrors,
      'External PostgreSQL rollback switch or OID verification was incomplete',
    );
  }
}

function restoreOriginalDatabaseAccess(context, databaseName, identity) {
  assertDatabaseOidMapping(
    context,
    { [databaseName]: identity.databaseOid },
    [],
    'External PostgreSQL original database OID verification',
  );
  setDatabaseConnectionLimit(
    context,
    databaseName,
    identity.databaseConnectionLimit,
  );
}

async function writeUpgradeResult(
  backupDirectory,
  result,
  writeTextFile = writeFile,
) {
  await writeTextFile(
    resolve(backupDirectory, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

function rollbackIncompleteError(
  primaryError,
  rollbackErrors,
  backupDirectory,
  backupAvailable,
) {
  const evidence =
    backupDirectory === undefined
      ? 'no backup directory was created'
      : backupAvailable
        ? `verified backup retained at ${backupDirectory}`
        : `evidence directory retained at ${backupDirectory}; no verified backup was created`;
  const error = new AggregateError(
    [primaryError, ...rollbackErrors],
    `External database release upgrade failed and rollback was incomplete; ${evidence}`,
    { cause: primaryError },
  );
  if (backupDirectory !== undefined) {
    error.evidenceDirectory = backupDirectory;
  }
  if (backupAvailable) {
    error.backupDirectory = backupDirectory;
  }
  error.retainRollbackResources = true;
  return error;
}

function rollbackCompletedError(
  primaryError,
  backupDirectory,
  backupAvailable,
) {
  const evidence =
    backupDirectory === undefined
      ? 'no backup was created'
      : backupAvailable
        ? `backup was retained at ${backupDirectory}`
        : `evidence was retained at ${backupDirectory}, but no verified backup was created`;
  const error = new Error(
    `External database release upgrade failed; rollback completed and ${evidence}: ${failureMessage(primaryError)}`,
    { cause: primaryError },
  );
  if (backupDirectory !== undefined) {
    error.evidenceDirectory = backupDirectory;
  }
  if (backupAvailable) {
    error.backupDirectory = backupDirectory;
  }
  error.retainRollbackResources = false;
  return error;
}

function commitIncompleteError(primaryError, backupDirectory) {
  const error = new Error(
    `External database release activation passed but commit cleanup was incomplete; rollback resources retained and backup is at ${backupDirectory}: ${failureMessage(primaryError)}`,
    { cause: primaryError },
  );
  error.activationCommitted = true;
  error.backupDirectory = backupDirectory;
  error.retainRollbackResources = true;
  return error;
}

export function retainExternalUpgradeRollbackResources(error) {
  try {
    return error?.retainRollbackResources === true;
  } catch {
    return true;
  }
}

export async function runExternalDatabaseUpgrade(
  {
    activateServices,
    applicationRole,
    assertRunningServices,
    backupRoot,
    databaseName,
    execute = run,
    expectedIngressImageId,
    expectedPostgresMajor,
    expectedPostgresSystemIdentifier,
    ingressContainerId,
    postgresAdmin,
    postgresContainerId,
    releaseImages,
    releaseOverride,
    restoreImageTags,
    rollbackImages,
    rollbackOverride,
    runSmoke,
    stopServices,
    workspace,
  },
  {
    changeMode = chmod,
    makeTemporaryDirectory = mkdtemp,
    now = () => new Date(),
    pipeCommand = pipeCommandToFile,
    pipeFile = pipeFileToCommand,
    randomTransactionId = () => randomBytes(12).toString('hex'),
    sha256 = sha256File,
    statFile = stat,
    waitForIngressHealth = wait,
    writeTextFile = writeFile,
  } = {},
) {
  const identity = await inspectExternalPostgres({
    applicationRole,
    databaseName,
    execute,
    expectedPostgresMajor,
    expectedPostgresSystemIdentifier,
    postgresAdmin,
    postgresContainerId,
  });
  const ingressIdentity = inspectExternalIngress({
    execute,
    expectedIngressImageId,
    ingressContainerId,
  });
  const names = createExternalDatabaseNames(randomTransactionId());
  const databaseContext = { execute, postgresAdmin, postgresContainerId };
  const ingressContext = { execute, waitForHealth: waitForIngressHealth };
  assertDatabaseNamesAvailable(databaseContext, names);
  const stagingOverride = resolve(workspace, 'staging-database.compose.yaml');
  await writeTextFile(
    stagingOverride,
    externalDatabaseOverrideSource(names.staging),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );

  let activationCommitted = false;
  let backup;
  let backupDirectory;
  let databaseState = 'original';
  let maintenanceStarted = false;
  let originalDatabaseFenceAttempted = false;
  let stagingCreationAttempted = false;
  let stagingDatabaseOid;
  let stagingIdentity;

  try {
    maintenanceStarted = true;
    stopExternalIngress(ingressContext, ingressIdentity);
    await stopServices({
      label: 'External database pre-upgrade write quiesce',
      expectedImages: rollbackImages,
      services: ['server'],
    });
    const stoppedIdentity = await inspectExternalPostgres({
      applicationRole,
      databaseName,
      execute,
      expectedPostgresMajor,
      expectedPostgresSystemIdentifier,
      postgresAdmin,
      postgresContainerId,
    });
    assertPostgresIdentityUnchanged(identity, stoppedIdentity);
    originalDatabaseFenceAttempted = true;
    fenceDatabaseConnections(databaseContext, databaseName);
    backupDirectory = await prepareBackupDirectory(backupRoot, {
      changeMode,
      makeTemporaryDirectory,
    });
    backup = await writeExternalDatabaseBackup(backupDirectory, identity, {
      now,
      pipeCommand,
      pipeFile,
      sha256,
      statFile,
      writeTextFile,
    });
    stagingCreationAttempted = true;
    createStagingDatabase(databaseContext, identity, names.staging);
    stagingDatabaseOid = databaseOidMapping(
      databaseContext,
      [names.staging],
      'External PostgreSQL staging database OID capture',
    )[names.staging];
    if (
      stagingDatabaseOid === undefined ||
      stagingDatabaseOid === identity.databaseOid
    ) {
      throw new Error(
        'External PostgreSQL staging database OID is unavailable or reused',
      );
    }
    await restoreStagingDatabase(
      databaseContext,
      identity,
      backup.databaseFile,
      names.staging,
      pipeFile,
    );
    stagingIdentity = await inspectExternalPostgres({
      applicationRole,
      databaseName: names.staging,
      execute,
      expectedPostgresMajor,
      expectedPostgresSystemIdentifier,
      postgresAdmin,
      postgresContainerId,
    });
    if (stagingIdentity.databaseOid !== stagingDatabaseOid) {
      throw new Error(
        'External PostgreSQL staging database OID changed after restore',
      );
    }
    assertDatabaseMetadataEquivalent(identity, stagingIdentity);
    await activateServices({
      label: 'External database staging migration activation',
      overrides: [releaseOverride, stagingOverride],
      services: ['server'],
    });
    await assertRunningServices(releaseImages, ['server']);
    await runSmoke('External database staging migration smoke');
    const migratedStagingIdentity = await inspectExternalPostgres({
      applicationRole,
      databaseName: names.staging,
      execute,
      expectedPostgresMajor,
      expectedPostgresSystemIdentifier,
      postgresAdmin,
      postgresContainerId,
    });
    if (migratedStagingIdentity.databaseOid !== stagingDatabaseOid) {
      throw new Error(
        'External PostgreSQL staging database OID changed after migration',
      );
    }
    assertDatabaseMetadataEquivalent(identity, migratedStagingIdentity);
    stagingIdentity = migratedStagingIdentity;
    await stopServices({
      label: 'External database staging server stop',
      expectedImages: releaseImages,
      services: ['server'],
    });
    try {
      switchToStagingDatabase(
        databaseContext,
        databaseName,
        names,
        identity,
        stagingIdentity,
      );
      databaseState = 'swapped';
    } catch (error) {
      if (isDatabaseRecoveryIncomplete(error)) {
        databaseState = 'unknown';
      }
      throw error;
    }
    await activateServices({
      label: 'External database release activation',
      overrides: [releaseOverride],
      services: upgradeServices,
    });
    await assertRunningServices(releaseImages, upgradeServices);
    await runSmoke('External database post-apply smoke');
    await restoreExternalIngress(ingressContext, ingressIdentity);
    activationCommitted = true;
    dropDatabaseByOid(databaseContext, names.previous, identity.databaseOid);
    databaseState = 'committed';
    await writeUpgradeResult(
      backupDirectory,
      {
        status: 'applied',
        completedAt: now().toISOString(),
        databaseSha256: backup.databaseSha256,
        databaseOids: {
          active: stagingIdentity.databaseOid,
          previous: identity.databaseOid,
        },
        ingressContainerId: ingressIdentity.containerId,
        ingressImageId: ingressIdentity.imageId,
        releaseImageIds: Object.fromEntries(
          upgradeServices.map((service) => [
            service,
            releaseImages[service].imageId,
          ]),
        ),
      },
      writeTextFile,
    );
    return Object.freeze({ backupDirectory, identity, names });
  } catch (error) {
    if (activationCommitted) {
      throw commitIncompleteError(error, backupDirectory);
    }
    const rollbackErrors = [];
    let ingressReadyForRollback = !maintenanceStarted;
    if (maintenanceStarted) {
      try {
        stopExternalIngress(ingressContext, ingressIdentity);
        ingressReadyForRollback = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        ingressReadyForRollback = false;
      }
    }
    let servicesReadyForDatabaseRollback = !maintenanceStarted;
    if (maintenanceStarted) {
      try {
        await stopServices({
          allowMissing: false,
          label: 'External database rollback service stop',
          services: upgradeServices,
        });
        servicesReadyForDatabaseRollback = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        servicesReadyForDatabaseRollback = false;
      }
    }

    let cleanupDatabaseName;
    let databaseReadyForServiceRollback = false;
    if (ingressReadyForRollback && servicesReadyForDatabaseRollback) {
      try {
        if (
          (databaseState === 'swapped' || databaseState === 'unknown') &&
          stagingIdentity !== undefined
        ) {
          cleanupDatabaseName = rollbackDatabaseSwitch(
            databaseContext,
            databaseName,
            names,
            identity,
            stagingIdentity,
          );
          databaseState = 'original';
        } else if (databaseState === 'original') {
          cleanupDatabaseName =
            stagingDatabaseOid === undefined ? undefined : names.staging;
        } else {
          throw databaseRecoveryIncompleteError(
            error,
            'External PostgreSQL database state cannot be recovered automatically',
          );
        }
        if (originalDatabaseFenceAttempted) {
          restoreOriginalDatabaseAccess(
            databaseContext,
            databaseName,
            identity,
          );
          originalDatabaseFenceAttempted = false;
        }
        databaseReadyForServiceRollback = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        databaseReadyForServiceRollback = false;
      }
    } else if (originalDatabaseFenceAttempted || databaseState !== 'original') {
      rollbackErrors.push(
        new Error(
          'Original database access remains fenced because ingress or service quiescence could not be verified',
        ),
      );
    }
    try {
      await restoreImageTags(rollbackImages, upgradeServices);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    let rollbackServicesVerified = false;
    if (databaseReadyForServiceRollback) {
      try {
        await activateServices({
          label: 'External database release image rollback',
          overrides: [rollbackOverride],
          services: upgradeServices,
        });
        await assertRunningServices(rollbackImages, upgradeServices);
        await runSmoke('External database rollback smoke');
        rollbackServicesVerified = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else {
      rollbackErrors.push(
        new Error(
          'Original services were not restarted because database rollback is incomplete',
        ),
      );
    }

    let ingressRestored = false;
    if (rollbackServicesVerified) {
      try {
        await restoreExternalIngress(ingressContext, ingressIdentity);
        ingressRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (
      rollbackErrors.length === 0 &&
      ingressRestored &&
      stagingCreationAttempted
    ) {
      if (
        cleanupDatabaseName === undefined ||
        stagingDatabaseOid === undefined
      ) {
        try {
          const unpinned = databaseOidMapping(
            databaseContext,
            [names.failed, names.staging],
            'External PostgreSQL unpinned staging cleanup inspection',
          );
          if (Object.keys(unpinned).length > 0) {
            rollbackErrors.push(
              new Error(
                'Staging database cleanup was skipped because its OID was not pinned',
              ),
            );
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      } else {
        try {
          dropDatabaseByOid(
            databaseContext,
            cleanupDatabaseName,
            stagingDatabaseOid,
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }

    try {
      if (backupDirectory !== undefined) {
        await writeUpgradeResult(
          backupDirectory,
          {
            status:
              rollbackErrors.length === 0
                ? 'rollback-completed'
                : 'rollback-incomplete',
            backupAvailable: backup !== undefined,
            completedAt: now().toISOString(),
            databaseSha256: backup?.databaseSha256 ?? null,
            failure: failureMessage(error),
            databaseNames: names,
            rollbackErrors: rollbackErrors.map((rollbackError) =>
              failureMessage(rollbackError),
            ),
          },
          writeTextFile,
        );
      }
    } catch (resultError) {
      rollbackErrors.push(resultError);
    }
    if (rollbackErrors.length > 0) {
      throw rollbackIncompleteError(
        error,
        rollbackErrors,
        backupDirectory,
        backup !== undefined,
      );
    }
    throw rollbackCompletedError(error, backupDirectory, backup !== undefined);
  }
}
