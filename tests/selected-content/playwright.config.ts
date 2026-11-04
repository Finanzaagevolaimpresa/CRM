import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'selected-content.spec.ts', workers: 1, retries: 0, timeout: 240000,
  expect: { timeout: 25000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3049',
    actionTimeout: 25000, navigationTimeout: 60000, trace: 'off', video: 'off', screenshot: 'only-on-failure' } });
