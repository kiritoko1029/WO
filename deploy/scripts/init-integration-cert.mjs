import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateTurnTlsIdentity } from './lib.mjs';
import { deployDirectory } from './ops.mjs';

const integrationSecretDirectory = resolve(
  deployDirectory,
  './secrets.integration',
);

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`${path} already exists`);
}

export async function initializeIntegrationCertificate() {
  await mkdir(integrationSecretDirectory, { recursive: true, mode: 0o700 });
  const certificateFile = resolve(
    integrationSecretDirectory,
    'turn_tls_cert.pem',
  );
  const privateKeyFile = resolve(
    integrationSecretDirectory,
    'turn_tls_key.pem',
  );
  await assertMissing(certificateFile);
  await assertMissing(privateKeyFile);

  const lockFile = resolve(integrationSecretDirectory, '.certificate.lock');
  await writeFile(lockFile, `${process.pid}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  let temporaryDirectory;

  let certificateCreated = false;
  let privateKeyCreated = false;
  try {
    temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), 'wo-integration-turn-'),
    );
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        'root',
        '--mount',
        `type=bind,source=${temporaryDirectory},target=/out`,
        'caddy:2.11.4-alpine',
        'sh',
        '-ec',
        "apk add --no-cache openssl >/dev/null && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=turn.localhost' -addext 'subjectAltName=DNS:turn.localhost' -keyout /out/turn_tls_key.pem -out /out/turn_tls_cert.pem && chmod 0644 /out/turn_tls_key.pem /out/turn_tls_cert.pem",
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `certificate generation failed: ${(result.stderr || result.stdout).trim()}`,
      );
    }

    const certificate = await readFile(
      resolve(temporaryDirectory, 'turn_tls_cert.pem'),
      'utf8',
    );
    const privateKey = await readFile(
      resolve(temporaryDirectory, 'turn_tls_key.pem'),
      'utf8',
    );
    const issues = validateTurnTlsIdentity({
      certificatePem: certificate,
      privateKeyPem: privateKey,
      hostname: 'turn.localhost',
      production: false,
    });
    if (issues.length > 0) {
      throw new Error(`generated certificate is invalid: ${issues.join('; ')}`);
    }

    await writeFile(certificateFile, certificate, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    certificateCreated = true;
    await writeFile(privateKeyFile, privateKey, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    privateKeyCreated = true;
    process.stdout.write('Created local TURN certificate and private key\n');
  } catch (error) {
    if (certificateCreated) {
      await rm(certificateFile);
    }
    if (privateKeyCreated) {
      await rm(privateKeyFile);
    }
    throw error;
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true });
    }
    await rm(lockFile);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initializeIntegrationCertificate().catch((error) => {
    process.stderr.write(
      `Certificate initialization failed (${error.message})\n`,
    );
    process.exitCode = 1;
  });
}
