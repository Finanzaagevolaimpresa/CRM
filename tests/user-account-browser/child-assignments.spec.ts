import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { classifySyntheticTechnicalVersion } from '../technical-confidentiality-fixtures';
import { syntheticSession } from '../selective-sharing/fixtures';
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


async function classification(versionId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: adminId } });
  await classifySyntheticTechnicalVersion(db, { user, ...await syntheticSession(db, user) }, versionId);
}
test('child-only scope retains classified versions after client reassignment; generic upload and foreign downloads stay denied', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin }), page = await context.newPage();
  const adminContext = await browser.newContext({ baseURL: origin }), admin = await adminContext.newPage();
  await login(page, 'operator'); await login(admin, 'admin');
  await page.goto('/documents'); await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const bytes = Buffer.from('Synthetic inherited service document ' + run);
  async function upload(client: string, project: string, service: string, suffix: string) {
    await admin.goto('/documents');
    const form = admin.locator('form').filter({ has: admin.locator('input[type="file"]') });
    await form.locator('select[name="clientId"]').selectOption(client);
    if (project) await form.locator('select[name="projectId"]').selectOption(project);
    if (service) await form.locator('select[name="clientServiceId"]').selectOption(service);
    await form.locator('input[name="title"]').fill(tag + '-' + suffix);
    await form.locator('input[type="file"]').setInputFiles({ name: 'child.txt', mimeType: 'text/plain', buffer: bytes });
    await form.getByRole('checkbox').check(); await capture(admin, '/documents');
    await form.getByRole('button', { name: 'Carica in storage privato' }).click();
    const request = await captured(admin);
    await expect.poll(() => db.document.count({ where: { title: tag + '-' + suffix } })).toBe(1);
    const document = await db.document.findFirstOrThrow({ where: { title: tag + '-' + suffix } });
    expect(document.uploadedById).toBe(adminId);
    expect((await page.request.get('/documents/' + document.id + '/download')).status()).toBe(403);
    if (process.env.PRIVILEGED_ACCESS_MODE === 'enforced') {
      const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: document.id } });
      await classification(version.id);
      const response = await page.request.get('/documents/' + document.id + '/download');
      expect(response.status()).toBe(200); expect(await response.body()).toEqual(bytes);
    }
    return { document, request };
  }
  const first = await upload(clientId, projectId, inheritedServiceId, 'before');
  await admin.goto('/clients/' + clientId);
  const assignment = admin.getByRole('form', { name: 'Assegna responsabili' });
  await assignment.getByLabel('Responsabile tecnico').selectOption(otherId);
  await assignment.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect(assignment.getByRole('status')).toHaveText('Responsabili aggiornati.');
  expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).consultantId).toBe(operatorId);
  await page.goto('/projects/' + projectId); await expect(page.getByText(tag + '-own-project', { exact: true })).toBeVisible();
  expect((await page.request.get('/clients/' + clientId)).status()).toBe(404);
  expect((await page.request.get('/documents/' + first.document.id + '/download')).status())
    .toBe(process.env.PRIVILEGED_ACCESS_MODE === 'enforced' ? 200 : 403);
  const service = await upload(otherClientId, '', ownServiceId, 'service-only');
  const before = await db.document.count();
  await replay(page, service.request, service.request.body.replaceAll(ownServiceId, foreignServiceId));
  expect(await db.document.count()).toBe(before);
  await db.project.update({ where: { id: projectId }, data: { consultantId: otherId } });
  expect((await page.request.get('/documents/' + first.document.id + '/download')).status()).toBe(403);
  expect((await db.document.findUniqueOrThrow({ where: { id: first.document.id } })).uploadedById).toBe(adminId);
  await adminContext.close(); await context.close();
});
test('canonical technical owner sees safe fields; captured legacy Admin edits cannot expose notes or move context', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin }), page = await context.newPage();
  const ac = await browser.newContext({ baseURL: origin }), admin = await ac.newPage();
  await db.technicalPractice.update({ where: { id: practiceId }, data: { internalNotes: 'PRIVATE_UNCLASSIFIED_CHILD_NOTE' } });
  await login(page, 'operator'); await login(admin, 'admin');
  const path = '/technical-office/practices/' + practiceId;
  await page.goto(path); await expect(page.getByText(tag + '-practice', { exact: true })).toBeVisible();
  await expect(page.locator('textarea[name="internalNotes"]')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE_UNCLASSIFIED_CHILD_NOTE');
  await admin.goto(path);
  const form = admin.locator('form').filter({ has: admin.getByRole('button', { name: 'Salva dati', exact: true }) });
  await form.locator('input[name="title"]').fill(tag + '-admin-corrected');
  await capture(admin, path); await form.getByRole('button', { name: 'Salva dati', exact: true }).click();
  const request = await captured(admin);
  await expect.poll(() => db.technicalPractice.findUnique({ where: { id: practiceId } }).then(v => v?.title)).toBe(tag + '-admin-corrected');
  const before = await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } });
  const audits = await db.auditLog.count({ where: { entityId: practiceId, event: 'technical_practice_update' } });
  await replay(page, request, request.body.replaceAll(otherClientId, clientId));
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toEqual(before);
  expect(await db.auditLog.count({ where: { entityId: practiceId, event: 'technical_practice_update' } })).toBe(audits);
  await page.goto(path); await expect(page.getByText(tag + '-admin-corrected', { exact: true })).toBeVisible();
  await db.client.update({ where: { id: otherClientId }, data: { deletedAt: new Date() } });
  expect((await page.reload())?.status()).toBe(404);
  await replay(page, request);
  expect(await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId } })).toEqual(before);
  await ac.close(); await context.close();
});
