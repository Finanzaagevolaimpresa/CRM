import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'.',testMatch:'flow.spec.ts',workers:1,retries:0,timeout:360000,
  expect:{ timeout:45000 },use:{ browserName:'chromium',headless:true,channel:'chromium',baseURL:'http://127.0.0.1:3059',
  actionTimeout:30000,navigationTimeout:80000,trace:'off',video:'off',screenshot:'off' } });
