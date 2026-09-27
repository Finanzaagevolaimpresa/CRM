import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'communications.spec.ts', workers: 1, retries: 0,
  timeout: 180_000, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3024', trace: 'off', video: 'off', screenshot: 'off' } });
