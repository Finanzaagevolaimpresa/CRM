import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'shared.spec.ts', workers: 1, retries: 0, timeout: 240_000,
  expect: { timeout: 30_000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3060',
    actionTimeout: 30_000, navigationTimeout: 90_000, trace: 'off', video: 'off', screenshot: 'only-on-failure' } });
