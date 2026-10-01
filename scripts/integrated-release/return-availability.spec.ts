import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';

const db = new PrismaClient(), app = process.env.PRACTICE_READINESS_BROWSER_ORIGIN!;
async function login(page: Page, email: string) {
  await page.goto(app + '/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(process.env.PRACTICE_READINESS_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(app + '/dashboard');
}
test.afterAll(() => db.$disconnect());
test('R37 return preserves available M4 history and denies an unrelated operator', async ({ page, browser }) => {
  expect(new URL(app).hostname).toBe('127.0.0.1');
  await assertSyntheticCatalogDatabase(db);
  const practice = await db.technicalPractice.findFirstOrThrow({ where: { title: 'M4 synthetic history' } });
  await login(page, 'release-owner@invalid.test');
  const path = app + '/communications?kind=TECHNICAL&practice=' + encodeURIComponent(practice.id);
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('Synthetic history only');
  expect(await response.text()).toContain('Synthetic acquired reply');
  const settings = await page.request.get(app + '/settings/communications');
  expect(settings.status()).toBe(200);
  expect(await settings.text()).toContain('Caselle e risposte');
  const f = JSON.parse(readFileSync(process.env.R05_M1_RECOVERY_FIXTURE!, 'utf8')) as { synthetic: boolean; otherEmail: string };
  expect(f.synthetic).toBe(true);
  const unrelated = await browser.newContext();
  try {
    const outsider = await unrelated.newPage();
    await login(outsider, f.otherEmail);
    const denied = await outsider.request.get(path);
    expect(denied.status()).toBe(404);
    expect(await denied.text()).not.toContain('Synthetic history only');
    const hidden = await outsider.request.get(app + '/search?q=' + encodeURIComponent('M4 synthetic return history'));
    expect(await hidden.text()).not.toContain('/clients/' + practice.clientId);
  } finally { await unrelated.close(); }
});
