import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const protocolSource = fileURLToPath(
  new URL('../../packages/protocol/src/index.ts', import.meta.url),
);
const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);
const serverLiteSource = fileURLToPath(
  new URL('../server/src/lite/index.ts', import.meta.url),
);
const bundledMainDependencies = [
  '@fastify/websocket',
  '@wo/protocol',
  '@wo/server',
  '@wo/server/lite',
  'fastify',
  'ws',
  'zod',
];
const mainEntry = fileURLToPath(
  new URL('./src/main/index.acceptance.ts', import.meta.url),
);
const preloadEntry = fileURLToPath(
  new URL('./src/preload/index.acceptance.ts', import.meta.url),
);
const rendererEntry = fileURLToPath(
  new URL('./src/renderer/index.acceptance.html', import.meta.url),
);
const caddyAuthorityPem = readFileSync(
  fileURLToPath(
    new URL('../../deploy/.certs/caddy-authority/root.crt', import.meta.url),
  ),
  'utf8',
);
const caddyAuthority = new X509Certificate(caddyAuthorityPem);
const caddyAuthoritySpki = createHash('sha256')
  .update(caddyAuthority.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

export default defineConfig({
  main: {
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
      __WO_ACCEPTANCE_CA_SPKI__: JSON.stringify(caddyAuthoritySpki),
      __WO_ACCEPTANCE_CA_CERTIFICATE__: JSON.stringify(caddyAuthorityPem),
    },
    plugins: [externalizeDepsPlugin({ exclude: bundledMainDependencies })],
    build: {
      outDir: 'out-acceptance/main',
      rollupOptions: {
        input: { index: mainEntry },
        output: { entryFileNames: '[name].js', inlineDynamicImports: true },
      },
    },
    resolve: {
      alias: {
        '@wo/protocol': protocolSource,
        '@wo/server/lite': serverLiteSource,
      },
    },
  },
  preload: {
    build: {
      outDir: 'out-acceptance/preload',
      externalizeDeps: false,
      rollupOptions: {
        input: { index: preloadEntry },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: {
      alias: { '@wo/protocol': protocolSource },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'out-acceptance/renderer',
      rollupOptions: { input: rendererEntry },
    },
    resolve: {
      alias: {
        '@wo/media-policy': mediaPolicySource,
        '@wo/protocol': protocolSource,
      },
    },
  },
});
