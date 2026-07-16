import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runBackup } from './backup.mjs';
import {
  argumentValue,
  composeArguments,
  deployDirectory,
  run,
} from './ops.mjs';

const services = Object.freeze(['caddy', 'server', 'postgres', 'coturn']);

export function postgresMajorFromImage(image) {
  const match = /^postgres:([0-9]+)(?:[.-]|$)/u.exec(image);
  if (match === null) {
    throw new Error(`Cannot determine PostgreSQL major from image ${image}`);
  }
  return Number(match[1]);
}

export function assertPostgresMajorUnchanged(envFile) {
  const configuration = JSON.parse(
    run('docker', composeArguments(envFile, 'config', '--format', 'json'), {
      label: 'Compose config',
    }),
  );
  const desiredImage = configuration.services?.postgres?.image;
  if (typeof desiredImage !== 'string') {
    throw new Error('Rendered Compose has no PostgreSQL image');
  }
  const containerId = run(
    'docker',
    composeArguments(envFile, 'ps', '-q', 'postgres'),
    { label: 'PostgreSQL container lookup' },
  ).trim();
  if (containerId.length === 0) {
    throw new Error('PostgreSQL must be running before upgrade');
  }
  const currentEnvironment = run(
    'docker',
    [
      'inspect',
      '--format',
      '{{range .Config.Env}}{{println .}}{{end}}',
      containerId,
    ],
    { label: 'PostgreSQL version inspection' },
  );
  const currentMatch = /^PG_MAJOR=([0-9]+)$/mu.exec(currentEnvironment);
  if (currentMatch === null) {
    throw new Error('Running PostgreSQL image has no PG_MAJOR metadata');
  }
  const currentMajor = Number(currentMatch[1]);
  const desiredMajor = postgresMajorFromImage(desiredImage);
  if (currentMajor !== desiredMajor) {
    throw new Error(
      `PostgreSQL major upgrade ${currentMajor} -> ${desiredMajor} requires a separate migration`,
    );
  }
}

function captureRollbackImages(envFile) {
  return Object.fromEntries(
    services.map((service) => {
      const containerId = run(
        'docker',
        composeArguments(envFile, 'ps', '-q', service),
        { label: `${service} container lookup` },
      ).trim();
      if (containerId.length === 0) {
        throw new Error(`${service} must be running before upgrade`);
      }
      const imageId = run(
        'docker',
        ['inspect', '--format', '{{.Image}}', containerId],
        { label: `${service} image inspection` },
      ).trim();
      const imageReference = run(
        'docker',
        ['inspect', '--format', '{{.Config.Image}}', containerId],
        { label: `${service} image reference inspection` },
      ).trim();
      if (
        !/^sha256:[a-f0-9]{64}$/u.test(imageId) ||
        imageReference.length === 0
      ) {
        throw new Error(`${service} rollback image cannot be pinned safely`);
      }
      return [service, { containerId, imageId, imageReference }];
    }),
  );
}

async function createRollbackOverride(directory, images) {
  const file = resolve(directory, 'rollback.compose.yaml');
  const lines = ['services:'];
  for (const service of services) {
    lines.push(`  ${service}:`);
    if (service === 'server' || service === 'coturn') {
      lines.push('    build: !reset null');
    }
    lines.push(`    image: ${images[service].imageId}`);
  }
  await writeFile(file, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return file;
}

function restoreImageTags(images, selectedServices = services) {
  for (const service of selectedServices) {
    run(
      'docker',
      ['image', 'tag', images[service].imageId, images[service].imageReference],
      { label: `${service} image tag rollback`, stdio: 'inherit' },
    );
  }
}

function runInternalSmoke(envFile) {
  const containerDeployDirectory = '/opt/wo/deploy';
  run(
    'docker',
    composeArguments(
      envFile,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      '--volume',
      `${resolve(deployDirectory, 'scripts')}:${containerDeployDirectory}/scripts:ro`,
      '--volume',
      `${envFile}:${containerDeployDirectory}/.env:ro`,
      'server',
      `${containerDeployDirectory}/scripts/smoke.mjs`,
      `--env-file=${containerDeployDirectory}/.env`,
      '--base-url=http://server:3000',
    ),
    { label: 'Internal post-upgrade smoke', stdio: 'inherit' },
  );
}

export async function runUpgrade() {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env')),
  );
  run(
    process.execPath,
    [
      resolve(import.meta.dirname, 'preflight.mjs'),
      `--env-file=${envFile}`,
      '--allow-running',
    ],
    { label: 'Preflight', stdio: 'inherit' },
  );
  assertPostgresMajorUnchanged(envFile);
  const rollbackImages = captureRollbackImages(envFile);
  const rollbackDirectory = await mkdtemp(resolve(tmpdir(), 'wo-upgrade-'));
  const rollbackOverride = await createRollbackOverride(
    rollbackDirectory,
    rollbackImages,
  );
  let backupDirectory;
  let quiesceAttempted = false;
  let publicExposureAttempted = false;

  try {
    run('docker', composeArguments(envFile, 'pull', 'caddy', 'postgres'), {
      label: 'Image pull',
      stdio: 'inherit',
    });
    run(
      'docker',
      composeArguments(envFile, 'build', '--pull', 'server', 'coturn'),
      {
        label: 'Application image build',
        stdio: 'inherit',
      },
    );
    quiesceAttempted = true;
    run('docker', composeArguments(envFile, 'stop', 'caddy', 'server'), {
      label: 'Pre-upgrade write quiesce',
      stdio: 'inherit',
    });
    backupDirectory = await runBackup();
    run(
      'docker',
      composeArguments(
        envFile,
        'up',
        '-d',
        '--wait',
        'postgres',
        'coturn',
        'server',
      ),
      { label: 'Private upgrade', stdio: 'inherit' },
    );
    runInternalSmoke(envFile);
    publicExposureAttempted = true;
    run('docker', composeArguments(envFile, 'up', '-d', '--wait', 'caddy'), {
      label: 'Public edge activation',
      stdio: 'inherit',
    });
  } catch (error) {
    const rollbackErrors = [];
    if (publicExposureAttempted) {
      try {
        restoreImageTags(rollbackImages, ['caddy']);
        run(
          'docker',
          composeArguments(
            envFile,
            '-f',
            rollbackOverride,
            'up',
            '-d',
            '--no-deps',
            '--wait',
            'caddy',
          ),
          { label: 'Caddy image rollback', stdio: 'inherit' },
        );
        run(
          process.execPath,
          [resolve(import.meta.dirname, 'smoke.mjs'), `--env-file=${envFile}`],
          { label: 'Caddy rollback smoke', stdio: 'inherit' },
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Caddy activation failed and its rollback was incomplete; application data was preserved',
          { cause: error },
        );
      }
      throw new Error(
        `Caddy activation failed; old Caddy restored without data rollback: ${error.message}`,
        { cause: error },
      );
    }
    try {
      restoreImageTags(rollbackImages);
      if (backupDirectory !== undefined) {
        run(
          process.execPath,
          [
            resolve(import.meta.dirname, 'restore.mjs'),
            `--env-file=${envFile}`,
            `--backup-dir=${backupDirectory}`,
            `--compose-override=${rollbackOverride}`,
            '--confirm-restore',
          ],
          { label: 'Pre-upgrade backup rollback', stdio: 'inherit' },
        );
      } else if (quiesceAttempted) {
        run(
          'docker',
          [
            'start',
            rollbackImages.server.containerId,
            rollbackImages.caddy.containerId,
          ],
          { label: 'Original container restart', stdio: 'inherit' },
        );
      }
      run(
        process.execPath,
        [resolve(import.meta.dirname, 'smoke.mjs'), `--env-file=${envFile}`],
        { label: 'Rollback smoke', stdio: 'inherit' },
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Upgrade failed and rollback was incomplete',
        { cause: error },
      );
    }
    throw new Error(`Upgrade failed; rollback completed: ${error.message}`, {
      cause: error,
    });
  } finally {
    await rm(rollbackDirectory, { recursive: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runUpgrade().catch((error) => {
    process.stderr.write(`Upgrade failed (${error.message})\n`);
    process.exitCode = 1;
  });
}
