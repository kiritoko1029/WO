import { fileURLToPath } from 'node:url';

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
  },
  renderer: {
    resolve: {
      alias: {
        '@wo/media-policy': mediaPolicySource,
      },
    },
  },
});
