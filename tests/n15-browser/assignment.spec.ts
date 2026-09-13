import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';
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

async function login(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto(`${appUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await page.waitForURL((url) => url.pathname === '/dashboard');
  return page;
}

test.afterAll(async () => db.$disconnect());

test('authorized manager assigns and manager/assignee consult the terminal HELD aggregate', async ({ browser }) => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const manager = await browser.newContext();
  const managerPage = await login(manager, 'manager@n15-browser.invalid');
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
  const assigneePage = await login(assignee, 'assigned@n15-browser.invalid');
  await assigneePage.goto(leadUrl);
  await expect(assigneePage.getByText('HELD significa trattenuta', { exact: false })).toBeVisible();
  await assigneePage.screenshot({ path: join(evidenceDirectory, 'n15-assignee-held.png'), fullPage: true });

  const foreign = await browser.newContext();
  const foreignPage = await login(foreign, 'foreign@n15-browser.invalid');
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
