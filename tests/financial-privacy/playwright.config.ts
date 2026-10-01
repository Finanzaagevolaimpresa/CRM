import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'privacy.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  expect: { timeout: 20_000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3042',
    actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'off', video: 'off', screenshot: 'off' } });
