import { defineConfig } from '@playwright/test';
import base from '../../tests/pr140-release/playwright.config';
export default defineConfig({ ...base, testDir: '.', testMatch: 'return-availability.spec.ts' });
