import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const protocolSource = fileURLToPath(
  new URL('../../packages/protocol/src/index.ts', import.meta.url),
);
const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@wo/protocol', 'zod'] })],
    resolve: {
      alias: {
        '@wo/protocol': protocolSource,
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
