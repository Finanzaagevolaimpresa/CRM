import { test, expect, type Page } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient(), origin = 'http://127.0.0.1:3015';
const run = randomUUID(), tag = `Perimeter-${run}`, password = process.env.M1_BROWSER_PASSWORD!;
const mode = process.env.PRIVILEGED_ACCESS_MODE;
const roles = ['commerciale', 'consulente', 'backoffice', 'revisore', 'amministrazione', 'collaboratore_limitato'] satisfies RoleCode[];
const email = (who: string) => `perimeter-${who}-${run}@example.test`;
const users = new Map<RoleCode, string>();
let adminId: string, clientId: string, foreignId: string, projectId: string, documentId: string;
type Captured = { url: string; action: string; contentType: string; body: string };
let uploadRequest: Captured;
const bytes = Buffer.from('Synthetic perimeter document ' + run);
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
    delete (window as Window & { perimeterAction?: Captured }).perimeterAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === pathname) {
        (window as Window & { perimeterAction?: Captured }).perimeterAction = { url: request.url, action,
          contentType: request.headers.get('content-type')!, body: await request.clone().text() };
        window.fetch = original; return original(request);
      }
      return original(input, init);
    };
  }, path);
}
async function captured(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { perimeterAction?: Captured }).perimeterAction)), { timeout: 30_000 }).toBe(true);
  return page.evaluate(() => (window as Window & { perimeterAction?: Captured }).perimeterAction!);
}
async function replay(page: Page, request: Captured) {
  return page.request.post(request.url, { headers: { 'next-action': request.action, 'content-type': request.contentType, origin }, data: request.body });
}
test.beforeAll(async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['enforced', 'disabled']).toContain(mode); expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  adminId = (await db.user.create({ data: { email: email('admin'), name: tag + '-admin', role: 'admin', passwordHash } })).id;
  for (const role of roles) {
    const user = await db.user.create({ data: { email: email(role), name: tag + '-' + role, role, passwordHash } });
    users.set(role, user.id);
    await db.userPermissionOverride.createMany({ data: ['client.read', 'project.read', 'document.download', 'document.upload', 'document.sensitive.read', 'client.write', 'project.write', 'service.write', 'service.read', 'user.read', 'user.write'].map(permission => ({ userId: user.id, permission, allowed: true })) });
  }
  clientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-client' } })).id;
  foreignId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-foreign' } })).id;
  projectId = (await db.project.create({ data: { clientId, title: tag + '-project' } })).id;
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
  const context = await browser.newContext({ baseURL: origin }), page = await context.newPage();
  await login(page, 'admin'); await page.goto('/documents');
  const form = page.locator('form').filter({ has: page.locator('input[type="file"]') });
  await form.locator('select[name="clientId"]').selectOption(clientId);
  await form.locator('input[name="title"]').fill(tag + '-document');
  await form.locator('input[type="file"]').setInputFiles({ name: 'perimeter.txt', mimeType: 'text/plain', buffer: bytes });
  await form.getByRole('checkbox').check(); await capture(page, '/documents');
  await form.getByRole('button', { name: 'Carica in storage privato' }).click();
  uploadRequest = await captured(page); expect(uploadRequest.body).toContain(bytes.toString());
  await expect.poll(() => db.document.count({ where: { title: tag + '-document' } })).toBe(1);
  documentId = (await db.document.findFirstOrThrow({ where: { title: tag + '-document' } })).id;
  await context.close();
});
test.afterAll(() => db.$disconnect());

for (const role of roles) test(`${role}: explicit admin grant and revocation affect the same open session without granting ownership`, async ({ browser }) => {
  const readerContext = await browser.newContext({ baseURL: origin }), reader = await readerContext.newPage();
  const adminContext = await browser.newContext({ baseURL: origin }), admin = await adminContext.newPage();
  const userId = users.get(role)!, path = `/settings/users/${userId}/perimeter`;
  await login(reader, role); await login(admin, 'admin');
  async function scope(allowed: boolean) {
    for (const [url, label] of [['/clients/' + clientId, tag + '-client'], ['/projects/' + projectId, tag + '-project']]) {
      await reader.goto(url);
      if (allowed) await expect(reader.getByText(label, { exact: true }).first()).toBeVisible();
      else await expect(reader.getByText(label, { exact: true })).toHaveCount(0);
    }
    await reader.goto('/search?q=' + encodeURIComponent(tag));
    const clientLink = reader.locator(`a[href="/clients/${clientId}"]`);
    if (allowed) await expect(clientLink.first()).toBeVisible(); else await expect(clientLink).toHaveCount(0);
    await expect(reader.locator(`a[href="/clients/${foreignId}"]`)).toHaveCount(0);
    const response = await reader.request.get('/documents/' + documentId + '/download');
    expect(response.status()).toBe(allowed ? 200 : 403);
    if (allowed) expect(await response.body()).toEqual(bytes);
    expect((await reader.request.get('/clients/' + clientId + '/operational-report')).status()).toBe(allowed ? 200 : 403);
  }
  await scope(false);
  await admin.goto(path + '?q=' + encodeURIComponent(tag + '-client'));
  await capture(admin, path);
  await admin.getByRole('form', { name: 'Consultazione ' + tag + '-client', exact: true }).getByRole('button', { name: 'Consenti consultazione' }).click();
  const initial = await captured(admin);
  await expect(admin).toHaveURL(/\/settings\/security/);
  expect(await db.clientReadGrant.count({ where: { userId, clientId } })).toBe(0);
  await replay(reader, initial);
  expect(await db.clientReadGrant.count({ where: { userId, clientId } })).toBe(0);
  if (mode === 'disabled') { await readerContext.close(); await adminContext.close(); return; }
  await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  await admin.goto(path + '?q=' + encodeURIComponent(tag + '-client'));
  await admin.getByRole('form', { name: 'Consultazione ' + tag + '-client', exact: true }).getByRole('button', { name: 'Consenti consultazione' }).click();
  await expect.poll(() => db.clientReadGrant.findUnique({ where: { userId_clientId: { userId, clientId } } }).then(row => row?.active)).toBe(true);
  await scope(true);
  const before = await db.document.count(); await replay(reader, uploadRequest);
  expect(await db.document.count()).toBe(before);
  const grant = await db.clientReadGrant.findUniqueOrThrow({ where: { userId_clientId: { userId, clientId } } });
  expect(grant.version).toBe(1); expect(grant.createdById).toBe(adminId);
  // A function-specific permission remains necessary even inside a granted scope.
  await db.userPermissionOverride.update({ where: { userId_permission: { userId, permission: 'document.sensitive.read' } }, data: { allowed: false } });
  expect((await reader.request.get('/documents/' + documentId + '/download')).status()).toBe(403);
  await db.userPermissionOverride.update({ where: { userId_permission: { userId, permission: 'document.sensitive.read' } }, data: { allowed: true } });
  await admin.goto(path);
  await expect(admin.getByText(new RegExp('Decisione di ' + tag + '-admin'))).toBeVisible();
  await admin.getByRole('form', { name: 'Consultazione ' + tag + '-client', exact: true }).getByRole('button', { name: 'Revoca consultazione' }).click();
  await expect.poll(() => db.clientReadGrant.findUnique({ where: { id: grant.id } }).then(row => row?.active)).toBe(false);
  await scope(false);
  await replay(admin, initial); // Stale version zero cannot recreate a revoked grant.
  expect(await db.clientReadGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ active: false, version: 2 });
  expect(await db.auditLog.count({ where: { entityId: grant.id, entityType: 'ClientReadGrant' } })).toBe(2);
  expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({ consultantId: null, salesOwnerId: null });
  await readerContext.close(); await adminContext.close();
});

test('admin can reach clients and previous grants beyond both first pages', async ({ page }) => {
  await login(page, 'admin');
  const userId = users.get('backoffice')!, prefix = `Paging-${run}`;
  for (let index = 0; index < 52; index++) {
    const client = await db.client.create({ data: { type: 'societa', displayName: `${prefix}-${index}` } });
    await db.clientReadGrant.create({ data: { userId, clientId: client.id, active: index % 2 === 0, createdById: adminId, updatedById: adminId } });
  }
  const last = await db.clientReadGrant.findFirstOrThrow({ where: { userId }, orderBy: { id: 'desc' }, include: { client: true } });
  const path = `/settings/users/${userId}/perimeter`;
  await page.goto(path); await page.getByRole('link', { name: 'Altre consultazioni' }).click();
  await expect(page.getByText(last.client.displayName, { exact: true })).toBeVisible();
  await page.goto(path + '?q=' + encodeURIComponent(prefix));
  const next = page.getByRole('link', { name: 'Altri clienti', exact: true });
  await expect(next).toBeVisible(); await next.click();
  await expect(page).toHaveURL(/after=/);
  await next.click();
  await expect(next).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Aggiungi un cliente', exact: true })).toBeVisible();
});
