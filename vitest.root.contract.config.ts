import { defineConfig } from 'vitest/config';

const contractRoot = 'tests/contract/**';
const testExtensions = '{js,mjs,cjs,ts,mts,cts,jsx,tsx}';

export default defineConfig({
  test: {
    environment: 'node',
    include: [`${contractRoot}/*.{test,spec}.${testExtensions}`],
    passWithNoTests: false,
  },
});
