import { test, expect, type Page, type Request } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();
const password = process.env.M1_BROWSER_PASSWORD!;
const updatedPassword = process.env.M1_BROWSER_UPDATED_PASSWORD!;
const privilegedMode = process.env.PRIVILEGED_ACCESS_MODE;
const scope = privilegedMode === 'disabled' ? 'disabled' : 'enforced';
const adminEmail = `m1-admin-${scope}@example.test`;
const selfAdminEmail = `m1-self-admin-${scope}@example.test`;
const operatorEmail = `m1-operator-${scope}@example.test`;
const changedEmail = `m1-updated-${scope}@example.test`;
const origin = 'http://127.0.0.1:3015';

test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['disabled', 'enforced'].includes(privilegedMode ?? '')).toBe(true);
  expect(password?.length >= 24 && updatedPassword?.length >= 24).toBe(true);
  expect((process.env.PRIVILEGED_STEP_UP_SECRET?.length ?? 0) >= 32).toBe(true);
  await db.user.create({ data: { email: adminEmail, name: 'M1 Admin', role: 'admin', passwordHash: await bcrypt.hash(password, 12) } });
  await db.user.create({ data: { email: selfAdminEmail, name: 'M1 Self Admin', role: 'admin', passwordHash: await bcrypt.hash(password, 12) } });
  if (privilegedMode === 'enforced') await db.applicationKeyVersion.create({ data: {
    purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(),
    keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!),
  } });
});
test.afterAll(async () => { await db.$disconnect(); });

async function login(page: Page, email: string, value: string, succeeds = true) {
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Login interno' }).click();
  if (succeeds) await expect(page).toHaveURL(/\/dashboard$/);
  else await expect(page).toHaveURL(/\/login\?error=invalid$/);
}

async function replay(page: Page, captured: Request, fromId: string, toId: string) {
  const response = await page.request.post(captured.url(), {
    headers: { 'next-action': captured.headers()['next-action'], 'content-type': captured.headers()['content-type'], origin },
    data: captured.postData()!.replaceAll(fromId, toId),
  });
  expect(response.status()).toBeLessThan(500);
}

test('admin account management, own profile/password, direct denials, revocation and reopening', async ({ browser }) => {
  test.skip(privilegedMode !== 'enforced', 'Administrative mutations require enforced step-up.');
  const adminContext = await browser.newContext({ baseURL: origin });
  const operatorContext = await browser.newContext({ baseURL: origin });
  const otherContext = await browser.newContext({ baseURL: origin });
  const admin = await adminContext.newPage();
  const operator = await operatorContext.newPage();
  const other = await otherContext.newPage();
  await login(admin, adminEmail, password);
  await admin.goto('/settings/security');
  await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await expect(admin).toHaveURL(/status=active/);
  await admin.goto('/settings/users');
  await admin.getByPlaceholder('Nome', { exact: true }).fill('M1 Operator');
  await admin.getByPlaceholder('email@azienda.it').fill(operatorEmail);
  await admin.locator('form').filter({ has: admin.getByRole('button', { name: 'Crea utente', exact: true }) }).locator('select[name="role"]').selectOption('consulente');
  await admin.getByPlaceholder('Password temporanea').fill(password);
  await admin.getByRole('button', { name: 'Crea utente', exact: true }).click();
  await expect(admin.getByRole('cell', { name: operatorEmail, exact: true })).toBeVisible();
  const operatorUser = await db.user.findUniqueOrThrow({ where: { email: operatorEmail } });
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
  await login(operator, operatorEmail, password);
  await login(other, operatorEmail, password);
  await operator.goto('/settings/account');
  const profile = operator.getByRole('form', { name: 'Modifica profilo' });
  await profile.getByLabel('Nome', { exact: true }).fill('M1 Updated operator');
  const profileRequest = operator.waitForRequest((req) => Boolean(req.headers()['next-action']));
  await profile.getByRole('button', { name: 'Salva profilo' }).click();
  const capturedProfile = await profileRequest;
  await expect(profile.getByRole('status')).toHaveText('Profilo aggiornato.');
  await operator.reload();
  await expect(operator.getByLabel('Nome', { exact: true })).toHaveValue('M1 Updated operator');
  await replay(operator, capturedProfile, operatorUser.id, adminUser.id);
  expect((await db.user.findUniqueOrThrow({ where: { id: adminUser.id } })).name).toBe('M1 Admin');

  const change = operator.getByRole('form', { name: 'Cambia password' });
  await change.getByLabel('Password attuale', { exact: true }).fill('wrong-current');
  await change.getByLabel('Nuova password', { exact: true }).fill(updatedPassword);
  await change.getByLabel('Conferma password', { exact: true }).fill(updatedPassword);
  await change.getByRole('button', { name: 'Aggiorna password' }).click();
  await expect(change.getByRole('status')).toHaveText('Password attuale non valida.');
  await change.getByLabel('Password attuale', { exact: true }).fill(password);
  await change.getByLabel('Nuova password', { exact: true }).fill(updatedPassword);
  await change.getByLabel('Conferma password', { exact: true }).fill(updatedPassword);
  await change.getByRole('button', { name: 'Aggiorna password' }).click();
  await expect(operator).toHaveURL(/\/login\?status=account-updated$/);
  await other.goto('/settings/account');
  await expect(other).toHaveURL(/\/login$/);
  await login(operator, operatorEmail, password, false);
  await login(operator, operatorEmail, updatedPassword);

  await admin.goto('/settings/users/' + operatorUser.id);
  const reset = admin.getByRole('form', { name: 'Reimposta password' });
  await reset.getByLabel('Nuova password', { exact: true }).fill(password);
  await reset.getByLabel('Conferma password', { exact: true }).fill(password);
  const resetRequest = admin.waitForRequest((req) => Boolean(req.headers()['next-action']));
  await reset.getByRole('button', { name: 'Reimposta password', exact: true }).click();
  const capturedReset = await resetRequest;
  await expect(reset.getByRole('status')).toHaveText('Password aggiornata. Le sessioni precedenti sono state revocate.');
  await operator.goto('/settings/account');
  await expect(operator).toHaveURL(/\/login$/);
  await login(operator, operatorEmail, password);
  await replay(operator, capturedReset, operatorUser.id, adminUser.id);
  expect((await db.user.findUniqueOrThrow({ where: { id: adminUser.id } })).passwordHash === adminUser.passwordHash).toBe(true);

  const adminProfile = admin.getByRole('form', { name: 'Modifica profilo' });
  await adminProfile.getByLabel('Email di accesso').fill(changedEmail);
  await adminProfile.getByRole('button', { name: 'Salva profilo' }).click();
  await expect(adminProfile.getByRole('status')).toHaveText('Profilo aggiornato.');
  await operator.goto('/settings/account');
  await expect(operator).toHaveURL(/\/login$/);
  await login(operator, operatorEmail, password, false);
  await login(operator, changedEmail, password);
  await operator.goto('/settings/account');
  await operator.getByRole('button', { name: 'Revoca tutte le sessioni' }).click();
  await expect(operator).toHaveURL(/\/login\?status=account-updated$/);
  const audits = JSON.stringify(await db.auditLog.findMany({ where: { actorId: { in: [adminUser.id, operatorUser.id] } } }));
  for (const value of [password, updatedPassword, adminUser.passwordHash, operatorUser.passwordHash]) expect(audits.includes(value)).toBe(false);
  await adminContext.close(); await operatorContext.close(); await otherContext.close();
});

test('own admin profile name works without step-up while email still requires admission', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  const user = await db.user.findUniqueOrThrow({ where: { email: selfAdminEmail } });
  await login(page, selfAdminEmail, password);
  await page.goto('/settings/account');
  const profile = page.getByRole('form', { name: 'Modifica profilo' });
  await profile.getByLabel('Nome', { exact: true }).fill('M1 Own admin updated');
  await profile.getByRole('button', { name: 'Salva profilo' }).click();
  await expect(profile.getByRole('status')).toHaveText('Profilo aggiornato.');
  await page.reload();
  await expect(profile.getByLabel('Nome', { exact: true })).toHaveValue('M1 Own admin updated');
  const newEmail = `m1-self-updated-${scope}@example.test`;
  await profile.getByLabel('Email di accesso').fill(newEmail);
  await profile.getByRole('button', { name: 'Salva profilo' }).click();
  await expect(page).toHaveURL(privilegedMode === 'enforced' ? /\/settings\/security\?status=required$/ : /\/settings\/security\?status=unavailable$/);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(selfAdminEmail);
  expect(await db.auditLog.count({ where: { actorId: user.id, event: 'user_profile_updated' } })).toBe(1);
  if (privilegedMode === 'enforced') {
    await page.getByLabel('Password corrente').fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
    await expect(page).toHaveURL(/status=active/);
    await page.goto('/settings/account');
    await profile.getByLabel('Email di accesso').fill(newEmail);
    await profile.getByRole('button', { name: 'Salva profilo' }).click();
    await expect(page).toHaveURL(/\/login\?status=account-updated$/);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(newEmail);
    expect(await db.internalSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  }
  await context.close();
});
