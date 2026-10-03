import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'communications.spec.ts', workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 10_000 }, use: { actionTimeout: 20_000, navigationTimeout: 45_000,
    browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3024', trace: 'off', video: 'off', screenshot: 'off' } });
