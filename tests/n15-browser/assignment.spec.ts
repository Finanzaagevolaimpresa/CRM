import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { parseCommunicationPersistenceAggregateV1 } from '../../src/lib/communication-intent-persistence';
import { N15_BROWSER_IDENTITIES } from './fixture-identities';

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
type ClientLoadEvent = Readonly<{
  type: 'SCRIPT_HTTP_ERROR' | 'REQUEST_FAILED' | 'PAGE_ERROR' | 'DEV_ORIGIN_BLOCKED';
  scope: 'STATIC_NEXT' | 'LOGIN' | 'OTHER';
  status: number | null;
}>;
const identityUserIds: Record<SyntheticIdentity, string> = {
  manager: N15_BROWSER_IDENTITIES.manager.userId,
  assignee: N15_BROWSER_IDENTITIES.assignee.userId,
  foreign: N15_BROWSER_IDENTITIES.foreign.userId,
};

function loginPathClassification(page: Page) {
  const current = new URL(page.url());
  if (current.origin !== appUrl) return 'UNEXPECTED_ORIGIN';
  if (current.pathname === '/dashboard') return 'DASHBOARD';
  if (current.pathname === '/login' && current.searchParams.get('error') === 'invalid') return 'INVALID_LOGIN';
  if (current.pathname === '/login') return 'LOGIN';
  return 'UNEXPECTED_PATH';
}

function resourceScope(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.origin === appUrl && url.pathname.startsWith('/_next/')) return 'STATIC_NEXT' as const;
    if (url.origin === appUrl && url.pathname === '/login') return 'LOGIN' as const;
  } catch { /* retain the finite OTHER classification */ }
  return 'OTHER' as const;
}

function collectClientLoadEvents(page: Page) {
  const events: ClientLoadEvent[] = [];
  const append = (event: ClientLoadEvent) => { if (events.length < 40) events.push(event); };
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script' && response.status() >= 400) {
      append({ type: 'SCRIPT_HTTP_ERROR', scope: resourceScope(response.url()), status: response.status() });
    }
  });
  page.on('requestfailed', (request) => {
    append({ type: 'REQUEST_FAILED', scope: resourceScope(request.url()), status: null });
  });
  page.on('pageerror', () => append({ type: 'PAGE_ERROR', scope: 'OTHER', status: null }));
  page.on('console', (message) => {
    if (message.type() === 'warning' && /Blocked cross-origin request to Next\.js dev resource/iu.test(message.text())) {
      append({ type: 'DEV_ORIGIN_BLOCKED', scope: 'STATIC_NEXT', status: null });
    }
  });
  return events;
}

function writeClientLoadFailure(identity: SyntheticIdentity, events: readonly ClientLoadEvent[]) {
  writeFileSync(join(evidenceDirectory, `n15-client-load-failure-${identity}.json`), `${JSON.stringify({
    phase: 'CLIENT_LOAD', status: 'FAILED', code: 'HYDRATION_UNAVAILABLE',
    identity, eventCount: events.length, events,
  })}\n`, { mode: 0o600 });
}

async function waitForInteractiveReady(page: Page) {
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
}

async function responseBodyClassification(response: Response | null) {
  if (!response) return { kind: 'UNAVAILABLE', markers: {} };
  let body = '';
  try {
    body = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 2_000)),
    ]);
  } catch { /* the finite classification is sufficient */ }
  const sample = body.slice(0, 64 * 1024);
  return {
    kind: sample.length === 0
      ? 'EMPTY'
      : /^\s*</u.test(sample)
        ? 'HTML'
        : /(?:^|\n)[0-9]+:/u.test(sample)
          ? 'RSC'
          : 'OTHER',
    markers: {
      originOrHostMismatch: /origin|host.*mismatch|does not match/iu.test(sample),
      missingOrUnknownAction: /failed to find server action|unknown server action|missing.*action/iu.test(sample),
      invalidActionRequest: /invalid.*server action|invalid action request/iu.test(sample),
      compilationOrModuleError: /module not found|failed to compile|compilation error/iu.test(sample),
      registryError: /internal_session|registry/iu.test(sample),
      prismaError: /prisma/iu.test(sample),
    },
  };
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
  const responseBody = await responseBodyClassification(response);
  writeFileSync(join(evidenceDirectory, `n15-login-failure-${identity}.json`), `${JSON.stringify({
    phase: 'LOGIN', status: 'FAILED', code,
    identity, path: loginPathClassification(page),
    httpStatus: response?.status() ?? null,
    responseBody,
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
  const clientLoadEvents = collectClientLoadEvents(page);
  await page.goto(`${appUrl}/login`);
  try {
    await waitForInteractiveReady(page);
  } catch {
    writeClientLoadFailure(identity, clientLoadEvents);
    throw new Error(`N15_BROWSER_CLIENT_LOAD_FAILED_${identity.toUpperCase()}`);
  }
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
  const managerPage = await login(manager, N15_BROWSER_IDENTITIES.manager.email, 'manager');
  await managerPage.goto(`${appUrl}/settings/security`);
  await waitForInteractiveReady(managerPage);
  await managerPage.getByLabel('Password corrente').fill(password);
  await managerPage.getByRole('button', { name: 'Conferma per cinque minuti' }).click();
  await managerPage.waitForURL(/\/settings\/security\?status=active$/u);

  await managerPage.goto(`${appUrl}/leads/inbox?queue=unassigned`);
  await waitForInteractiveReady(managerPage);
  const row = managerPage.locator('article').filter({ hasText: 'Lead sintetico assegnazione N15' });
  await expect(row).toBeVisible();
  await row.locator('select[name="targetUserId"]').selectOption({ label: 'Commerciale Assegnatario N15' });
  const [assignmentResponse] = await Promise.all([
    managerPage.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' && url.origin === appUrl && url.pathname === '/leads/inbox';
    }),
    row.getByRole('button', { name: 'Assegna' }).click(),
  ]);
  expect(assignmentResponse.status()).toBeLessThan(400);
  await expect(row).toHaveCount(0);

  const assignedLead = await db.lead.findUniqueOrThrow({ where: { id: 'n15-browser-assignment-lead' } });
  assert.equal(assignedLead.assignedToId, N15_BROWSER_IDENTITIES.assignee.userId);
  const activity = await db.commercialLeadActivity.findFirstOrThrow({
    where: { inboxItem: { leadId: 'n15-browser-assignment-lead' }, activityType: 'ASSIGNED' },
  });
  assert.equal(activity.actorUserId, N15_BROWSER_IDENTITIES.manager.userId);
  assert.equal(activity.assigneeAfterId, N15_BROWSER_IDENTITIES.assignee.userId);
  const records = await db.communicationIntentRecord.findMany({
    where: { intentId: activity.id }, include: { heldDecision: true, auditRecord: true },
  });
  assert.equal(records.length, 1);
  const aggregate = parseCommunicationPersistenceAggregateV1(records[0]!);
  assert.equal(aggregate.intent.recipient.entityId, activity.assigneeAfterId);
  assert.equal(aggregate.decision.toState, 'HELD');

  const leadUrl = `${appUrl}/leads/n15-browser-assignment-lead`;
  await managerPage.goto(leadUrl);
  const managerN15Card = managerPage.getByRole('heading', { name: 'Comunicazioni assegnazione N15' })
    .locator('..').locator('..').locator('..');
  await managerN15Card.scrollIntoViewIfNeeded();
  await expect(managerN15Card.getByText('HELD significa trattenuta', { exact: false })).toBeVisible();
  await expect(managerN15Card.getByText('destinatario interno Commerciale Assegnatario N15', { exact: false })).toBeVisible();
  await managerN15Card.screenshot({ path: join(evidenceDirectory, 'n15-manager-assignment-held.png') });

  const assignee = await browser.newContext();
  const assigneePage = await login(assignee, N15_BROWSER_IDENTITIES.assignee.email, 'assignee');
  await assigneePage.goto(leadUrl);
  const assigneeN15Card = assigneePage.getByRole('heading', { name: 'Comunicazioni assegnazione N15' })
    .locator('..').locator('..').locator('..');
  await assigneeN15Card.scrollIntoViewIfNeeded();
  await expect(assigneeN15Card.getByText('HELD significa trattenuta', { exact: false })).toBeVisible();
  await expect(assigneeN15Card.getByText('destinatario interno Commerciale Assegnatario N15', { exact: false })).toBeVisible();
  await assigneeN15Card.screenshot({ path: join(evidenceDirectory, 'n15-assignee-held.png') });

  const foreign = await browser.newContext();
  const foreignPage = await login(foreign, N15_BROWSER_IDENTITIES.foreign.email, 'foreign');
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
