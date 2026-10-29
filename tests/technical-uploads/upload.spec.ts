import { romeDateTimeInput } from '../../src/lib/rome-date-time';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { officeBytes } from './office-fixture';
const db = new PrismaClient(), evidence = process.env.TECHNICAL_UPLOAD_EVIDENCE!, password = process.env.TECHNICAL_UPLOAD_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as { synthetic: boolean; adminEmail: string;
  rows: Array<{ clientId: string; projectId: string; practiceId: string; otherPracticeId: string;
    techA: { id: string; email: string }; techB: { id: string; email: string }; salesA: { id: string; email: string }; salesB: { id: string; email: string } }> };
type Row = typeof f.rows[number];
const upload = (r: Row) => '/technical-uploads/practices/' + r.practiceId;
const review = (r: Row) => '/technical-upload-review/practices/' + r.practiceId + '/' + r.techA.id;
const management = (r: Row) => '/technical-office/practices/' + r.practiceId + '/assignments';
const content = Buffer.from('ELABORATO_PRIVATO_SINTETICO_PR220');
async function login(page: Page, email: string, stepUp = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (stepUp) { await page.goto('/settings/security'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
    await page.getByLabel('Password corrente', { exact: true }).fill(password); await page.getByRole('button', { name: /Conferma per (5|30) minuti/, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible(); }
}
async function assign(page: Page, r: Row, person = r.techA, extension = '.txt') {
  await page.goto(management(r)); await page.locator('[data-technical-editor-ready="true"]').waitFor();
  await page.getByRole('combobox', { name: 'Persona da incaricare', exact: true }).selectOption(person.id);
  await page.getByRole('button', { name: 'Apri scelte per la persona', exact: true }).click(); await page.locator('[data-technical-editor-ready="true"]').waitFor();
  await page.getByLabel('Caricare documenti tecnici', { exact: true }).check(); await page.getByLabel('Titolo', { exact: true }).check();
  await page.getByLabel('Scopo del caricamento', { exact: true }).fill('Elaborati da revisionare'); await page.getByLabel(extension, { exact: true }).check();
  await page.getByLabel('Dimensione massima per file (MiB)', { exact: true }).fill('1'); await page.getByLabel('Numero massimo di file', { exact: true }).fill('2');
  await page.getByLabel('Spazio totale massimo (MiB)', { exact: true }).fill('2');
  await page.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
  await page.getByLabel('Motivo dell’incarico', { exact: true }).fill('Deposito sintetico personale');
  await page.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deposito privato da revisionare', exact: true })).toBeVisible();
  await page.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
  await page.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(page.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
}
async function prepare(page: Page, r: Row, file = { name: 'Relazione.txt', mimeType: 'text/plain', buffer: content }) {
  await page.goto(upload(r)); await page.locator('[data-upload-ready="true"]').waitFor();
  await page.getByLabel('Titolo del documento', { exact: true }).fill('Elaborato privato PR220');
  await page.getByLabel('File da depositare', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Prepara riepilogo del deposito', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferma il deposito privato', exact: true })).toBeVisible();
  await page.getByLabel('Confermo questo file e il deposito privato riepilogato.', { exact: true }).check();
}
async function deposit(page: Page) {
  await page.getByRole('button', { name: 'Conferma deposito', exact: true }).click();
  await expect(page.getByText('Deposito privato registrato. Il file attende la revisione dell’Admin.', { exact: true })).toBeVisible();
}
async function prepareReview(page: Page, r: Row, verdict = 'APPROVE_PRIVATE') {
  await page.goto(review(r)); await page.locator('[data-upload-review-ready="true"]').waitFor();
  await page.getByLabel('Esito della revisione', { exact: true }).selectOption(verdict);
  await page.getByLabel('Motivo della revisione', { exact: true }).fill('Elaborato sintetico esaminato');
  await page.getByRole('button', { name: 'Prepara riepilogo della revisione', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Riepilogo revisione documento' })).toBeVisible();
  await page.getByLabel('Confermo personalmente questa revisione e il motivo riepilogato.', { exact: true }).check();
}
async function counts(r: Row) { const [value] = await db.$queryRaw<Array<{ uploads: bigint; reviews: bigint }>>`SELECT
  (SELECT count(*) FROM "TechnicalUploadSubmission" WHERE "targetId"=${r.practiceId}) AS uploads,
  (SELECT count(*) FROM "TechnicalUploadReview" WHERE receipt->'reference'->>'targetId'=${r.practiceId}) AS reviews`;
  return { uploads: Number(value.uploads), reviews: Number(value.reviews) }; }
async function screenshot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(evidence, name + '-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, name + '-mobile.png'), fullPage: true });
}
async function privateFile(context: BrowserContext, url: string) { const response = await context.request.get(url);
  expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('private, no-store');
  expect(response.headers()['content-security-policy']).toContain('sandbox'); expect(await response.body()).toEqual(content); }
test.beforeAll(async () => { expect(process.env.CI).toBe('true'); expect(f.synthetic).toBe(true); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());
test('native personal assignment, private upload and Admin approval; two technicians and sales remain separated', async ({ browser }) => {
  const r = f.rows[0], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const a = await ac.newPage(), t = await tc.newPage(), b = await bc.newPage(); await login(a, f.adminEmail, true); await login(t, r.techA.email); await login(b, r.techB.email);
  await assign(a, r); await assign(a, r, r.techB); const documents = await db.document.count(), versions = await db.documentVersion.count();
  await prepare(t, r); await screenshot(t, 'deposit-preview'); await deposit(t);
  await t.goto(upload(r)); const ownUrl = await t.getByRole('link', { name: 'Visualizza file', exact: true }).getAttribute('href'); expect(ownUrl).toBeTruthy();
  await privateFile(tc, ownUrl!); expect((await bc.request.get(ownUrl!)).status()).toBe(404);
  await prepareReview(a, r); await screenshot(a, 'review-preview');
  const adminUrl = await a.getByRole('link', { name: 'Visualizza file da revisionare', exact: true }).getAttribute('href'); await privateFile(ac, adminUrl!);
  expect((await tc.request.get(adminUrl!)).status()).toBe(404);
  await a.getByRole('button', { name: 'Conferma revisione', exact: true }).click();
  await expect(a.getByText('Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.', { exact: true })).toBeVisible();
  await t.goto(upload(r)); await expect(t.getByText('Approvato · deposito privato', { exact: true })).toBeVisible();
  for (const person of [r.salesA, r.salesB]) { const sc = await browser.newContext(), page = await sc.newPage(); await login(page, person.email);
    for (const url of [upload(r), review(r), ownUrl!, adminUrl!]) expect((await sc.request.get(url)).status()).toBe(404); await sc.close(); }
  for (const url of ['/search?q=Elaborato', '/documents', '/notifications', '/technical-uploads/practices/' + r.otherPracticeId]) {
    const response = await tc.request.get(url); expect(response.status()).toBeLessThan(500); expect(await response.text()).not.toContain('Elaborato privato PR220');
  }
  expect(await counts(r)).toEqual({ uploads: 1, reviews: 1 }); expect(await db.document.count()).toBe(documents); expect(await db.documentVersion.count()).toBe(versions);
  await ac.close(); await tc.close(); await bc.close();
});
test('native rejection retains the file and shows its reason without publishing', async ({ browser }) => {
  const r = f.rows[1], ac = await browser.newContext(), tc = await browser.newContext(), a = await ac.newPage(), t = await tc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await assign(a, r); await prepare(t, r); await deposit(t);
  await prepareReview(a, r, 'REJECT_PRIVATE'); await a.getByRole('button', { name: 'Conferma revisione', exact: true }).click();
  await expect(a.getByText('Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.', { exact: true })).toBeVisible();
  await t.goto(upload(r)); await expect(t.getByText('Rifiutato · storico conservato', { exact: true })).toBeVisible(); await expect(t.getByText('Motivo: Elaborato sintetico esaminato', { exact: true })).toBeVisible();
  await privateFile(tc, (await t.getByRole('link', { name: 'Visualizza file', exact: true }).getAttribute('href'))!);
  expect(await counts(r)).toEqual({ uploads: 1, reviews: 1 }); await ac.close(); await tc.close();
});
async function loseResponse(page: Page, routeGlob: string, button: string) {
  let forwarded = 0, done!: () => void, fail!: (e: unknown) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  await page.route(routeGlob, async route => { if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++; try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); } catch (e) { fail(e); } });
  await page.getByRole('button', { name: button, exact: true }).click(); await complete; await page.unroute(routeGlob); expect(forwarded).toBe(1);
  await page.reload(); await page.getByRole('button', { name: 'Verifica ricevuta', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Ricarica il deposito corrente', exact: true })).toBeVisible();
}
test('lost upload and review responses recover the original receipts without a second write', async ({ browser }) => {
  const r = f.rows[2], ac = await browser.newContext(), tc = await browser.newContext({ viewport: { width: 390, height: 844 } }), a = await ac.newPage(), t = await tc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await assign(a, r); await prepare(t, r);
  await loseResponse(t, '**/technical-uploads/**', 'Conferma deposito'); expect(await counts(r)).toEqual({ uploads: 1, reviews: 0 });
  await prepareReview(a, r); await loseResponse(a, '**/technical-upload-review/**', 'Conferma revisione'); expect(await counts(r)).toEqual({ uploads: 1, reviews: 1 });
  await ac.close(); await tc.close();
});
test('revocation with author and Admin pages open blocks pending review and direct file reads', async ({ browser }) => {
  const r = f.rows[3], ac = await browser.newContext(), tc = await browser.newContext(), a = await ac.newPage(), t = await tc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await assign(a, r); await prepare(t, r); await deposit(t);
  await t.goto(upload(r)); const ownUrl = (await t.getByRole('link', { name: 'Visualizza file', exact: true }).getAttribute('href'))!;
  await prepareReview(a, r); const adminUrl = (await a.getByRole('link', { name: 'Visualizza file da revisionare', exact: true }).getAttribute('href'))!;
  const revoke = await ac.newPage(); await revoke.goto(management(r) + '?recipient=' + r.techA.id); await revoke.locator('[data-technical-editor-ready="true"]').waitFor();
  await revoke.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica durante la revisione'); await revoke.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  await revoke.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
  await revoke.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click(); await expect(revoke.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  await a.getByRole('button', { name: 'Conferma revisione', exact: true }).click(); await expect(a.getByRole('button', { name: 'Verifica ricevuta', exact: true })).toBeVisible();
  expect((await tc.request.get(ownUrl)).status()).toBe(404); expect((await ac.request.get(adminUrl)).status()).toBe(404); expect((await tc.request.get(upload(r))).status()).toBe(404);
  expect(await counts(r)).toEqual({ uploads: 1, reviews: 0 }); await ac.close(); await tc.close();
});

async function approved(page: Page, technician: Page, r: Row) {
  await assign(page, r); await prepare(technician, r); await deposit(technician); await prepareReview(page, r);
  await page.getByRole('button', { name: 'Conferma revisione', exact: true }).click();
  await expect(page.getByText('Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.', { exact: true })).toBeVisible();
  await page.goto(review(r)); await page.locator('[data-acquisition-ready="true"]').waitFor();
}
async function prepareAcquisition(page: Page, classification = 'TECHNICAL_DOCUMENT') {
  await page.getByLabel('Titolo nel fascicolo', { exact: true }).fill('Documento acquisito sintetico');
  await page.getByLabel('Classificazione del documento', { exact: true }).selectOption(classification);
  await page.getByRole('button', { name: 'Prepara acquisizione privata', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Riepilogo acquisizione nel fascicolo' })).toBeVisible();
  await page.getByLabel('Confermo personalmente l’acquisizione privata e la classificazione di questo file esatto.', { exact: true }).check();
}
async function canonical(r: Row) {
  const rows = await db.$queryRaw<Array<{ commandId: string; documentId: string; versionId: string }>>`SELECT a."commandId",a."documentId",a."versionId"
    FROM "TechnicalDocumentAcquisition" a JOIN "TechnicalUploadSubmission" s ON s."commandId"=a."submissionCommandId" WHERE s."targetId"=${r.practiceId}`;
  expect(rows).toHaveLength(1); return rows[0];
}
test('native private acquisition, exact technical version selection, positive bytes and omitted recipient denial', async ({ browser }) => {
  const r = f.rows[4], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const a = await ac.newPage(), t = await tc.newPage(), b = await bc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await login(b, r.techB.email);
  await approved(a, t, r); await prepareAcquisition(a); await screenshot(a, 'acquisition-preview');
  const documents = await db.document.count(), versions = await db.documentVersion.count();
  await a.getByRole('button', { name: 'Acquisisci nel fascicolo privato', exact: true }).click();
  await expect(a.getByRole('link', { name: 'Apri documenti acquisiti e scegli la visibilità', exact: true })).toBeVisible();
  expect(await db.document.count()).toBe(documents + 1); expect(await db.documentVersion.count()).toBe(versions + 1);
  const saved = await canonical(r), privateUrl = '/acquired-documents/' + saved.documentId;
  await a.reload();
  await expect(a.getByRole('link', { name: 'Apri documenti acquisiti e scegli la visibilità', exact: true })).toBeVisible();
  await expect(a.getByRole('button', { name: 'Prepara acquisizione privata', exact: true })).toHaveCount(0);
  await a.getByRole('link', { name: 'Apri documenti acquisiti e scegli la visibilità', exact: true }).click();
  await screenshot(a, 'acquired-dossier'); await privateFile(ac, privateUrl);
  for (const intent of ['view', 'download']) {
    const ordinary = await ac.request.get('/documents/' + saved.documentId + '/' + intent, { maxRedirects: 0 });
    expect(ordinary.status()).toBe(403); expect(await ordinary.text()).not.toContain(content.toString());
  }
  for (const ctx of [tc, bc]) expect((await ctx.request.get(privateUrl)).status()).toBe(404);
  await a.goto(management(r) + '?recipient=' + r.techA.id); await a.locator('[data-technical-editor-ready="true"]').waitFor();
  await expect(a.getByRole('button', { name: 'Anteprima dell’incarico', exact: true })).toBeDisabled();
  await a.getByRole('combobox', { name: 'Responsabilità', exact: true }).selectOption('supporto');
  await a.getByLabel('Titolo', { exact: true }).check();
  await a.getByLabel('Chiedere un intervento all’Admin', { exact: true }).check();
  await a.getByLabel('Documento acquisito sintetico · Relazione.txt · versione 1', { exact: true }).check();
  await a.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
  await a.getByLabel('Motivo dell’incarico', { exact: true }).fill('Mostra soltanto la versione acquisita');
  await expect(a.getByLabel('Caricare documenti tecnici', { exact: true })).not.toBeChecked();
  await a.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
  await a.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
  await a.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
  await expect(a.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
  const work = '/technical-work/practices/' + r.practiceId, selectedUrl = work + '/documents/' + saved.versionId;
  await t.goto(work); await expect(t.getByRole('link', { name: 'Visualizza Relazione.txt', exact: true })).toBeVisible();
  await screenshot(t, 'acquired-recipient'); await privateFile(tc, selectedUrl);
  expect((await tc.request.get(selectedUrl + '?download=1')).status()).toBe(404);
  expect((await bc.request.get(selectedUrl)).status()).toBe(404);
  for (const person of [r.salesA, r.salesB]) { const sc = await browser.newContext(), page = await sc.newPage(); await login(page, person.email);
    for (const url of [privateUrl, selectedUrl]) expect((await sc.request.get(url)).status()).toBe(404);
    const ordinary = await sc.request.get('/documents/' + saved.documentId + '/download', { maxRedirects: 0 });
    expect(ordinary.status()).toBe(403); expect(ordinary.headers().location).toBeUndefined();
    expect(ordinary.headers()['cache-control']).toContain('no-store');
    expect(await ordinary.text()).not.toContain(content.toString());
    for (const url of ['/search?q=Documento%20acquisito', '/documents', '/notifications']) {
      const response = await sc.request.get(url); expect(response.status()).toBeLessThan(500); expect(await response.text()).not.toContain('Documento acquisito sintetico'); }
    await sc.close(); }
  await ac.close(); await tc.close(); await bc.close();
});
test('lost acquisition response reconciles the original command and creates no duplicate document', async ({ browser }) => {
  const r = f.rows[5], ac = await browser.newContext(), tc = await browser.newContext(), a = await ac.newPage(), t = await tc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await approved(a, t, r); await prepareAcquisition(a);
  const documents = await db.document.count(), versions = await db.documentVersion.count();
  await loseResponse(a, '**/technical-upload-review/**', 'Acquisisci nel fascicolo privato');
  await expect(a.getByText('Acquisizione già registrata. Non ripeterla; la visibilità resta una scelta separata.', { exact: true })).toBeVisible();
  await canonical(r); expect(await db.document.count()).toBe(documents + 1); expect(await db.documentVersion.count()).toBe(versions + 1);
  await a.getByRole('button', { name: 'Verifica ricevuta', exact: true }).click();
  expect(await db.document.count()).toBe(documents + 1); await ac.close(); await tc.close();
});
test('native contract classification preserves the financial ceiling before choosing a technician', async ({ browser }) => {
  const r = f.rows[6], ac = await browser.newContext(), tc = await browser.newContext(), a = await ac.newPage(), t = await tc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await approved(a, t, r); await prepareAcquisition(a, 'CONTRACT');
  await a.getByRole('button', { name: 'Acquisisci nel fascicolo privato', exact: true }).click();
  await expect(a.getByRole('link', { name: 'Apri documenti acquisiti e scegli la visibilità', exact: true })).toBeVisible();
  const saved = await canonical(r); await privateFile(ac, '/acquired-documents/' + saved.documentId);
  for (const person of [r.techA, r.techB]) {
    await a.goto(management(r) + '?recipient=' + person.id); await a.locator('[data-technical-editor-ready="true"]').waitFor();
    await expect(a.getByLabel('Documento acquisito sintetico · Relazione.txt · versione 1', { exact: true })).toHaveCount(0);
  }
  expect((await tc.request.get('/technical-work/practices/' + r.practiceId + '/documents/' + saved.versionId)).status()).toBe(404);
  expect((await tc.request.get('/acquired-documents/' + saved.documentId)).status()).toBe(404);
  await ac.close(); await tc.close();
});

test('native Office acquisition stays private; metadata-only, explicit download and revocation are distinct', async ({ browser }) => {
  const r = f.rows[7], ac = await browser.newContext(), tc = await browser.newContext(), bc = await browser.newContext();
  const a = await ac.newPage(), t = await tc.newPage(), b = await bc.newPage();
  await login(a, f.adminEmail, true); await login(t, r.techA.email); await login(b, r.techB.email);
  await assign(a, r, r.techA, '.docx');
  await prepare(t, r, { name: 'Relazione.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: officeBytes });
  await deposit(t); await prepareReview(a, r);
  await a.getByRole('button', { name: 'Conferma revisione', exact: true }).click();
  await expect(a.getByText('Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.', { exact: true })).toBeVisible();
  await a.goto(review(r)); await a.locator('[data-acquisition-ready="true"]').waitFor(); await prepareAcquisition(a);
  await a.getByRole('button', { name: 'Acquisisci nel fascicolo privato', exact: true }).click();
  await a.getByRole('link', { name: 'Apri documenti acquisiti e scegli la visibilità', exact: true }).click();
  await expect(a.getByText('Anteprima non disponibile per questo formato.', { exact: true })).toBeVisible();
  await expect(a.getByRole('link', { name: 'Visualizza documento acquisito', exact: true })).toHaveCount(0);
  const saved = await canonical(r), selectedUrl = '/technical-work/practices/' + r.practiceId + '/documents/' + saved.versionId;
  const privateUrl = '/acquired-documents/' + saved.documentId;
  const personal = await ac.request.get(privateUrl);
  expect(personal.status()).toBe(200); expect(personal.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(personal.headers()['content-type']).toBe('application/octet-stream');
  expect(await (await ac.request.get(privateUrl + '?download=1')).body()).toEqual(officeBytes);
  for (const ctx of [tc, bc]) expect((await ctx.request.get(privateUrl + '?download=1')).status()).toBe(404);
  for (const allowDownload of [false, true]) {
    await a.goto(management(r) + '?recipient=' + r.techA.id); await a.locator('[data-technical-editor-ready="true"]').waitFor();
    await a.getByRole('combobox', { name: 'Responsabilità', exact: true }).selectOption('supporto');
    await a.getByLabel('Titolo', { exact: true }).check(); await a.getByLabel('Chiedere un intervento all’Admin', { exact: true }).check();
    await a.getByLabel('Documento acquisito sintetico · Relazione.docx · versione 1', { exact: true }).check();
    const permission = a.getByLabel('Consenti il download (necessario per aprire il file)', { exact: true });
    await expect(permission).not.toBeChecked(); if (allowDownload) await permission.check();
    await a.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(Date.now() + 3600000)).replace(/:00$/, ''));
    await a.getByLabel('Motivo dell’incarico', { exact: true }).fill('Decisione esplicita sul file Office sintetico');
    await a.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
    await expect(a.getByRole('region', { name: 'Riepilogo incarico' })).toContainText(allowDownload
      ? 'Download consentito · anteprima non disponibile' : 'Solo nome e versione · download non consentito');
    if (allowDownload) await screenshot(a, 'office-download-decision');
    await a.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
    await a.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
    await expect(a.getByText('Incarico registrato con il solo perimetro confermato.', { exact: true })).toBeVisible();
    await t.goto('/technical-work/practices/' + r.practiceId);
    await expect(t.getByText('Relazione.docx · Anteprima non disponibile per questo formato.', { exact: true })).toBeVisible();
    await expect(t.getByRole('link', { name: 'Visualizza Relazione.docx', exact: true })).toHaveCount(0);
    await expect(t.getByRole('link', { name: 'Scarica versione', exact: true })).toHaveCount(allowDownload ? 1 : 0);
    expect((await tc.request.get(selectedUrl)).status()).toBe(404);
    const response = await tc.request.get(selectedUrl + '?download=1'); expect(response.status()).toBe(allowDownload ? 200 : 404);
    if (allowDownload) {
      expect(response.headers()['content-type']).toBe('application/octet-stream');
      expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
      expect(response.headers()['x-content-type-options']).toBe('nosniff'); expect(await response.body()).toEqual(officeBytes);
      await screenshot(t, 'office-download-recipient');
    } else expect(await response.text()).not.toContain('DOCUMENTO OFFICE SINTETICO');
    for (const url of [selectedUrl, selectedUrl + '?download=1']) expect((await bc.request.get(url)).status()).toBe(404);
  }
  await a.goto(management(r) + '?recipient=' + r.techA.id); await a.locator('[data-technical-editor-ready="true"]').waitFor();
  await a.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica con pagina già aperta');
  await a.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  await a.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
  await a.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect(a.getByText('Revoca registrata. Lo storico è conservato.', { exact: true })).toBeVisible();
  expect((await tc.request.get(selectedUrl + '?download=1')).status()).toBe(404);
  await ac.close(); await tc.close(); await bc.close();
});
