import { test, expect, type Page, type Request } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();
const origin = 'http://127.0.0.1:3015';
const password = process.env.M1_BROWSER_PASSWORD!;
const mode = process.env.PRIVILEGED_ACCESS_MODE;
const runId = randomUUID();
const email = (who: string) => `continuity-${who}-${runId}@example.test`;
let adminId: string, ownerId: string, otherId: string, clientId: string;
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['enforced', 'disabled']).toContain(mode);
  expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  const admin = await db.user.create({ data: { email: email('admin'), name: 'Continuity admin', role: 'admin', passwordHash } });
  const owner = await db.user.create({ data: { email: email('owner'), name: 'Continuity owner', role: 'commerciale', passwordHash } });
  const other = await db.user.create({ data: { email: email('other'), name: 'Continuity other', role: 'commerciale', passwordHash } });
  [adminId, ownerId, otherId] = [admin.id, owner.id, other.id];
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Continuity browser client', salesOwnerId: ownerId } }); clientId = client.id;
  await db.userPermissionOverride.createMany({ data: ['user.read', 'user.write'].map(permission => ({ userId: otherId, permission, allowed: true })) });
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(async () => { await db.$disconnect(); });
async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(who));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function replay(page: Page, captured: Request, fromId = ownerId, toId = ownerId) {
  return page.request.post(captured.url(), {
    headers: { 'next-action': captured.headers()['next-action'], 'content-type': captured.headers()['content-type'], origin },
    data: captured.postData()!.replaceAll(fromId, toId),
  });
}

test('removal requires admin step-up and preserves work, archive and immediate revocation through real HTTP', async ({ browser }) => {
  const adminContext = await browser.newContext({ baseURL: origin }), ownerContext = await browser.newContext({ baseURL: origin }), otherContext = await browser.newContext({ baseURL: origin });
  const admin = await adminContext.newPage(), owner = await ownerContext.newPage(), other = await otherContext.newPage();
  await login(admin, 'admin'); await login(owner, 'owner'); await login(other, 'other');
  await owner.goto('/clients/' + clientId);
  await expect(owner.getByText('Continuity browser client', { exact: true }).first()).toBeVisible();
  await admin.goto('/settings/users/' + ownerId);
  const removal = admin.getByRole('form', { name: 'Rimozione account' });
  await removal.getByRole('checkbox').check();
  const pending = admin.waitForRequest(request => Boolean(request.headers()['next-action']));
  await removal.getByRole('button', { name: 'Rimuovi account' }).click();
  const captured = await pending;
  await expect(admin).toHaveURL(mode === 'enforced' ? /status=required/ : /status=unavailable/);
  expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).deletedAt).toBeNull();
  await replay(other, captured);
  expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).deletedAt).toBeNull();
  await other.goto('/settings/assignment-exceptions');
  await expect(other.getByRole('heading', { name: 'Coda eccezioni delle assegnazioni' })).toHaveCount(0);
  if (mode === 'disabled') {
    expect(await db.auditLog.count({ where: { entityId: ownerId, event: 'user_removed' } })).toBe(0);
    await adminContext.close(); await ownerContext.close(); await otherContext.close(); return;
  }
  await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await expect(admin).toHaveURL(/status=active/);
  await admin.goto('/settings/users/' + ownerId);
  await removal.getByRole('checkbox').check();
  await removal.getByRole('button', { name: 'Rimuovi account' }).click();
  await expect(admin.getByRole('heading', { name: 'Account rimosso', exact: true })).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).active).toBe(false);
  expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).salesOwnerId).toBe(ownerId);
  expect(await db.internalSession.count({ where: { userId: ownerId, revokedAt: null } })).toBe(0);
  await replay(owner, captured, ownerId, otherId);
  expect((await db.user.findUniqueOrThrow({ where: { id: otherId } })).deletedAt).toBeNull();
  await owner.reload(); await expect(owner).toHaveURL(/\/login$/);
  await admin.goto('/settings/users?removed=1');
  await expect(admin.getByRole('cell', { name: 'Continuity owner', exact: true })).toBeVisible();
  await admin.getByRole('row').filter({ has: admin.getByRole('cell', { name: 'Continuity owner', exact: true }) }).getByRole('link', { name: 'Apri archivio account' }).click();
  await expect(admin.getByRole('heading', { name: 'Account rimosso', exact: true })).toBeVisible();
  await admin.goto('/settings/assignment-exceptions?kind=clients');
  await expect(admin.getByRole('cell', { name: 'Continuity browser client', exact: true })).toBeVisible();
  await admin.getByRole('row').filter({ hasText: 'Continuity browser client' }).getByRole('link', { name: 'Apri scheda' }).click();
  const assignment = admin.getByRole('form', { name: 'Assegna responsabili' });
  await assignment.getByLabel('Responsabile commerciale').selectOption(otherId);
  await assignment.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect(assignment.getByRole('status')).toHaveText('Responsabili aggiornati.');
  await admin.goto('/settings/assignment-exceptions?kind=clients');
  await expect(admin.getByRole('cell', { name: 'Continuity browser client', exact: true })).toHaveCount(0);
  expect(await db.auditLog.count({ where: { entityId: ownerId, event: 'user_removed', actorId: adminId } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: clientId, event: 'client_owners_assigned', actorId: adminId } })).toBe(1);
  await adminContext.close(); await ownerContext.close(); await otherContext.close();
});
