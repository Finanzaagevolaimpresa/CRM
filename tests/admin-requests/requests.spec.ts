import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.ADMIN_REQUEST_EVIDENCE!, password = process.env.ADMIN_REQUEST_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; mailboxId: string; mailboxAddress: string;
  rows: Array<{ clientId: string; leadId: string; projectId: string; practiceId: string; otherProjectId: string; otherClientId: string;
    techA: { id: string; email: string }; techB: { id: string; email: string };
    salesA: { id: string; email: string }; salesB: { id: string; email: string }; excluded: string[] }> };
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function prepare(page: Page, kind: string, id: string, title: string) {
  await page.goto('/admin-requests/new?kind=' + kind + '&id=' + id);
  await page.getByLabel('Oggetto della richiesta', { exact: true }).fill(title);
  await page.getByLabel('Indicazioni interne', { exact: true }).fill('Indicazioni riservate al solo autore e all’Admin personale.');
  return page.locator('input[name="commandId"]').inputValue();
}
async function submit(page: Page) {
  await page.getByRole('button', { name: 'Invia richiesta interna all’Admin', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Operazione registrata nello storico. Nessuna email inviata.');
}
async function count(id: string) {
  const [r] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "AdminRequestEvent" WHERE "requestId"=${id}::uuid`;
  return r.n;
}
test.beforeAll(async () => { expect(f.synthetic).toBe(true); expect(process.env.CI).toBe('true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(() => db.$disconnect());

test('commercial request, internal clarification, explicit Admin draft and private desktop/mobile views', async ({ browser }) => {
  const r = f.rows[0], sales = await browser.newContext(), admin = await browser.newContext(), foreign = await browser.newContext();
  const page = await sales.newPage(), decision = await admin.newPage(), other = await foreign.newPage();
  await login(page, r.salesA.email); await login(decision, f.adminEmail); await login(other, r.salesB.email);
  const id = await prepare(page, 'Lead', r.leadId, 'Documento per il solo cliente assegnato');
  await submit(page); expect(await count(id)).toBe(1);
  expect((await foreign.request.get('/admin-requests/' + id)).status()).toBe(404);
  expect((await foreign.request.get('/admin-requests/new?kind=Lead&id=' + r.leadId)).status()).toBe(404);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(evidence, 'request-mobile.png'), fullPage: true, caret: 'initial' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await decision.goto('/admin-requests/' + id);
  await decision.getByLabel('Risposta visibile all’autore', { exact: true }).fill('Chiarisci il documento necessario prima della bozza.');
  await decision.getByRole('button', { name: 'Chiedi integrazione interna', exact: true }).click();
  await expect.poll(() => count(id)).toBe(2);
  await expect(decision.getByRole('status')).toHaveText('Operazione registrata nello storico. Nessuna email inviata.');
  await page.goto('/admin-requests/' + id); await expect(page.getByText('Chiarisci il documento necessario prima della bozza.', { exact: true })).toBeVisible();
  await page.getByLabel('Indicazioni interne', { exact: true }).fill('Occorre il documento tecnico aggiornato, senza dati economici.');
  await page.getByRole('button', { name: 'Salva integrazione interna', exact: true }).click(); await expect.poll(() => count(id)).toBe(3);
  await expect(page.getByRole('status')).toHaveText('Operazione registrata nello storico. Nessuna email inviata.');
  await decision.goto('/admin-requests/' + id);
  await expect(decision.locator('section').filter({ has: decision.getByRole('heading', { name: 'Indicazioni interne', exact: true }) }).locator('p')).toHaveText('Occorre il documento tecnico aggiornato, senza dati economici.');
  await decision.setViewportSize({ width: 1440, height: 1000 }); await decision.screenshot({ path: path.join(evidence, 'review-desktop.png'), fullPage: true, caret: 'initial' });
  await decision.getByRole('link', { name: 'Prepara bozza email da approvare', exact: true }).click();
  const form = decision.locator('form').filter({ has: decision.locator('input[name="adminRequestId"]') }).first();
  await expect(form.locator('input[name="to"]')).toHaveValue(''); await expect(form.locator('textarea[name="body"]')).toHaveValue('');
  await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  expect(await db.approvedCommunication.findUnique({ where: { id } })).toBeNull();
  await form.locator('select[name="mailboxId"]').selectOption(f.mailboxId);
  await form.getByLabel('Reply-To', { exact: true }).fill(f.mailboxAddress);
  await form.locator('input[name="to"]').fill('synthetic-recipient@invalid.test');
  await form.getByLabel('Oggetto', { exact: true }).fill('Documentazione necessaria');
  await form.getByLabel('Testo esatto', { exact: true }).fill('Testo personale verificato, ancora da approvare.');
  await decision.screenshot({ path: path.join(evidence, 'draft-desktop.png'), fullPage: true, caret: 'initial' });
  await form.getByRole('button', { name: 'Salva bozza', exact: true }).click();
  await expect.poll(() => count(id)).toBe(4);
  const saved = await db.approvedCommunication.findUniqueOrThrow({ where: { id } });
  expect(saved.state).toBe('DRAFT'); expect(saved.currentRevision).toBe(1);
  expect(await db.communicationApproval.count({ where: { version: { messageId: id } } })).toBe(0);
  expect(await db.communicationAttempt.count({ where: { messageId: id } })).toBe(0);
  await page.goto('/admin-requests/' + id); await expect(page.getByText('Bozza preparata, invio da decidere', { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain('synthetic-recipient@invalid.test');
  expect(await page.content()).not.toContain('Testo personale verificato');
  await expect(page.getByRole('link', { name: 'Apri bozza email collegata' })).toHaveCount(0);
  await sales.close(); await admin.close(); await foreign.close();
});

test('two explicitly assigned technicians keep separate requests; current revocation blocks an open form', async ({ browser }) => {
  const r = f.rows[1], a = await browser.newContext(), b = await browser.newContext(), admin = await browser.newContext();
  const pa = await a.newPage(), pb = await b.newPage(), review = await admin.newPage();
  await login(pa, r.techA.email); await login(pb, r.techB.email); await login(review, f.adminEmail);
  await pa.goto('/technical-work/practices/' + r.practiceId);
  await pa.getByRole('link', { name: 'Richiedi documento o integrazione all’Admin', exact: true }).click();
  await pa.getByLabel('Oggetto della richiesta').fill('Integrazione tecnico A');
  await pa.getByLabel('Indicazioni interne').fill('Documento pertinente alla pratica tecnica assegnata.');
  const first = await pa.locator('input[name="commandId"]').inputValue(); await submit(pa);
  const second = await prepare(pb, 'Project', r.projectId, 'Integrazione tecnico B'); await submit(pb);
  expect(first).not.toBe(second); expect((await a.request.get('/admin-requests/' + second)).status()).toBe(404);
  expect((await b.request.get('/admin-requests/' + first)).status()).toBe(404);
  expect((await a.request.get('/admin-requests/new?kind=Client&id=' + r.clientId)).status()).toBe(404);
  expect((await a.request.get('/admin-requests/new?kind=Project&id=' + r.otherProjectId)).status()).toBe(404);
  const pending = await prepare(pa, 'TechnicalPractice', r.practiceId, 'Richiesta con sessione aperta');
  await db.user.update({ where: { id: r.techA.id }, data: { active: false } });
  await pa.getByRole('button', { name: 'Invia richiesta interna all’Admin', exact: true }).click();
  await expect.poll(() => count(pending)).toBe(0);
  expect((await admin.request.get('/admin-requests/' + first)).status()).toBe(404);
  await review.goto('/admin-requests/' + second); await review.setViewportSize({ width: 390, height: 844 });
  await review.screenshot({ path: path.join(evidence, 'review-mobile.png'), fullPage: true, caret: 'initial' });
  expect(await review.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const value of r.excluded) expect(await review.content()).not.toContain(value);
  await a.close(); await b.close(); await admin.close();
});

test('lost response and double click recover one durable request without replaying it', async ({ page }) => {
  const r = f.rows[2]; await login(page, r.salesA.email);
  const id = await prepare(page, 'Client', r.clientId, 'Richiesta con risposta interrotta');
  let forwarded = 0, resolve!: () => void, reject!: (error: unknown) => void;
  const completed = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  await page.route('**/admin-requests**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    try { forwarded++; await route.fetch({ maxRedirects: 0 }); await route.abort('failed'); resolve(); }
    catch (error) { reject(error); }
  });
  await page.getByRole('button', { name: 'Invia richiesta interna all’Admin', exact: true }).dblclick({ noWaitAfter: true });
  await completed; expect(forwarded).toBe(1); await expect.poll(() => count(id)).toBe(1);
  await page.unrouteAll({ behavior: 'wait' }); await page.goto('/admin-requests?recover=' + id);
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Apri richiesta registrata', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Apri richiesta registrata', exact: true }).click(); expect(await count(id)).toBe(1);
  expect(await db.approvedCommunication.findUnique({ where: { id } })).toBeNull();
});

test('stale commercial owner form and invalid/foreign API identifiers cannot disclose or submit', async ({ page }) => {
  const r = f.rows[3]; await login(page, r.salesA.email);
  const id = await prepare(page, 'Client', r.clientId, 'Richiesta prima del cambio referente');
  await db.client.update({ where: { id: r.clientId }, data: { salesOwnerId: r.salesB.id } });
  await page.getByRole('button', { name: 'Invia richiesta interna all’Admin', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('perimetro non è più valido');
  expect(await count(id)).toBe(0);
  expect((await page.request.get('/api/admin-requests/outcome?commandId=not-a-uuid')).status()).toBe(404);
  expect((await page.request.get('/admin-requests/not-a-uuid')).status()).toBe(404);
  expect(await db.communicationAttempt.count()).toBe(0);
});
