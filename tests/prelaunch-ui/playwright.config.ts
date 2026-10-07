import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({ testDir: '.', testMatch: 'counters.spec.ts', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:3041', browserName: 'chromium', headless: true },
  webServer: { command: 'node tests/prelaunch-ui/server.mjs', cwd: resolve(__dirname, '../..'), url: 'http://127.0.0.1:3041', reuseExistingServer: false },
});
