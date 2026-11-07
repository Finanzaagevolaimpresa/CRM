import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'drive-folders.spec.ts', workers: 1, retries: 0, timeout: 240000,
  outputDir: process.env.FOLDER_EVIDENCE + '/browser-artifacts',
  expect: { timeout: 25000 }, reporter: [['line'], ['json', { outputFile: process.env.FOLDER_EVIDENCE + '/playwright.json' }]],
  use: { browserName: 'chromium', headless: true, baseURL: process.env.APP_ORIGIN ?? 'http://localhost:3051',
    actionTimeout: 25000, navigationTimeout: 60000, trace: 'off', video: 'off', screenshot: 'only-on-failure' } });
