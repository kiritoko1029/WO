import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export * from './lab-server.js';
export * from './protocol.js';
export * from './worker.js';

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { createLabServer } = await import('./lab-server.js');
  const certificateDirectory = resolve(
    process.env.MEDIA_LAB_CERT_DIR ?? '.certs/media-lab',
  );
  const [cert, key] = await Promise.all([
    readFile(resolve(certificateDirectory, 'cert.pem')),
    readFile(resolve(certificateDirectory, 'key.pem')),
  ]);
  const server = await createLabServer({ tls: { cert, key } });
  console.log(`Media lab signaling ready at ${server.url}`);

  const shutdown = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
