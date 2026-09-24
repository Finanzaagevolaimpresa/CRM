import { test, expect, type Page, type Locator } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { purchasedFixture } from '../purchased-service-fixture';
import { handoffPurchasedService } from '../../src/lib/purchased-service-handoff';
import { acceptResponsibility, readResponsibility, savePracticeResponsibility } from '../../src/lib/responsibility';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient(), baseURL = 'http://127.0.0.1:3015';
const password = process.env.M1_BROWSER_PASSWORD!, mode = process.env.PRIVILEGED_ACCESS_MODE;
type Captured = { url: string; action: string; contentType: string; body: string };
async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function capture(page: Page, pathname: string) {
  await page.evaluate(path => {
    const original = window.fetch.bind(window); delete (window as Window & { legacyResponsibilityAction?: Captured }).legacyResponsibilityAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === path) {
        (window as Window & { legacyResponsibilityAction?: Captured }).legacyResponsibilityAction = {
          url: request.url, action, contentType: request.headers.get('content-type')!, body: await request.clone().text(),
        };
        window.fetch = original; return original(request);
      }
      return original(input, init);
    };
  }, pathname);
}
async function requestFrom(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { legacyResponsibilityAction?: Captured }).legacyResponsibilityAction))).toBe(true);
  return page.evaluate(() => (window as Window & { legacyResponsibilityAction?: Captured }).legacyResponsibilityAction!);
}
async function replay(page: Page, request: Captured) {
  return page.request.post(request.url, { headers: { origin: baseURL, 'next-action': request.action, 'content-type': request.contentType }, data: request.body });
}
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['enforced', 'disabled']).toContain(mode); expect(password.length).toBeGreaterThanOrEqual(24);
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(() => db.$disconnect());

test('a legacy context-only edit invalidates acceptance without admitting a new responsibility', async ({ page }) => {
  const f = await purchasedFixture(db, await bcrypt.hash(password, 4));
  const practice = await db.technicalPractice.create({ data: { clientId: f.client.id, title: f.tag + '-context',
    practiceType: 'Synthetic', targetEntity: 'FAI', createdById: f.admin.id } });
  const decision = await db.$transaction(tx => savePracticeResponsibility(tx, f.admin, {
    id: practice.id, expectedEntryId: '', expectedUpdatedAt: practice.updatedAt.toISOString(),
    commercialOwnerId: null, technicalOwnerId: f.tech.id, departmentCode: 'Synthetic', reason: 'Synthetic prior admission',
  }, true), { isolationLevel: 'Serializable' });
  const accepted = await db.$transaction(tx => acceptResponsibility(tx, f.tech, {
    kind: 'TechnicalPractice', id: practice.id, decisionId: decision.id, role: 'tecnico',
  }), { isolationLevel: 'Serializable' });
  const destination = await db.client.create({ data: { type: 'societa', displayName: f.tag + '-destination' } });
  await login(page, f.admin.email);
  const path = '/technical-office/practices/' + practice.id;
  await page.goto(path);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva dati', exact: true }) });
  await capture(page, path);
  await form.getByRole('button', { name: 'Salva dati', exact: true }).click();
  const request = await requestFrom(page);
  expect(request.body).toContain(f.client.id);
  const response = await replay(page, { ...request, body: request.body.replaceAll(f.client.id, destination.id) });
  expect(response.status()).toBeLessThan(400);
  await expect.poll(async () => (await db.technicalPractice.findUniqueOrThrow({ where: { id: practice.id } })).clientId).toBe(destination.id);
  const current = await readResponsibility(db, 'TechnicalPractice', practice.id);
  expect(current.current?.decision).toMatchObject({ allowed: false, departmentCode: null });
  expect(current.valid).toBe(false); expect(current.accepted).toHaveLength(0);
  expect(await db.auditLog.findUniqueOrThrow({ where: { id: accepted.id } })).toEqual(accepted);
  expect(await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).toEqual(f.service);
});

for (const entry of ['lead-update', 'practice-create', 'practice-update', 'practice-assign'] as const) {
  test(`legacy ${entry} requires privileged admission before changing M1 responsibility`, async ({ browser }) => {
    const f = await purchasedFixture(db, await bcrypt.hash(password, 4));
    const context = await browser.newContext({ baseURL }), page = await context.newPage();
    let practiceId: string | null = null, leadId: string | null = null, acceptanceId: string | null = null;
    if (entry === 'practice-update' || entry === 'practice-assign') {
      // Only fixture setup bypasses the UI. The action under test is the real legacy HTTP form.
      const handoff = await db.$transaction(tx => handoffPurchasedService(tx, f.admin, f.input, true), { isolationLevel: 'Serializable' });
      practiceId = handoff.receipt.technicalPracticeId;
      acceptanceId = (await db.$transaction(tx => acceptResponsibility(tx, f.tech, {
        kind: 'TechnicalPractice', id: practiceId!, decisionId: handoff.receipt.decisionId, role: 'tecnico',
      }), { isolationLevel: 'Serializable' })).id;
    }
    if (entry === 'lead-update') leadId = (await db.lead.create({ data: { firstName: f.tag, lastName: 'Legacy', clientId: f.client.id } })).id;
    await login(page, f.admin.email);
    const path = entry === 'lead-update' ? '/leads/' + leadId
      : entry === 'practice-create' ? '/technical-office/practices' : '/technical-office/practices/' + practiceId;
    await page.goto(path + (entry === 'practice-create' ? '?new=1' : ''));
    let form: Locator, button: string;
    if (entry === 'lead-update') {
      button = 'Salva aggiornamenti'; form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
      await form.locator('select[name="assignedToId"]').selectOption(f.admin.id);
    } else if (entry === 'practice-create') {
      button = 'Crea pratica'; form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
      await form.locator('input[name="title"]').fill(f.tag + '-legacy-created');
      await form.locator('input[name="practiceType"]').fill('Synthetic M1');
      await form.locator('select[name="clientId"]').selectOption(f.client.id);
      await form.locator('input[name="targetEntity"]').fill('FAI synthetic');
      await form.locator('select[name="technicalOwnerId"]').selectOption(f.other.id);
    } else if (entry === 'practice-update') {
      button = 'Salva dati'; form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
      // The previous update action accepted this field even when the ordinary UI omitted it.
      await form.evaluate((element, owner) => {
        const input = document.createElement('input'); input.type = 'hidden'; input.name = 'technicalOwnerId'; input.value = owner;
        element.appendChild(input);
      }, f.other.id);
    } else {
      button = 'Assegna'; form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
      await form.locator('select[name="technicalOwnerId"]').selectOption(f.other.id);
    }
    async function snapshot() {
      const practices = await db.technicalPractice.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } });
      return {
        practices, service: await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } }),
        lead: leadId ? await db.lead.findUniqueOrThrow({ where: { id: leadId } }) : null,
        audit: await db.auditLog.findMany({ where: { entityId: { in: [f.client.id, f.service.id, ...practices.map(p => p.id), ...(leadId ? [leadId] : [])] } }, orderBy: { id: 'asc' } }),
      };
    }
    const before = await snapshot();
    await capture(page, path); await form.getByRole('button', { name: button, exact: true }).click();
    const deniedRequest = await requestFrom(page); await expect(page).toHaveURL(/\/settings\/security/);
    expect(await snapshot()).toEqual(before);
    // Direct HTTP replay from the same authenticated admin still lacks the step-up.
    await replay(page, deniedRequest); expect(await snapshot()).toEqual(before);
    if (mode === 'disabled') { await context.close(); return; }
    await page.goto('/settings/security'); await page.getByLabel('Password corrente').fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(page).toHaveURL(/status=active/);
    const result = await replay(page, deniedRequest); expect(result.status()).toBeLessThan(400);
    if (entry === 'lead-update') {
      await expect.poll(async () => (await db.lead.findUniqueOrThrow({ where: { id: leadId! } })).assignedToId).toBe(f.admin.id);
    } else {
      if (entry === 'practice-create') {
        await expect.poll(() => db.technicalPractice.count({ where: { clientId: f.client.id } })).toBe(1);
        practiceId = (await db.technicalPractice.findFirstOrThrow({ where: { clientId: f.client.id } })).id;
      }
      await expect.poll(async () => (await db.technicalPractice.findUniqueOrThrow({ where: { id: practiceId! } })).technicalOwnerId).toBe(f.other.id);
      if (entry !== 'practice-create') {
        expect((await db.clientService.findUniqueOrThrow({ where: { id: f.service.id } })).assignedToId).toBe(f.other.id);
        expect(await db.auditLog.findUniqueOrThrow({ where: { id: acceptanceId! } })).toEqual(before.audit.find(a => a.id === acceptanceId));
      }
    }
    const decision = await db.auditLog.findFirstOrThrow({ where: { entityId: leadId ?? practiceId!, event: 'responsibility_assigned' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(decision.after).toMatchObject({ allowed: true });
    await context.close();
  });
}
