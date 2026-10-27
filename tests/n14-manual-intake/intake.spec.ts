import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.UPDATES_EVIDENCE!, password = process.env.UPDATES_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; commercialId: string; emails: { admin: string; commercial: string };
};
let other: { id: string; email: string };
type Captured = { url: string; headers: Record<string, string>; body: Buffer };
async function login(page: Page, email = f.emails.admin) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function manual(page: Page) {
  const title = 'Intake manuale sintetico ' + randomUUID();
  await page.goto('/leads');
  await page.getByPlaceholder('Nome / ragione sociale', { exact: true }).fill(title);
  await page.getByPlaceholder('Nome referente', { exact: true }).fill('Referente');
  await page.getByPlaceholder('Cognome referente', { exact: true }).fill('Sintetico');
  await page.getByRole('button', { name: 'Crea lead', exact: true }).click();
  await expect(page).toHaveURL(/\/leads\?created=1$/);
  const lead = await db.lead.findFirstOrThrow({ where: { companyName: title } });
  expect(lead.assignedToId).toBeNull(); expect(lead.clientId).toBeNull(); expect(lead.status).toBe('nuovo');
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id }, include: { slaCycles: true } });
  expect(item.originKind).toBe('MANUAL_CRM'); expect(item.state).toBe('OPEN'); expect(item.version).toBe(1);
  expect(item.slaCycles).toHaveLength(1); expect(item.slaCycles[0].firstResponseAt).toBeNull();
  return { lead, item, cycle: item.slaCycles[0] };
}
async function stepUp(page: Page) {
  await page.getByRole('link', { name: 'Conferma identità per assegnare', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/security\?returnTo=lead-inbox$/);
  await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
  await expect(page).toHaveURL(/\/leads\/inbox$/);
  await expect(page.getByText(/Conferma personale attiva\. Scegli il referente/)).toBeVisible();
}
async function screen(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: 950 }); await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`), fullPage: true });
}
async function replay(page: Page, command: Captured) {
  const headers = { ...command.headers }; delete headers.cookie; delete headers['content-length'];
  return page.request.post(command.url, { headers, data: command.body, maxRedirects: 0 });
}
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true);
  expect(process.env.COMMERCIAL_LEAD_INBOX_MODE).toBe('enforced');
  await db.commercialLeadSlaPolicyVersion.upsert({ where: { policyCode_version: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1 } },
    create: { version: 1, status: 'ACTIVE', responseTargetSeconds: 3600, createdById: f.adminId }, update: {} });
  const owner = await db.user.findUniqueOrThrow({ where: { id: f.commercialId } });
  other = await db.user.create({ data: { name: 'Secondo commerciale sintetico', email: `${randomUUID()}@n14.invalid.test`, role: 'commerciale', passwordHash: owner.passwordHash } });
});
test.afterAll(async () => db.$disconnect());

test('manual unassigned intake uses native identity confirmation, explicit owner, acceptance and real-time response before one conversion', async ({ browser }) => {
  const ac = await browser.newContext(), cc = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), owner = await cc.newPage(), excluded = await oc.newPage();
  await login(admin); const row = await manual(admin);
  await admin.goto(`/leads/${row.lead.id}`);
  await expect(admin.getByText('Assegna prima il referente commerciale', { exact: true })).toBeVisible();
  await admin.getByRole('link', { name: 'Apri coda e assegnazione del referente', exact: true }).click();
  await expect(admin.getByRole('button', { name: 'Assegna', exact: true })).toHaveCount(0);
  await screen(admin, 'assignment-required', 1440); await screen(admin, 'assignment-required', 390);
  await stepUp(admin); await admin.goto(`/leads/inbox?lead=${row.lead.id}`);
  await expect(admin.getByLabel('Referente commerciale', { exact: true })).toHaveValue('');
  await admin.getByLabel('Referente commerciale', { exact: true }).selectOption(f.commercialId);
  await admin.getByRole('button', { name: 'Assegna', exact: true }).click();
  await expect.poll(async () => (await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } })).assignedToId).toBe(f.commercialId);
  const unchanged = await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycle.id } });
  expect(unchanged.firstResponseAt).toBeNull(); expect(unchanged.availableAt).toEqual(row.cycle.availableAt); expect(unchanged.dueAt).toEqual(row.cycle.dueAt);
  await login(excluded, other.email); await excluded.goto(`/leads/inbox?lead=${row.lead.id}`);
  await expect(excluded.getByRole('link', { name: row.lead.companyName!, exact: true })).toHaveCount(0);
  await excluded.goto(`/leads/${row.lead.id}`); await expect(excluded.getByRole('heading', { name: 'Lead non trovato', exact: true })).toBeVisible();
  await login(owner, f.emails.commercial); await owner.goto(`/assignments/Lead/${row.lead.id}`);
  await owner.getByRole('button', { name: 'Confermo la presa in carico commerciale', exact: true }).click();
  await expect(owner.getByRole('button', { name: 'Confermo la presa in carico commerciale', exact: true })).toHaveCount(0);
  await owner.goto(`/leads/${row.lead.id}`);
  await expect(owner.getByRole('button', { name: 'Converti in cliente', exact: true })).toHaveCount(0);
  const beforeResponse = Date.now();
  // Synthetic contact attested at command time. No email, telephone or external service is contacted.
  await owner.getByRole('button', { name: 'Registra prima risposta', exact: true }).click();
  await expect(owner.getByRole('button', { name: 'Converti in cliente', exact: true })).toBeVisible();
  const response = await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycle.id } });
  expect(response.firstResponseAt!.getTime()).toBeGreaterThanOrEqual(beforeResponse - 1000);
  expect(response.availableAt).toEqual(row.cycle.availableAt); expect(response.dueAt).toEqual(row.cycle.dueAt);
  await screen(owner, 'ready-to-convert', 1440); await screen(owner, 'ready-to-convert', 390);
  await owner.getByRole('button', { name: 'Converti in cliente', exact: true }).click(); await expect(owner).toHaveURL(/\/clients\/[a-z0-9]+$/);
  const converted = await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } });
  expect(converted.status).toBe('vinto'); expect(converted.clientId).toBeTruthy();
  expect((await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.item.id } })).state).toBe('CLOSED');
  expect(await db.client.count({ where: { id: converted.clientId! } })).toBe(1);
  expect(await db.commercialLeadActivity.count({ where: { inboxItemId: row.item.id, activityType: 'FIRST_RESPONSE_RECORDED' } })).toBe(1);
  expect(await db.technicalPractice.count({ where: { clientId: converted.clientId! } })).toBe(0);
  await ac.close(); await cc.close(); await oc.close();
});

test('lost assignment response and stale native command cannot create a second assignment or a fabricated first response', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); await login(page); const row = await manual(page);
  await page.goto(`/leads/inbox?lead=${row.lead.id}`); await stepUp(page); await page.goto(`/leads/inbox?lead=${row.lead.id}`);
  await page.getByLabel('Referente commerciale', { exact: true }).selectOption(f.commercialId);
  let command: Captured | undefined;
  await page.route('**/leads/inbox*', async route => {
    const req = route.request(); if (req.method() !== 'POST') { await route.continue(); return; }
    command = { url: req.url(), headers: await req.allHeaders(), body: req.postDataBuffer()! };
    await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Assegna', exact: true }).click();
  await expect.poll(async () => (await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.item.id } })).version).toBe(2);
  expect(command).toBeDefined(); await page.unrouteAll({ behavior: 'wait' }); await page.goto(`/leads/inbox?lead=${row.lead.id}`);
  await replay(page, command!);
  expect((await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.item.id } })).version).toBe(2);
  expect(await db.commercialLeadActivity.count({ where: { inboxItemId: row.item.id, activityType: 'ASSIGNED' } })).toBe(1);
  expect((await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycle.id } })).firstResponseAt).toBeNull();
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } })).clientId).toBeNull();
  await context.close();
});

test('revoked identity confirmation rejects a previously rendered assignment and historical-contact guidance does not manufacture an event', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); await login(page); const row = await manual(page);
  await page.goto(`/leads/inbox?lead=${row.lead.id}`); await stepUp(page); await page.goto(`/leads/inbox?lead=${row.lead.id}`);
  await expect(page.getByText(/non usare questo comando per simulare un nuovo contatto/)).toBeVisible();
  await page.getByLabel('Referente commerciale', { exact: true }).selectOption(f.commercialId);
  const security = await context.newPage(); await security.goto('/settings/security');
  await security.getByRole('button', { name: 'Rimuovi conferma', exact: true }).click(); await expect(security).toHaveURL(/status=cleared/);
  const post = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/leads/inbox'));
  await page.getByRole('button', { name: 'Assegna', exact: true }).click(); await post;
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.lead.id } })).assignedToId).toBeNull();
  expect((await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.item.id } })).version).toBe(1);
  expect((await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycle.id } })).firstResponseAt).toBeNull();
  await page.goto(`/leads/inbox?lead=${row.lead.id}`);
  await expect(page.getByRole('link', { name: 'Conferma identità per assegnare', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assegna', exact: true })).toHaveCount(0);
  await context.close();
});
