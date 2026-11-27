import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'flow.spec.ts', workers: 1, retries: 0, timeout: 240000,
  expect: { timeout: 30000 }, use: { browserName: 'chromium', headless: true, channel: 'chromium',
    baseURL: process.env.APP_ORIGIN ?? 'http://127.0.0.1:3060', actionTimeout: 30000, navigationTimeout: 80000,
    trace: 'off', video: 'off', screenshot: 'off' } });
