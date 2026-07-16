import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { argumentValue, deployDirectory } from './ops.mjs';

const generatedSecretNames = Object.freeze([
  'jwt_access_secret',
  'postgres_password',
  'turn_shared_secret',
]);

export async function initializeSecrets() {
  const directory = resolve(
    deployDirectory,
    argumentValue('--secret-dir', './secrets'),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of generatedSecretNames) {
    const value = `${randomBytes(32).toString('base64url')}\n`;
    try {
      await writeFile(resolve(directory, name), value, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      process.stdout.write(`Created ${name}\n`);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      process.stdout.write(`Preserved existing ${name}\n`);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initializeSecrets().catch((error) => {
    process.stderr.write(
      `Secret initialization failed (${error.name ?? 'Error'})\n`,
    );
    process.exitCode = 1;
  });
}
