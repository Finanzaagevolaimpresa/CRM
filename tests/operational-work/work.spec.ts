import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { syntheticSession } from '../selective-sharing/fixtures';
import { revokeTechnical } from '../technical-assignments/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.OPERATIONAL_EVIDENCE!;
type Person = { id: string; email: string };
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; admin: Person; techA: Person; techB: Person; salesA: Person; salesB: Person;
  ordinary: { clientId: string; projectId: string; practiceId: string; documentId: string };
  selective: { clientId: string; projectId: string; practiceId: string; hiddenId: string; fileId: string; deniedDocumentId: string; financialDocumentId: string };
  otherPracticeId: string;
};
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(process.env.TECHNICAL_BROWSER_PASSWORD!);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function screen(page: Page, name: string) {
  // Use the supported reduced-motion preference, without changing DOM/styles.
  // A captured counter must show the exact accessible value, not a tween frame.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const counter of await page.locator('[data-counter-final]').all()) {
      const value = Number(await counter.getAttribute('data-counter-final')).toLocaleString('it-IT');
      await expect(counter.locator('[data-display-value]')).toHaveAttribute('data-display-value', value);
      await expect(counter.locator('[data-display-value]')).toHaveAttribute('data-phase', 'settled');
    }
    await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`), fullPage: true, caret: 'initial' });
  }
}
test.beforeAll(async () => { assert(f.synthetic); assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => { await db.$disconnect(); });
test('five views combine ordinary and limited work once with correct routes and masked states', async ({ page }) => {
  await login(page, f.techA.email);
  await expect(page.getByText('3 ulteriori pratiche autorizzate')).toHaveCount(0);
  await expect(page.getByText('1 ulteriori pratiche autorizzate non contribuiscono ai contatori per stato.')).toBeVisible();
  expect(await page.content()).not.toContain('TITOLO_ESCLUSO_R04');
  const activeCounter = page.locator('[data-kpi="pratiche"] [data-counter-final]');
  await expect(activeCounter).toHaveAttribute('data-counter-final', '2');
  await expect(activeCounter.locator('[data-display-value]')).toHaveAttribute('data-display-value', '2');
  await expect(activeCounter.locator('[data-display-value]')).toHaveAttribute('data-phase', 'settled');
  await screen(page, 'technical-dashboard');
  for (const url of ['/technical-office/practices', '/technical-work?kind=TechnicalPractice']) {
    await page.goto(url); await expect(page.locator('[data-operational-record]')).toHaveCount(3);
    await expect(page.locator(`[data-operational-record="${f.ordinary.practiceId}"] a`)).toHaveAttribute('href', '/technical-office/practices/' + f.ordinary.practiceId);
    await expect(page.locator(`[data-operational-record="${f.selective.practiceId}"] a`)).toHaveAttribute('href', '/technical-work/practices/' + f.selective.practiceId);
    expect(await page.content()).not.toContain('TITOLO_ESCLUSO_R04');
    await expect(page.locator(`[data-operational-record="${f.ordinary.practiceId}"]`))
      .toContainText('Scadenza operativa: 26/11/26, 18:00 · Europe/Rome');
  }
  await screen(page, 'mixed-practices');
  await page.goto('/technical-office/practices?status=da_progettare'); await expect(page.locator('[data-operational-record]')).toHaveCount(2);
  await page.goto('/technical-office/practices?status=in_istruttoria'); await expect(page.locator('[data-operational-record]')).toHaveCount(0);
  await page.goto('/technical-office/practices?dashboard=attive'); await expect(page.locator('[data-operational-record]')).toHaveCount(2);
  await page.goto('/technical-office/practices?q=TITOLO_ESCLUSO_R04'); await expect(page.locator('[data-operational-record]')).toHaveCount(0);
  await page.goto('/projects'); await expect(page.locator('[data-operational-record]')).toHaveCount(2);
  await screen(page, 'mixed-projects');
  await page.goto('/technical-office');
  await page.getByRole('link', { name: /Pratiche da progettare/ }).click();
  await expect(page).toHaveURL(/status=da_progettare/); await expect(page.locator('[data-operational-record]')).toHaveCount(2);
});
test('ordinary and exact selective documents remain usable while unselected and financial bytes are denied', async ({ page }) => {
  await login(page, f.techA.email);
  await page.goto('/technical-office/practices/' + f.ordinary.practiceId);
  await expect(page.getByText('Documento ordinario R04', { exact: true })).toBeVisible();
  const ordinaryPreview = page.locator(`a[href="/documents/${f.ordinary.documentId}/view"]`);
  await expect(ordinaryPreview).toHaveText('Visualizza');
  await expect(page.locator(`a[href="/documents/${f.ordinary.documentId}/download"]`)).toHaveText('Scarica');
  const popupPromise = page.waitForEvent('popup'); await ordinaryPreview.click();
  const popup = await popupPromise;
  await expect(popup.getByText('DOCUMENTO_ORDINARIO_R04', { exact: true })).toBeVisible();
  await popup.close();
  const ordinary = await page.request.get('/documents/' + f.ordinary.documentId + '/view');
  expect(ordinary.status()).toBe(200); expect(await ordinary.text()).toBe('DOCUMENTO_ORDINARIO_R04');
  const download = await page.request.get('/documents/' + f.ordinary.documentId + '/download');
  expect(download.status()).toBe(200); expect(await download.text()).toBe('DOCUMENTO_ORDINARIO_R04');
  expect(download.headers()['content-disposition']).toMatch(/^attachment/);
  await screen(page, 'ordinary-document-actions');
  await page.goto('/technical-work?kind=TechnicalPractice');
  const expiryText = await page.locator(`[data-operational-record="${f.selective.practiceId}"]`)
    .getByText('Scadenza dell’accesso:', { exact: false }).innerText();
  await page.goto('/technical-work/practices/' + f.selective.practiceId);
  await expect(page.getByText('scadenza dell’accesso', { exact: false }))
    .toContainText(expiryText.replace('Scadenza dell’accesso: ', ''));
  const link = page.locator(`a[href*="${f.selective.fileId}"]`).filter({ hasText: 'Visualizza' });
  await expect(link).toBeVisible();
  const url = await link.getAttribute('href'); assert(url);
  expect((await page.request.get(url)).status()).toBe(200);
  expect([403, 404]).toContain((await page.request.get(url + '?download=1')).status());
  expect(await page.content()).not.toContain(f.selective.financialDocumentId);
  for (const id of [f.selective.deniedDocumentId, f.selective.financialDocumentId]) {
    expect([403, 404]).toContain((await page.request.get('/documents/' + id + '/download')).status());
    expect([403, 404]).toContain((await page.request.get('/documents/' + id + '/view')).status());
  }
  await screen(page, 'limited-document-actions');
});
test('second technician and two commercial actors keep their own records and administrative pages are unchanged', async ({ browser }) => {
  for (const [person, denied] of [[f.techB, f.selective.practiceId], [f.salesB, f.ordinary.practiceId]] as const) {
    const page = await browser.newPage(); await login(page, person.email);
    await page.goto('/technical-office/practices/' + denied);
    await expect(page.getByRole('heading', { name: 'Pratica non accessibile' })).toBeVisible();
    await page.goto('/technical-work/practices/' + denied);
    expect(await page.content()).not.toContain('Pratica tecnica multipla sintetica');
    await page.close();
  }
  const sales = await browser.newPage(); await login(sales, f.salesA.email); await sales.goto('/progress');
  await expect(sales.getByText('Cliente ordinario R04', { exact: false }).first()).toBeVisible();
  await expect(sales.locator(`[data-commercial-progress="${f.ordinary.practiceId}"]`))
    .toContainText('Scadenza operativa: 26/11/26, 18:00 · Europe/Rome');
  expect(await sales.content()).not.toContain('Cliente commerciale B sintetico');
  await screen(sales, 'commercial-progress'); await sales.close();
  const admin = await browser.newPage(); await login(admin, f.admin.email); await admin.goto('/technical-office/practices');
  await expect(admin.getByRole('link', { name: 'Pratica ordinaria R04', exact: true })).toBeVisible();
  await expect(admin.getByRole('link', { name: 'Pratica tecnica multipla sintetica', exact: true })).toBeVisible();
  await expect(admin.getByRole('row').filter({ has: admin.getByRole('link', { name: 'Pratica ordinaria R04', exact: true }) }))
    .toContainText('26/11/26, 18:00 · Europe/Rome');
  expect((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.ordinary.practiceId } })).dueDate?.toISOString())
    .toBe('2026-11-26T17:00:00.000Z');
  await screen(admin, 'admin-practices'); await admin.close();
});
test('revocation with an open browser removes the selected record from every view and document endpoint', async ({ page }) => {
  await login(page, f.techA.email); await page.goto('/technical-work/practices/' + f.selective.practiceId);
  const href = await page.locator(`a[href*="${f.selective.fileId}"]`).filter({ hasText: 'Visualizza' }).getAttribute('href'); assert(href);
  const adminUser = await db.user.findUniqueOrThrow({ where: { id: f.admin.id } });
  const techUser = await db.user.findUniqueOrThrow({ where: { id: f.techA.id } });
  const admin = { user: adminUser, ...await syntheticSession(db, adminUser) };
  const tech = { user: techUser, ...await syntheticSession(db, techUser) };
  await revokeTechnical(db, admin, { kind: 'TechnicalPractice', targetId: f.selective.practiceId }, tech);
  for (const url of ['/technical-office/practices', '/technical-work?kind=TechnicalPractice', '/technical-office/practices?status=da_progettare']) {
    await page.goto(url); await expect(page.locator(`[data-operational-record="${f.selective.practiceId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-operational-record="${f.ordinary.practiceId}"]`)).toHaveCount(1);
  }
  expect([403, 404]).toContain((await page.request.get(href)).status());
  await page.goto('/technical-office/practices/' + f.selective.practiceId);
  await expect(page.getByRole('heading', { name: 'Pratica non accessibile' })).toBeVisible();
  await page.goto('/technical-office/practices'); await screen(page, 'after-revocation');
});
