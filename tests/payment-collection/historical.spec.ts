import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { collectionFixture, collectionKey } from './fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { historicalPaymentModel } from '../../src/lib/payment-historical-attestation-contract';
const db = new PrismaClient(), password = process.env.PAYMENT_COLLECTION_BROWSER_PASSWORD!;
let f: Awaited<ReturnType<typeof collectionFixture>>;
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(password.length).toBeGreaterThanOrEqual(24); await collectionKey(db); });
test.beforeEach(async () => {
  f = await collectionFixture(db, await bcrypt.hash(password, 4));
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'da_preparare', signedAt: null, signedDocumentId: null } });
});
test.afterAll(() => db.$disconnect());
async function login(page: Page, email = f.admin.email, proof = true) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (proof) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per 30 minuti', exact: true }).click();
    await expect(page).toHaveURL(/status=active/);
  }
}
const url = () => `/payments/${f.payment.id}/historical-attestation`;
async function prepare(page: Page, navigate = true) {
  if (navigate) await page.goto(url());
  await expect(page.getByTestId('historical-payment-form')).toHaveAttribute('data-interactive-ready', 'true');
  await page.getByLabel('Giorno effettivo dell’incasso', { exact: true }).fill('2026-01-15');
  await page.getByLabel('Giorno dell’attestazione del titolare', { exact: true }).fill('2026-01-20');
  await page.getByLabel('Titolare dichiarante', { exact: true }).fill('Titolare sintetico');
  await page.getByLabel('Provenienza dell’attestazione', { exact: true }).fill('Ordine sintetico nel canale amministrativo autorizzato');
  await page.getByLabel('Motivazione della rettifica', { exact: true }).fill('Riconciliazione storica sintetica senza prova bancaria verificata');
  await page.getByRole('button', { name: 'Controlla rettifica storica', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della rettifica' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registra incasso storico' })).toBeDisabled();
  await page.getByRole('checkbox').check();
}
async function zero() {
  expect(await db.adminRecordRevision.count({ where: { model: historicalPaymentModel, recordId: f.payment.id } })).toBe(0);
  expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe('da_incassare');
}
async function recorded() {
  const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  expect(payment.status).toBe('incassato'); expect(payment.collectedAt?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  expect(payment.accountingDocumentId).toBeNull(); expect(payment.method).toBeNull(); expect(payment.totalAmount.toFixed(2)).toBe('61.00');
  expect(await db.adminRecordRevision.count({ where: { model: historicalPaymentModel, recordId: payment.id } })).toBe(1);
}
test('Admin records an unsigned historical day on mobile and reopens consistent register and dossier without a second save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const contract = await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  await page.goto(`/payments/${f.payment.id}/collection`);
  await expect(page.getByRole('status')).toContainText('da preparare');
  await page.getByRole('link', { name: 'Rettifica storica · attestazione Admin', exact: true }).click();
  await prepare(page, false); await zero();
  await page.getByRole('button', { name: 'Registra incasso storico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('15/01/2026 · precisione solo giorno');
  await expect(page.getByRole('status')).toContainText('Non dichiarati');
  await recorded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('link', { name: 'Apri pagamenti e verifica lo stato' }).click();
  const row = page.getByRole('row').filter({ hasText: f.client.displayName });
  await expect(row).toContainText('incassato'); await expect(row).toContainText('15/01/2026 · solo giorno');
  await expect(row).not.toContainText('00:00'); await expect(row).not.toContainText('01:00');
  await row.getByRole('link', { name: 'Apri attestazione storica' }).click();
  await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible();
  await page.getByRole('link', { name: 'Apri pagamenti del fascicolo' }).click();
  await expect(page.locator('#pagamenti')).toContainText('incassato');
  await expect(page.locator('#pagamenti')).toContainText('15/01/2026 · solo giorno · attestazione Admin');
  await recorded(); expect(await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).toEqual(contract);
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
  expect(await db.payment.count({ where: { clientId: f.client.id } })).toBe(1);
});
test('Admin discovers the separate historical path from list and editor without changing the ordinary collection guard', async ({ page }) => {
  await login(page); await page.goto('/payments');
  const row = page.getByRole('row').filter({ hasText: f.client.displayName });
  await expect(row.getByRole('link', { name: 'Rettifica storica · attestazione Admin' })).toHaveAttribute('href', url());
  await page.goto(`/admin/records/Payment/${f.payment.id}`);
  await expect(page.getByRole('link', { name: 'Rettifica storica · attestazione Admin' })).toHaveAttribute('href', url());
  await page.goto(`/payments/${f.payment.id}/collection`);
  await expect(page.getByRole('status')).toContainText('da preparare');
  await expect(page.getByRole('form', { name: 'Conferma incasso' })).toHaveCount(0); await zero();
});
test('lost historical confirmation response is reconciled through the same command without duplicate registration', async ({ page }) => {
  await login(page); await prepare(page);
  const route = `**/payments/${f.payment.id}/historical-attestation`;
  let attempts = 0;
  await page.route(route, async request => {
    if (request.request().method() !== 'POST') return request.continue();
    attempts++; await request.fetch(); await request.abort('failed');
  });
  await page.getByRole('button', { name: 'Registra incasso storico' }).click();
  await expect(page.getByRole('button', { name: 'Verifica esito' })).toBeVisible();
  // The saved command exposes verification immediately, while it remains
  // disabled until the original POST has settled. Observe that actual boundary
  // before querying persistence or removing the response-loss route.
  await expect(page.getByRole('button', { name: 'Verifica esito' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('La risposta non è arrivata');
  await recorded(); expect(attempts).toBe(1); await page.unroute(route);
  await page.getByRole('button', { name: 'Verifica esito' }).click();
  await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible();
  await recorded();
});
test('inline privileged reconfirmation preserves the historical draft and permits one certain continuation', async ({ page }) => {
  await login(page, f.admin.email, false); await prepare(page);
  await page.getByRole('button', { name: 'Registra incasso storico' }).click();
  await expect(page.getByLabel('Password corrente', { exact: true })).toBeVisible(); await zero();
  await expect(page.getByLabel('Giorno effettivo dell’incasso', { exact: true })).toHaveValue('2026-01-15');
  await expect(page.getByRole('textbox', { name: 'Motivazione della rettifica', exact: true })).toHaveValue('Riconciliazione storica sintetica senza prova bancaria verificata');
  await expect(page.getByRole('textbox', { name: 'Provenienza dell’attestazione', exact: true })).toHaveValue('Ordine sintetico nel canale amministrativo autorizzato');
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Riconferma identità se la finestra è scaduta', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Registra incasso storico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible(); await recorded();
});
test('technical and commercial profiles cannot open the new financial route or its source', async ({ page, browser }) => {
  await login(page); await prepare(page); await page.getByRole('button', { name: 'Registra incasso storico' }).click();
  await expect(page.getByRole('heading', { name: 'Incasso storico registrato su attestazione Admin' })).toBeVisible();
  for (const role of ['consulente','commerciale'] as const) {
    const user = role === 'consulente' ? f.tech : await db.user.create({ data: { name: 'Commerciale sintetico', role, email: `history-${f.tag}@example.test`.toLowerCase(), passwordHash: await bcrypt.hash(password, 4) } });
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3047' }), other = await context.newPage();
    await login(other, user.email, false); await other.goto(url());
    await expect(other.getByText('404', { exact: true })).toBeVisible();
    await expect(other.getByText('Titolare sintetico', { exact: false })).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'Registra incasso storico' })).toHaveCount(0);
    await context.close();
  }
  await recorded();
});
test('unavailable command storage prevents historical submission instead of creating an uncertain blind retry', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('fai-historical-payment:')) throw new Error('Synthetic storage failure'); return original.call(this, key, value); };
  });
  await login(page); await prepare(page); await page.getByRole('button', { name: 'Registra incasso storico' }).click();
  await expect(page.getByRole('status')).toContainText('nessuna rettifica è stata inviata'); await zero();
});
