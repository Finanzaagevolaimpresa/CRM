import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  use: { browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off' } });
