import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient(), origin = 'http://127.0.0.1:3015';
const password = process.env.M1_BROWSER_PASSWORD!, run = randomUUID();
const email = (who: string) => `child-${who}-${run}@example.test`;
const tag = `Child-${run}`;
let adminId: string, operatorId: string, otherId: string;
let clientId: string, otherClientId: string, projectId: string, otherProjectId: string;
let inheritedServiceId: string, ownServiceId: string, foreignServiceId: string, practiceId: string;
type Captured = { url: string; action: string; contentType: string; body: string };

async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(who));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function capture(page: Page, path: string) {
  await page.evaluate(pathname => {
    const original = window.fetch.bind(window);
    delete (window as Window & { childAction?: Captured }).childAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === pathname) {
        (window as Window & { childAction?: Captured }).childAction = {
          url: request.url, action, contentType: request.headers.get('content-type')!, body: await request.clone().text(),
        };
        window.fetch = original;
        return original(request);
      }
      return original(input, init);
    };
  }, path);
}
async function captured(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { childAction?: Captured }).childAction)), { timeout: 30_000 }).toBe(true);
  return page.evaluate(() => (window as Window & { childAction?: Captured }).childAction!);
}
async function replay(page: Page, request: Captured, body = request.body) {
  return page.request.post(request.url, { headers: { 'next-action': request.action, 'content-type': request.contentType, origin }, data: body });
}

test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  const makeUser = (who: string, role: 'admin' | 'backoffice') => db.user.create({ data: { email: email(who), name: tag + '-' + who, role, passwordHash } });
  adminId = (await makeUser('admin', 'admin')).id;
  operatorId = (await makeUser('operator', 'backoffice')).id;
  otherId = (await makeUser('other', 'backoffice')).id;
  await db.userPermissionOverride.createMany({ data: [operatorId, otherId].flatMap(userId => ['document.upload', 'document.download', 'document.sensitive.read', 'technical.write'].map(permission => ({ userId, permission, allowed: true }))) });
  clientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-project-client', consultantId: operatorId } })).id;
  otherClientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-service-client', consultantId: otherId } })).id;
  projectId = (await db.project.create({ data: { clientId, title: tag + '-own-project', consultantId: operatorId } })).id;
  otherProjectId = (await db.project.create({ data: { clientId: otherClientId, title: tag + '-foreign-project', consultantId: otherId } })).id;
  const catalog = await db.serviceCatalog.create({ data: { code: tag, name: tag + '-catalog', category: 'synthetic' } });
  inheritedServiceId = (await db.clientService.create({ data: { clientId, projectId, serviceCatalogId: catalog.id } })).id;
  ownServiceId = (await db.clientService.create({ data: { clientId: otherClientId, projectId: otherProjectId, serviceCatalogId: catalog.id, assignedToId: operatorId } })).id;
  foreignServiceId = (await db.clientService.create({ data: { clientId: otherClientId, serviceCatalogId: catalog.id, assignedToId: otherId } })).id;
  practiceId = (await db.technicalPractice.create({ data: { clientId: otherClientId, title: tag + '-practice', practiceType: 'Synthetic', targetEntity: 'Synthetic', technicalOwnerId: operatorId, createdById: adminId } })).id;
  if (process.env.PRIVILEGED_ACCESS_MODE === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(() => db.$disconnect());

test('child-only project and service assignments retain uploads and inherited downloads after client reassignment', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin }), page = await context.newPage();
  const adminContext = await browser.newContext({ baseURL: origin }), admin = await adminContext.newPage();
  await login(page, 'operator'); await login(admin, 'admin');
  const bytes = Buffer.from('Synthetic inherited service document ' + run);
  async function upload(client: string, project: string, service: string, suffix: string) {
    await page.goto('/documents');
    const form = page.locator('form').filter({ has: page.locator('input[type="file"]') });
    await form.locator('select[name="clientId"]').selectOption(client);
    if (suffix !== 'before') await expect(form.getByRole('button', { name: 'Carica in storage privato' })).toBeDisabled();
    if (project) await form.locator('select[name="projectId"]').selectOption(project);
    if (service) await form.locator('select[name="clientServiceId"]').selectOption(service);
    await form.locator('input[name="title"]').fill(tag + '-' + suffix);
    await form.locator('input[type="file"]').setInputFiles({ name: 'child.txt', mimeType: 'text/plain', buffer: bytes });
    await form.getByRole('checkbox').check();
    await capture(page, '/documents');
    await form.getByRole('button', { name: 'Carica in storage privato' }).click();
    const request = await captured(page);
    expect(request.body).toContain(bytes.toString());
    await expect.poll(() => db.document.count({ where: { title: tag + '-' + suffix } })).toBe(1);
    const document = await db.document.findFirstOrThrow({ where: { title: tag + '-' + suffix } });
    expect(document.projectId).toBe(project || null); expect(document.clientServiceId).toBe(service || null);
    expect(document.uploadedById).toBe(operatorId);
    const response = await page.request.get('/documents/' + document.id + '/download');
    expect(response.status()).toBe(200); expect(await response.body()).toEqual(bytes);
    return { document, request };
  }
  const first = await upload(clientId, '', inheritedServiceId, 'before');
  if (process.env.PRIVILEGED_ACCESS_MODE === 'enforced') {
    await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
    await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  }
  await admin.goto('/clients/' + clientId);
  const assignment = admin.getByRole('form', { name: 'Assegna responsabili' });
  await assignment.getByLabel('Responsabile tecnico').selectOption(otherId);
  await assignment.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect(assignment.getByRole('status')).toHaveText('Responsabili aggiornati.');
  expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).consultantId).toBe(operatorId);
  const inherited = await page.request.get('/documents/' + first.document.id + '/download');
  expect(inherited.status()).toBe(200); expect(await inherited.body()).toEqual(bytes);
  await page.goto('/clients/' + clientId); await expect(page.getByRole('heading', { name: tag + '-project-client', exact: true })).toHaveCount(0);
  await upload(clientId, projectId, '', 'project-only');
  const service = await upload(otherClientId, '', ownServiceId, 'service-only');
  await page.goto('/documents');
  const form = page.locator('form').filter({ has: page.locator('input[type="file"]') });
  await form.locator('select[name="clientId"]').selectOption(otherClientId);
  await expect(form.locator(`select[name="projectId"] option[value="${otherProjectId}"]`)).toHaveCount(0);
  await expect(form.locator(`select[name="clientServiceId"] option[value="${foreignServiceId}"]`)).toHaveCount(0);
  const before = await db.document.count();
  await replay(page, service.request, service.request.body.replaceAll(ownServiceId, foreignServiceId));
  expect(await db.document.count()).toBe(before);
  // Removing the remaining assignment revokes access, despite unchanged uploader provenance.
  await db.project.update({ where: { id: projectId }, data: { consultantId: otherId } });
  expect((await page.request.get('/documents/' + first.document.id + '/download')).status()).toBe(403);
  expect((await db.document.findUniqueOrThrow({ where: { id: first.document.id } })).uploadedById).toBe(operatorId);
  await adminContext.close(); await context.close();
});

test('the practice-only technical owner can edit ordinary fields but cannot move the context or change assignees', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin }), page = await context.newPage();
  await login(page, 'operator');
  const path = '/technical-office/practices/' + practiceId;
  await page.goto(path);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva dati', exact: true }) });
  await form.locator('input[name="title"]').fill(tag + '-updated');
  await form.locator('textarea[name="internalNotes"]').fill('Synthetic ordinary edit');
  await capture(page, path);
  await form.getByRole('button', { name: 'Salva dati', exact: true }).click();
  const request = await captured(page);
  await expect.poll(() => db.technicalPractice.findUnique({ where: { id: practiceId } }).then(row => row?.title)).toBe(tag + '-updated');
  const before = await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } });
  expect(before.internalNotes).toBe('Synthetic ordinary edit'); expect(before.clientId).toBe(otherClientId);
  expect(before.technicalOwnerId).toBe(operatorId); expect(before.createdById).toBe(adminId);
  const audits = await db.auditLog.count({ where: { entityId: practiceId, event: 'technical_practice_update' } });
  expect(audits).toBe(1);
  expect(request.body).toContain(otherClientId);
  await replay(page, request, request.body.replaceAll(otherClientId, clientId));
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toEqual(before);
  await page.goto(path);
  // Submit an actual extra hidden field through the form to exercise admin-only ownership.
  await form.evaluate((element, userId) => { const input = document.createElement('input'); input.type = 'hidden'; input.name = 'technicalOwnerId'; input.value = userId; element.append(input); }, otherId);
  const deniedOwnerResponse = page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action']));
  await form.getByRole('button', { name: 'Salva dati', exact: true }).click();
  await deniedOwnerResponse;
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toEqual(before);
  expect(await db.auditLog.count({ where: { entityId: practiceId, event: 'technical_practice_update' } })).toBe(audits);
  await db.client.update({ where: { id: otherClientId }, data: { deletedAt: new Date() } });
  await replay(page, request);
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toEqual(before);
  await db.client.update({ where: { id: otherClientId }, data: { deletedAt: null } });
  await db.client.update({ where: { id: clientId }, data: { consultantId: operatorId } });
  await replay(page, request, request.body.replaceAll(otherClientId, clientId));
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toMatchObject({ clientId, technicalOwnerId: operatorId, createdById: adminId, title: before.title });
  expect(await db.auditLog.count({ where: { entityId: practiceId, event: 'technical_practice_update' } })).toBe(audits + 1);
  await context.close();
});
