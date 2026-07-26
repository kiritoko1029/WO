import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  argumentValue,
  composeArguments,
  deployDirectory,
  failureMessage,
  hasArgument,
  integrationComposeArguments,
  loadDeploymentEnvironment,
  pipeCommandToFile,
  run,
  sha256File,
  withDeploymentOperationLock,
} from './ops.mjs';
import {
  requiresRuntimeComposeImageOverride,
  withRuntimeComposeImageOverride,
} from './runtime-compose-override.mjs';

function backupTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

async function createBackup(environment, integration, compose) {
  const root = resolve(deployDirectory, environment.BACKUP_DIR);
  const directory = resolve(root, backupTimestamp());
  await mkdir(directory, { recursive: false, mode: 0o700 });

  const databaseFile = resolve(directory, 'postgres.dump');
  const caddyFile = resolve(directory, 'caddy-data.tgz');
  const postgresVersionNumber = Number(
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
  const postgresMajor = Math.floor(postgresVersionNumber / 10_000);
  if (!Number.isInteger(postgresMajor) || postgresMajor < 10) {
    throw new Error('PostgreSQL returned an invalid server version');
  }
  await pipeCommandToFile(
    'docker',
    compose(
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '--format=custom',
      '--create',
      '--no-owner',
      '--no-privileges',
      '--username',
      environment.POSTGRES_USER,
      '--dbname',
      environment.POSTGRES_DB,
    ),
    databaseFile,
    { label: 'PostgreSQL backup' },
  );
  await pipeCommandToFile(
    'docker',
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'tar',
      'caddy',
      '-C',
      '/data',
      '-czf',
      '-',
      'caddy',
    ),
    caddyFile,
    { label: 'Caddy state backup' },
  );

  const manifest = {
    formatVersion: 2,
    profile: integration ? 'integration' : 'production',
    databaseName: environment.POSTGRES_DB,
    postgresMajor,
    createdAt: new Date().toISOString(),
    files: {
      database: {
        name: 'postgres.dump',
        sha256: await sha256File(databaseFile),
      },
      caddy: {
        name: 'caddy-data.tgz',
        sha256: await sha256File(caddyFile),
      },
    },
  };
  await writeFile(
    resolve(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`${directory}\n`);
  return directory;
}

export async function runBackup({ operationLockToken } = {}) {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env')),
  );
  const environment = loadDeploymentEnvironment(envFile);
  const integration = hasArgument('--integration');
  const composeArgumentsForMode = integration
    ? integrationComposeArguments
    : composeArguments;
  const compose = (...arguments_) =>
    composeArgumentsForMode(envFile, ...arguments_);
  return withDeploymentOperationLock(
    deployDirectory,
    () => {
      const operation = (selectedCompose) =>
        createBackup(environment, integration, selectedCompose);
      if (!requiresRuntimeComposeImageOverride({ integration })) {
        return operation(compose);
      }
      return withRuntimeComposeImageOverride({
        compose,
        operation,
        service: 'caddy',
      });
    },
    { token: operationLockToken },
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runBackup().catch((error) => {
    process.stderr.write(`Backup failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  });
}
