import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  argumentValue,
  deployDirectory,
  integrationComposeArguments,
  run,
} from './ops.mjs';

const publicRootPath = '/data/caddy/pki/authorities/local/root.crt';

export async function exportLocalCa() {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env.integration')),
  );
  const outputFile = resolve(
    argumentValue(
      '--output',
      resolve(deployDirectory, '.certs', 'caddy-authority', 'root.crt'),
    ),
  );
  await mkdir(dirname(outputFile), { recursive: true });
  run(
    'docker',
    integrationComposeArguments(
      envFile,
      'cp',
      `caddy:${publicRootPath}`,
      outputFile,
    ),
    { label: 'Local CA export', stdio: 'inherit' },
  );
  process.stdout.write(`Exported local CA root to ${outputFile}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  exportLocalCa().catch((error) => {
    process.stderr.write(`Local CA export failed (${error.name ?? 'Error'})\n`);
    process.exitCode = 1;
  });
}
