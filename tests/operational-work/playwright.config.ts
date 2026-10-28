import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'work.spec.ts', workers: 1, retries: 0, timeout: 240_000,
  expect: { timeout: 25_000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3052',
    actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'off', video: 'off', screenshot: 'only-on-failure' } });
