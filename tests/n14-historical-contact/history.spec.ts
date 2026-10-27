import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page, type Browser } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.UPDATES_EVIDENCE!, password = process.env.UPDATES_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; commercialId: string; emails: { admin: string; commercial: string };
};
let other: { id: string; email: string };
type Captured = { url: string; headers: Record<string, string>; body: Buffer };

async function login(page: Page, email: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
async function ownedLead(browser: Browser, accept = true) {
  const ac = await browser.newContext(), cc = await browser.newContext();
  const admin = await ac.newPage(), owner = await cc.newPage();
  const title = `Contatto precedente sintetico ${randomUUID()}`;
  await login(admin, f.emails.admin); await admin.goto('/leads');
  await admin.getByPlaceholder('Nome / ragione sociale', { exact: true }).fill(title);
  await admin.getByPlaceholder('Nome referente', { exact: true }).fill('Referente');
  await admin.getByPlaceholder('Cognome referente', { exact: true }).fill('Sintetico');
  await admin.getByRole('button', { name: 'Crea lead', exact: true }).click(); await expect(admin).toHaveURL(/\/leads\?created=1$/);
  const lead = await db.lead.findFirstOrThrow({ where: { companyName: title } });
  await admin.goto(`/leads/inbox?lead=${lead.id}`);
  await admin.getByRole('link', { name: 'Conferma identità per assegnare', exact: true }).click();
  await admin.getByLabel('Password corrente', { exact: true }).fill(password);
  await admin.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
  await expect(admin).toHaveURL(/\/leads\/inbox$/); await admin.goto(`/leads/inbox?lead=${lead.id}`);
  await admin.getByLabel('Referente commerciale', { exact: true }).selectOption(f.commercialId);
  await admin.getByRole('button', { name: 'Assegna', exact: true }).click();
  await expect.poll(async () => (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId).toBe(f.commercialId);
  await login(owner, f.emails.commercial);
  if (accept) {
    await owner.goto(`/assignments/Lead/${lead.id}`);
    await owner.getByRole('button', { name: 'Confermo la presa in carico commerciale', exact: true }).click();
    await expect(owner.getByRole('button', { name: 'Confermo la presa in carico commerciale', exact: true })).toHaveCount(0);
  }
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id } });
  const cycle = await db.commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } });
  return { ac, cc, admin, owner, lead, item, cycle, route: `/leads/${lead.id}/historical-contact` };
}
async function rowCount(leadId: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "CommercialLeadHistoricalContact" WHERE input->>'leadId'=${leadId}`;
  return Number(rows[0].count);
}
async function preview(page: Page) {
  await page.locator('section[aria-label="Contatto precedente al CRM"][data-interactive-ready="true"]').waitFor();
  await page.getByLabel('Data e ora effettive dell’evento', { exact: true }).fill('2020-01-01T10:30');
  await page.getByLabel('Fuso orario dell’evento', { exact: true }).selectOption('+01:00');
  await page.getByLabel('Fonte', { exact: true }).selectOption('EXISTING_DOCUMENT');
  await page.getByLabel('Riferimento della prova', { exact: true }).fill('Riferimento sintetico al contatto precedente');
  await page.getByRole('checkbox', { name: 'Attesto che l’evento indicato è avvenuto prima dell’ingresso nel CRM.', exact: true }).check();
  await page.getByRole('button', { name: 'Prepara riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verifica prima di registrare', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Confermo l’evento, la data e la fonte qui riepilogati.', exact: true }).check();
}
async function screen(page: Page, label: string, width: number) {
  await page.setViewportSize({ width, height: 950 }); await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, `${label}-${width}.png`), fullPage: true, caret: 'initial' });
}
function hydration(page: Page) {
  const failures: string[] = [], record = (s: string) => { if (/hydration|cannot contain a nested|cannot be a descendant/i.test(s)) failures.push(s); };
  page.on('pageerror', e => record(e.message)); page.on('console', e => { if (e.type() === 'error') record(e.text()); });
  return () => expect(failures).toEqual([]);
}

async function conversionPreview(browser: Browser) {
  const x = await ownedLead(browser); await x.owner.goto(x.route); await preview(x.owner);
  await x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true }).click();
  await expect(x.owner.getByRole('heading', { name: 'Contatto registrato', exact: true })).toBeVisible();
  await x.owner.getByRole('link', { name: 'Prepara la conversione in cliente', exact: true }).click();
  await x.owner.locator('section[aria-label="Conversione da contatto precedente"][data-interactive-ready="true"]').waitFor();
  await x.owner.getByLabel('Tipo cliente', { exact: true }).selectOption('societa');
  await x.owner.getByRole('button', { name: 'Prepara conversione', exact: true }).click();
  await expect(x.owner.getByRole('heading', { name: 'Verifica il cliente da registrare', exact: true })).toBeVisible();
  await x.owner.getByRole('checkbox', { name: 'Confermo il cliente e la base storica riepilogati.', exact: true }).check();
  expect(await db.client.count({ where: { leadId: x.lead.id } })).toBe(0);
  return x;
}
test.beforeAll(async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.CI).toBe('true'); expect(f.synthetic).toBe(true);
  await db.commercialLeadSlaPolicyVersion.upsert({ where: { policyCode_version: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1 } },
    create: { version: 1, status: 'ACTIVE', responseTargetSeconds: 3600, createdById: f.adminId }, update: {} });
  const owner = await db.user.findUniqueOrThrow({ where: { id: f.commercialId } });
  other = await db.user.create({ data: { name: 'Escluso storico sintetico', email: `${randomUUID()}@history.invalid.test`, role: 'commerciale', passwordHash: owner.passwordHash } });
});
test.afterAll(async () => db.$disconnect());

test('native assignment and personal acceptance lead to an exact historical preview and durable receipt without a fabricated first response', async ({ browser }) => {
  const x = await ownedLead(browser), checkHydration = hydration(x.owner);
  await x.owner.goto(`/leads/${x.lead.id}`);
  await x.owner.getByRole('link', { name: 'Registra contatto precedente al CRM', exact: true }).click();
  await screen(x.owner, 'historical-form', 1440); await screen(x.owner, 'historical-form', 390);
  await preview(x.owner); expect(await rowCount(x.lead.id)).toBe(0);
  await screen(x.owner, 'historical-preview', 1440); await screen(x.owner, 'historical-preview', 390);
  await x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true }).click();
  await expect(x.owner.getByRole('heading', { name: 'Contatto registrato', exact: true })).toBeVisible();
  expect(await rowCount(x.lead.id)).toBe(1);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
  expect((await db.lead.findUniqueOrThrow({ where: { id: x.lead.id } })).clientId).toBeNull();
  const rows = await db.$queryRaw<Array<{ input: { occurredAt: string }; recordedAt: Date }>>`SELECT input,"recordedAt" FROM "CommercialLeadHistoricalContact" WHERE input->>'leadId'=${x.lead.id}`;
  expect(rows[0].input.occurredAt).toBe('2020-01-01T09:30:00.000Z'); expect(rows[0].recordedAt.getTime()).toBeGreaterThan(x.item.initializedAt.getTime());
  await screen(x.owner, 'historical-receipt', 390);
  await x.owner.reload(); await expect(x.owner.getByRole('heading', { name: 'Contatto registrato', exact: true })).toBeVisible();
  await expect(x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true })).toHaveCount(0);
  // Reopening the canonical route without the recovery query must keep the
  // existing receipt and next step, without offering a second registration.
  await x.owner.goto(x.route);
  await expect(x.owner.getByRole('heading', { name: 'Contatto registrato', exact: true })).toBeVisible();
  await expect(x.owner.getByRole('button', { name: 'Prepara riepilogo', exact: true })).toHaveCount(0);
  await expect(x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true })).toHaveCount(0);
  await expect(x.owner.getByRole('link', { name: 'Prepara la conversione in cliente', exact: true })).toBeVisible();
  expect(await rowCount(x.lead.id)).toBe(1);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
  await screen(x.owner, 'historical-reopened-receipt', 1440); await screen(x.owner, 'historical-reopened-receipt', 390);
  checkHydration(); await x.ac.close(); await x.cc.close();
});

test('lost native response retains the command and permits only reconciliation without a duplicate contact', async ({ browser }) => {
  const x = await ownedLead(browser); await x.owner.goto(x.route); await preview(x.owner);
  let command: Captured | undefined;
  await x.owner.route('**/historical-contact*', async route => {
    const req = route.request(); if (req.method() !== 'POST') { await route.continue(); return; }
    command = { url: req.url(), headers: await req.allHeaders(), body: req.postDataBuffer()! };
    await route.fetch(); await route.abort('failed');
  });
  await x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true }).click();
  await expect.poll(() => rowCount(x.lead.id)).toBe(1); expect(command).toBeDefined();
  await x.owner.unrouteAll({ behavior: 'wait' });
  await expect(x.owner.getByRole('button', { name: 'Verifica esito del contatto', exact: true })).toBeVisible();
  await expect(x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true })).toHaveCount(0);
  expect(x.owner.url()).toContain('historicalContactCommand=');
  await screen(x.owner, 'historical-uncertain', 390);
  await x.owner.getByRole('button', { name: 'Verifica esito del contatto', exact: true }).click();
  await expect(x.owner.getByRole('heading', { name: 'Contatto registrato', exact: true })).toBeVisible();
  const headers = { ...command!.headers }; delete headers.cookie; delete headers['content-length'];
  await x.owner.request.post(command!.url, { headers, data: command!.body, maxRedirects: 0 });
  expect(await rowCount(x.lead.id)).toBe(1);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
  await x.ac.close(); await x.cc.close();
});

test('revocation after native preview denies confirmation and direct URL disclosure in the open session', async ({ browser }) => {
  const x = await ownedLead(browser); await x.owner.goto(x.route); await preview(x.owner);
  const override = await db.userPermissionOverride.create({ data: { userId: f.commercialId, permission: 'lead.write', allowed: false } });
  try {
    await x.owner.getByRole('button', { name: 'Registra contatto precedente', exact: true }).click();
    await expect(x.owner.getByRole('button', { name: 'Verifica esito del contatto', exact: true })).toBeVisible();
    expect(await rowCount(x.lead.id)).toBe(0);
    expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
    await x.owner.reload(); await expect(x.owner.getByRole('heading', { name: 'Contatto precedente non disponibile', exact: true })).toBeVisible();
    await expect(x.owner.getByText(x.lead.companyName!, { exact: true })).toHaveCount(0);
    await screen(x.owner, 'historical-revoked', 390);
  } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); await x.ac.close(); await x.cc.close(); }
});

test('Admin cannot attest for the owner and another commercial or an owner without acceptance cannot read the form', async ({ browser }) => {
  const x = await ownedLead(browser, false), oc = await browser.newContext(), excluded = await oc.newPage();
  await login(excluded, other.email);
  for (const page of [x.admin, x.owner, excluded]) {
    await page.goto(x.route);
    await expect(page.getByRole('heading', { name: 'Contatto precedente non disponibile', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepara riepilogo', exact: true })).toHaveCount(0);
    await expect(page.getByText(x.lead.companyName!, { exact: true })).toHaveCount(0);
  }
  expect(await rowCount(x.lead.id)).toBe(0);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
  await oc.close(); await x.ac.close(); await x.cc.close();
});

test('native historical conversion survives a lost response and reload without a second client or a fabricated SLA response', async ({ browser }) => {
  const x = await conversionPreview(browser), checkHydration = hydration(x.owner);
  await screen(x.owner, 'conversion-preview', 1440); await screen(x.owner, 'conversion-preview', 390);
  let command: Captured | undefined;
  await x.owner.route('**/historical-conversion*', async route => {
    const req = route.request(); if (req.method() !== 'POST') { await route.continue(); return; }
    command = { url: req.url(), headers: await req.allHeaders(), body: req.postDataBuffer()! };
    await route.fetch(); await route.abort('failed');
  });
  await x.owner.getByRole('button', { name: 'Registra cliente da contatto precedente', exact: true }).click();
  await expect.poll(() => db.client.count({ where: { leadId: x.lead.id } })).toBe(1);
  await x.owner.unrouteAll({ behavior: 'wait' });
  await expect(x.owner.getByRole('button', { name: 'Verifica esito della conversione', exact: true })).toBeVisible();
  await expect(x.owner.getByRole('button', { name: 'Registra cliente da contatto precedente', exact: true })).toHaveCount(0);
  expect(x.owner.url()).toContain('historicalConversionCommand='); const outcomeUrl = x.owner.url();
  await screen(x.owner, 'conversion-uncertain', 390);
  await x.owner.getByRole('button', { name: 'Verifica esito della conversione', exact: true }).click();
  await expect(x.owner.getByRole('heading', { name: 'Cliente registrato', exact: true })).toBeVisible();
  await screen(x.owner, 'conversion-receipt', 390); await x.owner.reload();
  await expect(x.owner.getByRole('heading', { name: 'Cliente registrato', exact: true })).toBeVisible();
  const headers = { ...command!.headers }; delete headers.cookie; delete headers['content-length'];
  await x.owner.request.post(command!.url, { headers, data: command!.body, maxRedirects: 0 });
  expect(await db.client.count({ where: { leadId: x.lead.id } })).toBe(1);
  const cycle = await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } });
  expect(cycle.firstResponseAt).toBeNull(); expect(cycle.outcome).toBe('HISTORICAL_CONTACT_BEFORE_CRM');
  expect(cycle.dueAt).toEqual(x.cycle.dueAt); expect(cycle.availableAt).toEqual(x.cycle.availableAt);
  const client = await db.client.findFirstOrThrow({ where: { leadId: x.lead.id } });
  expect(client.salesOwnerId).toBe(f.commercialId); expect(await db.technicalPractice.count({ where: { clientId: client.id } })).toBe(0);
  await x.owner.goto(`/leads/inbox?queue=closed&lead=${x.lead.id}`);
  await expect(x.owner.getByText('Contatto precedente al CRM · SLA non misurato', { exact: true })).toBeVisible();
  await x.admin.goto(outcomeUrl);
  await expect(x.admin.getByRole('heading', { name: 'Conversione storica non disponibile', exact: true })).toBeVisible();
  checkHydration(); await x.ac.close(); await x.cc.close();
});

test('native conversion rejects a changed source after preview without copying stale data', async ({ browser }) => {
  const x = await conversionPreview(browser);
  await db.lead.update({ where: { id: x.lead.id }, data: { notes: 'Changed synthetic source after preview' } });
  await x.owner.getByRole('button', { name: 'Registra cliente da contatto precedente', exact: true }).click();
  await expect(x.owner.getByRole('button', { name: 'Verifica esito della conversione', exact: true })).toBeVisible();
  expect(await db.client.count({ where: { leadId: x.lead.id } })).toBe(0);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: x.cycle.id } })).toEqual(x.cycle);
  await screen(x.owner, 'conversion-stale', 390); await x.ac.close(); await x.cc.close();
});

test('native conversion rechecks client permission after preview in the open session', async ({ browser }) => {
  const x = await conversionPreview(browser);
  const override = await db.userPermissionOverride.create({ data: { userId: f.commercialId, permission: 'client.write', allowed: false } });
  try {
    await x.owner.getByRole('button', { name: 'Registra cliente da contatto precedente', exact: true }).click();
    await expect(x.owner.getByRole('button', { name: 'Verifica esito della conversione', exact: true })).toBeVisible();
    expect(await db.client.count({ where: { leadId: x.lead.id } })).toBe(0);
    await x.owner.reload(); await expect(x.owner.getByRole('heading', { name: 'Conversione storica non disponibile', exact: true })).toBeVisible();
    await screen(x.owner, 'conversion-revoked', 390);
  } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); await x.ac.close(); await x.cc.close(); }
});
