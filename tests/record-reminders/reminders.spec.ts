import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { revokeTechnical } from '../technical-assignments/fixtures';
import { revokeAllInternalSessions } from '../../src/lib/internal-session-registry';

type Person = { id: string; name: string; email: string };
type Row = { projectId: string; practiceId: string; taskId: string; title: string; excludedTaskId: string };
type Fixture = { synthetic: boolean; admin: Person; otherAdmin: Person; techA: Person; techB: Person;
  salesA: Person; salesB: Person; clientId: string; otherClientId: string; clientTaskId: string; rows: Row[] };
const db = new PrismaClient(), evidence = process.env.RECORD_REMINDER_EVIDENCE!;
const f: Fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8'));
const password = process.env.RECORD_REMINDER_BROWSER_PASSWORD!;
const setupPath = (row: Row) => `/record-reminders/PRACTICE/${row.practiceId}`;
const managementPath = (id: string) => `/notifications/reminders/${id}`;
const noticePath = (id: string) => `/notifications/updates/${id}`;
const futureMinute = (minutes = 5) => Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000;
const romeInput = (millis: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(millis)).replace(' ', 'T');

async function login(page: Page, person = f.admin, stepUp = person.id === f.admin.id) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function screen(page: Page, label: string, width: number) {
  await page.setViewportSize({ width, height: 950 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, `${label}-${width}.png`), fullPage: true });
}
async function open(page: Page, row: Row) {
  await page.goto(setupPath(row));
  await expect(page.getByTestId('record-reminder-form')).toHaveAttribute('data-interactive-ready', 'true');
  await expect(page.getByRole('option', { name: /Pagamento contratto/ })).toHaveCount(0);
}
async function select(page: Page, taskId: string, at: number, people: Person[], group = false) {
  await page.getByLabel('Attività con scadenza', { exact: true }).selectOption(taskId);
  await page.getByLabel('Data e ora del promemoria', { exact: true }).fill(romeInput(at));
  for (const person of people) await page.getByRole('checkbox', { name: new RegExp(person.email.replaceAll('.', '\\.')) }).check();
  if (group) await page.getByRole('checkbox', { name: 'Ufficio tecnico · consulenti e backoffice', exact: true }).check();
  await page.getByRole('button', { name: 'Controlla il promemoria', exact: true }).click();
}
async function preview(page: Page, row: Row, at: number, people = [f.techA, f.techB], group = false) {
  await open(page, row); await select(page, row.taskId, at, people, group);
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria' })).toContainText(new Date(at).toISOString());
}
async function confirm(page: Page) {
  await page.getByRole('checkbox', { name: 'Confermo questo istante e questi destinatari per l’avviso CRM', exact: true }).check();
  await page.getByRole('button', { name: 'Programma promemoria', exact: true }).click();
}
async function recorded(page: Page) {
  await expect(page.getByRole('status')).toContainText('Promemoria registrato');
  const id = new URL(page.url()).searchParams.get('reminderDecision'); expect(id).toMatch(/^[a-f0-9-]{36}$/); return id!;
}
async function deliveries(commandId: string) {
  return db.recordUpdateDelivery.findMany({ where: { commandId }, orderBy: { recipientId: 'asc' } });
}
async function readOnlyCounts() {
  return Promise.all([db.recordUpdateCommand.count(), db.recordUpdateEvent.count(), db.recordUpdateDelivery.count(),
    db.approvedCommunication.count(), db.auditLog.count()]);
}
async function waitAvailable(at: number) {
  await expect.poll(() => Date.now(), { timeout: 180_000, intervals: [1_000] }).toBeGreaterThan(at + 250);
}
async function syntheticActor(person: Person) {
  const user = await db.user.findUniqueOrThrow({ where: { id: person.id } }); return { user, ...await syntheticSession(db, user) };
}
async function close(...contexts: BrowserContext[]) { for (const context of contexts) await context.close(); }
test.beforeAll(async () => { expect(f.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());

test('two technicians receive only the selected deadline at its real time; current revocation and cancellation preserve the actual read receipt', async ({ browser }) => {
  const ac = await browser.newContext(), bc = await browser.newContext(), cc = await browser.newContext();
  const admin = await ac.newPage(), techA = await bc.newPage(), techB = await cc.newPage();
  await login(admin); await login(techA, f.techA); await login(techB, f.techB);
  const row = f.rows[0], at = futureMinute(2);
  await preview(admin, row, at, [f.techA, f.techB, f.salesA, f.salesB]);
  const summary = admin.getByRole('region', { name: 'Riepilogo promemoria', exact: true });
  await expect(summary.getByText(/escluso: accesso pertinente assente/)).toHaveCount(2);
  await screen(admin, 'exact-preview', 1440); await screen(admin, 'exact-preview', 390);
  const beforeMail = await db.approvedCommunication.count(); await confirm(admin); const commandId = await recorded(admin);
  const rows = await deliveries(commandId); expect(rows.map(r => r.recipientId).sort()).toEqual([f.techA.id, f.techB.id].sort());
  const a = rows.find(r => r.recipientId === f.techA.id)!, b = rows.find(r => r.recipientId === f.techB.id)!;
  const beforeRead = await readOnlyCounts();
  await techA.goto('/notifications/updates'); await expect(techA.locator(`a[href="${noticePath(a.id)}"]`)).toHaveCount(0);
  expect((await techA.goto(noticePath(a.id)))?.status()).toBe(404);
  await admin.goto(managementPath(commandId)); await expect(admin.getByText('Programmato', { exact: true })).toHaveCount(2);
  expect(await readOnlyCounts()).toEqual(beforeRead);
  await waitAvailable(at);
  await techA.goto('/notifications/updates'); await expect(techA.locator(`a[href="${noticePath(a.id)}"]`)).toBeVisible();
  await techA.locator(`a[href="${noticePath(a.id)}"]`).click();
  await expect(techA.getByText('Scadenza dell’attività:', { exact: false })).toBeVisible();
  expect(await techA.locator('body').innerText()).not.toMatch(/DESCRIZIONE_PRIVATA|Scadenza riservata sintetica|CONTRATTO_PRIVATO|PAGAMENTO_PRIVATO/);
  await screen(techA, 'deadline-notice', 1440); await screen(techA, 'deadline-notice', 390);
  expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: a.id } })).readAt).toBeNull();
  await techA.getByRole('button', { name: 'Segna come letto', exact: true }).click();
  await expect(techA.getByText(/Segnato come letto il/)).toBeVisible();
  const readAt = (await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: a.id } })).readAt; expect(readAt).not.toBeNull();
  await techB.goto(noticePath(b.id)); await expect(techB.getByRole('button', { name: 'Segna come letto', exact: true })).toBeVisible();
  await revokeTechnical(db, await syntheticActor(f.admin), { kind: 'TechnicalPractice', targetId: row.practiceId }, await syntheticActor(f.techB));
  expect((await techB.reload())?.status()).toBe(404);
  await admin.goto(managementPath(commandId)); await expect(admin.getByText('Letto nel CRM', { exact: true })).toBeVisible();
  await expect(admin.getByText(/Sospeso: attività/)).toBeVisible();
  await screen(admin, 'read-and-revoked', 1440); await screen(admin, 'read-and-revoked', 390);
  await admin.getByRole('checkbox', { name: 'Confermo l’annullamento di questo promemoria', exact: true }).check();
  await admin.getByRole('button', { name: 'Annulla promemoria', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText('Promemoria annullato');
  expect((await techA.reload())?.status()).toBe(404);
  expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: a.id } })).readAt).toEqual(readAt);
  expect(await db.approvedCommunication.count()).toBe(beforeMail); await close(ac, bc, cc);
});

test('native lost responses and replay reconcile one schedule and one cancellation across reload without repeating a mutation', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = f.rows[1];
  await login(page); await preview(page, row, futureMinute());
  let captured: { url: string; headers: Record<string, string>; body: Buffer } | undefined;
  await page.route(`**${setupPath(row)}*`, async route => {
    const request = route.request(); if (request.method() !== 'POST') return route.continue();
    captured = { url: request.url(), headers: await request.allHeaders(), body: request.postDataBuffer()! };
    const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed');
  });
  await confirm(page); await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  const commandId = new URL(page.url()).searchParams.get('reminderDecision')!; expect(captured).toBeDefined();
  const originalRows = await deliveries(commandId); expect(originalRows).toHaveLength(2);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload();
  await expect(page.getByRole('button', { name: 'Programma promemoria', exact: true })).toHaveCount(0);
  const before = await readOnlyCounts(); await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Promemoria già registrato.'); expect(await readOnlyCounts()).toEqual(before);
  const headers = { ...captured!.headers }; delete headers.host; delete headers['content-length'];
  expect((await context.request.post(captured!.url, { headers, data: captured!.body })).ok()).toBe(true);
  expect(await readOnlyCounts()).toEqual(before);
  // Cross-origin use of the actual native request is rejected before mutation.
  await context.request.post(captured!.url, { headers: { ...headers, origin: 'https://untrusted.invalid.test', 'sec-fetch-site': 'cross-site' }, data: captured!.body });
  expect(await readOnlyCounts()).toEqual(before);
  await page.getByRole('link', { name: 'Apri stato del promemoria', exact: true }).click();
  await page.route(`**${managementPath(commandId)}*`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed');
  });
  await page.getByRole('checkbox', { name: 'Confermo l’annullamento di questo promemoria', exact: true }).check();
  await page.getByRole('button', { name: 'Annulla promemoria', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verifica esito annullamento', exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' }); await page.reload();
  // A retained cancellation can already be shown by the read-only page.
  await expect(page.getByText('Annullato', { exact: true })).toHaveCount(2);
  const cancellation = await db.recordUpdateCommand.findMany({ where: { actorId: f.admin.id, operation: 'REMINDER_REVOKE' } });
  expect(cancellation.filter(c => c.id === new URL(page.url()).searchParams.get('cancelDecision'))).toHaveLength(1);
  await screen(page, 'reconciled-cancellation', 1440); await screen(page, 'reconciled-cancellation', 390);
  expect(await deliveries(commandId)).toEqual(originalRows); await close(context);
});

test('an activity changed after the native preview cannot commit an obsolete deadline or notification', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = f.rows[2];
  await login(page); await preview(page, row, futureMinute());
  await db.task.update({ where: { id: row.taskId }, data: { dueAt: new Date(Date.now() + 172_800_000) } });
  const before = await readOnlyCounts(); await confirm(page);
  await expect(page.getByRole('status')).toContainText('Operazione non registrata');
  expect(await readOnlyCounts()).toEqual(before);
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria', exact: true })).toHaveCount(0);
  await screen(page, 'stale-deadline-rejected', 390); await close(context);
});

test('the actual group membership is shown and a changed group invalidates its open approval', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = f.rows[3];
  await login(page); await preview(page, row, futureMinute(), [], true);
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria', exact: true }).getByRole('listitem')).toHaveCount(2);
  await syntheticPerson(db, 'Nuovo tecnico sintetico senza incarico', 'consulente');
  const before = await readOnlyCounts(); await confirm(page);
  await expect(page.getByRole('status')).toContainText('Operazione non registrata'); expect(await readOnlyCounts()).toEqual(before);
  await close(context);
});

test('a client-only commercial deadline admits its own commercial and excludes the other without granting a practice', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page); await page.goto(`/record-reminders/CLIENT/${f.clientId}`);
  await expect(page.getByTestId('record-reminder-form')).toHaveAttribute('data-interactive-ready', 'true');
  for (const row of f.rows) await expect(page.locator(`option[value="${row.taskId}"]`)).toHaveCount(0);
  await select(page, f.clientTaskId, futureMinute(), [f.salesA, f.salesB]);
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria', exact: true })).toBeVisible();
  await expect(page.getByText(/escluso: accesso pertinente assente/)).toHaveCount(1);
  const grants = await db.technicalAssignment.count(); await confirm(page); const id = await recorded(page);
  expect((await deliveries(id)).map(r => r.recipientId)).toEqual([f.salesA.id]);
  expect(await db.technicalAssignment.count()).toBe(grants);
  await screen(page, 'commercial-client-only', 1440); await screen(page, 'commercial-client-only', 390); await close(context);
});

test('Admin personal confirmation, current session and direct-route permissions are enforced without GET mutations', async ({ browser }) => {
  const ac = await browser.newContext(), tc = await browser.newContext(), oc = await browser.newContext();
  const page = await ac.newPage(), tech = await tc.newPage(), other = await oc.newPage(), row = f.rows[5];
  await login(page, f.admin, false); await login(tech, f.techA); await login(other, f.otherAdmin, false);
  const before = await readOnlyCounts(); await open(page, row);
  await select(page, row.taskId, futureMinute(), [f.techA]);
  await expect(page.getByRole('status')).toContainText('Operazione non registrata');
  await expect(page.getByRole('region', { name: 'Riepilogo promemoria', exact: true })).toHaveCount(0);
  expect((await tech.goto(setupPath(row)))?.status()).toBe(404);
  expect((await tech.goto('/notifications/reminders'))?.status()).toBe(404);
  await other.goto(setupPath(row)); await expect(other.getByRole('option', { name: new RegExp(row.title) })).toHaveCount(0);
  const saved = await db.recordUpdateCommand.findFirstOrThrow({ where: { actorId: f.admin.id, operation: 'REMINDER' } });
  expect((await other.goto(managementPath(saved.id)))?.status()).toBe(404);
  expect(await readOnlyCounts()).toEqual(before);
  await page.getByLabel('Cerca fra le attività con scadenza', { exact: true }).fill('Nessunrisultatosintetico');
  await page.getByRole('button', { name: 'Cerca attività', exact: true }).click();
  await expect(page.getByText('Nessuna attività con scadenza disponibile', { exact: true })).toBeVisible();
  await db.$transaction(tx => revokeAllInternalSessions(tx, f.admin.id, 'INTERNAL_GLOBAL', f.admin.id));
  await page.goto(setupPath(row)); await expect(page).toHaveURL(/\/login/);
  await close(ac, tc, oc);
});
