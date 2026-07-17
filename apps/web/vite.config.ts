import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const protocolSource = fileURLToPath(
  new URL('../../packages/protocol/src/index.ts', import.meta.url),
);
const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@wo/media-policy': mediaPolicySource,
      '@wo/protocol': protocolSource,
    },
    dedupe: ['lucide-react', 'react', 'react-dom'],
  },
  server: {
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
