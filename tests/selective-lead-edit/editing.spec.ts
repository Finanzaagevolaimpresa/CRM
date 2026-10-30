import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.LEAD_EDIT_EVIDENCE!, password = process.env.LEAD_EDIT_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: Array<{ leadId: string; readerId: string; readerEmail: string;
    excluded: string[]; inboxId: string; cycleId: string }>;
};
type Row = typeof f.rows[number];
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function grantCount(leadId: string) {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "SelectiveLeadEditGrant" WHERE "leadId"=${leadId}`;
  return Number(row.count);
}
async function commands(leadId: string) {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "SelectiveLeadEditCommand" WHERE "leadId"=${leadId}`;
  return Number(row.count);
}
async function prepareGrant(page: Page, row: Row) {
  await page.goto('/leads/' + row.leadId + '/sharing');
  await page.getByRole('link', { name: 'Gestisci i permessi di modifica', exact: true }).click();
  await page.getByLabel('Persona con accesso selettivo', { exact: true }).selectOption(row.readerId);
  await page.getByLabel('Priorità', { exact: true }).check();
  await page.getByRole('button', { name: 'Anteprima dei permessi di modifica' }).click();
  await expect(page.getByRole('heading', { name: 'Conferma persona e campi modificabili' })).toBeVisible();
  await expect(page.getByLabel('Persona con accesso selettivo', { exact: true })).toHaveValue(row.readerId);
  await expect(page.getByLabel('Priorità', { exact: true })).toBeChecked();
  const preview = page.getByRole('region', { name: 'Conferma persona e campi modificabili' });
  expect(await preview.locator('dt').count()).toBe(1);
  expect(await grantCount(row.leadId)).toBe(0);
  await page.getByLabel('Confermo personalmente destinatario, campi e scadenza.').check();
}
async function grant(page: Page, row: Row) {
  await prepareGrant(page, row);
  await page.getByRole('button', { name: 'Conferma permessi di modifica', exact: true }).click();
  await expect.poll(() => grantCount(row.leadId)).toBe(1);
}
async function prepareEdit(page: Page, row: Row, priority = 'alta') {
  await page.goto('/shared-leads/' + row.leadId);
  await page.getByRole('link', { name: 'Modifica i campi abilitati', exact: true }).click();
  expect(await page.locator('textarea').count()).toBe(0);
  for (const excluded of row.excluded) expect(await page.content()).not.toContain(excluded);
  await page.getByLabel('Priorità', { exact: true }).selectOption(priority);
  await page.getByRole('button', { name: 'Rivedi le modifiche', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma le modifiche', exact: true })).toBeVisible();
  await expect(page.getByLabel('Priorità', { exact: true })).toHaveValue(priority);
  await page.getByLabel('Confermo questi valori e il salvataggio sul lead.').check();
}
async function lostResponse(page: Page, button: string) {
  let forwarded = 0, done!: () => void, fail!: (error: unknown) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route('**/leads/**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try {
      const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done();
    } catch (error) { fail(error); }
  });
  await page.getByRole('button', { name: button, exact: true }).click(); await complete;
  await page.unroute('**/leads/**');
  return forwarded;
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.CI).toBe('true'); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native personal selection, exact recipient edit, privacy and open-session revocation on desktop/mobile', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  expect((await rc.request.get('/leads/' + row.leadId + '/sharing/editing')).status()).toBe(404);
  expect((await rc.request.get('/leads/' + row.leadId + '/edit-selected')).status()).toBe(404);
  await prepareGrant(admin, row);
  await admin.screenshot({ path: path.join(evidence, 'edit-management-desktop.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'edit-management-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: 'Conferma permessi di modifica', exact: true }).click();
  await expect.poll(() => grantCount(row.leadId)).toBe(1);
  const before = await db.lead.findUniqueOrThrow({ where: { id: row.leadId } });
  const inbox = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.inboxId } });
  const cycle = await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycleId } });
  expect((await rc.request.get('/leads/' + row.leadId + '/edit')).status()).toBe(404);
  await prepareEdit(reader, row);
  await reader.screenshot({ path: path.join(evidence, 'edit-recipient-desktop.png'), fullPage: true });
  await reader.setViewportSize({ width: 390, height: 844 });
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: path.join(evidence, 'edit-recipient-mobile.png'), fullPage: true });
  await reader.getByRole('button', { name: 'Conferma e salva modifiche', exact: true }).click();
  await expect.poll(() => commands(row.leadId)).toBe(1);
  const after = await db.lead.findUniqueOrThrow({ where: { id: row.leadId } });
  expect({ ...after, priority: before.priority, updatedAt: before.updatedAt }).toEqual(before);
  expect(after.priority).toBe('alta');
  expect(await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: row.inboxId } })).toEqual(inbox);
  expect(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: row.cycleId } })).toEqual(cycle);
  await prepareEdit(reader, row, 'urgente');
  await admin.goto('/leads/' + row.leadId + '/sharing/editing');
  await admin.getByLabel('Confermo la revoca dei permessi di modifica.').check();
  await admin.getByRole('button', { name: 'Revoca modifica', exact: true }).click();
  await expect.poll(async () => {
    const [g] = await db.$queryRaw<Array<{ revokedAt: Date | null }>>`SELECT "revokedAt" FROM "SelectiveLeadEditGrant" WHERE "leadId"=${row.leadId}`;
    return !!g.revokedAt;
  }).toBe(true);
  await reader.getByRole('button', { name: 'Conferma e salva modifiche', exact: true }).click();
  await expect(reader.getByText('Operazione non consentita. Verifica sessione e abilitazione corrente.', { exact: true })).toBeVisible();
  expect(await commands(row.leadId)).toBe(1);
  expect((await db.lead.findUniqueOrThrow({ where: { id: row.leadId } })).priority).toBe('alta');
  expect((await rc.request.get('/leads/' + row.leadId + '/edit-selected')).status()).toBe(404);
  await ac.close(); await rc.close();
});

test('lost native recipient response is reconciled after reload without retaining values or sending again', async ({ browser }) => {
  const row = f.rows[1], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await grant(admin, row);
  await login(reader, row.readerEmail); await prepareEdit(reader, row);
  expect(await lostResponse(reader, 'Conferma e salva modifiche')).toBe(1);
  expect(new URL(reader.url()).searchParams.get('editCommandId')).toBeTruthy();
  expect(reader.url()).not.toContain('alta');
  await reader.reload();
  await expect(reader.getByRole('button', { name: 'Rivedi le modifiche' })).toHaveCount(0);
  await reader.getByRole('button', { name: 'Verifica esito della modifica', exact: true }).click();
  await expect(reader.getByText('Modifica registrata. Puoi ricaricare i dati correnti.', { exact: true })).toBeVisible();
  expect(await commands(row.leadId)).toBe(1);
  const [command] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "SelectiveLeadEditCommand" WHERE "leadId"=${row.leadId}`;
  expect(await db.auditLog.count({ where: { id: command.id, event: 'selective_lead_edit_applied' } })).toBe(1);
  await ac.close(); await rc.close();
});

test('lost personal decision has one receipt; revoking the recipient session blocks an open native edit', async ({ browser }) => {
  const row = f.rows[2], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await prepareGrant(admin, row);
  expect(await lostResponse(admin, 'Conferma permessi di modifica')).toBe(1);
  expect(new URL(admin.url()).searchParams.get('editDecisionId')).toBeTruthy();
  await admin.reload();
  await expect(admin.getByRole('button', { name: 'Anteprima dei permessi di modifica' })).toBeDisabled();
  await admin.getByRole('button', { name: 'Verifica ricevuta della decisione' }).click();
  await expect(admin.getByText('Operazione registrata: abilitazione, revisione 1. Ricarica lo stato corrente.', { exact: true })).toBeVisible();
  expect(await grantCount(row.leadId)).toBe(1);
  await login(reader, row.readerEmail); await prepareEdit(reader, row);
  await db.internalSession.updateMany({ where: { userId: row.readerId, revokedAt: null }, data: { revokedAt: new Date() } });
  await reader.getByRole('button', { name: 'Conferma e salva modifiche', exact: true }).click();
  await expect(reader).toHaveURL(/\/login/);
  expect(await commands(row.leadId)).toBe(0);
  await ac.close(); await rc.close();
});
