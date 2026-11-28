import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['calendar.spec.ts', 'perimeter.spec.ts'], workers: 1, retries: 0, timeout: 240_000,
  expect: { timeout: 30_000 }, use: { browserName: 'chromium', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    baseURL: process.env.APP_ORIGIN ?? 'http://127.0.0.1:3059', actionTimeout: 30_000, navigationTimeout: 60_000,
    trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
