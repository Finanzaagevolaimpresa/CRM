import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { collectionFixture, collectionKey } from './fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { getHandoffReceipt } from '../../src/lib/purchased-service-handoff';

const db = new PrismaClient(), password = process.env.PAYMENT_COLLECTION_BROWSER_PASSWORD!;
let f: Awaited<ReturnType<typeof collectionFixture>>;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(password.length).toBeGreaterThanOrEqual(24); await collectionKey(db);
});
test.beforeEach(async () => { f = await collectionFixture(db, await bcrypt.hash(password, 4)); });
test.afterAll(() => db.$disconnect());
async function login(page: Page, email = f.admin.email, proof = true) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (proof) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click(); await expect(page).toHaveURL(/status=active/);
  }
}
async function prepare(page: Page) {
  await page.goto(`/payments/${f.payment.id}/collection`);
  await expect(page.getByTestId('payment-collection-form')).toHaveAttribute('data-interactive-ready', 'true');
  const date = new Date(Date.now() - 120_000).toISOString().slice(0, 16);
  await page.getByLabel('Data e ora effettive dell’incasso', { exact: true }).fill(date);
  await page.getByLabel('Prova dell’incasso', { exact: true }).selectOption(f.command.documentVersionId);
  await expect(page.getByLabel('Data e ora effettive dell’incasso', { exact: true })).toHaveValue(date);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della conferma' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conferma incasso', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(process.env.PAYMENT_COLLECTION_EVIDENCE!, name + '.png'), fullPage: true });
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth, width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('main *')].map(element => {
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, classes: element.getAttribute('class'), left: box.left, right: box.right, width: box.width };
    }).filter(element => element.right > window.innerWidth || element.left < 0),
  }));
  await writeFile(path.join(process.env.PAYMENT_COLLECTION_EVIDENCE!, name + '-layout.json'), JSON.stringify(layout));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
}
async function unpaid() {
  const p = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  expect(p.status).toBe('da_incassare'); expect(p.collectedAt).toBeNull(); expect(p.accountingDocumentId).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(0);
}
test('desktop payment entry to exact collection preview; double click commits once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto('/payments'); await page.locator(`a[href="/payments/${f.payment.id}/collection"]`).click();
  await expect(page.getByRole('heading', { name: 'Conferma incasso', exact: true })).toBeVisible();
  await prepare(page); await unpaid(); await screenshot(page, 'desktop-preview');
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible(); await screenshot(page, 'desktop-result');
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
});
test('mobile service registration, actual collection, explicit linking and technical handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await page.goto(`/clients/${f.client.id}/services/new`);
  await page.getByLabel('Servizio del catalogo', { exact: true }).selectOption(f.catalog.id);
  await page.getByLabel('Incarico firmato del cliente', { exact: true }).selectOption(f.contract.id);
  await page.getByLabel('Data di acquisto', { exact: true }).fill(f.registrationCommand.purchasedOn);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  const service = await db.clientService.findFirstOrThrow({ where: { clientId: f.client.id } }); expect(service.paymentId).toBeNull();
  await prepare(page); await screenshot(page, 'mobile-preview');
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible(); await screenshot(page, 'mobile-result');
  expect((await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).paymentId).toBeNull();
  await page.getByRole('link', { name: 'Apri servizi acquistati', exact: true }).click();
  await page.locator(`#service-${service.id}`).getByRole('link', { name: 'Collega pagamento', exact: true }).click();
  await page.getByLabel('Rata incassata', { exact: true }).selectOption(f.payment.id);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Collega pagamento', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pagamento collegato al servizio' })).toBeVisible();
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(0);
  await page.goto(`/services/${service.id}/handoff?q=${encodeURIComponent(f.tag)}`);
  const form = page.getByRole('form', { name: 'Passaggio al tecnico', exact: true });
  await form.getByLabel('Variante prevista dall’incarico', { exact: true }).fill(f.input.variantCode);
  await form.getByLabel('Reparto tecnico', { exact: true }).fill(f.input.departmentCode);
  await form.getByLabel('Referente tecnico', { exact: true }).selectOption(f.tech.id);
  await form.getByLabel('Scadenza delle attività', { exact: true }).fill('2027-01-15');
  await form.getByLabel('Attività incluse, una per riga', { exact: true }).fill(f.input.activities.join('\n'));
  await form.getByLabel('Motivazione', { exact: true }).fill(f.input.reason); await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Affida il servizio al tecnico', exact: true }).click();
  await expect.poll(async () => Boolean(await getHandoffReceipt(db, service.id))).toBe(true);
  await page.goto(`/services/${service.id}/handoff`);
  await expect(page.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toBeVisible();
  await screenshot(page, 'mobile-handoff');
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(1);
  expect(await db.payment.count({ where: { clientId: f.client.id } })).toBe(1);
});
test('lost response and reload reconcile the collected payment without another write', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page);
  const route = `**/payments/${f.payment.id}/collection`;
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'POST' && intercepted.request().headers()['next-action']) {
      await intercepted.fetch(); await intercepted.abort('failed'); await page.unroute(route);
    } else await intercepted.continue();
  });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0);
  await screenshot(page, 'mobile-reconciliation');
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toHaveCount(0);
});
test('permission revocation after preview and direct technician URL deny collection', async ({ page, browser }) => {
  await login(page); await prepare(page);
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'payment.write', allowed: false } });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dati o autorizzazioni cambiati'); await unpaid();
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3047' }), other = await context.newPage();
  await login(other, f.tech.email, false); await other.goto(`/payments/${f.payment.id}/collection`);
  await expect(other.getByRole('form', { name: 'Conferma incasso', exact: true })).toHaveCount(0); await context.close();
});
test('new proof version after preview is rejected with no financial update', async ({ page }) => {
  await login(page); await prepare(page);
  await db.documentVersion.create({ data: { documentId: f.documents[1].id, version: 2, storagePath: f.documents[1].storagePath, checksum: f.documents[1].checksum } });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('La prova non è disponibile'); await unpaid();
});
test('missing personal step-up preserves the exact collection preview and resumes once after confirmation', async ({ page }) => {
  await login(page, f.admin.email, false); await prepare(page);
  const date = await page.getByLabel('Data e ora effettive dell’incasso', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma identità senza lasciare il lavoro', exact: true })).toBeVisible(); await unpaid();
  await expect(page.getByLabel('Data e ora effettive dell’incasso', { exact: true })).toHaveValue(date);
  await expect(page.getByLabel('Prova dell’incasso', { exact: true })).toHaveValue(f.command.documentVersionId);
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(page.getByText('Identità confermata. Le scelte sono conservate; scegli personalmente quando proseguire.', { exact: true })).toBeVisible(); await unpaid();
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso registrato', exact: true })).toBeVisible();
  expect(await db.auditLog.count({ where: { entityId: f.payment.id, event: 'payment_collection_v1' } })).toBe(1);
});
test('unavailable session storage prevents an unrecoverable submission', async ({ page }) => {
  await login(page); await prepare(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('fai-payment-collection:')) throw new Error('Synthetic blocked session storage'); original.call(this, key, value); };
  });
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) posts++; });
  await page.getByRole('button', { name: 'Conferma incasso', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Nessuna conferma è stata inviata'); expect(posts).toBe(0); await unpaid();
});
