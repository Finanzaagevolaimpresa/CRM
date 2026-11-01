import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { romeDateTimeInput } from '../../src/lib/rome-date-time';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.TECHNICAL_EVIDENCE!, password = process.env.TECHNICAL_BROWSER_PASSWORD!;
type Person = { id: string; email: string };
type Row = { clientId: string; projectId: string; practiceId: string; leadId: string; contractId: string; contractNumber: string;
  paymentId: string; clientDossierId: string; dossierId: string; mixedProjectId: string; techA: Person; techB: Person; third: Person; mixed: Person; sales: Person;
  documents: Array<{ id: string; versionId: string; title: string; fileName: string; text: string }>; excluded: string[] };
const fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: Row[] };
const work = (r: Row) => '/technical-work/practices/' + r.practiceId;
const file = (r: Row, index = 0) => work(r) + '/documents/' + r.documents[index].versionId + '?download=1';
const management = (r: Row, person: Person) => '/technical-office/practices/' + r.practiceId + '/assignments?recipient=' + person.id;
async function login(page: Page, email: string, privileged = false) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (privileged) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per 30 minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function deniedFile(context: BrowserContext, url: string, row: Row, method = 'GET') {
  const response = await context.request.fetch(url, { method, maxRedirects: 0,
    ...(method === 'POST' ? { headers: { origin: process.env.APP_ORIGIN!, 'sec-fetch-site': 'same-origin' },
      form: { expectedVersionId: row.dossierId, packageId: 'synthetic-private-export', manualTransferAuthorized: 'on' } } : {}) });
  expect([403, 404]).toContain(response.status());
  const body = await response.text();
  for (const value of [...row.excluded, ...row.documents.flatMap(d => [d.title, d.fileName, d.text])]) expect(body.includes(value), 'Denied file response disclosed a reserved synthetic value').toBe(false);
  expect(response.headers()['content-disposition']).toBeUndefined();
}
async function deniedPage(page: Page, url: string, row: Row) {
  const response = await page.goto(url); expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible();
  const html = await response!.text();
  for (const value of [...row.excluded, ...row.documents.flatMap(d => [d.title, d.fileName, d.text])]) expect(html.includes(value), 'Page disclosed a reserved synthetic value').toBe(false);
}
async function assertBytes(context: BrowserContext, row: Row) {
  const response = await context.request.get(file(row)); expect(response.status()).toBe(200);
  expect(await response.body()).toEqual(Buffer.from(row.documents[0].text));
}
test.beforeAll(async () => {
  expect(process.env.CI).toBe('true'); expect(fixture.synthetic).toBe(true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
});
test.afterAll(async () => db.$disconnect());

for (const profile of ['techA', 'techB', 'mixed'] as const) test(profile + ': technical ceiling covers direct pages, metadata, exports, notes and exact files', async ({ browser }) => {
  const row = fixture.rows[0], context = await browser.newContext(), page = await context.newPage();
  await login(page, row[profile].email);
  const positive = profile === 'mixed' ? '/projects/' + row.mixedProjectId : work(row);
  await page.goto(positive); expect(await page.locator('main').innerText()).toContain(profile === 'mixed' ? 'seconda' : 'Pratica tecnica multipla sintetica');
  if (profile !== 'mixed') {
    await assertBytes(context, row);
    await expect(page.getByRole('textbox', { name: /note|avanzamento|descrizione/i })).toHaveCount(0);
    await expect(page.getByText(row.documents[2].title, { exact: false })).toHaveCount(0);
  }
  for (const url of ['/contracts', '/contracts/' + row.contractId, '/payments', '/payments/' + row.paymentId + '/collection',
    '/audit-log', '/dossiers/' + row.dossierId + '/print', '/admin/document-disclosure/' + row.documents[0].versionId]) await deniedPage(page, url, row);
  for (const url of ['/documents/' + row.documents[2].id + '/view?versionId=' + row.documents[2].versionId,
    '/documents/' + row.documents[2].id + '/download?versionId=' + row.documents[2].versionId,
    '/client-dossiers/' + row.clientDossierId + '/export',
    '/dossiers/' + row.dossierId + '/export?format=markdown']) await deniedFile(context, url, row);
  await deniedFile(context, '/client-dossiers/' + row.clientDossierId + '/work-export', row, 'POST');
  for (const url of ['/dashboard', '/dashboard?view=oggi', '/documents', '/search?q=PAGAMENTO', '/notifications', '/communications']) {
    const response = await page.goto(url); expect(response?.status()).toBe(200);
    const title = url.startsWith('/documents') ? 'Documenti tecnici consentiti' : url.startsWith('/search') ? 'Ricerca nel perimetro tecnico'
      : url.startsWith('/notifications') ? 'Notifiche · perimetro tecnico' : url.startsWith('/communications') ? 'Comunicazioni · perimetro tecnico' : 'Ufficio Tecnico';
    if (url.startsWith('/dashboard')) { await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
      await expect(page.locator('main')).toContainText('Il tuo lavoro tecnico'); }
    else await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    const html = (await response!.text()) + (await page.content());
    for (const value of row.excluded) expect(html.includes(value), 'Page disclosed a reserved synthetic value').toBe(false);
  }
  await context.close();
});

test('Admin and Commerciale retain their actual permitted paths; exact classification persists and withdraws technical file access', async ({ browser }) => {
  const row = fixture.rows[2], ac = await browser.newContext(), tc = await browser.newContext(), sc = await browser.newContext();
  const admin = await ac.newPage(), tech = await tc.newPage(), sales = await sc.newPage();
  await login(admin, fixture.adminEmail, true); await login(tech, row.techA.email); await login(sales, row.sales.email);
  for (const target of [row.techA, row.mixed]) {
    await admin.goto('/settings/users/' + target.id);
    await expect(admin.getByRole('heading', { name: 'Limite della funzione tecnica', exact: true })).toBeVisible();
    for (const code of ['contract.read', 'payment.read', 'dossier.read']) {
      const control = admin.locator('select[name="permission:' + code + '"]');
      await expect(control).toBeDisabled();
      await expect(control.locator('..')).toContainText('Effettivo: negato');
    }
  }
  await admin.goto('/contracts/' + row.contractId); await expect(admin.locator('main')).toContainText(row.contractNumber);
  const signed = await ac.request.get('/documents/' + row.documents[2].id + '/download?versionId=' + row.documents[2].versionId);
  expect(signed.status()).toBe(200); expect(await signed.body()).toEqual(Buffer.from(row.documents[2].text));
  for (const url of ['/client-dossiers/' + row.clientDossierId + '/export', '/dossiers/' + row.dossierId + '/export?format=markdown']) {
    const exported = await ac.request.get(url); expect(exported.status()).toBe(200);
    expect(await exported.text()).toContain('NOTA_DOSSIER_RISERVATA');
  }
  await sales.goto('/leads/' + row.leadId); await expect(sales.locator('main')).toContainText('Tecnico sintetico');
  await assertBytes(tc, row);
  const url = '/admin/document-disclosure/' + row.documents[0].versionId;
  await admin.goto(url); await admin.locator('[data-interactive-ready="true"]').last().waitFor({ state: 'attached' });
  await expect(admin.locator('main')).toContainText('Contenuto tecnico verificato');
  await admin.getByRole('combobox', { name: 'Classificazione', exact: true }).selectOption('RESTRICTED');
  await admin.getByLabel('Motivazione', { exact: true }).fill('Rettifica sintetica del perimetro tecnico');
  await admin.getByLabel('Confermo questa classificazione, senza aggiungere destinatari o versioni.', { exact: true }).check();
  await admin.getByRole('button', { name: 'Registra classificazione', exact: true }).click();
  await expect(admin.getByRole('link', { name: 'Riapri e verifica la classificazione', exact: true })).toBeVisible();
  const decision = new URL(admin.url()).searchParams.get('decision'); expect(decision).toBeTruthy();
  expect(await db.adminRecordRevision.count({ where: { commandId: decision! } })).toBe(1);
  await deniedFile(tc, file(row), row);
  await tech.goto(work(row)); await expect(tech.getByText(row.documents[0].fileName, { exact: false })).toHaveCount(0);
  await admin.getByRole('link', { name: 'Riapri e verifica la classificazione', exact: true }).click({ noWaitAfter: true });
  await expect(admin).toHaveURL(url => url.pathname === '/admin/document-disclosure/' + row.documents[0].versionId && !url.search);
  await expect(admin.locator('main')).toContainText('Classificazione corrente: Riservato ai profili ammessi');
  // Reopening the stored command is a read, not a second save.
  await admin.goto(url + '?decision=' + decision);
  await admin.getByRole('button', { name: 'Verifica esito registrato', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText('Classificazione già registrata.');
  expect(await db.adminRecordRevision.count({ where: { commandId: decision! } })).toBe(1);
  await ac.close(); await tc.close(); await sc.close();
});

test('Admin copies only into a draft then authorizes each collaborator; revocation removes one individual, retaining the owner and third technician', async ({ browser }) => {
  const row = fixture.rows[1], ac = await browser.newContext(), bc = await browser.newContext(), cc = await browser.newContext();
  const admin = await ac.newPage(), second = await bc.newPage(), third = await cc.newPage();
  await login(admin, fixture.adminEmail, true); await login(second, row.techB.email); await login(third, row.third.email);
  const count = async () => {
    const [result] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalAssignment" WHERE "practiceId"=${row.practiceId}`;
    return Number(result.n);
  };
  for (const [person, context] of [[row.techB, bc], [row.third, cc]] as const) {
    await deniedFile(context, file(row), row);
    const before = await count(); await admin.goto(management(row, person));
    await admin.locator('[data-technical-editor-ready="true"]').waitFor();
    const selector = admin.getByRole('combobox', { name: 'Incarico esistente da cui copiare', exact: true });
    const source = await selector.locator('option').filter({ hasText: row.techA.email }).getAttribute('value'); expect(source).toBeTruthy();
    await selector.selectOption(source!); await admin.getByRole('button', { name: 'Copia nella bozza, senza concedere accesso', exact: true }).click();
    expect(await count()).toBe(before); await deniedFile(context, file(row), row);
    const [sourceRecord] = await db.$queryRaw<Array<{ selection: { expiresAt: string } }>>
      `SELECT payload->'selection' AS selection FROM "TechnicalAssignment" WHERE id=${source!}::uuid`;
    await expect(admin.getByLabel('Scadenza, entro 90 giorni · Europe/Rome', { exact: true })).toHaveValue(romeDateTimeInput(sourceRecord.selection.expiresAt));
    await expect(admin.getByRole('combobox', { name: 'Responsabilità', exact: true })).toHaveValue('supporto');
    await admin.getByLabel('Motivo dell’incarico', { exact: true }).fill('Collaborazione sintetica nominale');
    await admin.getByRole('button', { name: 'Anteprima dell’incarico', exact: true }).click();
    await expect(admin.getByRole('region', { name: 'Riepilogo incarico', exact: true })).toContainText(person.email);
    await admin.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
    await admin.getByRole('button', { name: 'Conferma incarico tecnico', exact: true }).click();
    await expect.poll(count).toBe(before + 1); await assertBytes(context, row);
  }
  expect((await db.technicalPractice.findUniqueOrThrow({ where: { id: row.practiceId } })).technicalOwnerId).toBe(row.techA.id);
  await admin.goto(management(row, row.techB));
  await admin.getByLabel('Motivo della revoca', { exact: true }).fill('Revoca sintetica del solo secondo collaboratore');
  await admin.getByRole('button', { name: 'Anteprima della revoca', exact: true }).click();
  await admin.getByLabel('Confermo personalmente questa decisione, la persona e il perimetro riepilogati.', { exact: true }).check();
  await admin.getByRole('button', { name: 'Revoca incarico tecnico', exact: true }).click();
  await expect.poll(async () => (await bc.request.get(file(row))).status()).toBe(404);
  await assertBytes(cc, row);
  expect((await db.technicalPractice.findUniqueOrThrow({ where: { id: row.practiceId } })).technicalOwnerId).toBe(row.techA.id);
  await ac.close(); await bc.close(); await cc.close();
});

test('an individually classified but unselected version and a signed client contract remain unavailable', async ({ browser }) => {
  const row = fixture.rows[0], context = await browser.newContext(), page = await context.newPage();
  await login(page, row.techA.email);
  await assertBytes(context, row);
  await deniedFile(context, file(row, 1), row);
  await deniedFile(context, file(row, 2), row);
  await page.goto(work(row));
  for (const index of [1, 2]) await expect(page.getByText(row.documents[index].fileName, { exact: false })).toHaveCount(0);
  await context.close();
});
