import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticSession } from '../selective-sharing/fixtures';
import { revokeTechnical } from '../technical-assignments/fixtures';
import { technicalWorkPath } from '../../src/lib/technical-assignment-display';

type Person = { id: string; email: string };
const db = new PrismaClient(), evidence = process.env.SHARED_EVIDENCE!, password = process.env.SHARED_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; admin: Person; tech: Person; second: Person; sales: Person; otherSales: Person; stranger: Person;
  clientId: string; projectId: string; practiceId: string; siblingId: string; leadId: string; paymentId: string; contractId: string;
};
const origin = 'http://127.0.0.1:3060';
const panel = (page: Page) => page.getByTestId('shared-operational-panel');
async function login(page: Page, person: Person) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function open(page: Page, route = '/operational-updates/practice/' + f.practiceId) {
  await page.goto(route);
  await expect(panel(page)).toHaveAttribute('data-server-time', /.+/);
  return panel(page);
}
test.beforeAll(async () => {
  expect(process.env.SHARED_BROWSER_CONFIRMED).toBe('1'); expect(f.synthetic).toBe(true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
});
test.afterAll(async () => db.$disconnect());

test('native assigned save updates the same event in three already-open views and the internal notice, with measured latency', async ({ browser }) => {
  const ac = await browser.newContext(), tc = await browser.newContext(), cc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(), sales = await cc.newPage();
  await login(admin, f.admin); await login(tech, f.tech); await login(sales, f.sales);
  const client = await ac.newPage(), project = await ac.newPage(), notices = await cc.newPage();
  await open(admin, '/technical-office/practices/' + f.practiceId);
  await open(client, '/clients/' + f.clientId); await open(project, '/projects/' + f.projectId);
  await open(tech, technicalWorkPath({ kind: 'TechnicalPractice', targetId: f.practiceId }));
  await open(sales); await notices.goto('/notifications/updates');
  await expect(panel(tech).getByRole('region', { name: 'Dati cliente e referente' })).toContainText('CAP: 00001');
  await expect(panel(tech)).toContainText('SDI: SYN0001');
  const body = 'Avanzamento browser sintetico ' + randomUUID();
  await panel(tech).getByLabel('Testo operativo condiviso', { exact: true }).fill(body);
  await panel(tech).getByLabel('Stato da aggiornare esplicitamente').selectOption('in_progettazione');
  const started = performance.now();
  await panel(tech).getByRole('button', { name: 'Salva e notifica', exact: true }).click();
  await expect(panel(tech).getByRole('status')).toContainText('Aggiornamento salvato');
  const latency = await Promise.all([['practice', admin], ['client', client], ['project', project], ['commercial', sales]].map(async ([name, value]) => {
    await expect(panel(value as Page).getByText(body, { exact: true })).toBeVisible({ timeout: 15_000 });
    return { view: name as string, millisecondsFromClick: Math.round(performance.now() - started), visibility: await (value as Page).evaluate(() => document.visibilityState) };
  }));
  const saved = await db.sharedOperationalUpdate.findFirstOrThrow({ where: { text: body } });
  for (const page of [admin, client, project, sales]) await expect(panel(page).locator('[data-event-id="' + saved.id + '"]')).toBeVisible();
  const deliveries = await db.recordUpdateDelivery.findMany({ where: { eventId: saved.id } });
  expect(deliveries.map(row => row.recipientId).sort()).toEqual([f.admin.id, f.sales.id].sort());
  const salesNotice = deliveries.find(row => row.recipientId === f.sales.id)!;
  await expect(notices.locator('a[href="/notifications/updates/' + salesNotice.id + '"]')).toBeVisible({ timeout: 15_000 });
  writeFileSync(path.join(evidence, 'latency.json'), JSON.stringify({ synthetic: true, at: new Date().toISOString(),
    periodMilliseconds: 3000, eventId: saved.id, latency, noticeMillisecondsFromClick: Math.round(performance.now() - started) }, null, 2));
  await notices.goto('/notifications/updates/' + salesNotice.id);
  await expect(notices.getByRole('link', { name: 'Apri scheda', exact: true })).toHaveAttribute('href', '/operational-updates/practice/' + f.practiceId);
  await notices.getByRole('button', { name: 'Segna come letto', exact: true }).click();
  await expect(notices.getByText(/Segnato come letto il/)).toBeVisible();
  expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: salesNotice.id } })).readAt).not.toBeNull();
  await tech.reload(); await expect(panel(tech).getByText(body, { exact: true })).toBeVisible();
  await tech.setViewportSize({ width: 390, height: 844 });
  expect(await tech.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await tech.screenshot({ path: path.join(evidence, 'technical-shared-mobile.png'), fullPage: true });
  await ac.close(); await tc.close(); await cc.close();
});

test('second nominal technician can read the permitted panel; outsiders, another commercial and financial direct URLs stay denied', async ({ browser }) => {
  for (const person of [f.second, f.stranger, f.otherSales, f.sales]) {
    const context = await browser.newContext(), page = await context.newPage();
    await login(page, person);
    const response = await context.request.get('/api/operational-updates?kind=PRACTICE&id=' + f.practiceId);
    if ([f.second.id, f.sales.id].includes(person.id)) {
      expect(response.status()).toBe(200);
      expect(await response.text()).not.toContain('PRIVATE_');
      await open(page);
      if (person.id === f.sales.id) await expect(panel(page).getByRole('button', { name: 'Salva e notifica', exact: true })).toHaveCount(0);
    } else { expect(response.status()).toBe(404); expect(await response.text()).not.toContain(f.practiceId); }
    if (person.id === f.second.id) {
      expect((await context.request.get('/api/operational-updates?kind=PRACTICE&id=' + f.siblingId)).status()).toBe(404);
      for (const route of ['/payments/' + f.paymentId + '/collection', '/contracts/' + f.contractId]) {
        const denied = await context.request.get(route);
        expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain('PRIVATE_');
      }
    }
    await context.close();
  }
});

test('Admin inline confirmation retains the draft and applies only the explicit Client operational state', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, f.admin); await open(page, '/operational-updates/client/' + f.clientId);
  const before = await db.client.findUniqueOrThrow({ where: { id: f.clientId } });
  const text = 'Aggiornamento Admin sintetico ' + randomUUID();
  await panel(page).getByLabel('Testo operativo condiviso', { exact: true }).fill(text);
  await panel(page).getByLabel('Stato da aggiornare esplicitamente').selectOption('in_attesa_cliente');
  await panel(page).getByRole('button', { name: 'Salva e notifica', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro' })).toBeVisible();
  expect(await db.sharedOperationalUpdate.count({ where: { text } })).toBe(0);
  await expect(panel(page).getByLabel('Testo operativo condiviso', { exact: true })).toHaveValue(text);
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Riconferma identità se la finestra è scaduta' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Salva e notifica', exact: true }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'Aggiornamento salvato' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Storico condiviso' }).getByText(text, { exact: true })).toBeVisible();
  const after = await db.client.findUniqueOrThrow({ where: { id: f.clientId } });
  expect(after.status).toBe(before.status); expect(after.operationalState).toBe('in_attesa_cliente');
  await context.close();
});

test('response loss, reload, outcome reconciliation and captured replay retain one persisted event', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, f.second); await open(page);
  const text = 'Risposta persa sintetica ' + randomUUID();
  await panel(page).getByLabel('Testo operativo condiviso', { exact: true }).fill(text);
  let captured: { url: string; body: string; headers: Record<string, string> } | undefined;
  let done!: () => void, fail!: (error: unknown) => void;
  const intercepted = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route('**/operational-updates/practice/**', async route => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.headers()['next-action']) return route.continue();
    try {
      captured = { url: request.url(), body: request.postData()!, headers: { 'next-action': request.headers()['next-action'],
        'content-type': request.headers()['content-type'], origin } };
      const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done();
    } catch (error) { fail(error); }
  });
  await panel(page).getByRole('button', { name: 'Salva e notifica', exact: true }).click(); await intercepted;
  await page.unroute('**/operational-updates/practice/**');
  expect(await db.sharedOperationalUpdate.count({ where: { text } })).toBe(1);
  await page.reload();
  await panel(page).getByRole('button', { name: 'Verifica esito e chiudi il tentativo', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('Aggiornamento salvato');
  expect(captured).toBeTruthy();
  await context.request.post(captured!.url, { headers: captured!.headers, data: captured!.body });
  expect(await db.sharedOperationalUpdate.count({ where: { text } })).toBe(1);
  await context.close();
});

test('an open technical draft loses its access after nominal revocation; the retained audit remains available to Admin', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, f.tech); await open(page);
  const text = 'Bozza conservata dopo revoca ' + randomUUID();
  await panel(page).getByLabel('Testo operativo condiviso', { exact: true }).fill(text);
  const user = await db.user.findUniqueOrThrow({ where: { id: f.admin.id } });
  const admin = { user, ...await syntheticSession(db, user) };
  await revokeTechnical(db, admin, { kind: 'TechnicalPractice', targetId: f.practiceId },
    { user: await db.user.findUniqueOrThrow({ where: { id: f.tech.id } }), ...await syntheticSession(db, await db.user.findUniqueOrThrow({ where: { id: f.tech.id } })) });
  await expect(panel(page)).toHaveAttribute('data-server-time', '', { timeout: 15_000 });
  await expect(panel(page).getByLabel('Testo operativo condiviso', { exact: true })).toHaveValue(text);
  await expect(panel(page).getByRole('button', { name: 'Salva e notifica', exact: true })).toBeDisabled();
  expect((await context.request.get('/api/operational-updates?kind=PRACTICE&id=' + f.practiceId)).status()).toBe(404);
  expect(await db.sharedOperationalUpdate.count({ where: { text } })).toBe(0);
  expect(await db.sharedOperationalUpdate.count({ where: { practiceId: f.practiceId } })).toBeGreaterThan(0);
  await context.close();
});
