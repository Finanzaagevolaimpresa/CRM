import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { activitiesFixture } from './fixture';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), password = process.env.CONTRACT_ACTIVITIES_BROWSER_PASSWORD!;
let f: Awaited<ReturnType<typeof activitiesFixture>>;
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(password.length).toBeGreaterThanOrEqual(24); });
test.beforeEach(async () => { f = await activitiesFixture(db, await bcrypt.hash(password, 4)); });
test.afterAll(() => db.$disconnect());
async function login(page: Page, email = f.person.user.email) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function prepare(page: Page) {
  await page.goto(`/contracts/${f.contract.id}/activities`);
  await expect(page.getByTestId('contract-activities-form')).toHaveAttribute('data-interactive-ready', 'true');
  await page.getByRole('textbox', { name: 'Attività previste dall’incarico', exact: true }).fill(f.command.activities);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo prima del salvataggio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salva attività nel contratto', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(process.env.CONTRACT_ACTIVITIES_EVIDENCE!, name + '.png'), fullPage: true });
  const layout = await page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth }));
  await writeFile(path.join(process.env.CONTRACT_ACTIVITIES_EVIDENCE!, name + '-layout.json'), JSON.stringify(layout));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
}
async function unchanged() {
  expect((await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).serviceDescription).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: f.contract.id, event: 'contract_activities_completed_v1' } })).toBe(0);
}
test('desktop existing contract entry, text amendment and exact confirmation without duplicates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
  await page.goto(`/contracts/${f.contract.id}`);
  await page.getByRole('link', { name: 'Completa attività dell’incarico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attività previste dall’incarico', exact: true })).toBeVisible();
  await prepare(page); await unchanged();
  await page.getByRole('textbox', { name: 'Attività previste dall’incarico', exact: true }).fill(f.command.activities + '\nUna terza attività concordata.');
  await expect(page.getByRole('button', { name: 'Salva attività nel contratto', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Controlla riepilogo', exact: true }).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked(); await page.getByRole('checkbox').check();
  await screenshot(page, 'desktop-preview');
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: 'Attività salvate nel contratto', exact: true })).toBeVisible();
  await screenshot(page, 'desktop-result');
  await page.getByRole('link', { name: 'Torna al contratto', exact: true }).click();
  await expect(page.getByText('Una terza attività concordata.', { exact: false })).toBeVisible();
  expect(await db.contract.count({ where: { clientId: f.client.id } })).toBe(1);
  expect(await db.payment.count({ where: { clientId: f.client.id } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: f.contract.id, event: 'contract_activities_completed_v1' } })).toBe(1);
  const contract = await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  expect(contract.status).toBe('da_preparare'); expect(contract.signedAt).toBeNull(); expect(contract.signedDocumentId).toBeNull();
});
test('mobile completion retains the recorded signature and needs no new contract or service', async ({ page }) => {
  await db.contract.update({ where: { id: f.contract.id }, data: { status: 'firmato', signedAt: new Date('2020-01-01') } });
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page); await screenshot(page, 'mobile-preview');
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attività salvate nel contratto', exact: true })).toBeVisible(); await screenshot(page, 'mobile-result');
  const contract = await db.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  expect(contract.signedAt?.toISOString()).toBe('2020-01-01T00:00:00.000Z'); expect(contract.status).toBe('firmato');
  expect(await db.clientService.count({ where: { clientId: f.client.id } })).toBe(0);
});
test('lost response and reload reconcile the original save without writing again', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await prepare(page);
  const route = `**/contracts/${f.contract.id}/activities`;
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'POST' && intercepted.request().headers()['next-action']) {
      await intercepted.fetch(); await intercepted.abort('failed'); await page.unroute(route);
    } else await intercepted.continue();
  });
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Completa attività dell’incarico', exact: true })).toHaveCount(0);
  await screenshot(page, 'mobile-reconciliation');
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attività salvate nel contratto', exact: true })).toBeVisible();
  expect(await db.auditLog.count({ where: { entityId: f.contract.id, event: 'contract_activities_completed_v1' } })).toBe(1);
});
test('permission revocation after preview and direct technician URL deny completion', async ({ page, browser }) => {
  await login(page); await prepare(page);
  await db.userPermissionOverride.create({ data: { userId: f.person.user.id, permission: 'contract.write', allowed: false } });
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dati o autorizzazioni cambiati'); await unchanged();
  const tech = await syntheticPerson(db, 'Tecnico sintetico', 'consulente', await bcrypt.hash(password, 4));
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3048' }), other = await context.newPage();
  await login(other, tech.user.email); await other.goto(`/contracts/${f.contract.id}/activities`);
  await expect(other.getByRole('form', { name: 'Completa attività dell’incarico', exact: true })).toHaveCount(0); await context.close();
});
test('a changed contract invalidates an open preview without overwriting activities', async ({ page }) => {
  await login(page); await prepare(page);
  await db.contract.update({ where: { id: f.contract.id }, data: { serviceName: 'Servizio sintetico aggiornato' } });
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dati o autorizzazioni cambiati'); await unchanged();
});
test('unavailable session storage prevents an unrecoverable submission', async ({ page }) => {
  await login(page); await prepare(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('fai-contract-activities:')) throw new Error('Synthetic blocked storage'); original.call(this, key, value); };
  });
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) posts++; });
  await page.getByRole('button', { name: 'Salva attività nel contratto', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Nessun salvataggio è stato inviato'); expect(posts).toBe(0); await unchanged();
});
