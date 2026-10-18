import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.SELECTIVE_LEAD_EVIDENCE!, password = process.env.SELECTIVE_LEAD_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: { leadId: string; label: string; readerId: string; readerEmail: string;
    privateNote: string; privateEmail: string; offerId: string; offerTitle: string; otherLeadId: string; otherLabel: string }[];
};
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function prepare(page: Page, row: typeof f.rows[number]) {
  await page.goto('/leads/' + row.leadId + '/sharing');
  await page.getByLabel('Persona esistente').selectOption(row.readerId);
  await page.getByLabel('Azienda', { exact: true }).check(); await page.getByLabel('Stato', { exact: true }).check();
  await page.getByRole('button', { name: 'Anteprima come destinatario' }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo e anteprima' })).toBeVisible();
  const preview = page.getByRole('region', { name: 'Riepilogo e anteprima', exact: true });
  await expect(preview).toContainText(row.label); await expect(preview).not.toContainText(row.privateNote);
  await expect(preview).not.toContainText(row.privateEmail);
  expect(await db.selectiveLeadGrant.count({ where: { leadId: row.leadId } })).toBe(0);
  await page.getByLabel('Confermo personalmente i campi, il destinatario e l’effetto sui permessi.').check();
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native two-field selection, direct/indirect denials, open-session revocation, desktop and mobile', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await reader.goto('/leads/' + row.leadId); await expect(reader.getByText(row.label, { exact: true }).first()).toBeVisible();
  await prepare(admin, row);
  await admin.screenshot({ path: path.join(evidence, 'selective-lead-preview-desktop.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'selective-lead-preview-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectiveLeadGrant.count({ where: { leadId: row.leadId } })).toBe(1);
  for (const url of ['/leads', '/leads/inbox', '/leads/' + row.leadId, '/leads/' + row.leadId + '/edit', '/search?q=' + encodeURIComponent(row.privateEmail), '/dashboard', '/notifications', '/commercial-offers', '/assignments', '/controlled-intakes', '/leads/duplicates']) {
    const response = await rc.request.get(url); expect(response.status()).toBeLessThan(500);
    const html = await response.text(); expect(html).not.toContain(row.label); expect(html).not.toContain(row.offerTitle);
    // Search echoes the caller's query in its input, even when no record is returned.
    if (!url.startsWith('/search?')) expect(html).not.toContain(row.privateEmail);
    else expect(html).not.toContain('href="/leads/' + row.leadId + '"');
  }
  expect((await rc.request.get('/commercial-offers/' + row.offerId + '/export/docx')).status()).toBe(404);
  expect(await (await rc.request.get('/leads/' + row.otherLeadId)).text()).toContain(row.otherLabel);
  expect((await rc.request.get('/leads/' + row.leadId + '/sharing')).status()).toBe(404);
  await reader.goto('/shared-leads/' + row.leadId);
  await expect(reader.getByText(row.label, { exact: true })).toBeVisible();
  expect(await reader.locator('dt').count()).toBe(2);
  expect(await reader.content()).not.toContain(row.privateNote); expect(await reader.content()).not.toContain(row.privateEmail);
  await reader.screenshot({ path: path.join(evidence, 'selective-lead-recipient-desktop.png'), fullPage: true });
  await reader.setViewportSize({ width: 390, height: 844 });
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: path.join(evidence, 'selective-lead-recipient-mobile.png'), fullPage: true });
  await admin.reload();
  await admin.getByLabel('Confermo la revoca. Le copie già acquisite non possono essere recuperate.').check();
  await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
  await expect.poll(async () => (await db.selectiveLeadGrant.findFirstOrThrow({ where: { leadId: row.leadId } })).revokedAt !== null).toBe(true);
  await reader.reload(); await expect(reader.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  expect(await reader.content()).not.toContain(row.label);
  expect(await (await rc.request.get('/leads/' + row.leadId)).text()).not.toContain(row.label);
  await ac.close(); await rc.close();
});
test('lost native response is reconciled from recorded command; no automatic second submission', async ({ browser }) => {
  const row = f.rows[1], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  let forwarded = 0, done!: () => void, failed!: (error: unknown) => void;
  const lost = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
  await page.route('**/leads/**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); }
    catch (error) { failed(error); }
  });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click(); await lost;
  expect(new URL(page.url()).searchParams.get('commandId')).toBeTruthy();
  await page.unroute('**/leads/**'); await page.reload();
  await expect(page.getByText('Operazione registrata: selezione, revisione 1. Lo stato corrente è riportato sotto.', { exact: true })).toBeVisible();
  expect(forwarded).toBe(1); expect(await db.selectiveLeadCommand.count({ where: { leadId: row.leadId } })).toBe(1);
  expect(await db.selectiveLeadRevision.count({ where: { grant: { leadId: row.leadId } } })).toBe(1);
  await context.close();
});
test('session revoked with an open native confirmation prevents a grant', async ({ browser }) => {
  const row = f.rows[2], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.selectiveLeadGrant.count({ where: { leadId: row.leadId } })).toBe(0);
  await context.close();
});
