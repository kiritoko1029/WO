import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const protocolSource = fileURLToPath(
  new URL('../../packages/protocol/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@wo/protocol': protocolSource,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
