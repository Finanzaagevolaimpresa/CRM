import { test, expect, type Page } from '@playwright/test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { commercialOriginEvents } from '../../src/lib/commercial-origin-contract';

const db = new PrismaClient(), baseURL = 'http://127.0.0.1:3015', run = randomUUID(), tag = `Origin-${run}`;
const password = process.env.M1_BROWSER_PASSWORD!, mode = process.env.PRIVILEGED_ACCESS_MODE;
const email = (who: string) => `origin-${who}-${run}@example.test`;
const ids: Record<string, string> = {};
let clientId: string, foreignId: string;
type Captured = { url: string; action: string; contentType: string; body: string };
async function login(page: Page, who: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email(who)); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function capture(page: Page, path: string) {
  await page.evaluate(pathname => {
    const original = window.fetch.bind(window);
    delete (window as Window & { originAction?: Captured }).originAction;
    window.fetch = async (input, init) => {
      const request = new Request(input, init), action = request.headers.get('next-action');
      if (request.method === 'POST' && action && new URL(request.url).pathname === pathname) {
        (window as Window & { originAction?: Captured }).originAction = { url: request.url, action, contentType: request.headers.get('content-type')!, body: await request.clone().text() };
        window.fetch = original; return original(request);
      }
      return original(input, init);
    };
  }, path);
}
async function captured(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { originAction?: Captured }).originAction))).toBe(true);
  return page.evaluate(() => (window as Window & { originAction?: Captured }).originAction!);
}
async function replay(page: Page, request: Captured) {
  return page.request.post(request.url, { headers: { origin: baseURL, 'next-action': request.action, 'content-type': request.contentType }, data: request.body });
}
const originRows = () => db.auditLog.findMany({ where: { entityId: clientId, entityType: 'Client', event: { in: [...commercialOriginEvents] } }, orderBy: { createdAt: 'asc' } });
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  expect(['enforced', 'disabled']).toContain(mode); expect(password.length).toBeGreaterThanOrEqual(24);
  const passwordHash = await bcrypt.hash(password, 4);
  for (const [who, role] of [['admin', 'admin'], ['original', 'commerciale'], ['current', 'commerciale'], ['next', 'commerciale']] as Array<[string, RoleCode]>) {
    ids[who] = (await db.user.create({ data: { email: email(who), name: tag + '-' + who, role, passwordHash } })).id;
  }
  clientId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-client', salesOwnerId: ids.current } })).id;
  foreignId = (await db.client.create({ data: { type: 'societa', displayName: tag + '-foreign' } })).id;
  if (mode === 'enforced') await db.applicationKeyVersion.upsert({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: 1 } },
    create: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) }, update: {} });
});
test.afterAll(() => db.$disconnect());

test('documented origin is admin-only, versioned and independent of current assignment and historical account removal', async ({ browser }) => {
  const adminContext = await browser.newContext({ baseURL }), readerContext = await browser.newContext({ baseURL }), originalContext = await browser.newContext({ baseURL });
  const admin = await adminContext.newPage(), reader = await readerContext.newPage(), original = await originalContext.newPage();
  await login(admin, 'admin'); await login(reader, 'current'); await login(original, 'original');
  const path = `/clients/${clientId}/commercial-origin`, search = path + '?q=' + encodeURIComponent(tag);
  const originalClient = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  await reader.goto(path); await expect(reader.getByText('Provenienza non ancora documentata', { exact: true })).toBeVisible();
  await expect(reader.getByRole('form', { name: 'Provenienza commerciale', exact: true })).toHaveCount(0);
  await original.goto(path); await expect(original.getByRole('heading', { name: 'Provenienza non accessibile', exact: true })).toBeVisible();
  await admin.goto(search);
  const form = admin.getByRole('form', { name: 'Provenienza commerciale', exact: true });
  async function fillInitial() {
    await form.getByLabel('Acquisizione cliente', { exact: true }).selectOption(ids.original);
    await form.getByLabel('Contrattualizzazione', { exact: true }).selectOption(ids.original);
    await form.getByLabel('Riferimento alla prova', { exact: true }).fill(tag + '-archive');
    await form.getByLabel('Motivo della registrazione', { exact: true }).fill('Recorded against the synthetic original evidence');
  }
  await fillInitial(); await capture(admin, path); await form.getByRole('button', { name: 'Registra provenienza', exact: true }).click();
  const initialRequest = await captured(admin); await expect(admin).toHaveURL(/\/settings\/security/);
  expect(await originRows()).toHaveLength(0);
  await replay(reader, initialRequest); expect(await originRows()).toHaveLength(0);
  if (mode === 'disabled') { await adminContext.close(); await readerContext.close(); await originalContext.close(); return; }
  await admin.goto('/settings/security'); await admin.getByLabel('Password corrente').fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti' }).click(); await expect(admin).toHaveURL(/status=active/);
  await admin.goto(search); await fillInitial(); await form.getByRole('button', { name: 'Registra provenienza', exact: true }).click();
  await expect.poll(async () => (await originRows()).length).toBe(1);
  const first = (await originRows())[0];
  expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toEqual(originalClient);
  await reader.goto(path); await expect(reader.getByText('Acquisizione: ' + tag + '-original', { exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Registra rettifica' })).toHaveCount(0);
  await original.goto(path); await expect(original.getByRole('heading', { name: 'Provenienza non accessibile', exact: true })).toBeVisible();
  await replay(admin, initialRequest); expect(await originRows()).toHaveLength(1);
  // Reassign through the existing admin UI; the original provenance remains byte-for-byte unchanged.
  await admin.goto('/clients/' + clientId);
  const owners = admin.getByRole('form', { name: 'Assegna responsabili', exact: true });
  await owners.getByLabel('Responsabile commerciale', { exact: true }).selectOption(ids.next);
  await owners.getByRole('button', { name: 'Salva responsabili' }).click();
  await expect.poll(() => db.client.findUniqueOrThrow({ where: { id: clientId } }).then(c => c.salesOwnerId)).toBe(ids.next);
  expect(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
  await reader.goto(path); await expect(reader.getByRole('heading', { name: 'Provenienza non accessibile', exact: true })).toBeVisible();
  await admin.goto(search);
  await form.getByLabel('Contrattualizzazione', { exact: true }).selectOption(ids.current);
  await form.getByLabel('Motivo della rettifica', { exact: true }).fill('Corrected using a different synthetic contract evidence');
  await form.getByRole('button', { name: 'Registra rettifica', exact: true }).click();
  await expect.poll(async () => (await originRows()).length).toBe(2);
  expect(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
  expect((await originRows())[1].after).toMatchObject({ revision: 2, predecessorId: first.id, acquiredById: ids.original, contractedById: ids.current });
  // The origin is historical: logical removal never reassigns it or grants renewed access.
  await db.user.update({ where: { id: ids.original }, data: { active: false, deletedAt: new Date() } });
  await admin.goto(path); await expect(admin.getByText('Acquisizione: ' + tag + '-original (rimosso)', { exact: true })).toBeVisible();
  expect(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
  await original.goto(path); await expect(original).toHaveURL(/\/login/);
  await reader.goto(`/clients/${foreignId}/commercial-origin`);
  await expect(reader.getByRole('heading', { name: 'Provenienza non accessibile', exact: true })).toBeVisible();
  await adminContext.close(); await readerContext.close(); await originalContext.close();
});

test('origin history and identity search remain reachable after the first page', async ({ page }) => {
  await login(page, 'admin');
  let predecessorId: string | null = null;
  for (let revision = 1; revision <= 27; revision++) {
    const entry = await db.auditLog.create({ data: { entityType: 'Client', entityId: foreignId, actorId: ids.admin,
      event: revision === 1 ? commercialOriginEvents[0] : commercialOriginEvents[1], createdAt: new Date(Date.UTC(2020, 0, 1) + revision * 1000),
      after: { protocol: 'R05_COMMERCIAL_ORIGIN_V1', clientId: foreignId, revision, predecessorId, acquiredById: ids.current, contractedById: null,
        sourceReference: 'Synthetic paging evidence', reason: `Synthetic evidence clarification revision ${revision}` } } });
    predecessorId = entry.id;
  }
  const pagingTag = tag + '-identity';
  for (let index = 0; index < 27; index++) await db.user.create({ data: { email: `origin-page-${run}-${index}@example.test`, name: `${pagingTag}-${index}`, role: 'commerciale', passwordHash: 'synthetic-no-login' } });
  const path = `/clients/${foreignId}/commercial-origin`;
  await page.goto(path); await page.getByRole('link', { name: 'Versioni precedenti', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Revisione 1', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Versioni precedenti', exact: true })).toHaveCount(0);
  await page.goto(path + '?q=' + encodeURIComponent(pagingTag));
  await page.getByRole('link', { name: 'Altre identità', exact: true }).click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.getByRole('link', { name: 'Altre identità', exact: true })).toHaveCount(0);
  expect(await page.locator('select[name="acquiredById"] option').allTextContents()).toHaveLength(4); // unknown + current historical identity + final two matches
});
