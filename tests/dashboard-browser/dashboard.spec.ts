import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.DASHBOARD_EVIDENCE!, password = process.env.DASHBOARD_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as { synthetic: boolean; readerId: string; otherId: string; leadId: string; emails: { admin: string; reader: string; restricted: string } };
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
const kpi = (page: Page, id: string) => page.locator(`[data-kpi="${id}"]`);
async function selectByKeyboard(page: Page, id: string) {
  // Server-rendered links can be visible before the client tree is ready.
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  const target = kpi(page, id);
  await target.focus(); await expect(target).toBeFocused();
  await target.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?vista=${id}$`));
  await expect(target).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#dashboard-detail')).toBeFocused();
}
async function shot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: width === 1672 ? 941 : 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false });
}
test.beforeAll(async () => { expect(f.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => { await db.$disconnect(); });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page.evaluate(() => ({
    url: location.pathname + location.search, width: innerWidth,
    ready: !!document.querySelector('[data-interactive-ready="true"]'),
    focusedId: document.activeElement?.id,
    focusedKpi: document.activeElement?.getAttribute('data-kpi'),
    selectedKpi: document.querySelector('[data-kpi][aria-current="true"]')?.getAttribute('data-kpi'),
  }));
  await info.attach('dashboard-navigation-state', { body: JSON.stringify(state), contentType: 'application/json' });
});

test('native Admin dashboard uses complete real synthetic totals, original logo, selection and filtered lead destination', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await login(page, f.emails.admin);
  for (const [id, value] of [['lead', 47], ['pratiche', 18], ['revisioni', 6], ['oggi', 3]] as const) await expect(kpi(page, id).locator('[data-counter-final]')).toHaveAttribute('data-counter-final', String(value));
  await expect(kpi(page, 'pratiche')).toHaveAttribute('aria-current', 'true');
  const logo = page.getByRole('img', { name: 'Finanza Agevola Impresa' }).filter({ visible: true });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((node: HTMLImageElement) => node.naturalWidth / node.naturalHeight)).toBeCloseTo(971 / 567, 1);
  await expect(page.locator('#dashboard-detail li')).toHaveCount(3);
  await expect(page.locator('#dashboard-detail')).not.toContainText('approvata fuori filtro');
  await shot(page, 'dashboard-native-desktop-1672', 1672);
  await selectByKeyboard(page, 'lead');
  await expect(page.locator('#dashboard-detail li')).toHaveCount(3);
  await page.locator('#dashboard-detail').getByRole('link', { name: 'Vedi elenco completo' }).click();
  await expect(page).toHaveURL(/\/leads\?status=da_contattare/);
  await expect(page.locator('select[name="status"]')).toHaveValue('da_contattare');
  await expect(page.getByText('Lead nuovo escluso dal filtro', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Lead nel cestino escluso', { exact: true })).toHaveCount(0);
});

test('review and today lists apply the same filters as their counters without changing domain data', async ({ page }) => {
  await login(page, f.emails.admin);
  const snapshot = async () => JSON.stringify(await Promise.all([db.lead.findMany({ orderBy: { id: 'asc' } }), db.task.findMany({ orderBy: { id: 'asc' } }), db.preAnalysis.findMany({ orderBy: { id: 'asc' } }), db.technicalPractice.findMany({ orderBy: { id: 'asc' } })]));
  const before = await snapshot();
  await kpi(page, 'revisioni').click(); await expect(page.locator('#dashboard-detail')).toContainText('Pre-analisi');
  await page.locator('#dashboard-detail').getByRole('link', { name: 'Vedi elenco completo' }).click();
  await expect(page.getByRole('status')).toContainText('pre-analisi in bozza o da revisionare');
  await expect(page.getByRole('table').getByRole('link', { name: 'Apri', exact: true })).toHaveCount(6);
  await page.goto('/dashboard?vista=oggi'); await expect(kpi(page, 'oggi')).toHaveAttribute('aria-current', 'true');
  await page.locator('#dashboard-detail').getByRole('link', { name: 'Vedi elenco completo' }).click();
  await expect(page.getByRole('status')).toContainText('attività aperte in scadenza oggi');
  for (const name of ['ieri', 'domani', 'completata', 'eliminata']) await expect(page.getByText(`Attività sintetica ${name}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Attività sintetica oggi [123]/)).toHaveCount(3);
  expect(await snapshot()).toBe(before);
});

test('an open session loses detail and counts after permission revocation or reassignment', async ({ page }) => {
  await login(page, f.emails.reader); await page.goto('/dashboard?vista=lead');
  await expect(kpi(page, 'lead').locator('[data-counter-final]')).toHaveAttribute('data-counter-final', '3');
  await db.lead.update({ where: { id: f.leadId }, data: { assignedToId: f.otherId } });
  try {
    await page.reload(); await expect(kpi(page, 'lead').locator('[data-counter-final]')).toHaveAttribute('data-counter-final', '2');
    await expect(page.locator('#dashboard-detail')).not.toContainText('Lead sintetico 01');
    await db.userPermissionOverride.create({ data: { userId: f.readerId, permission: 'lead.read', allowed: false } });
    await page.reload(); await expect(kpi(page, 'lead')).toHaveCount(0);
    const response = await page.request.get('/dashboard?vista=lead'); expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain('Lead sintetico 01');
  } finally {
    await db.userPermissionOverride.deleteMany({ where: { userId: f.readerId, permission: 'lead.read' } });
    await db.lead.update({ where: { id: f.leadId }, data: { assignedToId: f.readerId } });
  }
});

test('native mobile layout, keyboard focus and reduced motion keep all destinations reachable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await login(page, f.emails.admin);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard');
    await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await shot(page, `dashboard-native-mobile-${width}`, width);
    await selectByKeyboard(page, 'oggi');
    await expect(page.locator('#dashboard-detail')).toBeInViewport();
    await expect(kpi(page, 'oggi').locator('[data-phase]')).toHaveAttribute('data-phase', 'settled');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('restricted profile cannot select or infer denied areas and malformed queries fail closed', async ({ page }) => {
  await login(page, f.emails.restricted);
  for (const query of ['vista=lead', 'vista=pratiche', 'vista=revisioni', 'vista=oggi', 'vista=lead&vista=pratiche']) {
    await page.goto('/dashboard?' + query); await expect(page.locator('[data-kpi]')).toHaveCount(0);
    await expect(page.locator('#dashboard-detail li')).toHaveCount(0);
    await expect(page.locator('#dashboard-detail')).toContainText('Nessun contatore disponibile');
    await expect(page.locator('#dashboard-detail')).not.toContainText('sintetico');
  }
});
