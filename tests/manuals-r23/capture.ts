import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';

// Called only from browser tests after their real database identity check.
// Opt-in captures the unchanged application UI, never a generated mock-up.
export async function captureManual(page: Page, id: string, role: string, caption: string, focus?: Locator, visibleProof: Locator[] = []) {
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
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const anchor = focus ?? page.locator('main').getByRole('heading').first();
  await anchor.waitFor({ state: 'visible' });
  await anchor.evaluate(element => {
    // Desktop scrolls an inner container. Only scroll: never hide or restyle UI for evidence.
    element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight
      && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    // Recompute after scrolling because the client section navigation becomes sticky too.
    for (let attempt = 0; attempt < 3; attempt++) {
      const rect = element.getBoundingClientRect();
      let top = Math.max(0, scroller?.getBoundingClientRect().top ?? 0);
      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        if (['sticky', 'fixed'].includes(style.position) && box.height > 0
          && box.right > rect.left && box.left < rect.right
          && box.top <= Number.parseFloat(style.top) + 1 && box.bottom > 0) top = Math.max(top, box.bottom);
      }
      const movement = { top: rect.top - top - 16, behavior: 'instant' as const };
      if (scroller) scroller.scrollBy(movement); else window.scrollBy(movement);
    }
  });
  const viewportProof = [];
  for (const target of [anchor, ...visibleProof]) {
    await expect(target, id + ': evidence must be inside the screenshot').toBeInViewport({ ratio: 1 });
    await expect.poll(() => target.evaluate(element => {
      const box = element.getBoundingClientRect();
      return [0.1, 0.5, 0.9].every(x => [0.1, 0.5, 0.9].every(y => {
        const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
        return hit !== null && element.contains(hit);
      }));
    }), { message: id + ': evidence must not be covered by sticky navigation' }).toBe(true);
    viewportProof.push(await target.evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, tag: element.tagName, insideViewport: true, unobscured: true };
    }));
  }
  mkdirSync(root, { recursive: true });
  const bytes = await page.screenshot({ path: join(root, id + '.png'), fullPage: false, animations: 'disabled' });
  writeFileSync(join(root, id + '.json'), JSON.stringify({
    protocol: 'FAI_R23_SYNTHETIC_MANUAL_VIEW_V1', synthetic: true, id, role, caption,
    path: url.pathname, query: url.search, capturedAt: new Date().toISOString(),
    head: process.env.R23_CANDIDATE_SHA, runId: process.env.GITHUB_RUN_ID,
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 1440, height: 1000,
    realCustomerUsed: false, realDelivery: false, viewportProof,
  }, null, 2) + '\n');
}
