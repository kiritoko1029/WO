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

export default defineConfig({
  main: {
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    },
    plugins: [externalizeDepsPlugin({ exclude: bundledMainDependencies })],
    resolve: {
      alias: {
        '@wo/protocol': protocolSource,
        '@wo/server/lite': serverLiteSource,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
    resolve: {
      alias: {
        '@wo/protocol': protocolSource,
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@wo/media-policy': mediaPolicySource,
        '@wo/protocol': protocolSource,
      },
    },
  },
});
