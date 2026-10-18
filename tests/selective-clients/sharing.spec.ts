import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.SELECTIVE_CLIENT_EVIDENCE!, password = process.env.SELECTIVE_CLIENT_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: { clientId: string; label: string; readerId: string; readerEmail: string;
    privateNote: string; companyId: string; companyName: string; projectId: string; projectTitle: string; leadId: string; otherClientId: string; otherLabel: string }[];
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
  await page.goto('/clients/' + row.clientId + '/sharing');
  await page.getByLabel('Persona esistente').selectOption(row.readerId);
  await page.getByLabel('Denominazione', { exact: true }).check(); await page.getByLabel('Stato', { exact: true }).check();
  await page.getByRole('button', { name: 'Anteprima come destinatario' }).click();
  const preview = page.getByRole('region', { name: 'Riepilogo e anteprima', exact: true });
  await expect(preview).toBeVisible(); await expect(preview).toContainText(row.label);
  await expect(preview).not.toContainText(row.privateNote); await expect(preview).not.toContainText(row.companyName);
  expect(await db.selectiveClientGrant.count({ where: { clientId: row.clientId } })).toBe(0);
  await page.getByLabel('Confermo personalmente i campi, il destinatario e l’effetto sui permessi.').check();
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native selected client fields, indirect denials, open-session revocation and responsive UI', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await reader.goto('/clients/' + row.clientId); await expect(reader.getByText(row.label, { exact: true }).first()).toBeVisible();
  await prepare(admin, row);
  await admin.screenshot({ path: path.join(evidence, 'selective-client-preview-desktop.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'selective-client-preview-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectiveClientGrant.count({ where: { clientId: row.clientId } })).toBe(1);
  const urls = ['/clients', '/clients/' + row.clientId, '/companies/' + row.companyId,
    '/projects', '/projects/' + row.projectId, '/leads', '/leads/' + row.leadId, '/dashboard',
    '/notifications', '/assignments', '/documents', '/commercial-offers', '/contracts',
    '/practice-readiness', '/technical-office/practices', '/communications', '/search?q=' + encodeURIComponent(row.label)];
  for (const url of urls) {
    const response = await rc.request.get(url); expect(response.status(), url).toBeLessThan(500);
    const html = await response.text();
    if (!url.startsWith('/search?')) expect(html, url).not.toContain(row.label);
    else expect(html).not.toContain('href="/clients/' + row.clientId + '"');
    expect(html, url).not.toContain(row.privateNote); expect(html, url).not.toContain(row.companyName);
    expect(html, url).not.toContain(row.projectTitle);
  }
  expect(await (await rc.request.get('/clients/' + row.otherClientId)).text()).toContain(row.otherLabel);
  expect((await rc.request.get('/clients/' + row.clientId + '/sharing')).status()).toBe(404);
  await reader.goto('/shared-clients/' + row.clientId); await expect(reader.getByText(row.label, { exact: true })).toBeVisible();
  expect(await reader.locator('dt').count()).toBe(2);
  expect(await reader.content()).not.toContain(row.privateNote); expect(await reader.content()).not.toContain(row.companyName);
  await reader.screenshot({ path: path.join(evidence, 'selective-client-recipient-desktop.png'), fullPage: true });
  await reader.setViewportSize({ width: 390, height: 844 });
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: path.join(evidence, 'selective-client-recipient-mobile.png'), fullPage: true });
  await admin.reload(); await admin.getByLabel('Confermo la revoca. Le copie già acquisite non possono essere recuperate.').check();
  await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
  await expect.poll(async () => (await db.selectiveClientGrant.findFirstOrThrow({ where: { clientId: row.clientId } })).revokedAt !== null).toBe(true);
  await reader.reload(); await expect(reader.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  expect(await reader.content()).not.toContain(row.label);
  expect(await (await rc.request.get('/clients/' + row.clientId)).text()).not.toContain(row.label);
  await ac.close(); await rc.close();
});
test('lost native response reconciles the recorded command without automatic resubmission', async ({ browser }) => {
  const row = f.rows[1], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  let forwarded = 0, done!: () => void, failed!: (error: unknown) => void;
  const lost = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
  await page.route('**/clients/**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); }
    catch (error) { failed(error); }
  });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click(); await lost;
  expect(new URL(page.url()).searchParams.get('commandId')).toBeTruthy();
  await page.unroute('**/clients/**'); await page.reload();
  await expect(page.getByText('Operazione registrata: selezione, revisione 1. Lo stato corrente è riportato sotto.', { exact: true })).toBeVisible();
  expect(forwarded).toBe(1); expect(await db.selectiveClientCommand.count({ where: { clientId: row.clientId } })).toBe(1);
  expect(await db.selectiveClientRevision.count({ where: { grant: { clientId: row.clientId } } })).toBe(1);
  await context.close();
});
test('revoked session with an open native confirmation cannot create a client grant', async ({ browser }) => {
  const row = f.rows[2], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.selectiveClientGrant.count({ where: { clientId: row.clientId } })).toBe(0);
  await context.close();
});
