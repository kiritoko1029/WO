import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  argumentValue,
  composeArguments,
  deployDirectory,
  failureMessage,
  hasArgument,
  integrationComposeArguments,
  loadDeploymentEnvironment,
  pipeFileToCommand,
  run,
  sha256File,
  withDeploymentOperationLock,
} from './ops.mjs';
import {
  requiresRuntimeComposeImageOverride,
  withRuntimeComposeImageOverride,
} from './runtime-compose-override.mjs';

const restoreRuntimeServices = Object.freeze([
  'caddy',
  'server',
  'postgres',
  'coturn',
]);

function tarText(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block
    .subarray(
      offset,
      end === -1 || end > offset + length ? offset + length : end,
    )
    .toString('utf8');
}

function tarOctal(block, offset, length, label) {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]*$/u.test(value)) {
    throw new Error(`Caddy archive has an invalid ${label}`);
  }
  const parsed = value.length === 0 ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Caddy archive has an unsafe ${label}`);
  }
  return parsed;
}

function inspectTarHeader(block) {
  const storedChecksum = tarOctal(block, 148, 8, 'header checksum');
  const checksumBlock = Buffer.from(block);
  checksumBlock.fill(0x20, 148, 156);
  const actualChecksum = [...checksumBlock].reduce(
    (sum, value) => sum + value,
    0,
  );
  if (storedChecksum !== actualChecksum) {
    throw new Error('Caddy archive header checksum mismatch');
  }

  const name = tarText(block, 0, 100);
  const prefix = tarText(block, 345, 155);
  const archivePath = prefix.length > 0 ? `${prefix}/${name}` : name;
  const normalizedArchivePath = archivePath.replace(/\/$/u, '');
  if (
    archivePath.length === 0 ||
    archivePath.includes('\\') ||
    /[\p{Cc}]/u.test(archivePath) ||
    posix.isAbsolute(archivePath) ||
    posix.normalize(normalizedArchivePath) !== normalizedArchivePath ||
    archivePath.split('/').some((part) => part === '..') ||
    (normalizedArchivePath !== 'caddy' &&
      !normalizedArchivePath.startsWith('caddy/'))
  ) {
    throw new Error(`Caddy archive contains an unsafe path: ${archivePath}`);
  }

  const type = String.fromCharCode(block[156] ?? 0);
  if (type !== '\0' && type !== '0' && type !== '5') {
    throw new Error(`Caddy archive contains an unsafe entry type: ${type}`);
  }
  const size = tarOctal(block, 124, 12, 'entry size');
  if (type === '5' && size !== 0) {
    throw new Error('Caddy archive directory has a non-zero size');
  }
  return { archivePath: normalizedArchivePath, size };
}

export async function inspectCaddyArchive(file) {
  const stream = createReadStream(file).pipe(createGunzip());
  let buffered = Buffer.alloc(0);
  let payloadBytes = 0;
  let paddingBytes = 0;
  let zeroBlocks = 0;
  let sawCaddyRoot = false;

  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length > 0) {
      if (payloadBytes > 0) {
        const consumed = Math.min(payloadBytes, buffered.length);
        buffered = buffered.subarray(consumed);
        payloadBytes -= consumed;
        continue;
      }
      if (paddingBytes > 0) {
        const consumed = Math.min(paddingBytes, buffered.length);
        buffered = buffered.subarray(consumed);
        paddingBytes -= consumed;
        continue;
      }
      if (buffered.length < 512) {
        break;
      }
      const block = buffered.subarray(0, 512);
      buffered = buffered.subarray(512);
      if (block.every((value) => value === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks > 0) {
        throw new Error('Caddy archive contains data after its end marker');
      }
      const entry = inspectTarHeader(block);
      sawCaddyRoot ||= entry.archivePath.replace(/\/$/u, '') === 'caddy';
      payloadBytes = entry.size;
      paddingBytes = (512 - (entry.size % 512)) % 512;
    }
  }
  if (
    payloadBytes !== 0 ||
    paddingBytes !== 0 ||
    buffered.some((value) => value !== 0) ||
    zeroBlocks < 2 ||
    !sawCaddyRoot
  ) {
    throw new Error('Caddy archive is truncated or has no caddy root');
  }
}

async function verifiedBackup(directory, expectedProfile) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.formatVersion !== 2 ||
    manifest.profile !== expectedProfile ||
    manifest.files?.database?.name !== 'postgres.dump' ||
    manifest.files?.caddy?.name !== 'caddy-data.tgz'
  ) {
    throw new Error('Unsupported, mismatched, or unsafe backup manifest');
  }
  const databaseFile = resolve(directory, manifest.files.database.name);
  const caddyFile = resolve(directory, manifest.files.caddy.name);
  if ((await sha256File(databaseFile)) !== manifest.files.database.sha256) {
    throw new Error('PostgreSQL backup checksum mismatch');
  }
  if ((await sha256File(caddyFile)) !== manifest.files.caddy.sha256) {
    throw new Error('Caddy backup checksum mismatch');
  }
  await inspectCaddyArchive(caddyFile);
  return {
    databaseFile,
    caddyFile,
    databaseName: manifest.databaseName,
    postgresMajor: manifest.postgresMajor,
  };
}

function selectedCompose(envFile, integration, composeOverride) {
  const base = integration ? integrationComposeArguments : composeArguments;
  return (...arguments_) =>
    base(
      envFile,
      ...(composeOverride === undefined
        ? []
        : ['-f', resolve(composeOverride)]),
      ...arguments_,
    );
}

function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function postgresSql(compose, environment, sql, label) {
  return run(
    'docker',
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '--username',
      environment.POSTGRES_USER,
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ),
    { label, stdio: 'inherit' },
  );
}

function currentPostgresMajor(compose, environment) {
  const versionNumber = Number(
    run(
      'docker',
      compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '--username',
        environment.POSTGRES_USER,
        '--dbname',
        'postgres',
        '--tuples-only',
        '--no-align',
        '--command',
        'SHOW server_version_num',
      ),
      { label: 'PostgreSQL version inspection' },
    ).trim(),
  );
  const major = Math.floor(versionNumber / 10_000);
  if (!Number.isInteger(major) || major < 10) {
    throw new Error('PostgreSQL returned an invalid server version');
  }
  return major;
}

function terminateDatabaseConnections(compose, environment, database) {
  postgresSql(
    compose,
    environment,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(database)} AND pid <> pg_backend_pid()`,
    `${database} connection termination`,
  );
}

function dropDatabase(compose, environment, database) {
  terminateDatabaseConnections(compose, environment, database);
  postgresSql(
    compose,
    environment,
    `DROP DATABASE IF EXISTS ${sqlIdentifier(database)}`,
    `${database} database cleanup`,
  );
}

function createStagingDatabase(compose, environment, stagingDatabase) {
  run(
    'docker',
    compose(
      'exec',
      '-T',
      'postgres',
      'createdb',
      '--username',
      environment.POSTGRES_USER,
      '--owner',
      environment.POSTGRES_USER,
      '--template',
      'template0',
      stagingDatabase,
    ),
    { label: 'PostgreSQL staging database creation', stdio: 'inherit' },
  );
}

function restoreStagingDatabase(
  compose,
  environment,
  databaseFile,
  stagingDatabase,
) {
  return pipeFileToCommand(
    databaseFile,
    'docker',
    compose(
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--username',
      environment.POSTGRES_USER,
      '--dbname',
      stagingDatabase,
    ),
    { label: 'PostgreSQL restore' },
  );
}

function switchToStagingDatabase(
  compose,
  environment,
  stagingDatabase,
  previousDatabase,
) {
  const database = environment.POSTGRES_DB;
  terminateDatabaseConnections(compose, environment, database);
  postgresSql(
    compose,
    environment,
    `ALTER DATABASE ${sqlIdentifier(database)} RENAME TO ${sqlIdentifier(previousDatabase)}`,
    'PostgreSQL original database preservation',
  );
  try {
    postgresSql(
      compose,
      environment,
      `ALTER DATABASE ${sqlIdentifier(stagingDatabase)} RENAME TO ${sqlIdentifier(database)}`,
      'PostgreSQL staging database activation',
    );
  } catch (error) {
    postgresSql(
      compose,
      environment,
      `ALTER DATABASE ${sqlIdentifier(previousDatabase)} RENAME TO ${sqlIdentifier(database)}`,
      'PostgreSQL switch recovery',
    );
    throw error;
  }
}

function rollbackDatabaseSwitch(
  compose,
  environment,
  previousDatabase,
  failedDatabase,
) {
  const database = environment.POSTGRES_DB;
  terminateDatabaseConnections(compose, environment, database);
  postgresSql(
    compose,
    environment,
    `ALTER DATABASE ${sqlIdentifier(database)} RENAME TO ${sqlIdentifier(failedDatabase)}`,
    'PostgreSQL failed database preservation',
  );
  try {
    postgresSql(
      compose,
      environment,
      `ALTER DATABASE ${sqlIdentifier(previousDatabase)} RENAME TO ${sqlIdentifier(database)}`,
      'PostgreSQL original database rollback',
    );
  } catch (error) {
    postgresSql(
      compose,
      environment,
      `ALTER DATABASE ${sqlIdentifier(failedDatabase)} RENAME TO ${sqlIdentifier(database)}`,
      'PostgreSQL rollback recovery',
    );
    throw error;
  }
  dropDatabase(compose, environment, failedDatabase);
}

const caddyStageScript = String.raw`
set -eu
id="$1"
stage="/data/.wo-restore-$id-stage"
old="/data/.wo-restore-$id-old"
marker="/data/.wo-restore-$id-had-current"
test ! -e "$stage" && test ! -e "$old" && test ! -e "$marker"
mkdir "$stage"
cleanup() {
  status=$?
  rm -rf "$stage"
  if [ "$status" -ne 0 ] && [ -e "$old" ] && [ ! -e /data/caddy ]; then
    mv "$old" /data/caddy
  fi
  exit "$status"
}
trap cleanup EXIT
tar -C "$stage" -xzf -
test -d "$stage/caddy"
if [ -e /data/caddy ]; then
  mv /data/caddy "$old"
  : > "$marker"
fi
mv "$stage/caddy" /data/caddy
trap - EXIT
rm -rf "$stage"
`;

const caddyRollbackScript = String.raw`
set -eu
id="$1"
old="/data/.wo-restore-$id-old"
marker="/data/.wo-restore-$id-had-current"
rm -rf /data/caddy
if [ -e "$marker" ]; then
  test -d "$old"
  mv "$old" /data/caddy
else
  test ! -e "$old"
fi
rm -f "$marker"
`;

const caddyCommitScript = String.raw`
set -eu
id="$1"
rm -rf "/data/.wo-restore-$id-old"
rm -f "/data/.wo-restore-$id-had-current"
`;

function caddyHelperArguments(compose, script, transactionId) {
  return compose(
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    '/bin/sh',
    'caddy',
    '-ec',
    script,
    'wo-restore',
    transactionId,
  );
}

async function restoreBackup(compose, environment, backup) {
  const transactionId = randomBytes(12).toString('hex');
  const stagingDatabase = `wo_restore_stage_${transactionId}`;
  const previousDatabase = `wo_restore_old_${transactionId}`;
  const failedDatabase = `wo_restore_failed_${transactionId}`;
  if (
    backup.databaseName !== environment.POSTGRES_DB ||
    backup.postgresMajor !== currentPostgresMajor(compose, environment)
  ) {
    throw new Error('Backup database identity or PostgreSQL major mismatch');
  }
  let restoreStarted = false;
  let stagingCreated = false;
  let caddySwapped = false;
  let databaseSwapped = false;

  try {
    restoreStarted = true;
    run('docker', compose('stop', 'caddy', 'server'), {
      label: 'Service stop',
      stdio: 'inherit',
    });
    createStagingDatabase(compose, environment, stagingDatabase);
    stagingCreated = true;
    await restoreStagingDatabase(
      compose,
      environment,
      backup.databaseFile,
      stagingDatabase,
    );
    await pipeFileToCommand(
      backup.caddyFile,
      'docker',
      caddyHelperArguments(compose, caddyStageScript, transactionId),
      { label: 'Caddy staged restore' },
    );
    caddySwapped = true;
    switchToStagingDatabase(
      compose,
      environment,
      stagingDatabase,
      previousDatabase,
    );
    databaseSwapped = true;
    stagingCreated = false;
    run('docker', compose('up', '-d', '--wait'), {
      label: 'Service restart',
      stdio: 'inherit',
    });
    try {
      dropDatabase(compose, environment, previousDatabase);
    } catch (cleanupError) {
      process.stderr.write(
        `Restore warning: previous database cleanup failed (${failureMessage(cleanupError)})\n`,
      );
    }
    try {
      run(
        'docker',
        caddyHelperArguments(compose, caddyCommitScript, transactionId),
        { label: 'Caddy restore commit', stdio: 'inherit' },
      );
    } catch (cleanupError) {
      process.stderr.write(
        `Restore warning: previous Caddy state cleanup failed (${failureMessage(cleanupError)})\n`,
      );
    }
  } catch (error) {
    const rollbackErrors = [];
    let stoppedForRollback = false;
    if (restoreStarted) {
      try {
        run('docker', compose('stop', 'caddy', 'server'), {
          label: 'Rollback service stop',
          stdio: 'inherit',
        });
        stoppedForRollback = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (stoppedForRollback && databaseSwapped) {
      try {
        rollbackDatabaseSwitch(
          compose,
          environment,
          previousDatabase,
          failedDatabase,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else if (stoppedForRollback && stagingCreated) {
      try {
        dropDatabase(compose, environment, stagingDatabase);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (stoppedForRollback && caddySwapped) {
      try {
        run(
          'docker',
          caddyHelperArguments(compose, caddyRollbackScript, transactionId),
          { label: 'Caddy rollback', stdio: 'inherit' },
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (restoreStarted) {
      try {
        run('docker', compose('up', '-d', '--wait'), {
          label: 'Original service restart',
          stdio: 'inherit',
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Restore failed and rollback was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function withRestoreRuntimeImageOverrides({
  compose,
  operation,
  services = restoreRuntimeServices,
  withOverride = withRuntimeComposeImageOverride,
}) {
  const pinService = (index, selectedCompose) => {
    if (index === services.length) {
      return operation(selectedCompose);
    }
    return withOverride({
      compose: selectedCompose,
      operation: (nextCompose) => pinService(index + 1, nextCompose),
      service: services[index],
    });
  };
  return pinService(0, compose);
}

export async function runRestore({ operationLockToken } = {}) {
  if (!hasArgument('--confirm-restore')) {
    throw new Error('Restore requires --confirm-restore');
  }
  const backupDirectory = argumentValue('--backup-dir');
  if (backupDirectory === undefined) {
    throw new Error('Restore requires --backup-dir=/absolute/path');
  }
  const integration = hasArgument('--integration');
  const envFile = resolve(
    argumentValue(
      '--env-file',
      resolve(deployDirectory, integration ? '.env.integration' : '.env'),
    ),
  );
  const environment = loadDeploymentEnvironment(envFile);
  const composeOverride = argumentValue('--compose-override');
  const compose = selectedCompose(envFile, integration, composeOverride);
  return withDeploymentOperationLock(
    deployDirectory,
    async () => {
      const backup = await verifiedBackup(
        resolve(backupDirectory),
        integration ? 'integration' : 'production',
      );
      const operation = (selectedCompose) =>
        restoreBackup(selectedCompose, environment, backup);
      if (
        !requiresRuntimeComposeImageOverride({
          composeOverride,
          integration,
        })
      ) {
        return operation(compose);
      }
      return withRestoreRuntimeImageOverrides({ compose, operation });
    },
    { token: operationLockToken },
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runRestore().catch((error) => {
    process.stderr.write(`Restore failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
