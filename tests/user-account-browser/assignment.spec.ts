import { test, expect, type Page, type Request } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient();
const password = process.env.M1_BROWSER_PASSWORD!;
const scope = process.env.PRIVILEGED_ACCESS_MODE!;
const origin = 'http://127.0.0.1:3015';
const email = (role: string) => 'assignment-' + role + '-' + scope + '@example.test';
let adminId: string, salesId: string, otherId: string, clientId: string, projectId: string;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  const admin = await db.user.create({ data: { name: 'Assignment Admin', email: email('admin'), role: 'admin', passwordHash } });
  const sales = await db.user.create({ data: { name: 'Assignment Sales', email: email('sales'), role: 'commerciale', passwordHash } });
  const other = await db.user.create({ data: { name: 'Assignment Other', email: email('other'), role: 'commerciale', passwordHash } });
  const tech = await db.user.create({ data: { name: 'Assignment Technician', email: email('tech'), role: 'consulente', passwordHash } });
  [adminId, salesId, otherId] = [admin.id, sales.id, other.id];
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Assignment Client', salesOwnerId: salesId, consultantId: tech.id } });
  clientId = client.id;
  const project = await db.project.create({ data: { clientId, title: 'Assignment Project', consultantId: tech.id } });
  projectId = project.id;
  await db.userPermissionOverride.createMany({ data: ['service.assign', 'technical.assign'].map(permission => ({ userId: salesId, permission, allowed: true })) });
});
test.afterAll(async () => { await db.$disconnect(); });
async function login(page: Page, role: string) {
  await page.goto('/login');
  await page.locator('[data-login-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(role));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function replay(page: Page, request: Request, oldTimestamp: string, newTimestamp: string) {
  const body = request.postData()!;
  expect(body).toContain(oldTimestamp);
  return page.request.post(request.url(), {
    headers: { 'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin },
    data: body.replaceAll(oldTimestamp, newTimestamp),
  });
}
test('admin assigns client/project; old sessions and direct actions cannot reclaim reassigned scope', async ({ browser }) => {
  const adminContext = await browser.newContext({ baseURL: origin });
  const salesContext = await browser.newContext({ baseURL: origin });
  const admin = await adminContext.newPage(), sales = await salesContext.newPage();
  await login(admin, 'admin'); await login(sales, 'sales');
  await sales.goto('/clients/' + clientId);
  await expect(sales.getByRole('form', { name: 'Assegna responsabili' })).toHaveCount(0);
  await admin.goto('/clients/' + clientId);
  const form = admin.getByRole('form', { name: 'Assegna responsabili' });
  const oldTimestamp = await form.locator('input[name="updatedAt"]').inputValue();
  await form.getByLabel('Responsabile commerciale').selectOption(otherId);
  const pending = admin.waitForRequest(request => Boolean(request.headers()['next-action']));
  await form.getByRole('button', { name: 'Salva responsabili' }).click();
  const request = await pending;
  await expect(form.getByRole('status')).toHaveText('Responsabili aggiornati.');
  const current = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  expect(current.salesOwnerId).toBe(otherId);
  const beforeAudit = await db.auditLog.count({ where: { entityId: clientId, event: 'client_owners_assigned' } });
  // The replay contains the fresh revision: denial cannot be explained by a stale form.
  await replay(sales, request, oldTimestamp, current.updatedAt.toISOString());
  expect(await db.auditLog.count({ where: { entityId: clientId, event: 'client_owners_assigned' } })).toBe(beforeAudit);
  await sales.reload();
  await expect(sales.getByRole('heading', { name: 'Cliente non trovato' })).toBeVisible();
  await sales.goto('/clients/' + clientId + '/operational-report');
  expect(await sales.getByText('Assignment Client', { exact: true }).count()).toBe(0);
  await admin.goto('/projects/' + projectId);
  const projectForm = admin.getByRole('form', { name: 'Assegna responsabili' });
  await projectForm.getByLabel('Responsabile tecnico').selectOption(adminId);
  await projectForm.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect(projectForm.getByRole('status')).toHaveText('Responsabili aggiornati.');
  expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).consultantId).toBe(adminId);
  await admin.reload();
  await expect(admin.getByLabel('Responsabile tecnico')).toHaveValue(adminId);
  await adminContext.close(); await salesContext.close();
});
test('manual leads enter the admin queue; operator HTTP payloads cannot self assign on create or update', async ({ browser }) => {
  const adminContext = await browser.newContext({ baseURL: origin });
  const salesContext = await browser.newContext({ baseURL: origin });
  const admin = await adminContext.newPage(), sales = await salesContext.newPage();
  await login(admin, 'admin'); await login(sales, 'sales');
  await sales.goto('/leads');
  const create = sales.locator('form').filter({ has: sales.getByRole('button', { name: 'Crea lead', exact: true }) });
  await create.getByPlaceholder('Nome referente', { exact: true }).fill('AssignmentBrowser');
  await create.getByPlaceholder('Cognome referente', { exact: true }).fill(scope);
  await create.getByRole('button', { name: 'Crea lead', exact: true }).click();
  await expect(sales.getByRole('status')).toHaveText('Lead registrato nella coda dell’amministratore.');
  const lead = await db.lead.findFirstOrThrow({ where: { firstName: 'AssignmentBrowser', lastName: scope } });
  expect(lead.assignedToId).toBeNull();
  await sales.goto('/leads/' + lead.id);
  await expect(sales.getByRole('heading', { name: 'Lead non trovato' })).toBeVisible();
  await admin.goto('/leads/' + lead.id);
  const update = admin.locator('form').filter({ has: admin.getByRole('button', { name: 'Salva aggiornamenti', exact: true }) });
  await update.locator('select[name="assignedToId"]').selectOption(salesId);
  await update.getByRole('button', { name: 'Salva aggiornamenti' }).click();
  await expect.poll(async () => (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId).toBe(salesId);
  await sales.goto('/leads/' + lead.id);
  await expect(sales.getByRole('heading', { name: 'Lead non trovato' })).toHaveCount(0);
  const salesUpdate = sales.locator('form').filter({ has: sales.getByRole('button', { name: 'Salva aggiornamenti', exact: true }) });
  await expect(salesUpdate.locator('select[name="assignedToId"]')).toHaveCount(0);
  // Submit a direct, altered form from a valid old commercial session.
  await salesUpdate.evaluate((element, target) => {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'assignedToId'; input.value = target;
    element.appendChild(input);
  }, otherId);
  const denied = sales.waitForResponse(response => Boolean(response.request().headers()['next-action']));
  await salesUpdate.getByRole('button', { name: 'Salva aggiornamenti' }).click().catch(() => undefined);
  expect((await denied).status()).toBeGreaterThanOrEqual(400);
  expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId).toBe(salesId);
  await sales.goto('/leads');
  const nextCreate = sales.locator('form').filter({ has: sales.getByRole('button', { name: 'Crea lead', exact: true }) });
  await nextCreate.getByPlaceholder('Nome referente', { exact: true }).fill('ForbiddenAssignment');
  await nextCreate.getByPlaceholder('Cognome referente', { exact: true }).fill(scope);
  await nextCreate.evaluate((element, target) => {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'assignedToId'; input.value = target;
    element.appendChild(input);
  }, salesId);
  const deniedCreation = sales.waitForResponse(response => Boolean(response.request().headers()['next-action']));
  await nextCreate.getByRole('button', { name: 'Crea lead', exact: true }).click().catch(() => undefined);
  expect((await deniedCreation).status()).toBeGreaterThanOrEqual(400);
  expect(await db.lead.count({ where: { firstName: 'ForbiddenAssignment', lastName: scope } })).toBe(0);
  await adminContext.close(); await salesContext.close();
});
