import { defineConfig } from '@playwright/test';
import assert from 'node:assert/strict';
const spki = process.env.PR140_CI_CERT_SPKI;
assert.equal(process.env.CI, 'true');
assert.match(spki ?? '', /^[A-Za-z0-9+/]{43}=$/);
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  use: { browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off',
    launchOptions: { args: [`--ignore-certificate-errors-spki-list=${spki}`] } } });
