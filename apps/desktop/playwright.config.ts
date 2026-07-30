import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  preserveOutput:
    process.env['WO_RUN_V13_SOAK'] === '1' ? 'always' : 'failures-only',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
