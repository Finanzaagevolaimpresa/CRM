import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'signature.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  expect: { timeout: 15_000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3039',
    actionTimeout: 20_000, navigationTimeout: 45_000, trace: 'off', video: 'off', screenshot: 'off' } });
