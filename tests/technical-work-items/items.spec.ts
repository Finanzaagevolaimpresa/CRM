import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.TECHNICAL_ITEM_EVIDENCE!, password = process.env.TECHNICAL_ITEM_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as { synthetic: boolean; adminEmail: string;
  rows: Array<{ clientId: string; projectId: string; practiceId: string; taskId: string; checklistId: string;
    techA: { id: string; email: string }; techB: { id: string; email: string }; salesA: { id: string; email: string };
    salesB: { id: string; email: string }; excluded: string[] }> };
type Row = typeof f.rows[number];
const work = (r: Row) => '/technical-work/practices/' + r.practiceId;
const item = (r: Row, checklist = false) => work(r) + '/items/' + (checklist ? 'ChecklistItem/' + r.checklistId : 'Task/' + r.taskId);
const management = (r: Row) => '/technical-office/practices/' + r.practiceId + '/assignments';
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) { await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per cinque minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible(); }
}
async function assign(page: Page, row: Row, person: Row['techA'], checklist = false) {
  await page.goto(management(row));
  await page.getByRole('combobox', { name: 'Persona da incaricare', exact: true }).selectOption(person.id);
  await page.getByRole('button', { name: 'Apri scelte per la persona', exact: true }).click();
  await page.getByRole('combobox', { name: 'Responsabilità', exact: true }).selectOption('co_responsabile');
  await page.getByLabel(checklist ? 'Gestire la checklist' : 'Gestire le attività e le scadenze', { exact: true }).check();
  await page.getByLabel('Titolo', { exact: true }).check();
  const selected = page.getByLabel(checklist ? 'Checklist · Checklist scelta' : 'Attività · Attività tecnica scelta', { exact: true });
  await selected.check(); const card = selected.locator('..').locator('..');
  for (const name of checklist ? ['Titolo', 'Note', 'Stato'] : ['Titolo', 'Priorità', 'Scadenza']) await card.getByLabel(name, { exact: true }).check();
  await card.getByLabel(checklist ? 'Consenti modifica note' : 'Consenti modifica priorità', { exact: true }).check();
  await expect(page.getByText('Checklist finanziaria esclusa', { exact: false })).toHaveCount(0);
  await page.getByLabel('Scadenza, entro 90 giorni', { exact: true }).fill(new Date(Date.now() + 3600000).toISOString().slice(0,16));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Selezione sintetica di elementi e campi');
  await page.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  await page.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await page.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(page.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
}
async function prepare(page: Page, row: Row, checklist = false) {
  await page.goto(item(row, checklist)); await page.locator('[data-technical-item-ready="true"]').waitFor();
  for (const value of row.excluded) expect(await page.content()).not.toContain(value);
  await page.getByLabel(checklist ? 'Modifica note' : 'Modifica priorità', { exact: true }).check();
  if (checklist) await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Nota tecnica aggiornata');
  else await page.getByRole('combobox', { name: 'Priorità', exact: true }).selectOption('urgente');
  await page.getByRole('button', { name: 'Prepara riepilogo dell’attività', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma le modifiche', exact: true })).toBeVisible();
  await page.getByLabel('Confermo soltanto le modifiche riepilogate.', { exact: true }).check();
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click();
  await expect(page.getByText('Modifica registrata con ricevuta. Nessun messaggio è stato inviato.', { exact: true })).toBeVisible();
}
async function count(row: Row) { const [r] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalWorkItemCommand" WHERE "targetId"=${row.practiceId}`; return Number(r.n); }
async function screenshot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(evidence, name + '-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, name + '-mobile.png'), fullPage: true });
}
test.beforeAll(async () => { expect(process.env.CI).toBe('true'); expect(f.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());
test('personal Admin selects different items for two technicians; native edits persist and both sales are excluded', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const admin = await ac.newPage(), a = await tc.newPage(), b = await bc.newPage();
  await login(admin, f.adminEmail, true); await login(a, row.techA.email); await login(b, row.techB.email);
  await assign(admin, row, row.techA); await assign(admin, row, row.techB, true);
  await prepare(a, row); await screenshot(a, 'task-preview'); await save(a);
  await prepare(b, row, true); await screenshot(b, 'checklist-preview'); await save(b);
  expect(await count(row)).toBe(2);
  expect((await db.task.findUniqueOrThrow({ where: { id: row.taskId } })).priority).toBe('urgente');
  expect((await db.documentChecklistItem.findUniqueOrThrow({ where: { id: row.checklistId } })).notes).toBe('Nota tecnica aggiornata');
  expect((await tc.request.get(item(row, true))).status()).toBe(404); expect((await bc.request.get(item(row))).status()).toBe(404);
  for (const person of [row.salesA, row.salesB]) { const sc = await browser.newContext(), s = await sc.newPage(); await login(s, person.email);
    for (const url of [item(row), item(row, true)]) expect((await sc.request.get(url)).status()).toBe(404);
    await sc.close(); }
  for (const url of ['/search?q=DESCRIZIONE_TASK_NON_SCELTA', '/tasks', '/documents', '/notifications']) {
    const response = await tc.request.get(url); expect(response.status()).toBeLessThan(500);
    for (const value of row.excluded) expect(await response.text()).not.toContain(value);
  }
  await ac.close(); await tc.close(); await bc.close();
});
test('mobile lost response reconciles the single item receipt without a second command', async ({ browser }) => {
  const row = f.rows[1], ac = await browser.newContext(), tc = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true); await login(tech, row.techA.email);
  await assign(admin, row, row.techA); await prepare(tech, row); let forwarded = 0, done!: () => void, fail!: (e: unknown) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await tech.route('**/technical-work/**', async route => { if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++; try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); } catch(e) { fail(e); } });
  await tech.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click(); await complete;
  await tech.unroute('**/technical-work/**'); await expect.poll(() => count(row)).toBe(1); expect(forwarded).toBe(1);
  await tech.reload(); await tech.getByRole('button', { name: 'Verifica esito del salvataggio', exact: true }).click();
  await expect(tech.getByText('Modifica già registrata. Non ripetere il salvataggio.', { exact: true })).toBeVisible(); expect(await count(row)).toBe(1);
  await screenshot(tech, 'item-recovery'); await ac.close(); await tc.close();
});
test('Admin revocation denies an already open item preview and subsequent URL reads', async ({ browser }) => {
  const row = f.rows[2], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true); await login(tech, row.techA.email);
  await assign(admin, row, row.techA); await prepare(tech, row);
  await admin.goto(management(row) + '?recipient=' + row.techA.id); await admin.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica con attività aperta');
  await admin.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  const revocation = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await revocation.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await revocation.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  await tech.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click();
  await expect(tech.getByText('La modifica non è stata registrata: attività, incarico o permessi non più validi. Ricarica prima di riprovare.', { exact: true })).toBeVisible();
  expect(await count(row)).toBe(0); expect((await tc.request.get(item(row))).status()).toBe(404);
  expect((await db.task.findUniqueOrThrow({ where: { id: row.taskId } })).priority).toBe('alta');
  await ac.close(); await tc.close();
});
