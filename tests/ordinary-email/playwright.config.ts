import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['native-ui.spec.ts', 'native-send.spec.ts', 'native-inbound.spec.ts'], workers: 1, retries: 0, timeout: 240_000,
  expect: { timeout: 15_000 }, use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:3036',
    actionTimeout: 20_000, navigationTimeout: 60_000, trace: 'off', video: 'off', screenshot: 'off' } });
