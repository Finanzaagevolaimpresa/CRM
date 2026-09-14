import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'intake.spec.ts', workers: 1, retries: 0, timeout: 120_000, use: { browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off' } });
