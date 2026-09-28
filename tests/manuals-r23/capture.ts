import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';

// Called only from browser tests after their real database identity check.
// Opt-in captures the unchanged application UI, never a generated mock-up.
export async function captureManual(page: Page, id: string, role: string, caption: string, focus?: Locator) {
  const root = process.env.R23_MANUAL_EVIDENCE;
  if (!root) return;
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({
    requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
    databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
    appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV,
  }), true);
  const url = new URL(page.url());
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(id, /^S0[1-8]-[a-z0-9-]+$/);
  assert.notEqual(url.pathname, '/login');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (focus) await focus.scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, 0));
  mkdirSync(root, { recursive: true });
  const bytes = await page.screenshot({ path: join(root, id + '.png'), fullPage: false, animations: 'disabled' });
  writeFileSync(join(root, id + '.json'), JSON.stringify({
    protocol: 'FAI_R23_SYNTHETIC_MANUAL_VIEW_V1', synthetic: true, id, role, caption,
    path: url.pathname, query: url.search, capturedAt: new Date().toISOString(),
    head: process.env.R23_CANDIDATE_SHA, runId: process.env.GITHUB_RUN_ID,
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 1440, height: 1000,
    realCustomerUsed: false, realDelivery: false,
  }, null, 2) + '\n');
}
