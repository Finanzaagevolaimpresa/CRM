import { romeDateTimeInput } from '../../src/lib/rome-date-time';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.TECHNICAL_PRIVATE_ITEM_EVIDENCE!, password = process.env.TECHNICAL_PRIVATE_ITEM_BROWSER_PASSWORD!;
type Person = { id: string; email: string };
const fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string;
  rows: Array<{ clientId: string; projectId: string; practiceId: string; siblingId: string; techA: Person; techB: Person; salesA: Person; salesB: Person }> };
type Row = typeof fixture.rows[number];
const management = (r: Row, project = false) => project ? '/projects/' + r.projectId + '/assignments' : '/technical-office/practices/' + r.practiceId + '/assignments';
const creation = (r: Row, project = false) => management(r, project) + '/create';
const workItem = (r: Row, kind: string, id: string) => '/technical-work/practices/' + r.practiceId + '/items/' + kind + '/' + id;
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) { await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible(); }
}
async function preview(page: Page, row: Row, kind: 'Task' | 'ChecklistItem', title: string, project = false) {
  await page.goto(creation(row, project)); await page.locator('[data-private-item-ready="true"]').waitFor();
  await page.getByLabel('Tipo di elemento', { exact: true }).selectOption(kind);
  await page.getByLabel('Titolo', { exact: true }).fill(title);
  await page.getByLabel(kind === 'Task' ? 'Descrizione' : 'Note', { exact: true }).fill('TESTO_PRIVATO_NON_SCELTO');
  const command = JSON.parse(await page.locator('input[name="command"]').inputValue()) as { commandId: string; itemId: string; kind: string };
  await page.getByRole('button', { name: 'Prepara riepilogo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma la creazione privata', exact: true })).toBeVisible();
  await page.getByLabel('Confermo il contenuto e la creazione privata.', { exact: true }).check();
  return command;
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Crea elemento privato', exact: true }).click();
  await expect(page.getByText('Elemento privato creato. Puoi ora scegliere separatamente chi potrà utilizzarlo.', { exact: true })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(evidence, name + '-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, name + '-mobile.png'), fullPage: true });
}
async function assign(page: Page, row: Row, person: Person, title: string, kind: 'Task' | 'ChecklistItem') {
  await page.goto(management(row) + '?recipient=' + person.id);
  await page.locator('[data-technical-editor-ready="true"]').waitFor();
  await page.getByRole('combobox', { name: 'Responsabilità', exact: true }).selectOption('co_responsabile');
  await page.getByLabel(kind === 'Task' ? 'Gestire le attività e le scadenze' : 'Gestire la checklist', { exact: true }).check();
  await page.getByLabel('Titolo', { exact: true }).check();
  const selected = page.getByLabel((kind === 'Task' ? 'Attività · ' : 'Checklist · ') + title, { exact: true });
  await selected.check(); const card = selected.locator('..').locator('..');
  for (const field of kind === 'Task' ? ['Titolo', 'Priorità'] : ['Titolo', 'Note tecniche']) await card.getByLabel(field, { exact: true }).check();
  await card.getByLabel(kind === 'Task' ? 'Consenti modifica priorità' : 'Consenti modifica note tecniche', { exact: true }).check();
  await page.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Decisione sintetica separata dalla creazione');
  await page.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  await page.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await page.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(page.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
}
test.beforeAll(async () => { expect(process.env.CI).toBe('true'); expect(fixture.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());

test('native preview creates nothing; exact private task and checklist save without implicit people or notifications', async ({ page }) => {
  const row = fixture.rows[0]; await login(page, fixture.adminEmail, true);
  const before = { grants: await db.technicalAssignment.count(), messages: await db.recordUpdateDelivery.count(), emails: await db.approvedCommunication.count() };
  for (const kind of ['Task', 'ChecklistItem'] as const) {
    const title = kind === 'Task' ? 'Relazione tecnica privata' : 'Documenti tecnici da preparare';
    const command = await preview(page, row, kind, title);
    expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(0);
    await screenshot(page, kind.toLowerCase() + '-creation-preview');
    if (kind === 'Task') {
      await page.context().clearCookies({ name: 'fai_crm_privileged_step_up' });
      await page.getByRole('button', { name: 'Crea elemento privato', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Conferma identità senza lasciare il lavoro', exact: true })).toBeVisible();
      expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(0);
      await expect(page.getByLabel('Confermo il contenuto e la creazione privata.', { exact: true })).toBeChecked();
      await page.getByLabel('Password corrente', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
      await expect(page.getByText('Identità confermata. Le scelte sono conservate; scegli personalmente quando proseguire.', { exact: true })).toBeVisible();
      expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(0);
    }
    await save(page);
    expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(1);
    expect(await db.auditLog.count({ where: { id: command.commandId } })).toBe(1);
    await screenshot(page, kind.toLowerCase() + '-creation-receipt');
    for (const url of ['/tasks', '/documents', '/clients/' + row.clientId, '/technical-office/practices/' + row.practiceId, '/search?q=Relazione']) {
      const response = await page.request.get(url); expect(response.status()).toBeLessThan(500);
      expect(await response.text()).not.toContain(title);
    }
  }
  expect({ grants: await db.technicalAssignment.count(), messages: await db.recordUpdateDelivery.count(), emails: await db.approvedCommunication.count() }).toEqual(before);
});
test('Admin creates then explicitly assigns different items to two technicians; both sales and cross-item URLs remain denied', async ({ browser }) => {
  const row = fixture.rows[1], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const admin = await ac.newPage(), a = await tc.newPage(), b = await bc.newPage(); await login(admin, fixture.adminEmail, true);
  const task = await preview(admin, row, 'Task', 'Attività riservata al tecnico A'); await save(admin);
  const check = await preview(admin, row, 'ChecklistItem', 'Checklist riservata al tecnico B'); await save(admin);
  await login(a, row.techA.email); await login(b, row.techB.email);
  expect((await a.request.get(workItem(row, 'Task', task.itemId))).status()).toBe(404);
  await assign(admin, row, row.techA, 'Attività riservata al tecnico A', 'Task');
  await assign(admin, row, row.techB, 'Checklist riservata al tecnico B', 'ChecklistItem');
  await a.goto(workItem(row, 'Task', task.itemId)); await a.locator('[data-technical-item-ready="true"]').waitFor();
  expect(await a.content()).not.toContain('TESTO_PRIVATO_NON_SCELTO');
  await a.getByLabel('Modifica priorità', { exact: true }).check(); await a.getByLabel('Priorità', { exact: true }).selectOption('urgente');
  await a.getByRole('button', { name: 'Prepara riepilogo dell’attività', exact: true }).click();
  await a.getByLabel('Confermo soltanto le modifiche riepilogate.', { exact: true }).check();
  await a.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click();
  await expect(a.getByText('Modifica registrata con ricevuta. Nessun messaggio è stato inviato.', { exact: true })).toBeVisible();
  await screenshot(a, 'private-task-assigned-work');
  await b.goto(workItem(row, 'ChecklistItem', check.itemId)); await b.locator('[data-technical-item-ready="true"]').waitFor();
  await expect(b.getByRole('definition').filter({ hasText: /^TESTO_PRIVATO_NON_SCELTO$/ })).toBeVisible();
  await expect(b.getByRole('textbox', { name: 'Note tecniche', exact: true })).toHaveValue('TESTO_PRIVATO_NON_SCELTO');
  await b.getByLabel('Modifica note tecniche', { exact: true }).check();
  await b.getByRole('textbox', { name: 'Note tecniche', exact: true }).fill('Preparazione tecnica verificata da B');
  await b.getByRole('button', { name: 'Prepara riepilogo dell’attività', exact: true }).click();
  await b.getByLabel('Confermo soltanto le modifiche riepilogate.', { exact: true }).check();
  await b.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click();
  await expect(b.getByText('Modifica registrata con ricevuta. Nessun messaggio è stato inviato.', { exact: true })).toBeVisible();
  await screenshot(b, 'private-checklist-assigned-work');
  expect((await a.request.get(workItem(row, 'ChecklistItem', check.itemId))).status()).toBe(404);
  expect((await b.request.get(workItem(row, 'Task', task.itemId))).status()).toBe(404);
  for (const person of [row.salesA, row.salesB]) { const sc = await browser.newContext(), s = await sc.newPage(); await login(s, person.email);
    for (const url of [creation(row), workItem(row, 'Task', task.itemId), workItem(row, 'ChecklistItem', check.itemId)]) expect((await s.request.get(url)).status()).toBe(404);
    await sc.close(); }
  expect((await db.task.findUniqueOrThrow({ where: { id: task.itemId } })).priority).toBe('urgente');
  expect((await db.documentChecklistItem.findUniqueOrThrow({ where: { id: check.itemId } })).notes).toBe('Preparazione tecnica verificata da B');
  await ac.close(); await tc.close(); await bc.close();
});
test('lost native response recovers the single creation receipt without another write', async ({ page }) => {
  const row = fixture.rows[2]; await login(page, fixture.adminEmail, true);
  const command = await preview(page, row, 'Task', 'Creazione con risposta persa');
  let forwarded = 0, done!: () => void, fail!: (e: unknown) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route('**/assignments/create**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++; try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500);
      await route.abort('failed'); done(); } catch (error) { fail(error); }
  });
  await page.getByRole('button', { name: 'Crea elemento privato', exact: true }).click(); await complete;
  await page.unroute('**/assignments/create**'); expect(forwarded).toBe(1);
  expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'Crea elemento privato', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verifica esito della creazione', exact: true }).click();
  await expect(page.getByText('Creazione già registrata. L’elemento resta privato finché non scegli chi potrà utilizzarlo.', { exact: true })).toBeVisible();
  await screenshot(page, 'private-creation-recovery');
  expect(await db.auditLog.count({ where: { id: command.commandId } })).toBe(1);
});
test('revocation of the open Admin session prevents native confirmation and creates no private row', async ({ page }) => {
  const row = fixture.rows[3]; await login(page, fixture.adminEmail, true);
  const command = await preview(page, row, 'Task', 'Creazione con sessione revocata');
  await db.internalSession.updateMany({ where: { userId: fixture.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Crea elemento privato', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.technicalPrivateItemOrigin.count({ where: { commandId: command.commandId } })).toBe(0);
  expect(await db.task.count({ where: { id: command.itemId } })).toBe(0);
});
test('project-private creation remains unavailable in either sibling practice catalogue', async ({ page }) => {
  const row = fixture.rows[4]; await login(page, fixture.adminEmail, true);
  const command = await preview(page, row, 'ChecklistItem', 'Voce riservata al progetto', true); await save(page);
  await page.goto(management(row, true) + '?recipient=' + row.techA.id);
  await expect(page.getByLabel('Checklist · Voce riservata al progetto', { exact: true })).toBeVisible();
  for (const id of [row.practiceId, row.siblingId]) {
    await page.goto('/technical-office/practices/' + id + '/assignments?recipient=' + row.techA.id);
    await expect(page.getByLabel('Checklist · Voce riservata al progetto', { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(command.itemId);
  }
  await page.goto(creation(row, true) + '?privateItemDecision=' + command.commandId);
  await page.getByRole('button', { name: 'Verifica esito della creazione', exact: true }).click();
  await expect(page.getByText('Creazione già registrata. L’elemento resta privato finché non scegli chi potrà utilizzarlo.', { exact: true })).toBeVisible();
});
