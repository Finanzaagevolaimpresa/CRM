import { test, expect, type Page } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient(), baseURL = 'http://127.0.0.1:3015', run = randomUUID(), tag = `Responsibility-${run}`;
const password = process.env.M1_BROWSER_PASSWORD!, mode = process.env.PRIVILEGED_ACCESS_MODE;
const email = (who: string) => `resp-${who}-${run}@example.test`, ids: Record<string, string> = {};
let clientId: string, practiceId: string;
type Captured = { url: string; action: string; contentType: string; body: string };
async function login(page: Page, who: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(who)); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function capture(page: Page, path: string) {
  await page.evaluate(pathname => {
    const original = window.fetch.bind(window); delete (window as Window & { responsibilityAction?: Captured }).responsibilityAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === pathname) {
        (window as Window & { responsibilityAction?: Captured }).responsibilityAction = { url: request.url, action, contentType: request.headers.get('content-type')!, body: await request.clone().text() };
        window.fetch = original; return original(request);
      } return original(input, init);
    };
  }, path);
}
async function captured(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { responsibilityAction?: Captured }).responsibilityAction))).toBe(true);
  return page.evaluate(() => (window as Window & { responsibilityAction?: Captured }).responsibilityAction!);
}
async function replay(page: Page, request: Captured) {
  return page.request.post(request.url, { headers: { origin: baseURL, 'next-action': request.action, 'content-type': request.contentType }, data: request.body });
}
const decisions = () => db.auditLog.findMany({ where: { entityId: practiceId, entityType: 'TechnicalPractice', event: 'responsibility_assigned' }, orderBy: { createdAt: 'asc' } });
const acceptances = () => db.auditLog.findMany({ where: { entityId: practiceId, entityType: 'TechnicalPractice', event: 'responsibility_accepted' }, orderBy: { createdAt: 'asc' } });
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(['enforced', 'disabled']).toContain(mode); expect(password.length).toBeGreaterThanOrEqual(24);
  for (const [who, role] of [['admin', 'admin'], ['sales', 'commerciale'], ['tech', 'consulente'], ['other', 'consulente']] as Array<[string, RoleCode]>) {
    ids[who] = (await db.user.create({ data: { email: email(who), name: tag + '-' + who, role, passwordHash: await bcrypt.hash(password, 4) } })).id;
  }
  clientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-client' } })).id;
  practiceId = (await db.technicalPractice.create({ data: { clientId, title: tag + '-practice', practiceType: 'Synthetic', targetEntity: 'FAI', createdById: ids.admin } })).id;
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(() => db.$disconnect());

test('department does not grant access; actual admin decisions and personal acceptance remain distinct across reassignments', async ({ browser }) => {
  const ac = await browser.newContext({ baseURL }), tc = await browser.newContext({ baseURL }), oc = await browser.newContext({ baseURL });
  const admin = await ac.newPage(), tech = await tc.newPage(), other = await oc.newPage();
  await login(admin, 'admin'); await login(tech, 'tech'); await login(other, 'other');
  const path = `/assignments/TechnicalPractice/${practiceId}`, search = path + '?q=' + encodeURIComponent(tag);
  const form = admin.getByRole('form', { name: 'Decisione responsabilità', exact: true });
  async function assign(technicalOwnerId: string) {
    await admin.goto(search);
    await form.getByLabel('Responsabile commerciale', { exact: true }).selectOption(ids.sales);
    await form.getByLabel('Reparto tecnico', { exact: true }).fill('Tecnico sintetico');
    await form.getByLabel('Referente tecnico', { exact: true }).selectOption(technicalOwnerId);
    await form.getByLabel('Motivazione', { exact: true }).fill('Explicit decision for the synthetic assigned work');
    await capture(admin, path); await form.getByRole('button', { name: 'Registra decisione', exact: true }).click();
    return captured(admin);
  }
  const initial = await assign(''); await expect(admin).toHaveURL(/\/settings\/security/);
  expect(await decisions()).toHaveLength(0); await replay(tech, initial); expect(await decisions()).toHaveLength(0);
  if (mode === 'disabled') { await ac.close(); await tc.close(); await oc.close(); return; }
  await admin.getByLabel('Password corrente').fill(password); await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  await assign(''); await expect.poll(async () => (await decisions()).length).toBe(1);
  await expect(admin.getByText('Referente individuale mancante: presa in carico tecnica non avvenuta.', { exact: true })).toBeVisible();
  await tech.goto(path); await expect(tech.getByRole('heading', { name: 'Responsabilità e presa in carico', exact: true })).toHaveCount(0);
  expect(await acceptances()).toHaveLength(0);
  await assign(ids.tech); await expect.poll(async () => (await decisions()).length).toBe(2);
  await tech.goto('/assignments?kind=TechnicalPractice'); await tech.getByRole('link', { name: tag + '-practice', exact: true }).click();
  await capture(tech, path); await tech.getByRole('button', { name: 'Confermo la presa in carico tecnico', exact: true }).click();
  const acceptedRequest = await captured(tech); await expect.poll(async () => (await acceptances()).length).toBe(1);
  const history = await acceptances(); expect(history[0].actorId).toBe(ids.tech);
  await replay(tech, acceptedRequest); expect(await acceptances()).toEqual(history);
  const denied = await replay(admin, acceptedRequest); expect(await denied.text()).toContain('Solo il referente individuale corrente');
  await replay(other, acceptedRequest); expect(await acceptances()).toEqual(history);
  await other.goto(path); await expect(other.getByRole('heading', { name: 'Responsabilità e presa in carico', exact: true })).toHaveCount(0);
  await assign(ids.other); await expect.poll(async () => (await decisions()).length).toBe(3);
  await tech.goto(path); await expect(tech.getByRole('heading', { name: 'Responsabilità e presa in carico', exact: true })).toHaveCount(0);
  await replay(tech, acceptedRequest); expect(await acceptances()).toEqual(history);
  await assign(ids.tech); await expect.poll(async () => (await decisions()).length).toBe(4);
  await tech.goto(path); await expect(tech.getByRole('button', { name: 'Confermo la presa in carico tecnico', exact: true })).toBeVisible();
  await replay(tech, acceptedRequest); expect(await acceptances()).toEqual(history);
  await tech.getByRole('button', { name: 'Confermo la presa in carico tecnico', exact: true }).click(); await expect.poll(async () => (await acceptances()).length).toBe(2);
  expect(await db.auditLog.findUniqueOrThrow({ where: { id: history[0].id } })).toEqual(history[0]);
  expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({ salesOwnerId: null, consultantId: null });
  await ac.close(); await tc.close(); await oc.close();
});

test('personal work list is pageable and does not include another assignee', async ({ page }) => {
  const created: string[] = [];
  for (let n = 0; n < 28; n++) created.push((await db.lead.create({ data: { firstName: 'Synthetic', lastName: `queue-${n}`, companyName: `${tag}-queue-${n}`, assignedToId: ids.sales } })).id);
  const foreign = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Foreign', companyName: tag + '-foreign', assignedToId: ids.other } });
  await login(page, 'sales');
  await page.getByRole('link', { name: 'Le mie assegnazioni', exact: true }).first().click();
  await expect(page.getByRole('link', { name: tag + '-foreign', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Altre assegnazioni', exact: true }).click();
  await expect(page).toHaveURL(/after=/); await expect(page.getByRole('link', { name: 'Altre assegnazioni', exact: true })).toHaveCount(0);
  const last = await db.lead.findFirstOrThrow({ where: { id: { in: created } }, orderBy: { id: 'desc' } });
  await expect(page.getByRole('link', { name: last.companyName!, exact: true })).toBeVisible();
  await page.goto(`/assignments/Lead/${foreign.id}`); await expect(page.getByRole('heading', { name: 'Responsabilità e presa in carico', exact: true })).toHaveCount(0);
});
