import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.TECHNICAL_EVIDENCE!, password = process.env.TECHNICAL_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as { synthetic: boolean; adminId: string; adminEmail: string;
  rows: Array<{ clientId: string; projectId: string; practiceId: string; otherProjectId: string;
    techA: { id: string; email: string }; techB: { id: string; email: string }; salesA: { id: string; email: string }; salesB: { id: string; email: string };
    documents: Array<{ id: string; fileId: string; title: string; fileName: string; text: string }>; excluded: string[] }> };
type Row = typeof f.rows[number];
function management(row: Row, project = false) { return project ? `/projects/${row.projectId}/assignments` : `/technical-office/practices/${row.practiceId}/assignments`; }
function work(row: Row, project = false) { return `/technical-work/${project ? 'projects/' + row.projectId : 'practices/' + row.practiceId}`; }
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
async function count(row: Row, project = false) {
  const target = project ? row.projectId : row.practiceId;
  const [r] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalWorkCommand" WHERE "targetId"=${target}`;
  return Number(r.n);
}
async function assignments(row: Row) {
  const [r] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalAssignment" WHERE "practiceId"=${row.practiceId} OR "projectId"=${row.projectId}`;
  return Number(r.n);
}
async function coldEditor(page: Page, url: string, marker: string, control: string, button: string) {
  let release!: () => void, blockedScripts = 0;
  const scripts = new Promise<void>(resolve => { release = resolve; });
  const pattern = /\/_next\/static\/.*\.js(?:\?.*)?$/;
  await page.route(pattern, async route => { blockedScripts++; await scripts; await route.continue(); });
  try {
    await page.goto(url, { waitUntil: 'commit' });
    await expect.poll(() => blockedScripts).toBeGreaterThan(0);
    await expect(page.locator(`[${marker}="false"]`)).toBeVisible();
    await expect(page.getByRole('combobox', { name: control, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: button, exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.locator(`[${marker}="true"]`)).toBeVisible();
  await expect(page.getByRole('combobox', { name: control, exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
}
async function prepareAssignment(page: Page, row: Row, person: Row['techA'], project = false) {
  await page.goto(management(row, project));
  await page.getByRole('combobox', { name: 'Persona da incaricare', exact: true }).selectOption(person.id);
  await page.getByRole('button', { name: 'Apri scelte per la persona', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('recipient=' + person.id));
  await page.getByRole('combobox', { name: 'Responsabilità', exact: true }).selectOption('co_responsabile');
  await page.getByLabel('Modificare i campi scelti', { exact: true }).check();
  await page.getByLabel('Aggiornare lo stato', { exact: true }).check();
  for (const name of ['Titolo', 'Stato', project ? 'Descrizione tecnica' : 'Avanzamento comunicabile al cliente']) await page.getByLabel(name, { exact: true }).check();
  const field = page.getByLabel(project ? 'Descrizione tecnica' : 'Avanzamento comunicabile al cliente', { exact: true }).locator('..').locator('..');
  await field.getByLabel('Consenti la modifica', { exact: true }).check();
  await page.getByLabel(new RegExp(row.documents[0].title + ' ·')).check();
  const downloadable = page.getByLabel(new RegExp(row.documents[1].title + ' ·'));
  await downloadable.check(); await downloadable.locator('..').locator('..').getByLabel('Consenti anche il download', { exact: true }).check();
  await expect(page.getByText(row.documents[2].title, { exact: false })).toHaveCount(0);
  await page.getByLabel('Scadenza, entro 90 giorni', { exact: true }).fill(new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Incarico sintetico qualificazione browser');
  await expect(page.getByRole('combobox', { name: 'Responsabilità', exact: true })).toHaveValue('co_responsabile');
  expect(JSON.parse(await page.locator('input[name="command"]').first().inputValue()).selection.responsibility).toBe('co_responsabile');
  await page.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma incarico e perimetro', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Responsabilità', exact: true })).toHaveValue('co_responsabile');
  for (const name of ['Modificare i campi scelti', 'Aggiornare lo stato', 'Titolo', 'Stato', project ? 'Descrizione tecnica' : 'Avanzamento comunicabile al cliente']) {
    await expect(page.getByLabel(name, { exact: true })).toBeChecked();
  }
  await expect(page.getByLabel(new RegExp(row.documents[0].title + ' ·'))).toBeChecked();
  await expect(downloadable).toBeChecked();
  await page.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
}
async function assign(page: Page, row: Row, person: Row['techA'], project = false) {
  const n = await assignments(row); await prepareAssignment(page, row, person, project);
  await page.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect.poll(() => assignments(row)).toBe(n + 1);
  await expect(page.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
}
async function prepareWork(page: Page, row: Row, value: string, project = false) {
  await page.goto(work(row, project));
  for (const text of row.excluded) expect(await page.content()).not.toContain(text);
  const label = project ? 'Descrizione tecnica' : 'Avanzamento comunicabile al cliente';
  await page.getByLabel('Modifica ' + label.toLocaleLowerCase('it-IT'), { exact: true }).check();
  await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('button', { name: 'Prepara riepilogo della modifica', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo della modifica', exact: true })).toBeVisible();
  await expect(page.getByLabel('Modifica ' + label.toLocaleLowerCase('it-IT'), { exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: label, exact: true })).toHaveValue(value);
  await page.getByLabel('Confermo soltanto le modifiche riepilogate.').check();
}
async function lostResponse(page: Page, button: string, pattern: string) {
  let forwarded = 0, done!: () => void, fail!: (error: unknown) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); }
    catch (error) { fail(error); }
  });
  await page.getByRole('button', { name: button, exact: true }).click(); await complete; await page.unroute(pattern);
  return forwarded;
}
async function screenshot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(evidence, name + '-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, name + '-mobile.png'), fullPage: true });
}
async function ordinaryPageDenied(page: Page, url: string, heading: string, row: Row) {
  // The legacy client dossier renders an explicit denial with HTTP 200.
  // Assert both that denial and the absence of record data, including streamed HTML.
  const response = await page.goto(url); expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  const html = (await response!.text()) + (await page.content());
  for (const text of [...row.excluded, 'Cliente tecnico A sintetico', 'Progetto tecnico multiplo sintetico',
    'PROGETTO_ESTRANEO_NON_ASSEGNATO', ...row.documents.flatMap(doc => [doc.title, doc.text])]) expect(html).not.toContain(text);
  await expect(page.locator('main form')).toHaveCount(0);
}
test.beforeAll(async () => { expect(process.env.CI).toBe('true'); expect(f.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());

test('two technicians use exact personal assignments, private preview/download and real native updates on desktop/mobile', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(), second = await bc.newPage();
  await login(admin, f.adminEmail, true); await login(tech, row.techA.email); await login(second, row.techB.email);
  await coldEditor(admin, management(row) + '?recipient=' + row.techA.id, 'data-technical-editor-ready', 'Responsabilità', 'Anteprima dell’incarico');
  expect(await assignments(row)).toBe(0);
  await prepareAssignment(admin, row, row.techA); expect(await assignments(row)).toBe(0); await screenshot(admin, 'assignment-management');
  await admin.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click(); await expect.poll(() => assignments(row)).toBe(1);
  await assign(admin, row, row.techB);
  await coldEditor(tech, work(row), 'data-technical-work-ready', 'Operazione', 'Prepara riepilogo della modifica');
  expect(await count(row)).toBe(0);
  await prepareWork(tech, row, 'Avanzamento nativo sintetico'); await screenshot(tech, 'assigned-work');
  await tech.getByRole('button', { name: 'Conferma modifica tecnica', exact: true }).click(); await expect.poll(() => count(row)).toBe(1);
  await second.goto(work(row)); await expect(second.getByText('Avanzamento nativo sintetico', { exact: true }).first()).toBeVisible();
  const preview = await bc.request.get(work(row) + '/documents/' + row.documents[0].fileId);
  expect(preview.status()).toBe(200); expect(await preview.text()).toBe(row.documents[0].text);
  expect(preview.headers()['content-disposition']).toMatch(/^inline;/); expect(preview.headers()['cache-control']).toContain('no-store');
  expect((await bc.request.get(work(row) + '/documents/' + row.documents[0].fileId + '?download=1')).status()).toBe(404);
  const download = await bc.request.get(work(row) + '/documents/' + row.documents[1].fileId + '?download=1');
  expect(download.status()).toBe(200); expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
  await ordinaryPageDenied(second, '/clients/' + row.clientId, 'Cliente non trovato o non accessibile', row);
  for (const url of ['/projects/' + row.otherProjectId, management(row), work(row) + '/documents/' + row.documents[2].fileId]) {
    const denied = await bc.request.get(url); expect(denied.status(), url).toBe(404);
    for (const text of [...row.excluded, 'PROGETTO_ESTRANEO_NON_ASSEGNATO', row.documents[2].text]) expect(await denied.text()).not.toContain(text);
  }
  const current = await db.technicalPractice.findUniqueOrThrow({ where: { id: row.practiceId } });
  expect(current.commercialOwnerId).toBe(row.salesA.id); expect(current.technicalOwnerId).toBe(row.techA.id);
  await ac.close(); await tc.close(); await bc.close();
});

test('lost native assignment and work responses recover one receipt, without another submission', async ({ browser }) => {
  const row = f.rows[1], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true); await login(tech, row.techA.email);
  await prepareAssignment(admin, row, row.techA);
  expect(await lostResponse(admin, 'Conferma incarico tecnico', '**/technical-office/practices/**')).toBe(1);
  await expect.poll(() => assignments(row)).toBe(1); await admin.reload();
  await admin.getByRole('button', { name: 'Verifica esito della decisione', exact: true }).click();
  await expect(admin.getByText('Decisione registrata. Ricarica per consultare gli incarichi correnti.', { exact: true })).toBeVisible();
  await prepareWork(tech, row, 'Salvataggio con risposta persa');
  expect(await lostResponse(tech, 'Conferma modifica tecnica', '**/technical-work/**')).toBe(1);
  await expect.poll(() => count(row)).toBe(1); await tech.reload();
  await tech.getByRole('button', { name: 'Verifica esito del salvataggio', exact: true }).click();
  await expect(tech.getByRole('link', { name: 'Ricarica il lavoro corrente', exact: true })).toBeVisible();
  expect(await count(row)).toBe(1); expect(await assignments(row)).toBe(1); await ac.close(); await tc.close();
});

test('native revocation stops an open preview, direct documents and ordinary fallback while retaining work history', async ({ browser }) => {
  const row = f.rows[2], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true); await login(tech, row.techA.email);
  await assign(admin, row, row.techA); await prepareWork(tech, row, 'Modifica non più ammessa');
  await admin.goto(management(row) + '?recipient=' + row.techA.id);
  await admin.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica a sessione aperta');
  await admin.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  const revocation = admin.getByRole('region', { name: 'Riepilogo incarico', exact: true });
  await revocation.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.').check();
  await revocation.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect(admin.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  await tech.getByRole('button', { name: 'Conferma modifica tecnica', exact: true }).click();
  await expect(tech.getByText('La modifica non è stata registrata: dati, incarico o permessi non più validi. Ricarica prima di riprovare.', { exact: true })).toBeVisible();
  expect(await count(row)).toBe(0); expect(await assignments(row)).toBe(1);
  for (const url of [work(row), work(row) + '/documents/' + row.documents[0].fileId]) expect((await tc.request.get(url)).status(), url).toBe(404);
  await ordinaryPageDenied(tech, '/clients/' + row.clientId, 'Cliente non trovato o non accessibile', row);
  await ac.close(); await tc.close();
});

test('project operation has its own exact grant and native status changes do not grant the linked practice', async ({ browser }) => {
  const row = f.rows[3], ac = await browser.newContext(), tc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(); await login(admin, f.adminEmail, true); await login(tech, row.techB.email);
  await assign(admin, row, row.techB, true); await prepareWork(tech, row, 'Descrizione progetto aggiornata', true);
  await tech.getByRole('button', { name: 'Conferma modifica tecnica', exact: true }).click(); await expect.poll(() => count(row, true)).toBe(1);
  await tech.goto(work(row, true)); await tech.getByRole('combobox', { name: 'Operazione', exact: true }).selectOption('update_status');
  await tech.getByRole('combobox', { name: 'Nuovo stato', exact: true }).selectOption('in_analisi');
  await tech.getByRole('button', { name: 'Prepara riepilogo della modifica', exact: true }).click();
  await tech.getByLabel('Confermo soltanto le modifiche riepilogate.').check();
  await tech.getByRole('button', { name: 'Conferma modifica tecnica', exact: true }).click(); await expect.poll(() => count(row, true)).toBe(2);
  expect((await db.project.findUniqueOrThrow({ where: { id: row.projectId } })).status).toBe('in_analisi');
  expect((await tc.request.get(work(row))).status()).toBe(404);
  await tech.goto('/search?q=' + encodeURIComponent('Progetto tecnico multiplo'));
  await expect(tech.getByRole('heading', { name: 'Progetti con incarico personale (1)', exact: true })).toBeVisible();
  await expect(tech.getByRole('heading', { name: 'Progetto tecnico multiplo sintetico', exact: true })).toBeVisible();
  const result = tech.locator(`a[href="${work(row, true)}"]`).filter({ hasText: 'Apri' });
  await expect(result).toHaveCount(1); expect(await tech.content()).not.toContain(row.excluded[1]);
  await result.click(); await expect(tech).toHaveURL(new RegExp(work(row, true) + '$'));
  await expect(tech.getByText('Descrizione progetto aggiornata', { exact: true }).first()).toBeVisible();
  await ac.close(); await tc.close();
});
