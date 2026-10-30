import { romeDateTimeInput } from '../../src/lib/rome-date-time';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.TECHNICAL_ITEM_EVIDENCE!, password = process.env.TECHNICAL_ITEM_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as { synthetic: boolean; adminEmail: string;
  rows: Array<{ clientId: string; projectId: string; practiceId: string; taskId: string; checklistId: string; catalogTaskIds: string[];
    catalogDocuments: Array<{ id: string; title: string; fileName: string; versions: Array<{ fileId: string; version: number; text: string }> }>;
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
    await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click();
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
  for (const name of checklist ? ['Titolo', 'Note tecniche', 'Stato'] : ['Titolo', 'Priorità', 'Scadenza']) await card.getByLabel(name, { exact: true }).check();
  await card.getByLabel(checklist ? 'Consenti modifica note tecniche' : 'Consenti modifica priorità', { exact: true }).check();
  await expect(page.getByText('Checklist finanziaria esclusa', { exact: false })).toHaveCount(0);
  await page.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
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
  await page.getByLabel(checklist ? 'Modifica note tecniche' : 'Modifica priorità', { exact: true }).check();
  if (checklist) await page.getByRole('textbox', { name: 'Note tecniche', exact: true }).fill('Nota tecnica aggiornata');
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
  // Use a matching prefix: the search page legitimately echoes the user's query.
  // Keep the complete excluded value out of that input so the response assertion
  // still detects any disclosure from a result or its serialized payload.
  for (const url of ['/search?q=DESCRIZIONE_TASK', '/tasks', '/documents', '/notifications']) {
    const response = await tc.request.get(url); expect(response.status()).toBeLessThan(500);
    const body = await response.text();
    if (url.startsWith('/search?')) expect(body).toContain('Nessun risultato trovato');
    for (const value of row.excluded) expect(body).not.toContain(value);
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

async function openCatalogue(page: Page, row: Row) {
  await page.goto(management(row) + '?recipient=' + row.techA.id);
  await page.locator('[data-technical-editor-ready="true"]').waitFor();
  await page.getByLabel('Gestire le attività e le scadenze', { exact: true }).check();
  await page.getByLabel('Titolo', { exact: true }).check();
  await page.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Scelte sintetiche conservate fra pagine');
  await page.getByLabel('Cerca attività e checklist', { exact: true }).fill('Catalogo sintetico');
  await page.getByLabel('Tipo di elemento', { exact: true }).selectOption('Task');
  await page.getByRole('button', { name: 'Cerca nel catalogo', exact: true }).click();
  await expect(page.getByText('Catalogo aggiornato. Le scelte già effettuate sono conservate.', { exact: true })).toBeVisible();
}
async function chooseCatalogueItem(page: Page, suffix: string) {
  const check = page.getByLabel(`Attività · Catalogo sintetico ${suffix}`, { exact: true });
  await check.check(); const card = check.locator('..').locator('..');
  await card.getByLabel('Titolo', { exact: true }).check(); await card.getByLabel('Priorità', { exact: true }).check();
  await card.getByLabel('Consenti modifica priorità', { exact: true }).check();
}

test('catalogue search reaches the fourth page, retains exact choices across pages and admits their actual technical use', async ({ browser }) => {
  const row = f.rows[3], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true);
  await openCatalogue(admin, row); await chooseCatalogueItem(admin, '00');
  for (let page = 2; page <= 4; page++) {
    await admin.getByRole('button', { name: 'Altri elementi', exact: true }).click();
    await expect(admin.getByText(new RegExp(`^Pagina ${page} ·`))).toBeVisible();
  }
  await expect(admin.getByRole('button', { name: 'Altri elementi', exact: true })).toHaveCount(0);
  await expect(admin.getByLabel('Attività · Catalogo sintetico 00', { exact: true })).toBeChecked();
  await chooseCatalogueItem(admin, '64');
  expect(await admin.content()).not.toContain('Catalogo sintetico ESCLUSO');
  await screenshot(admin, 'catalogue-selection');
  // A new search does not remove either choice, or turn an unseen row into one.
  await admin.getByLabel('Cerca attività e checklist', { exact: true }).fill('nessun risultato sintetico');
  await admin.getByRole('button', { name: 'Cerca nel catalogo', exact: true }).click();
  await expect(admin.getByText('Nessun elemento pertinente per questa ricerca e pagina.', { exact: true })).toBeVisible();
  await expect(admin.getByLabel('Attività · Catalogo sintetico 00', { exact: true })).toBeChecked();
  await expect(admin.getByLabel('Attività · Catalogo sintetico 64', { exact: true })).toBeChecked();
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  const preview = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await expect(preview.getByText('Catalogo sintetico 00', { exact: true })).toBeVisible();
  await expect(preview.getByText('Catalogo sintetico 64', { exact: true })).toBeVisible();
  await preview.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await preview.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
  await login(tech, row.techA.email);
  const taskUrl = work(row) + '/items/Task/' + row.catalogTaskIds[64];
  await tech.goto(taskUrl); await expect(tech.getByRole('heading', { name: 'Catalogo sintetico 64', exact: true, level: 1 })).toBeVisible();
  await tech.getByLabel('Modifica priorità', { exact: true }).check();
  await tech.getByRole('combobox', { name: 'Priorità', exact: true }).selectOption('alta');
  await tech.getByRole('button', { name: 'Prepara riepilogo dell’attività', exact: true }).click();
  await tech.getByLabel('Confermo soltanto le modifiche riepilogate.', { exact: true }).check(); await save(tech);
  expect((await db.task.findUniqueOrThrow({ where: { id: row.catalogTaskIds[64] } })).priority).toBe('alta');
  expect((await tc.request.get(work(row) + '/items/Task/' + row.catalogTaskIds[30])).status()).toBe(404);
  for (const person of [row.techB, row.salesA, row.salesB]) {
    const context = await browser.newContext(), p = await context.newPage(); await login(p, person.email);
    expect((await context.request.get(taskUrl)).status()).toBe(404);
    expect((await context.request.get(management(row) + '?recipient=' + row.techA.id)).status()).toBe(404);
    await context.close();
  }
  await ac.close(); await tc.close();
});

test('catalogue refresh preserves a chosen stale generation and the renewed preview fails after concurrent content change', async ({ browser }) => {
  const row = f.rows[4], ac = await browser.newContext({ viewport: { width: 390, height: 844 } }), admin = await ac.newPage();
  await login(admin, f.adminEmail, true); await openCatalogue(admin, row);
  await chooseCatalogueItem(admin, '00');
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  await db.task.update({ where: { id: row.catalogTaskIds[0] }, data: { priority: 'alta' } });
  await admin.getByRole('button', { name: 'Cerca nel catalogo', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toHaveCount(0);
  await expect(admin.getByLabel('Attività · Catalogo sintetico 00', { exact: true })).toBeChecked();
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(admin.getByText('Stato o permessi cambiati. Ricarica e prepara un nuovo riepilogo.', { exact: true })).toBeVisible();
  expect(await db.technicalAssignment.count({ where: { recipientId: row.techA.id, practiceId: row.practiceId } })).toBe(0);
  await screenshot(admin, 'catalogue-stale'); await ac.close();
});

async function openDocuments(page: Page, row: Row) {
  await page.goto(management(row) + '?recipient=' + row.techA.id);
  await page.locator('[data-technical-editor-ready="true"]').waitFor();
  await page.getByLabel('Aggiornare lo stato', { exact: true }).check();
  await page.getByLabel('Stato', { exact: true }).check(); await page.getByLabel('Titolo', { exact: true }).check();
  await page.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Scelta sintetica di versioni e download');
  await searchDocuments(page, 'Catalogo documentale sintetico');
}
async function searchDocuments(page: Page, query: string) {
  await page.getByLabel('Cerca documenti e versioni', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Cerca nel catalogo documenti', exact: true }).click();
  await expect(page.getByText('Catalogo aggiornato. Le versioni già scelte conservano la selezione originale.', { exact: true })).toBeVisible();
}
function documentLabel(row: Row['catalogDocuments'][number], version = 1) {
  return `${row.title} · ${row.fileName} · versione ${version}`;
}

test('document pages preserve explicit old/off-page versions; one technician reads exact bytes and download remains separate', async ({ browser }) => {
  const row = f.rows[5], ac = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), admin = await ac.newPage();
  const tc = await browser.newContext(), tech = await tc.newPage(), first = row.catalogDocuments[0], last = row.catalogDocuments[64];
  await login(admin, f.adminEmail, true); await openDocuments(admin, row);
  const selected = admin.getByLabel(documentLabel(first), { exact: true }); await selected.check();
  await selected.locator('..').locator('..').getByLabel('Consenti anche il download', { exact: true }).check();
  await admin.getByRole('button', { name: 'Altre versioni', exact: true }).click();
  await expect(admin.getByRole('region', { name: 'Versioni conservate da altre pagine', exact: true }).getByLabel(documentLabel(first), { exact: true })).toBeChecked();
  await searchDocuments(admin, last.fileName); await admin.getByLabel(documentLabel(last), { exact: true }).check();
  await expect(admin.getByLabel(documentLabel(last, 2), { exact: true })).not.toBeChecked();
  await screenshot(admin, 'document-catalogue-selections');
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  const preview = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await expect(preview.getByRole('heading', { name: 'Versioni documentali incluse', exact: true })).toBeVisible();
  await expect(preview.getByText(new RegExp(first.fileName.replace('.', '\\.')))).toBeVisible();
  await expect(preview.getByText(new RegExp(last.fileName.replace('.', '\\.')))).toBeVisible();
  await preview.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await preview.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
  await login(tech, row.techA.email); await tech.goto(work(row));
  const base = work(row) + '/documents/';
  const allowed = await tc.request.get(base + first.versions[0].fileId + '?download=1');
  expect(allowed.status()).toBe(200); expect(await allowed.text()).toBe(first.versions[0].text);
  expect(allowed.headers()['content-disposition']).toContain('attachment');
  const inline = await tc.request.get(base + last.versions[0].fileId);
  expect(inline.status()).toBe(200); expect(await inline.text()).toBe(last.versions[0].text);
  expect(inline.headers()['content-disposition']).toContain('inline');
  for (const suffix of [last.versions[0].fileId + '?download=1', last.versions[1].fileId, row.catalogDocuments[30].versions[0].fileId])
    expect((await tc.request.get(base + suffix)).status()).toBe(404);
  await screenshot(tech, 'document-catalogue-recipient');
  for (const person of [row.techB, row.salesA, row.salesB]) {
    const c = await browser.newContext(), page = await c.newPage(); await login(page, person.email);
    expect((await c.request.get(base + first.versions[0].fileId)).status()).toBe(404);
    expect((await c.request.get(management(row) + '?recipient=' + row.techA.id)).status()).toBe(404); await c.close();
  }
  await ac.close(); await tc.close();
});

test('document search retains stale selected context until explicit removal and reselection', async ({ browser }) => {
  const row = f.rows[6], ac = await browser.newContext({ viewport: { width: 390, height: 844 } }), admin = await ac.newPage();
  const chosen = row.catalogDocuments[64];
  await login(admin, f.adminEmail, true); await openDocuments(admin, row); await searchDocuments(admin, chosen.fileName);
  await admin.getByLabel(documentLabel(chosen), { exact: true }).check();
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  const title = 'Documento sintetico aggiornato dopo anteprima';
  await db.document.update({ where: { id: chosen.id }, data: { title } });
  await searchDocuments(admin, chosen.fileName);
  await expect(admin.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toHaveCount(0);
  await expect(admin.getByLabel(documentLabel(chosen), { exact: true })).toBeChecked();
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(admin.getByText('Stato o permessi cambiati. Ricarica e prepara un nuovo riepilogo.', { exact: true })).toBeVisible();
  expect(await db.technicalAssignment.count({ where: { recipientId: row.techA.id, practiceId: row.practiceId } })).toBe(0);
  await screenshot(admin, 'document-catalogue-stale');
  await admin.getByRole('button', { name: 'Rimuovi questa versione', exact: true }).click();
  await admin.getByLabel(documentLabel({ ...chosen, title }), { exact: true }).check();
  await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  expect(await db.technicalAssignment.count({ where: { recipientId: row.techA.id, practiceId: row.practiceId } })).toBe(0);
  await ac.close();
});

test('exceeded document capacity is explicit and preserves independent personal revocation', async ({ browser }) => {
  const row = f.rows[7], ac = await browser.newContext(), admin = await ac.newPage(), tc = await browser.newContext(), tech = await tc.newPage();
  await login(tech, row.techA.email); expect((await tc.request.get(work(row))).status()).toBe(200);
  await login(admin, f.adminEmail, true); await admin.goto(management(row) + '?recipient=' + row.techA.id);
  await admin.locator('[data-technical-editor-ready="true"]').waitFor();
  await expect(admin.getByText('Catalogo documenti non disponibile. La revoca degli incarichi resta disponibile.', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true })).toBeDisabled();
  await screenshot(admin, 'document-catalogue-capacity');
  await admin.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica indipendente dal catalogo');
  await admin.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  const preview = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await expect(preview.getByRole('heading', { name: 'Conferma revoca dell’incarico', exact: true })).toBeVisible();
  await preview.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await preview.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  expect((await tc.request.get(work(row))).status()).toBe(404); await ac.close(); await tc.close();
});

test('a real catalogue lock timeout leaves native history and personal revocation available', async ({ browser }) => {
  const row = f.rows[8], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage();
  await login(admin, f.adminEmail, true); await login(tech, row.techA.email);
  await assign(admin, row, row.techA); await prepare(tech, row);
  const url = management(row) + '?recipient=' + row.techA.id;
  // Warm the actual page before holding the row, so compilation is not the
  // timing condition. The real app keeps its unchanged 5s transaction timeout.
  await admin.goto(url); await expect(admin.getByLabel('Motivo della revoca', { exact: true })).toBeVisible();
  let locked!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id=${row.taskId} FOR UPDATE`;
    locked(); await held;
  }, { timeout: 30_000 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([acquired, blocker]);
    timer = setTimeout(release, 9_000);
    await admin.goto(url);
    await expect(admin.getByText('Catalogo non disponibile. Puoi consultare gli incarichi registrati e revocarli; ricarica per preparare un nuovo incarico.', { exact: true })).toBeVisible();
    await expect(admin.getByRole('heading', { name: 'Incarichi registrati su questo record', exact: true })).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true })).toHaveCount(0);
    await expect(admin.getByLabel('Cerca attività e checklist', { exact: true })).toHaveCount(0);
    await expect(admin.getByRole('button', { name: 'Anteprima della revoca', exact: true })).toBeEnabled();
    for (const value of row.excluded) expect(await admin.content()).not.toContain(value);
    await screenshot(admin, 'catalogue-error-revocation');
  } finally { if (timer) clearTimeout(timer); release(); await blocker; }
  await admin.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica dopo errore del catalogo');
  await admin.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  const revocation = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await revocation.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await revocation.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  await tech.getByRole('button', { name: 'Conferma modifica dell’attività', exact: true }).click();
  await expect(tech.getByText('La modifica non è stata registrata: attività, incarico o permessi non più validi. Ricarica prima di riprovare.', { exact: true })).toBeVisible();
  expect((await tc.request.get(item(row))).status()).toBe(404); expect(await count(row)).toBe(0);
  await ac.close(); await tc.close();
});
