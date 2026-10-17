import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { leadFixture } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.LEAD_EVIDENCE!, password = process.env.LEAD_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; ownerId: string; emails: { admin: string; owner: string };
};
const origin = 'http://127.0.0.1:3037';
type Captured = { url: string; body: string; headers: Record<string, string> };
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security');
    await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function openAction(page: Page, label: string, title: string) {
  await page.getByRole('button', { name: label + ': ' + title, exact: true }).click();
  const form = page.locator('form[aria-label=' + JSON.stringify(label + ': ' + title) + ']');
  await expect(page.getByRole('dialog', { name: label, exact: true })).toBeVisible();
  expect(await form.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })).toBe(true);
  await form.getByLabel('Confermo queste conseguenze per questo lead', { exact: true }).check();
  return form;
}
function capture(page: Page) {
  let value: Captured | undefined;
  page.on('request', req => {
    if (!value && req.method() === 'POST' && req.headers()['next-action']) value = { url: req.url(), body: req.postData()!,
      headers: { 'next-action': req.headers()['next-action'], 'content-type': req.headers()['content-type'], origin } };
  });
  return () => value;
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native list/detail trash and restore, old-session denial, replay, preserved client and responsive UI', async ({ browser }) => {
  const row = await leadFixture(db, f.ownerId), ac = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), owner = await oc.newPage();
  await login(admin, f.emails.admin, true); await login(owner, f.emails.owner);
  await owner.goto('/leads/' + row.lead.id);
  await expect(owner.getByText(row.label, { exact: true }).first()).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Sposta nel cestino: ' + row.label, exact: true })).toHaveCount(0);
  await admin.goto('/leads');
  const cancelled = await openAction(admin, 'Sposta nel cestino', row.label);
  await cancelled.getByRole('button', { name: 'Annulla', exact: true }).click();
  await expect(admin.getByRole('dialog')).toHaveCount(0);
  expect(await db.auditLog.count({ where: { entityId: row.lead.id, event: 'lead_lifecycle_changed' } })).toBe(0);
  const getPost = capture(admin), form = await openAction(admin, 'Sposta nel cestino', row.label);
  await form.getByLabel('Motivo facoltativo').selectOption('DUPLICATE');
  await admin.screenshot({ path: path.join(evidence, 'lead-list-desktop.png'), fullPage: true });
  await form.getByRole('button', { name: 'Sposta nel cestino', exact: true }).click();
  await expect(admin).toHaveURL(/\/leads\/trash\?result=trashed$/);
  await expect(admin.getByRole('heading', { name: row.label, exact: true })).toBeVisible();
  for (const ctx of [ac, oc]) {
    for (const url of ['/leads', '/leads/inbox', '/search?q=' + encodeURIComponent(row.lead.email!), '/dashboard', '/notifications', '/commercial-offers']) {
      const response = await ctx.request.get(url); expect(response.status()).toBeLessThan(500);
      const html = await response.text(); expect(html).not.toContain(row.label); expect(html).not.toContain(row.offer.title);
    }
    const detail = await ctx.request.get('/leads/' + row.lead.id);
    expect(await detail.text()).not.toContain(row.label);
    expect((await ctx.request.get('/commercial-offers/' + row.offer.id + '/export/docx')).status()).toBe(404);
    expect((await ctx.request.get('/clients/' + row.client.id)).status()).toBe(200);
  }
  expect((await oc.request.get('/leads/trash')).status()).toBe(404);
  await admin.setViewportSize({ width: 390, height: 844 });
  const restore = await openAction(admin, 'Ripristina lead', row.label);
  await admin.screenshot({ path: path.join(evidence, 'lead-trash-mobile.png'), fullPage: true });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await restore.getByRole('button', { name: 'Ripristina lead', exact: true }).click();
  await expect(admin).toHaveURL(new RegExp('/leads/' + row.lead.id + '\\?result=restored$'));
  const stale = getPost()!; expect(stale).toBeTruthy();
  await ac.request.post(stale.url, { headers: stale.headers, data: stale.body });
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } })).deletedAt).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: row.lead.id, event: 'lead_lifecycle_changed' } })).toBe(2);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycle!.id } })).toEqual(row.cycle);
  await owner.reload(); await expect(owner.getByText(row.label, { exact: true }).first()).toBeVisible();
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'lead-detail-mobile.png'), fullPage: true });
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await admin.screenshot({ path: path.join(evidence, 'lead-restored-desktop.png'), fullPage: true });
  await ac.close(); await oc.close();
});
test('revocation with an open native form prevents a lifecycle write', async ({ browser }) => {
  const row = await leadFixture(db, f.ownerId), context = await browser.newContext(), page = await context.newPage();
  await login(page, f.emails.admin, true); await page.goto('/leads/' + row.lead.id);
  const form = await openAction(page, 'Sposta nel cestino', row.label);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await form.getByRole('button', { name: 'Sposta nel cestino', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } })).deletedAt).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: row.lead.id, event: 'lead_lifecycle_changed' } })).toBe(0);
  await context.close();
});
test('lost response has one persisted transition and no automatic retry; old command cannot repeat it', async ({ browser }) => {
  const row = await leadFixture(db, f.ownerId), context = await browser.newContext(), page = await context.newPage();
  await login(page, f.emails.admin, true); await page.goto('/leads/' + row.lead.id);
  const form = await openAction(page, 'Sposta nel cestino', row.label), getPost = capture(page);
  let forwarded = 0;
  let abortDone!: () => void, abortFailed!: (error: unknown) => void;
  const aborted = new Promise<void>((resolve, reject) => { abortDone = resolve; abortFailed = reject; });
  await page.route('**/leads/**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBeLessThan(500);
      await route.abort('failed');
      abortDone();
    } catch (error) { abortFailed(error); }
  });
  await form.getByRole('button', { name: 'Sposta nel cestino', exact: true }).click();
  await aborted;
  await expect.poll(async () => db.auditLog.count({ where: { entityId: row.lead.id, event: 'lead_lifecycle_changed' } })).toBe(1);
  await page.unroute('**/leads/**');
  await page.goto('/leads/trash');
  await expect(page.getByRole('heading', { name: row.label, exact: true })).toBeVisible();
  const stale = getPost()!; expect(stale).toBeTruthy();
  await context.request.post(stale.url, { headers: stale.headers, data: stale.body });
  expect(forwarded).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: row.lead.id, event: 'lead_lifecycle_changed' } })).toBe(1);
  await context.close();
});
