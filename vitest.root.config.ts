import { defineConfig } from 'vitest/config';

const testExtensions = '{js,mjs,cjs,ts,mts,cts,jsx,tsx}';
const testFile = `*.{test,spec}.${testExtensions}`;

export default defineConfig({
  test: {
    environment: 'node',
    include: [`tests/**/${testFile}`],
    exclude: [
      'tests/**/integration/**',
      'tests/**/contract/**',
      `tests/**/*.{integration,contract}.{test,spec}.${testExtensions}`,
      'apps/desktop/e2e/**',
    ],
    passWithNoTests: true,
  },
});
