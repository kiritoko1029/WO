import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@wo/media-policy': mediaPolicySource,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
