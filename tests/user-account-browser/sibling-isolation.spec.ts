import { test, expect, type Page } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), origin = 'http://127.0.0.1:3015', tag = `isolation-${randomUUID()}`;
const password = process.env.M1_BROWSER_PASSWORD!;
const roles = ['commerciale', 'consulente', 'backoffice', 'revisore', 'collaboratore_limitato', 'admin', 'direzione', 'amministrazione'] satisfies RoleCode[];
const users = new Map<RoleCode, string>();
let clientId: string, ownProject: string, foreignProject: string, taskId: string, adminId: string;
const ownTitle = tag + '-own-task', foreignTitle = tag + '-foreign-task';
async function login(page: Page, role: RoleCode) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(`${tag}-${role}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  for (const role of roles) {
    const user = await db.user.create({ data: { name: tag + '-' + role, email: `${tag}-${role}@example.test`, role, passwordHash } });
    users.set(role, user.id);
    await db.userPermissionOverride.createMany({ data: ['client.read', 'project.read', 'service.read', 'service.write', 'lead.read', 'document.download'].map(permission => ({ userId: user.id, permission, allowed: true })) });
  }
  adminId = users.get('admin')!;
  clientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-shared-client', salesOwnerId: users.get('commerciale'), consultantId: users.get('consulente') } })).id;
  await db.clientReadGrant.createMany({ data: roles.filter(role => !['admin', 'direzione'].includes(role)).map(role => ({ userId: users.get(role)!, clientId, createdById: adminId, updatedById: adminId })) });
  ownProject = (await db.project.create({ data: { clientId, title: tag + '-own-project', consultantId: users.get('consulente') } })).id;
  foreignProject = (await db.project.create({ data: { clientId, title: tag + '-foreign-project', consultantId: adminId } })).id;
  taskId = (await db.task.create({ data: { clientId, title: ownTitle, assignedToId: users.get('consulente'), createdById: adminId, dueAt: new Date('2020-01-01') } })).id;
  await db.task.create({ data: { clientId, title: foreignTitle, assignedToId: adminId, createdById: users.get('consulente'), dueAt: new Date('2020-01-01') } });
});
test.afterAll(() => db.$disconnect());

for (const role of roles) test(`${role}: shared-client list, search, direct URL and export hide another user's work`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const page = await context.newPage(); await login(page, role);
  const supervisor = ['admin', 'direzione', 'amministrazione'].includes(role);
  const own = role === 'consulente' || supervisor;
  await page.goto('/tasks');
  await expect(page.getByText(ownTitle, { exact: true })).toHaveCount(own ? 1 : 0);
  await expect(page.getByText(foreignTitle, { exact: true })).toHaveCount(supervisor ? 1 : 0);
  await page.goto('/projects/' + foreignProject);
  await expect(page.getByRole('heading', { name: 'Progetto — ' + tag + '-foreign-project', exact: true })).toHaveCount(supervisor ? 1 : 0);
  await page.goto('/projects/' + ownProject);
  await expect(page.getByRole('heading', { name: 'Progetto — ' + tag + '-own-project', exact: true })).toHaveCount(own ? 1 : 0);
  await page.goto('/search?q=' + encodeURIComponent(tag));
  await expect(page.getByText(foreignTitle, { exact: true })).toHaveCount(supervisor ? 1 : 0);
  const report = await page.request.get('/clients/' + clientId + '/operational-report');
  expect(report.status()).toBe(200);
  const text = await report.text(); expect(text.includes(foreignTitle)).toBe(supervisor); expect(text.includes(ownTitle)).toBe(own);
  await page.goto('/dashboard');
  const counters = page.locator('[data-counter-final]'); await expect(counters.first()).toBeVisible();
  expect(await counters.evaluateAll(nodes => nodes.every(node => node.querySelector('[aria-hidden]')?.textContent === Number(node.getAttribute('data-counter-final')).toLocaleString('it-IT')))).toBe(true);
  await context.close();
});

test('an already-open task form cannot write after reassignment; motion preference change settles on the actual total', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'no-preference' });
  const page = await context.newPage(); await login(page, 'consulente');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.locator('[data-counter-final]').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.querySelector('[aria-hidden]')?.textContent === Number(node.getAttribute('data-counter-final')).toLocaleString('it-IT')))).toBe(true);
  await page.goto('/tasks'); const form = page.locator('form').filter({ has: page.locator(`input[name="id"][value="${taskId}"]`) });
  await expect(form.getByRole('button', { name: 'Completa', exact: true })).toBeVisible();
  await db.task.update({ where: { id: taskId }, data: { assignedToId: adminId } });
  const response = page.waitForResponse(r => r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Completa', exact: true }).click(); await response;
  expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('aperta');
  await page.goto('/tasks'); await expect(page.getByText(ownTitle, { exact: true })).toHaveCount(0);
  await context.close();
});
