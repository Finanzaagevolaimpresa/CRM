import { defineConfig } from '@playwright/test';
if (process.env.CI && process.env.CALENDAR_CALLBACK_EXPECT_BASELINE
  && process.env.CALENDAR_CALLBACK_BASELINE_HEAD !== '0eb4c878bb70d3e377572fe46fc6567a6e1c538f') throw new Error('PINNED_BASELINE_REQUIRED');
export default defineConfig({ testDir: '.', testMatch: 'callback.spec.ts', workers: 1, retries: 0, timeout: 90_000,
  expect: { timeout: 15_000 }, reporter: './redacted-reporter.ts',
  use: { browserName: 'chromium', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    baseURL: process.env.APP_ORIGIN, trace: 'off', screenshot: 'off', video: 'off' } });
