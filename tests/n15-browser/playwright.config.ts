import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'assignment.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { browserName: 'chromium', headless: true, screenshot: 'off', trace: 'off', video: 'off' },
});
