import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.UPDATES_EVIDENCE!, password = process.env.UPDATES_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; readerId: string; otherId: string; readerName: string; emails: { admin: string; reader: string; other: string };
};
const origin = 'http://127.0.0.1:3038';
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function fixture(kind: 'LEAD' | 'CLIENT' | 'PROJECT' | 'PRACTICE' = 'LEAD') {
  const label = 'Aggiornamento sintetico ' + randomUUID(); let id: string;
  if (kind === 'LEAD') id = (await db.lead.create({ data: { firstName: label, lastName: 'Test', assignedToId: f.readerId } })).id;
  else {
    const client = await db.client.create({ data: { type: 'societa', displayName: label, salesOwnerId: f.readerId } });
    if (kind === 'CLIENT') id = client.id;
    else if (kind === 'PROJECT') id = (await db.project.create({ data: { clientId: client.id, title: label } })).id;
    else id = (await db.technicalPractice.create({ data: { clientId: client.id, title: label, practiceType: 'test',
      targetEntity: 'synthetic', createdById: f.adminId } })).id;
  }
  return { kind, id, label };
}
async function open(page: Page, row: Awaited<ReturnType<typeof fixture>>) {
  await page.goto('/record-updates/' + row.kind + '/' + row.id);
  const form = page.getByTestId('record-update-form');
  await expect(form).toHaveAttribute('data-interactive-ready', 'true'); return form;
}
async function preview(page: Page, row: Awaited<ReturnType<typeof fixture>>, persistent = false) {
  const form = await open(page, row);
  await form.getByRole('checkbox', { name: new RegExp(f.readerName) }).check();
  if (row.kind === 'LEAD') await form.getByLabel('Prossima azione: descrizione', { exact: true }).fill('Contenuto privato sintetico');
  else if (row.kind === 'CLIENT') await form.getByLabel('Denominazione', { exact: true }).fill(row.label + ' modificato');
  else await form.getByLabel('Stato', { exact: true }).selectOption(row.kind === 'PROJECT' ? 'in_analisi' : 'in_progettazione');
  if (persistent) await form.getByRole('checkbox', { name: 'Attiva anche una regola per questa scheda' }).check();
  await form.getByRole('button', { name: 'Controlla destinatari e modifiche' }).click();
  await expect(page.getByRole('region', { name: 'Riepilogo aggiornamento' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Confermo questa operazione, i destinatari ammessi e il canale CRM' }).check();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione registrata');
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native four-context save, persistent rule and revocation; only selected current recipients see notices, desktop/mobile fit', async ({ browser }) => {
  const ac = await browser.newContext(), rc = await browser.newContext(), oc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage(), other = await oc.newPage();
  await login(admin, f.emails.admin, true); await login(reader, f.emails.reader); await login(other, f.emails.other);
  let lead: Awaited<ReturnType<typeof fixture>> | undefined;
  for (const kind of ['LEAD', 'CLIENT', 'PROJECT', 'PRACTICE'] as const) {
    const row = await fixture(kind);
    if (kind === 'LEAD') lead = row;
    await preview(admin, row, kind === 'LEAD');
    await admin.setViewportSize({ width: kind === 'PRACTICE' ? 390 : 1440, height: kind === 'PRACTICE' ? 844 : 1000 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await admin.screenshot({ path: path.join(evidence, 'updates-' + kind.toLowerCase() + '-preview.png'), fullPage: true });
    await confirm(admin);
    const work = await db.recordUpdateDelivery.findMany({ where: { event: { recordId: row.id } } });
    expect(work).toHaveLength(1); expect(work[0].recipientId).toBe(f.readerId); expect(work[0].readAt).toBeNull();
    await reader.goto('/notifications/updates/' + work[0].id);
    await expect(reader.getByRole('link', { name: 'Apri scheda' })).toBeVisible();
    expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work[0].id } })).readAt).toBeNull();
    const denied = await oc.request.get('/notifications/updates/' + work[0].id);
    expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(row.label);
  }
  await db.lead.update({ where: { id: lead!.id }, data: { nextActionDate: new Date('2027-02-01T10:00:00Z') } });
  const ruleWork = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: lead!.id }, ruleId: { not: null } } });
  await reader.goto('/notifications/updates/' + ruleWork.id);
  await expect(reader.getByRole('link', { name: 'Apri scheda' })).toBeVisible();
  await admin.setViewportSize({ width: 390, height: 844 }); await open(admin, lead!);
  await admin.getByRole('button', { name: 'Revoca regola', exact: true }).click();
  await admin.getByRole('checkbox', { name: 'Confermo questa operazione, i destinatari ammessi e il canale CRM' }).check();
  await admin.getByRole('button', { name: 'Conferma revoca', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText('Operazione registrata');
  expect((await rc.request.get('/notifications/updates/' + ruleWork.id)).status()).toBe(404);
  expect((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: ruleWork.id } })).readAt).toBeNull();
  await reader.goto('/notifications/updates'); await reader.screenshot({ path: path.join(evidence, 'updates-history.png'), fullPage: true });
  await ac.close(); await rc.close(); await oc.close();
});
test('an open preview cannot save after its native registry session is revoked', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true); await preview(page, row);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(0);
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.id } })).nextActionNote).toBeNull();
  await context.close();
});
test('lost confirmation response freezes repeat writes; explicit receipt lookup and replay prove one save', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(), row = await fixture();
  await login(page, f.emails.admin, true); await preview(page, row);
  let captured: { url: string; body: string; headers: Record<string, string> } | undefined;
  let done!: () => void, fail!: (e: unknown) => void;
  const aborted = new Promise<void>((r, j) => { done = r; fail = j; });
  await page.route('**/record-updates/**', async route => {
    const req = route.request();
    if (req.method() !== 'POST' || !req.headers()['next-action']) return route.continue();
    try {
      captured = { url: req.url(), body: req.postData()!, headers: { 'next-action': req.headers()['next-action'], 'content-type': req.headers()['content-type'], origin } };
      const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done();
    } catch (error) { fail(error); }
  });
  await page.getByRole('button', { name: 'Salva e aggiorna', exact: true }).click(); await aborted;
  await page.unroute('**/record-updates/**');
  await expect(page.getByRole('button', { name: 'Verifica esito', exact: true })).toBeVisible();
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(1);
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('salvataggio è già registrato');
  expect(captured).toBeTruthy();
  await context.request.post(captured!.url, { headers: captured!.headers, data: captured!.body });
  expect(await db.recordUpdateDelivery.count({ where: { event: { recordId: row.id } } })).toBe(1);
  expect(await db.recordUpdateCommand.count({ where: { recordId: row.id } })).toBe(1);
  await context.close();
});
