import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  use: { baseURL: 'http://127.0.0.1:3015', browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off' },
  webServer: { command: 'npm run dev -- --hostname 127.0.0.1 --port 3015', url: 'http://127.0.0.1:3015/login', timeout: 120_000, reuseExistingServer: false, stdout: 'ignore' },
});
