import { captureManual } from '../manuals-r23/capture';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { classifySyntheticTechnicalVersion } from '../technical-confidentiality-fixtures';
import { syntheticSession } from '../selective-sharing/fixtures';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { purchasedFixture, type PurchasedFixture } from '../purchased-service-fixture';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { getHandoffReceipt } from '../../src/lib/purchased-service-handoff';

const db = new PrismaClient(), baseURL = 'http://127.0.0.1:3015';
const password = process.env.M1_BROWSER_PASSWORD!, mode = process.env.PRIVILEGED_ACCESS_MODE;
let f: PurchasedFixture;
type Captured = { url: string; action: string; contentType: string; body: string };
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function stepUp(page: Page) {
  await page.goto('/settings/security'); await page.getByLabel('Password corrente').fill(password);
  await page.getByRole('button', { name: /Conferma per (5|30) minuti/ }).click(); await expect(page).toHaveURL(/status=active/);
}
async function capture(page: Page, path: string) {
  await page.evaluate(pathname => {
    const original = window.fetch.bind(window); delete (window as Window & { handoffAction?: Captured }).handoffAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === pathname) {
        (window as Window & { handoffAction?: Captured }).handoffAction = { url: request.url, action, contentType: request.headers.get('content-type')!, body: await request.clone().text() };
        window.fetch = original; return original(request);
      } return original(input, init);
    };
  }, path);
}
async function captured(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { handoffAction?: Captured }).handoffAction))).toBe(true);
  return page.evaluate(() => (window as Window & { handoffAction?: Captured }).handoffAction!);
}
async function replay(page: Page, request: Captured) {
  return page.request.post(request.url, { headers: { origin: baseURL, 'next-action': request.action, 'content-type': request.contentType }, data: request.body });
}
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(['enforced', 'disabled']).toContain(mode); expect(password.length).toBeGreaterThanOrEqual(24);
  f = await purchasedFixture(db, await bcrypt.hash(password, 4));
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(() => db.$disconnect());

test('paid service UI: Admin handoff, individual acceptance, classified material and reassignment preserve the privacy ceiling', async ({ browser }) => {
  test.setTimeout(240_000);
  const ac = await browser.newContext({ baseURL }), tc = await browser.newContext({ baseURL }), oc = await browser.newContext({ baseURL });
  const admin = await ac.newPage(), tech = await tc.newPage(), other = await oc.newPage();
  await login(admin, f.admin.email); await login(tech, f.tech.email); await login(other, f.other.email);
  await admin.goto(`/clients/${f.client.id}`); await admin.locator(`#service-${f.service.id}`).getByRole('link', { name: 'Passaggio al tecnico', exact: true }).click();
  const path = `/services/${f.service.id}/handoff`;
  const form = admin.getByRole('form', { name: 'Passaggio al tecnico', exact: true });
  async function submit() {
    await admin.goto(`${path}?q=${encodeURIComponent(f.tag)}`);
    await form.getByLabel('Variante prevista dallâ€™incarico', { exact: true }).fill(f.input.variantCode);
    await form.getByLabel('Reparto tecnico', { exact: true }).fill(f.input.departmentCode);
    await form.getByLabel('Referente tecnico', { exact: true }).selectOption(f.tech.id);
    await form.getByLabel('Scadenza delle attivitÃ ', { exact: true }).fill('2027-01-15');
    await form.getByLabel('AttivitÃ  incluse, una per riga', { exact: true }).fill(f.input.activities.join('\n'));
    await form.getByLabel('Motivazione', { exact: true }).fill(f.input.reason); await form.getByRole('checkbox').check();
    await capture(admin, path); await form.getByRole('button', { name: 'Affida il servizio al tecnico', exact: true }).click(); return captured(admin);
  }
  const denied = await submit(); expect(await getHandoffReceipt(db, f.service.id)).toBeNull();
  await replay(tech, denied); expect(await getHandoffReceipt(db, f.service.id)).toBeNull();
  if (mode === 'disabled') { await expect(form.getByRole('status')).toContainText('non disponibile'); await ac.close(); await tc.close(); await oc.close(); return; }
  const inline = admin.getByRole('region', { name: 'Conferma identitÃ  senza lasciare il lavoro', exact: true });
  await expect(inline).toBeVisible();
  await expect(form.getByLabel('Referente tecnico', { exact: true })).toHaveValue(f.tech.id);
  await expect(form.getByLabel('Motivazione', { exact: true })).toHaveValue(f.input.reason);
  await expect(form.getByRole('checkbox')).toBeChecked();
  await inline.getByLabel('Password corrente', { exact: true }).fill(password);
  await inline.getByRole('button', { name: 'Conferma identitÃ  e conserva le scelte', exact: true }).click();
  await expect(inline).toContainText('IdentitÃ  confermata.');
  expect(await getHandoffReceipt(db, f.service.id)).toBeNull();
  await capture(admin, path); await form.getByRole('button', { name: 'Affida il servizio al tecnico', exact: true }).click();
  const committedRequest = await captured(admin);
  await expect.poll(async () => Boolean(await getHandoffReceipt(db, f.service.id))).toBe(true);
  const receipt = (await getHandoffReceipt(db, f.service.id))!;
  await admin.goto(path);
  await expect(admin.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toBeVisible();
  await captureManual(admin, 'S03-passaggio-admin', 'admin', 'Incarico e pagamento sintetici verificati; ricevuta del passaggio senza creare una seconda offerta.');
  await replay(admin, committedRequest); expect((await getHandoffReceipt(db, f.service.id))!.id).toBe(receipt.id);
  expect(await db.technicalPractice.count({ where: { clientServiceId: f.service.id } })).toBe(1);
  expect(await db.commercialOffer.count({ where: { clientId: f.client.id } })).toBe(0);
  expect(await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).toEqual(f.client);
  await other.goto(path); await expect(other.getByRole('heading', { name: 'Passaggio del servizio acquistato', exact: true })).toHaveCount(0);
  const practicePath = `/technical-office/practices/${receipt.receipt.technicalPracticeId}`, assignmentPath = `/assignments/TechnicalPractice/${receipt.receipt.technicalPracticeId}`;
  await tech.goto('/assignments?kind=TechnicalPractice'); await tech.getByRole('link', { name: f.catalog.name, exact: true }).click();
  await tech.getByRole('button', { name: 'Confermo la presa in carico tecnico', exact: true }).click();
  await expect.poll(() => db.auditLog.count({ where: { entityId: receipt.receipt.technicalPracticeId, event: 'responsibility_accepted' } })).toBe(1);
  await tech.goto(practicePath);
  expect((await tech.request.get('/documents/' + f.documents[2].id + '/download')).status()).toBe(403);
  const adminUser = await db.user.findUniqueOrThrow({ where: { id: f.admin.id } });
  await classifySyntheticTechnicalVersion(db, { user: adminUser, ...await syntheticSession(db, adminUser) }, f.documents[2].version.id);
  await tech.reload(); await expect(tech.getByText(f.documents[2].title, { exact: true })).toBeVisible();
  const material = await tech.request.get('/documents/' + f.documents[2].id + '/download');
  expect(material.status()).toBe(200); expect((await material.body()).toString()).toBe('Synthetic material ' + f.tag);
  for (const document of f.documents.slice(0, 2)) {
    expect((await tech.request.get('/documents/' + document.id + '/download')).status()).toBe(403);
    expect((await tech.request.get('/documents/' + document.id + '/view?versionId=' + document.version.id)).status()).toBe(403);
  }
  const safeHtml = await tech.locator('body').innerText();
  for (const value of [f.contract.id, f.payment.id, f.documents[0].title, f.documents[1].title]) expect(safeHtml).not.toContain(value);
  expect((await tech.request.get(path)).status()).toBe(404);
  await expect(tech.locator('input[type="file"]')).toHaveCount(0);
  await expect(tech.getByRole('button', { name: 'Crea nota per commerciale', exact: true })).toHaveCount(0);
  expect(await db.practiceCommunication.count({ where: { technicalPracticeId: receipt.receipt.technicalPracticeId } })).toBe(0);
  await captureManual(tech, 'S03-passaggio-tecnico', 'consulente', 'Responsabilità personale e materiale tecnico classificato; contratto, pagamento e note restano riservati.');
  await stepUp(admin); await admin.goto(`${assignmentPath}?q=${encodeURIComponent(f.tag)}`);
  const assignment = admin.getByRole('form', { name: 'Decisione responsabilitÃ ', exact: true });
  await assignment.getByLabel('Referente tecnico', { exact: true }).selectOption(f.other.id);
  await assignment.getByLabel('Motivazione', { exact: true }).fill('Reassignment of technical scope, preserving original evidence');
  await assignment.getByRole('button', { name: 'Registra decisione', exact: true }).click();
  await expect.poll(async () => (await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).assignedToId).toBe(f.other.id);
  expect((await tech.request.get(`/documents/${f.documents[2].id}/download`)).status()).toBe(403);
  expect((await other.request.get(`/documents/${f.documents[2].id}/download`)).status()).toBe(200);
  await replay(admin, committedRequest); expect((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).assignedToId).toBe(f.other.id);
  expect(await getHandoffReceipt(db, f.service.id)).toEqual(receipt);
  await ac.close(); await tc.close(); await oc.close();
});
