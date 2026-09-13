import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { parseCommunicationPersistenceAggregateV1 } from '../../src/lib/communication-intent-persistence';

const appUrl = 'http://127.0.0.1:3000';
const password = required('N15_BROWSER_PASSWORD');
const evidenceDirectory = required('N15_BROWSER_EVIDENCE_DIR');
const db = new PrismaClient();

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`N15_BROWSER_ENVIRONMENT_MISSING_${name}`);
  return value;
}

type SyntheticIdentity = 'manager' | 'assignee' | 'foreign';
const identityUserIds: Record<SyntheticIdentity, string> = {
  manager: 'n15-browser-manager',
  assignee: 'n15-browser-commercial-one',
  foreign: 'n15-browser-commercial-two',
};

function loginPathClassification(page: Page) {
  const current = new URL(page.url());
  if (current.origin !== appUrl) return 'UNEXPECTED_ORIGIN';
  if (current.pathname === '/dashboard') return 'DASHBOARD';
  if (current.pathname === '/login' && current.searchParams.get('error') === 'invalid') return 'INVALID_LOGIN';
  if (current.pathname === '/login') return 'LOGIN';
  return 'UNEXPECTED_PATH';
}

async function writeLoginFailureDiagnostic(
  page: Page,
  context: BrowserContext,
  identity: SyntheticIdentity,
  response: Response | null,
  code: 'ACTION_TIMEOUT' | 'DASHBOARD_TIMEOUT' | 'INVALID_LOGIN' | 'SERVER_ERROR',
) {
  await page.getByLabel('Email').fill('').catch(() => undefined);
  await page.getByLabel('Password').fill('').catch(() => undefined);
  const cookies = await context.cookies(appUrl);
  const userId = identityUserIds[identity];
  writeFileSync(join(evidenceDirectory, `n15-login-failure-${identity}.json`), `${JSON.stringify({
    phase: 'LOGIN', status: 'FAILED', code,
    identity, path: loginPathClassification(page),
    httpStatus: response?.status() ?? null,
    sessionCookiePresent: cookies.some((cookie) => cookie.name === 'fai_n15_browser_session'),
    liveSessionCount: await db.internalSession.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    loginAuditCount: await db.auditLog.count({
      where: { actorId: userId, event: 'login', entityType: 'User', entityId: userId },
    }),
  })}\n`, { mode: 0o600 });
  await page.screenshot({
    path: join(evidenceDirectory, `n15-login-failure-${identity}.png`), fullPage: true,
  }).catch(() => undefined);
}

async function login(context: BrowserContext, email: string, identity: SyntheticIdentity) {
  const page = await context.newPage();
  await page.goto(`${appUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const responseHolder: { current: Response | null } = { current: null };
  try {
    await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return candidate.request().method() === 'POST' && url.origin === appUrl && url.pathname === '/login';
      }, { timeout: 15_000 }).then((candidate) => {
        responseHolder.current = candidate;
        return candidate;
      }),
      page.waitForURL((url) => url.pathname === '/dashboard' ||
        (url.pathname === '/login' && url.searchParams.get('error') === 'invalid'), { timeout: 15_000 }),
      page.getByRole('button', { name: 'Login interno' }).click({ timeout: 15_000 }),
    ]);
  } catch {
    const response = responseHolder.current;
    const code = response === null
      ? 'ACTION_TIMEOUT'
      : response.status() >= 500
        ? 'SERVER_ERROR'
        : loginPathClassification(page) === 'INVALID_LOGIN'
          ? 'INVALID_LOGIN'
          : 'DASHBOARD_TIMEOUT';
    await writeLoginFailureDiagnostic(page, context, identity, response, code);
    throw new Error(`N15_BROWSER_LOGIN_${code}_${identity.toUpperCase()}`);
  }
  const response = responseHolder.current;
  assert.ok(response);
  if (response.status() >= 500) {
    await writeLoginFailureDiagnostic(page, context, identity, response, 'SERVER_ERROR');
    throw new Error(`N15_BROWSER_LOGIN_SERVER_ERROR_${identity.toUpperCase()}`);
  }
  if (loginPathClassification(page) === 'INVALID_LOGIN') {
    await writeLoginFailureDiagnostic(page, context, identity, response, 'INVALID_LOGIN');
    throw new Error(`N15_BROWSER_LOGIN_INVALID_${identity.toUpperCase()}`);
  }
  await expect(page).toHaveURL(`${appUrl}/dashboard`);
  return page;
}

test.afterAll(async () => db.$disconnect());

test('authorized manager assigns and manager/assignee consult the terminal HELD aggregate', async ({ browser }) => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const manager = await browser.newContext();
  const managerPage = await login(manager, 'manager@n15-browser.invalid', 'manager');
  await managerPage.goto(`${appUrl}/settings/security`);
  await managerPage.getByLabel('Password corrente').fill(password);
  await managerPage.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await managerPage.waitForURL(/\/settings\/security\?status=active$/u);

  await managerPage.goto(`${appUrl}/leads/inbox?queue=unassigned`);
  const row = managerPage.locator('article').filter({ hasText: 'Lead sintetico assegnazione N15' });
  await expect(row).toBeVisible();
  await row.locator('select[name="targetUserId"]').selectOption({ label: 'Commerciale Assegnatario N15' });
  await row.getByRole('button', { name: 'Assegna' }).click();
  await expect(row).toHaveCount(0);

  const activity = await db.commercialLeadActivity.findFirstOrThrow({
    where: { inboxItem: { leadId: 'n15-browser-assignment-lead' }, activityType: 'ASSIGNED' },
  });
  assert.equal(activity.actorUserId, 'n15-browser-manager');
  assert.equal(activity.assigneeAfterId, 'n15-browser-commercial-one');
  const records = await db.communicationIntentRecord.findMany({
    where: { intentId: activity.id }, include: { heldDecision: true, auditRecord: true },
  });
  assert.equal(records.length, 1);
  const aggregate = parseCommunicationPersistenceAggregateV1(records[0]!);
  assert.equal(aggregate.intent.recipient.entityId, activity.assigneeAfterId);
  assert.equal(aggregate.decision.toState, 'HELD');

  const leadUrl = `${appUrl}/leads/n15-browser-assignment-lead`;
  await managerPage.goto(leadUrl);
  await expect(managerPage.getByText('HELD significa trattenuta', { exact: false })).toBeVisible();
  await expect(managerPage.getByText('destinatario interno Commerciale Assegnatario N15', { exact: false })).toBeVisible();
  await managerPage.screenshot({ path: join(evidenceDirectory, 'n15-manager-assignment-held.png'), fullPage: true });

  const assignee = await browser.newContext();
  const assigneePage = await login(assignee, 'assigned@n15-browser.invalid', 'assignee');
  await assigneePage.goto(leadUrl);
  await expect(assigneePage.getByText('HELD significa trattenuta', { exact: false })).toBeVisible();
  await assigneePage.screenshot({ path: join(evidenceDirectory, 'n15-assignee-held.png'), fullPage: true });

  const foreign = await browser.newContext();
  const foreignPage = await login(foreign, 'foreign@n15-browser.invalid', 'foreign');
  await foreignPage.goto(leadUrl);
  await expect(foreignPage.getByRole('heading', { name: 'Lead non trovato' })).toBeVisible();
  writeFileSync(join(evidenceDirectory, 'n15-assignment-browser.json'), `${JSON.stringify({
    synthetic: true, managerAssigned: true, recipientDerived: true, aggregateComplete: true,
    aggregateState: 'HELD', managerVisible: true, assigneeVisible: true,
    foreignDirectAccessDenied: true, duplicateCount: records.length,
    communicationSent: false, communicationQueued: false,
  }, null, 2)}\n`, { mode: 0o600 });
  await Promise.all([foreign.close(), assignee.close(), manager.close()]);
});
