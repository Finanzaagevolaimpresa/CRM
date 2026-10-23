import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { registrationFixture } from './fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
const db = new PrismaClient(), password = process.env.SERVICE_REGISTRATION_BROWSER_PASSWORD!;
let f: Awaited<ReturnType<typeof registrationFixture>>;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const keyDigest = privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!);
  const existing = await db.applicationKeyVersion.findUnique({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } } });
  if (existing) { expect(existing.status).toBe('ACTIVE'); expect(existing.keyDigest).toEqual(keyDigest); }
  else await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest } });
});
test.beforeEach(async () => { f = await registrationFixture(db, await bcrypt.hash(password, 4)); });
test.afterAll(() => db.$disconnect());
async function login(page: Page, email = f.admin.email) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function prepare(page: Page, payment = true) {
  await page.goto(`/clients/${f.client.id}/services/new`);
  await page.getByLabel('Servizio del catalogo', { exact: true }).selectOption(f.catalog.id);
  await page.getByLabel('Incarico firmato del cliente', { exact: true }).selectOption(f.contract.id);
  await page.getByLabel('Data di acquisto', { exact: true }).fill(f.command.purchasedOn);
  if (payment) await page.getByLabel('Rata incassata (facoltativa)', { exact: true }).selectOption(f.payment.id);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check();
}
async function screenshot(page: Page, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(process.env.SERVICE_REGISTRATION_EVIDENCE!, name + '.png'), fullPage: true });
}
test('contract creation captures the service scope without declaring a signature or creating a purchase', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto('/contracts');
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Crea contratto', exact: true }) });
  const number = `${f.tag}-ui`, scope = 'Verifica dei materiali e preparazione di un elaborato per revisione, come concordato nel contratto sintetico.';
  await form.locator('select[name="clientId"]').selectOption(f.client.id);
  await form.getByPlaceholder('Numero', { exact: true }).fill(number);
  await form.getByPlaceholder('Servizio', { exact: true }).fill(f.catalog.name);
  await form.getByLabel('Attività previste dall’incarico', { exact: true }).fill(scope);
  await form.getByPlaceholder('Imponibile', { exact: true }).fill('100');
  await form.getByPlaceholder('IVA', { exact: true }).fill('22');
  await form.getByPlaceholder('Totale', { exact: true }).fill('122');
  await screenshot(page, 'contract-scope-create');
  await form.getByRole('button', { name: 'Crea contratto', exact: true }).click();
  await expect(page.getByText(number, { exact: true })).toBeVisible();
  const contract = await db.contract.findFirstOrThrow({ where: { clientId: f.client.id, contractNumber: number } });
  expect(contract.serviceDescription).toBe(scope); expect(contract.signedAt).toBeNull(); expect(contract.signedDocumentId).toBeNull();
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
  await page.goto(`/contracts/${contract.id}`); await expect(page.getByText(scope, { exact: true })).toBeVisible();
});
test('desktop empty dossier to registration, exact preview and existing handoff page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto(`/clients/${f.client.id}`);
  await page.getByRole('link', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${f.client.id}/services/new$`));
  await prepare(page);
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
  await screenshot(page, 'desktop-preview');
  await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  await screenshot(page, 'desktop-result');
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(1);
  expect(await db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(0);
  await page.getByRole('link', { name: 'Passaggio al tecnico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Affida il servizio acquistato al tecnico', exact: true })).toBeVisible();
});
test('mobile registration without payment and explicit later payment link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page, false);
  await screenshot(page, 'mobile-preview');
  await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  const service = await db.clientService.findFirstOrThrow({ where: { clientId: f.client.id } }); expect(service.paymentId).toBeNull();
  await page.getByRole('link', { name: 'Apri servizio nel fascicolo', exact: true }).click();
  await page.locator(`#service-${service.id}`).getByRole('link', { name: 'Collega pagamento', exact: true }).click();
  await page.getByLabel('Rata incassata', { exact: true }).selectOption(f.payment.id);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check(); await screenshot(page, 'mobile-payment');
  await page.getByRole('button', { name: 'Collega pagamento', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pagamento collegato al servizio' })).toBeVisible();
  expect((await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).paymentId).toBe(f.payment.id);
});
async function loseCommittedResponse(page: Page, route: string, button: string) {
  let forwarded = 0, completed!: () => void, failed!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject; });
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'POST' && intercepted.request().headers()['next-action']) {
      forwarded++;
      try {
        const response = await intercepted.fetch(); expect(response.status()).toBeLessThan(400);
        await intercepted.abort('failed'); completed();
      } catch (error) { failed(error); }
    } else await intercepted.continue();
  });
  await page.getByRole('button', { name: button, exact: true }).click();
  // The recovery button appears as soon as the command is retained. Reload only
  // after the intercepted action completed and its response was actually lost.
  await finished; await page.unroute(route); expect(forwarded).toBe(1);
}

test('lost response survives reload and reconciliation never creates another service', async ({ page }) => {
  await login(page); await prepare(page);
  await loseCommittedResponse(page, `**/clients/${f.client.id}/services/new`, 'Registra servizio acquistato');
  await expect.poll(() => db.clientService.count({ where: { clientId: f.client.id } })).toBe(1);
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(1);
});
test('lost payment-link response survives reload into a read-only reconciliation page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page, false);
  await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servizio registrato nel fascicolo' })).toBeVisible();
  const service = await db.clientService.findFirstOrThrow({ where: { clientId: f.client.id } });
  await page.getByRole('link', { name: 'Apri servizio nel fascicolo', exact: true }).click();
  await page.locator(`#service-${service.id}`).getByRole('link', { name: 'Collega pagamento', exact: true }).click();
  await page.getByLabel('Rata incassata', { exact: true }).selectOption(f.payment.id);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima della registrazione' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await loseCommittedResponse(page, `**/clients/${f.client.id}/services/new?serviceId=${service.id}`, 'Collega pagamento');
  await expect.poll(async () => (await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).paymentId).toBe(f.payment.id);
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Registrazione servizio acquistato' })).toHaveCount(0);
  await screenshot(page, 'mobile-payment-recovery');
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pagamento collegato al servizio' })).toBeVisible();
  await screenshot(page, 'mobile-payment-reconciled');
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(1);
  expect((await db.clientService.findUniqueOrThrow({ where: { id: service.id } })).paymentId).toBe(f.payment.id);
  expect(await db.auditLog.count({ where: { event: 'client_service_registration_v1', entityId: service.id } })).toBe(2);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Registrazione servizio acquistato' })).toHaveCount(0);
  await expect(page.getByText('Il servizio non richiede più un collegamento da questa pagina.', { exact: false })).toBeVisible();
});
test('open preview permission revocation and direct technician URL are denied', async ({ page, browser }) => {
  await login(page); await prepare(page);
  await db.userPermissionOverride.create({ data: { userId: f.admin.id, permission: 'service.write', allowed: false } });
  await page.getByRole('button', { name: 'Registra servizio acquistato', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dati o permessi non più disponibili');
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3046' }), other = await context.newPage(); await login(other, f.tech.email);
  await other.goto(`/clients/${f.client.id}/services/new`);
  await expect(other.getByRole('form', { name: 'Registrazione servizio acquistato' })).toHaveCount(0);
  await context.close();
});
