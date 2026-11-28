import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'agenda.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  expect: { timeout: 30_000 }, use: { browserName: 'chromium', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    baseURL: process.env.APP_ORIGIN ?? 'http://localhost:3063', viewport: { width: 1600, height: 1100 },
    actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
