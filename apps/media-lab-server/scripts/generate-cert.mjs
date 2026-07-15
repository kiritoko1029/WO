import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import selfsigned from 'selfsigned';

const outputDirectory = resolve(process.argv[2] ?? '.certs/media-lab');
const pems = selfsigned.generate(
  [{ name: 'commonName', value: 'localhost media lab' }],
  {
    algorithm: 'sha256',
    days: 30,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  },
);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, 'cert.pem'), pems.cert, {
    mode: 0o600,
  }),
  writeFile(resolve(outputDirectory, 'key.pem'), pems.private, {
    mode: 0o600,
  }),
]);
console.log(`Generated media lab certificate in ${outputDirectory}`);
