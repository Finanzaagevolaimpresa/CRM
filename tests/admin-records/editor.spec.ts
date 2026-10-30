import {readAdminDraftReplacement,replaceAdminCommunicationDraft} from '../../src/lib/admin-draft-context';
import {emptyCommunicationRecipientSelection} from '../../src/lib/communication-recipient-policy';
import { storeCommunicationFile, revokeCommunicationFile } from '../../src/lib/communication-files';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from '../record-updates/communication-fixtures';
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { syntheticSession } from '../selective-sharing/fixtures';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { adminHistoryFixture } from './history-fixture';
import { adminContextFixture, adminGraphFixture } from './context-fixture';
import { paymentCorrectionFixture } from './payment-fixture';
import { romeDateTimeInput } from '../../src/lib/rome-date-time';
import { lifecycleReadinessFixture,lifecyclePrivateDocumentFixture } from '../admin-lifecycle/fixtures';
import {readAdminPrivateDocumentMetadata,saveAdminPrivateDocumentMetadata} from '../../src/lib/admin-private-document-metadata';
import { readAdminOperationalState, saveAdminOperationalState } from '../../src/lib/admin-operational-lifecycle';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
const db = new PrismaClient(), evidence = process.env.ADMIN_RECORD_EVIDENCE!;
const f: { adminEmail: string; technicianEmail: string; commandsEmail: string; clientId: string; projects: { id: string; title: string }[] } = JSON.parse(readFileSync(join(evidence, 'fixture.json'), 'utf8'));
const password = process.env.ADMIN_RECORD_BROWSER_PASSWORD!;



test('the complete context summary survives confirmation expiry and reopens one coherent company graph', async ({ page, context }) => {
  const actor = await db.user.findUniqueOrThrow({ where: { email: f.adminEmail } });
  const graph = await adminGraphFixture(db, actor.id);
  await login(page); await page.goto('/admin/records/Company/' + graph.company.id);
  const client = page.getByRole('combobox', { name: 'Cliente', exact: true }), lookup = client.locator('..').locator('..');
  await lookup.getByRole('textbox', { name: 'Cerca Cliente', exact: true }).fill(graph.clients[1].id);
  await lookup.getByRole('button', { name: 'Cerca collegamenti', exact: true }).click();
  await expect(client).toBeEnabled(); await client.selectOption(graph.clients[1].id);
  await reason(page);
  await expect(page.getByRole('button', { name: 'Salva operazione', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepara il riepilogo delle schede collegate', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Riepilogo del nuovo contesto', exact: true });
  await expect(summary.getByText(/Progetto del gruppo sintetico/)).toBeVisible();
  await expect(summary.getByText(/Versione documentale conservata/)).toBeVisible();
  await page.getByRole('checkbox', { name: /Confermo il nuovo contesto selezionato/ }).check();
  await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(confirmation).toBeVisible(); await expect(client).toHaveValue(graph.clients[1].id);
  await expect(page.getByRole('checkbox', { name: /Confermo il nuovo contesto selezionato/ })).toBeChecked();
  expect((await db.company.findUniqueOrThrow({ where: { id: graph.company.id } })).clientId).toBe(graph.clients[0].id);
  await confirmation.getByLabel('Password corrente', { exact: true }).fill(password);
  await confirmation.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(confirmation).toContainText('Identità confermata.');
  await save(page); await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(client).toHaveValue(graph.clients[1].id);
  expect((await db.project.findUniqueOrThrow({ where: { id: graph.project.id } })).clientId).toBe(graph.clients[1].id);
  expect((await db.task.findUniqueOrThrow({ where: { id: graph.task.id } })).clientId).toBe(graph.clients[1].id);
  expect(await db.documentVersion.findUniqueOrThrow({ where: { id: graph.version.id } })).toEqual(graph.version);
});

test('Admin annotates privacy and intake sources, reopens their history and follows the current lead without changing originals', async ({ page }) => {
  const actor = await db.user.findUniqueOrThrow({ where: { email: f.adminEmail } });
  const source = await adminHistoryFixture(db, actor.id);
  await login(page, f.adminEmail);
  for (const [model, row] of [['PrivacyEvidenceReceipt', source.receipt], ['ControlledIntake', source.intake]] as const) {
    await page.goto('/admin/records/' + model + '/' + row.id);
    await expect(page.getByLabel('Operazione', { exact: true })).toHaveValue('RECTIFY');
    await expect(page.getByRole('option', { name: 'Correggi i dati operativi' })).toHaveCount(0);
    const reason = 'Rettifica sintetica persistita ' + model;
    await page.getByLabel('Motivazione della correzione').fill(reason);
    await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Riapri e verifica il salvataggio' })).toBeVisible();
    await page.getByRole('link', { name: 'Riapri e verifica il salvataggio' }).click();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Apri il lead: dati correnti, assegnazione e archivio' }).click();
  await expect(page).toHaveURL(new RegExp('/leads/' + source.lead.id + '$'));
  expect(await db.privacyEvidenceReceipt.findUniqueOrThrow({ where: { id: source.receipt.id } })).toEqual(source.receipt);
  expect(await db.controlledIntake.findUniqueOrThrow({ where: { id: source.intake.id } })).toEqual(source.intake);
});

test('service dates stay saved after reopening and the account role filter keeps email identity visible', async ({ page }) => {
  const setup = await adminContextFixture(db);
  await login(page, f.adminEmail);
  await page.goto('/admin/records/ClientService/' + setup.service.id);
  const corrected = new Date(Date.now() - 3 * 86_400_000); corrected.setSeconds(0, 0);
  // Native datetime-local inputs omit zero seconds when normalizing their value.
  const correctedWall = romeDateTimeInput(corrected).slice(0, 16);
  await page.getByLabel('Data amministrativa di acquisto · Europe/Rome', { exact: true }).fill(correctedWall);
  await page.getByLabel('Motivazione della correzione').fill('Data amministrativa corretta da prova sintetica');
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio' }).click();
  await expect(page.getByLabel('Data amministrativa di acquisto · Europe/Rome', { exact: true })).toHaveValue(correctedWall);
  const persisted = await db.clientService.findUniqueOrThrow({ where: { id: setup.service.id } });
  expect(persisted.purchasedAt?.getTime()).toBe(corrected.getTime());
  expect(persisted.contractId).toBe(setup.contract.id);
  await page.goto('/settings/users?role=admin&q=' + encodeURIComponent(f.adminEmail));
  await expect(page.getByText(f.adminEmail, { exact: true })).toBeVisible();
  await expect(page.getByText(f.technicianEmail, { exact: true })).toHaveCount(0);
});

test('Admin activates and retires the reviewed notice version from its own record', async ({ page }) => {
  const notice = await db.privacyNoticeVersion.create({ data: { noticeCode: 'SYNTHETIC_UI_' + randomUUID().replaceAll('-', '').toUpperCase(),
    noticeVersion: 'v1', purposeCode: 'SYNTHETIC_TEST', legalBasisCode: 'SYNTHETIC_TEST',
    evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: 'e'.repeat(64) } });
  await login(page); await page.goto('/admin/records/PrivacyNoticeVersion/' + notice.id);
  await page.getByRole('combobox', { name: 'Operazione', exact: true }).selectOption('UPDATE');
  await page.getByRole('checkbox', { name: /Ho verificato il testo corrispondente/ }).check();
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByText('Stato informativa: ACTIVE.', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Operazione', exact: true }).selectOption('UPDATE');
  await page.getByRole('checkbox', { name: /Confermo il ritiro da ora/ }).check();
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByText('Stato informativa: RETIRED.', { exact: false })).toBeVisible();
  expect((await db.privacyNoticeVersion.findUniqueOrThrow({ where: { id: notice.id } })).contentHash).toBe(notice.contentHash);
  await expect(page.getByRole('combobox', { name: 'Operazione', exact: true }).locator('option[value="UPDATE"]')).toHaveCount(0);
});

test('Admin publishes, retires and restores catalogue contents through a new usable revision', async ({ page }) => {
  const master = await db.serviceCatalog.create({ data: { code: 'synthetic_ui_' + randomUUID().replaceAll('-', ''),
    name: 'Servizio UI sintetico', category: 'sintetico' } });
  await login(page); await page.goto('/admin/records/ServiceCatalogRevision/new');
  await page.getByRole('combobox', { name: 'Servizio a catalogo', exact: true }).selectOption(master.id);
  await page.getByRole('textbox', { name: 'Nome del servizio nella revisione', exact: true }).fill('Servizio revisionato dal browser');
  await page.getByRole('textbox', { name: 'Descrizione del servizio nella revisione', exact: true }).fill('Descrizione sintetica operativa');
  await page.getByRole('combobox', { name: 'Modalità del prezzo', exact: true }).selectOption('FIXED');
  await page.getByRole('spinbutton', { name: 'Prezzo imponibile (EUR)', exact: true }).fill('99.90');
  await page.getByRole('textbox', { name: 'Versione delle condizioni', exact: true }).fill('SYNTHETIC-UI-v1');
  await page.getByRole('button', { name: 'Prepara la revisione del servizio scelto', exact: true }).click();
  for (const label of ['Attività incluse','Attività escluse','Documenti e fasi','Tempi di esecuzione','Risultati da consegnare','Incarichi successivi e condizioni separate'])
    await page.getByRole('textbox', { name: label, exact: true }).fill('Contenuto sintetico ' + label);
  await page.getByRole('checkbox', { name: /Confermo la nuova revisione interna/ }).check();
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  const original = await db.serviceCatalogRevision.findFirstOrThrow({ where: { serviceCatalogId: master.id } });
  await expect(page.getByRole('spinbutton', { name: 'Prezzo imponibile (EUR)', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Stato', exact: true }).selectOption('RETIRED');
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await page.getByRole('link', { name: 'Prepara una nuova revisione da questi contenuti', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Prezzo imponibile (EUR)', exact: true })).toHaveValue('99.9');
  await page.getByRole('button', { name: 'Prepara la revisione del servizio scelto', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Attività incluse', exact: true })).toHaveValue('Contenuto sintetico Attività incluse');
  await page.getByRole('button', { name: 'Conferma questi contenuti per la nuova revisione', exact: true }).click();
  await page.getByRole('checkbox', { name: /Confermo la nuova revisione interna/ }).check();
  await reason(page); await save(page);
  expect(await db.serviceCatalogRevision.count({ where: { serviceCatalogId: master.id } })).toBe(2);
  expect((await db.serviceCatalogRevision.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('RETIRED');
  await page.goto('/service-catalog?serviceCode=' + master.code);
  await expect(page.getByRole('heading', { name: 'Selezione valida', exact: true })).toBeVisible();
  expect(await db.serviceCatalogPublication.count()).toBe(0);
});

test('Admin creates a notice draft and annotates it after reopening without rewriting or activating it', async ({ page }) => {
  await login(page); await page.goto('/admin/records/PrivacyNoticeVersion/new');
  await expect(page.getByRole('button', { name: 'Salva operazione', exact: true })).toBeEnabled();
  const code = 'SYNTHETIC_BROWSER_' + Date.now();
  for (const [label, value] of [['Codice informativa', code], ['Versione informativa', 'v1'], ['Codice finalità', 'SYNTHETIC_TEST'],
    ['Codice base giuridica', 'SYNTHETIC_TEST'], ['SHA256 del testo della versione', 'c'.repeat(64)]])
    await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('combobox', { name: 'Tipo di evidenza', exact: true }).selectOption('NOTICE_ACKNOWLEDGEMENT');
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SHA256 del testo della versione', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Operazione', exact: true })).toHaveValue('RECTIFY');
  const original = await db.privacyNoticeVersion.findFirstOrThrow({ where: { noticeCode: code } });
  expect(original.status).toBe('DRAFT'); expect(original.effectiveFrom).toBeNull();
  await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Correzioni e rettifiche registrate', exact: true })).toBeVisible();
  expect(await db.privacyNoticeVersion.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  expect(await db.adminRecordRevision.count({ where: { model: 'PrivacyNoticeVersion', recordId: original.id, operation: 'RECTIFY' } })).toBe(1);
});

test('legacy dossier exports contain current saved content and retain the exact reader perimeter', async ({ page, browser }) => {
  const dossier = await db.dossier.create({ data: { clientId: f.clientId, projectId: f.projects[0].id,
    title: 'Dossier export sintetico', type: 'verifica', status: 'bozza_consulente',
    markdownContent: 'Contenuto sintetico conservato nel dossier', jsonContent: { criterio: 'sintetico', valore: 42 } } });
  await login(page); await page.goto('/dossiers/' + dossier.id);
  await expect(page.getByRole('link', { name: 'Scarica DOCX', exact: true })).toBeVisible();
  const exported = await page.request.get('/dossiers/' + dossier.id + '/export?format=docx');
  expect(exported.status()).toBe(200);
  const bytes = await exported.body();
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(bytes.includes(Buffer.from(dossier.markdownContent!))).toBe(true);
  expect(exported.headers()['x-dossier-content-hash']).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(exported.headers()['cache-control']).toBe('private, no-store');
  const markdown = await page.request.get('/dossiers/' + dossier.id + '/export?format=markdown');
  expect(markdown.status()).toBe(200); expect(await markdown.text()).toContain('"valore": 42');
  await page.getByRole('link', { name: 'Stampa / salva PDF', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stampa / salva PDF', exact: true })).toBeVisible();
  await expect(page.locator('#dossier-print')).toContainText(dossier.markdownContent!);
  expect(await db.dossier.findUniqueOrThrow({ where: { id: dossier.id } })).toEqual(dossier);
  expect(await db.auditLog.count({ where: { entityId: dossier.id, event: 'legacy_dossier_export' } })).toBe(2);
  const context = await browser.newContext(), outsider = await context.newPage();
  await login(outsider, f.technicianEmail, false);
  expect((await outsider.request.get('/dossiers/' + dossier.id + '/export?format=docx')).status()).toBe(404);
  expect(await db.auditLog.count({ where: { entityId: dossier.id, event: 'legacy_dossier_export' } })).toBe(2);
  await context.close();
});

test('payment adjustment selects an exact evidence version and reopens the preserved collection and linked service state', async ({ page }) => {
  const admin = await db.user.findUniqueOrThrow({ where: { email: f.adminEmail } });
  const payment = await paymentCorrectionFixture(db, admin.id);
  await login(page); await page.goto(`/admin/records/Payment/${payment.payment.id}`);
  await page.getByLabel('Stato', { exact: true }).selectOption('stornato');
  const proof = page.getByRole('region', { name: 'Prova della rettifica del pagamento', exact: true });
  await proof.getByLabel('Cerca Documento e versione a prova della rettifica', { exact: true }).fill(payment.document.title);
  await proof.getByRole('button', { name: 'Cerca collegamenti', exact: true }).click();
  const version = proof.getByLabel('Documento e versione a prova della rettifica', { exact: true });
  await expect(version.locator(`option[value="${payment.version.id}"]`)).toHaveCount(1); await version.selectOption(payment.version.id);
  await proof.getByLabel('Data effettiva della rettifica documentata · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(payment.effectiveAt)).replace(/:00$/, ''));
  await proof.getByRole('checkbox').check(); await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByLabel('Stato', { exact: true })).toHaveValue('stornato');
  const persisted = await db.payment.findUniqueOrThrow({ where: { id: payment.payment.id } });
  expect(persisted.collectedAt).toEqual(payment.payment.collectedAt); expect(persisted.accountingDocumentId).toBe(payment.payment.accountingDocumentId);
  expect((await db.clientService.findUniqueOrThrow({ where: { id: payment.service.id } })).paymentStatus).toBe('stornato');
  expect(await db.auditLog.count({ where: { entityId: payment.payment.id, event: 'admin_payment_status_correction' } })).toBe(1);
});

test('creating an account keeps every choice through expiry and confirms one persisted identity', async ({ page, context }) => {
  await login(page); await page.goto('/settings/users');
  const form = page.getByRole('form', { name: 'Crea utente interno', exact: true }), email = 'admin-new-browser@example.test';
  await form.getByPlaceholder('Nome', { exact: true }).fill('Account browser nuovo');
  await form.getByPlaceholder('email@azienda.it').fill(email);
  await form.locator('select[name="role"]').selectOption('commerciale');
  await form.getByPlaceholder('Password temporanea').fill(password);
  await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await form.getByRole('button', { name: 'Crea utente', exact: true }).click();
  const inline = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(inline).toBeVisible(); await expect(form.getByPlaceholder('email@azienda.it')).toHaveValue(email);
  expect(await db.user.count({ where: { email } })).toBe(0);
  await inline.getByLabel('Password corrente', { exact: true }).fill(password);
  await inline.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(inline).toContainText('Identità confermata.');
  await expect(form.getByPlaceholder('Password temporanea')).toHaveValue(password);
  await expect(form.locator('select[name="role"]')).toHaveValue('commerciale');
  await form.getByRole('button', { name: 'Crea utente', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Operazione account registrata.');
  await expect(form.getByPlaceholder('Password temporanea')).toHaveValue('');
  expect(await db.user.count({ where: { email } })).toBe(1);
  await expect(page).toHaveURL(/#account-command=/);
  await page.reload(); await page.getByRole('button', { name: 'Verifica esito account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione già registrata.');
  await page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Modifica profilo', exact: true }).getByRole('textbox', { name: 'Email di accesso', exact: true })).toHaveValue(email);
});

test('a lost role-change response reopens its receipt and never repeats the command', async ({ page }) => {
  await login(page); await page.goto('/settings/users');
  const target = await db.user.findUniqueOrThrow({ where: { email: f.commandsEmail } });
  const form = page.getByRole('form', { name: `Modifica ruolo di ${target.name}`, exact: true });
  await form.locator('select[name="role"]').selectOption('commerciale');
  let discarded = false, posts = 0; const pattern = '**/settings/users*';
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; await route.fetch(); await route.abort('failed'); discarded = true;
  });
  await form.getByRole('button', { name: 'Modifica ruolo', exact: true }).click();
  await expect.poll(() => discarded).toBe(true); await page.unroute(pattern); await page.reload();
  await page.getByRole('button', { name: 'Verifica esito account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione già registrata.');
  expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('commerciale');
  expect(await db.auditLog.count({ where: { entityId: target.id, event: 'role_change' } })).toBe(1); expect(posts).toBe(1);
});
test.beforeAll(async () => { expect(process.env.CI).toBe('true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());
async function login(page: Page, email = f.adminEmail, privileged = true) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  if (privileged) {
    await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Conferma per 30 minuti', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
  }
}
async function openProject(page: Page, index: number) {
  await page.goto(`/admin/records/Project/${f.projects[index].id}`);
  await expect(page.getByRole('button', { name: 'Salva operazione', exact: true })).toBeEnabled();
}
async function reason(page: Page) { await page.getByRole('textbox', { name: 'Motivazione della correzione', exact: true }).fill('Correzione sintetica verificata nel browser'); }
async function save(page: Page) {
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true })).toBeVisible();
}
test('expired Admin confirmation preserves the complete draft and the renewed thirty-minute window saves once', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); await login(page); await openProject(page, 0);
  const client = page.getByRole('combobox', { name: 'Cliente', exact: true }), lookup = client.locator('..').locator('..');
  const linkedClient = await client.inputValue();
  await lookup.getByRole('textbox', { name: 'Cerca Cliente', exact: true }).fill(f.clientId);
  await lookup.getByRole('button', { name: 'Cerca collegamenti', exact: true }).click();
  await expect(client).toBeEnabled(); await expect(client).toHaveValue(linkedClient);
  await expect(client.locator('option[value="' + f.clientId + '"]')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Titolo', exact: true }).fill('Titolo conservato dopo scadenza');
  await page.getByRole('combobox', { name: 'Priorità', exact: true }).selectOption('urgente');
  await page.getByRole('spinbutton', { name: 'Importo richiesto', exact: true }).fill('1234.56'); await reason(page);
  const commandId = new URL(page.url()).searchParams.get('command')!;
  await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Titolo', exact: true })).toHaveValue('Titolo conservato dopo scadenza');
  await expect(page.getByRole('combobox', { name: 'Priorità', exact: true })).toHaveValue('urgente');
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(0);
  await confirmation.getByLabel('Password corrente', { exact: true }).fill(password);
  await confirmation.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(confirmation).toContainText('Identità confermata.');
  const cookie = (await context.cookies()).find(row => row.name === 'fai_crm_privileged_step_up')!;
  const token = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString('utf8'));
  expect(token.e - token.i).toBe(1800); expect(token.r).toBe('admin');
  await save(page); await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Importo richiesto', exact: true })).toHaveValue('1234.56');
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, 'admin-expiry-reopened-mobile.png'), fullPage: true }); await context.close();
});
test('historical values are restored by an explicit new revision and retained after reopening', async ({ page }) => {
  await login(page); await openProject(page, 1);
  await page.getByRole('textbox', { name: 'Titolo', exact: true }).fill('Correzione da ripristinare'); await reason(page); await save(page);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await page.getByRole('link', { name: 'Prepara il ripristino dei dati precedenti', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Titolo', exact: true })).toHaveValue(f.projects[1].title);
  await reason(page); await save(page);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projects[1].id } })).title).toBe(f.projects[1].title);
  expect(await db.adminRecordRevision.count({ where: { model: 'Project', recordId: f.projects[1].id } })).toBe(2);
});

test('an incompatible promoter is refused atomically while the complete draft remains editable', async ({ page }) => {
  const otherClient = await db.client.create({ data: { displayName: 'Cliente diverso per rifiuto sintetico', type: 'societa' } });
  const wrong = await db.incorporationSubject.create({ data: { promoterClientId: otherClient.id, plannedActivity: 'Promotore incompatibile sintetico' } });
  const right = await db.incorporationSubject.create({ data: { promoterClientId: f.clientId, plannedActivity: 'Promotore coerente sintetico' } });
  const original = await db.project.create({ data: { clientId: f.clientId, title: 'Progetto prima del rifiuto sintetico' } });
  await login(page); await page.goto('/admin/records/Project/' + original.id);
  await page.getByRole('combobox', { name: 'Soggetto da costituire', exact: true }).selectOption(wrong.id);
  await page.getByRole('textbox', { name: 'Titolo', exact: true }).fill('Bozza conservata dopo rifiuto del contesto');
  await page.getByRole('combobox', { name: 'Priorità', exact: true }).selectOption('urgente');
  await page.getByRole('spinbutton', { name: 'Importo richiesto', exact: true }).fill('3210.45'); await reason(page);
  const commandId = new URL(page.url()).searchParams.get('command')!;
  await page.getByRole('button', { name: 'Prepara il riepilogo delle schede collegate', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preparazione non disponibile');
  await expect(page.getByRole('textbox', { name: 'Titolo', exact: true })).toHaveValue('Bozza conservata dopo rifiuto del contesto');
  await expect(page.getByRole('combobox', { name: 'Priorità', exact: true })).toHaveValue('urgente');
  await expect(page.getByRole('spinbutton', { name: 'Importo richiesto', exact: true })).toHaveValue('3210.45');
  await expect(page.getByRole('textbox', { name: 'Motivazione della correzione', exact: true })).toHaveValue('Correzione sintetica verificata nel browser');
  await expect(page.getByRole('combobox', { name: 'Soggetto da costituire', exact: true })).toHaveValue(wrong.id);
  expect(await db.project.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(0);
  expect(await db.auditLog.count({ where: { id: `admin-record:${commandId}` } })).toBe(0);
  await page.getByRole('combobox', { name: 'Soggetto da costituire', exact: true }).selectOption(right.id);
  await page.getByRole('button', { name: 'Prepara il riepilogo delle schede collegate', exact: true }).click();
  await page.getByRole('checkbox', { name: /Confermo il nuovo contesto selezionato/ }).check();
  await save(page); await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Titolo', exact: true })).toHaveValue('Bozza conservata dopo rifiuto del contesto');
  await expect(page.getByRole('combobox', { name: 'Soggetto da costituire', exact: true })).toHaveValue(right.id);
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(1);
});
test('create, trash and restore an expense without duplicating identity or losing its amount', async ({ page }) => {
  await login(page); await page.goto('/admin/records/ProjectExpense/new');
  await page.getByRole('combobox', { name: 'Progetto', exact: true }).selectOption(f.projects[2].id);
  await page.getByRole('combobox', { name: 'Categoria', exact: true }).selectOption('software');
  await page.getByRole('textbox', { name: 'Descrizione', exact: true }).fill('Voce browser sintetica');
  await page.getByRole('spinbutton', { name: 'Importo', exact: true }).fill('123.45'); await reason(page);
  const originalNewUrl = page.url(), id = new URL(originalNewUrl).searchParams.get('draft')!; await save(page);
  // Revalidation or reload may use the pre-submit /new URL without decision=.
  // The exact command receipt must recover the creation, never recreate it.
  await page.goto(originalNewUrl);
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true })).toBeVisible();
  expect(await db.projectExpense.count({ where: { id } })).toBe(1);
  await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await page.getByRole('combobox', { name: 'Operazione', exact: true }).selectOption('TRASH'); await reason(page); await save(page);
  await page.goto('/admin/records/ProjectExpense?trash=1&q=' + id);
  await page.getByRole('link', { name: 'Voce browser sintetica', exact: true }).click(); await reason(page); await save(page);
  expect((await db.projectExpense.findUniqueOrThrow({ where: { id } })).amount.toString()).toBe('123.45');
  expect(await db.projectExpense.count({ where: { id } })).toBe(1);
});
test('a committed response lost in transit recovers one receipt after reload without resubmission', async ({ page }) => {
  await login(page); await openProject(page, 3);
  await page.getByRole('textbox', { name: 'Titolo', exact: true }).fill('Esito recuperato dopo perdita risposta'); await reason(page);
  const commandId = new URL(page.url()).searchParams.get('command')!;
  let posts = 0, responseDiscarded = false; const pattern = '**/admin/records/Project/**';
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; await route.fetch(); await route.abort('failed'); responseDiscarded = true;
  });
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect.poll(() => db.adminRecordRevision.count({ where: { commandId } })).toBe(1);
  await expect.poll(() => responseDiscarded).toBe(true);
  await page.unroute(pattern); await page.reload();
  await page.getByRole('button', { name: 'Verifica esito', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true })).toBeVisible();
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(1); expect(posts).toBe(1);
});
test('an unobserved attempt is durably closed before another command and the editor remains Admin-only', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage(); await login(page); await openProject(page, 4);
  await page.getByRole('textbox', { name: 'Titolo', exact: true }).fill('Tentativo non arrivato'); await reason(page);
  const commandId = new URL(page.url()).searchParams.get('command')!, pattern = '**/admin/records/Project/**';
  await page.route(pattern, route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Riconciliazione del salvataggio' })).toBeVisible();
  await page.unroute(pattern); await page.reload();
  await page.getByRole('checkbox', { name: 'Riconcilia le operazioni ancora in corso e chiudi questo tentativo soltanto se non risulta registrato.', exact: true }).check();
  await page.getByRole('button', { name: 'Riconcilia e chiudi il tentativo', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Riapri per una nuova operazione', exact: true })).toBeVisible();
  expect((await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId } })).operation).toBe('CLOSE');
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projects[4].id } })).title).toBe(f.projects[4].title);
  await context.close();
  const restricted = await browser.newContext(), technician = await restricted.newPage(); await login(technician, f.technicianEmail, false);
  await technician.goto(`/admin/records/Project/${f.projects[4].id}`);
  await expect(technician.getByRole('button', { name: 'Salva operazione', exact: true })).toHaveCount(0);
  await expect(technician.getByText(f.projects[4].title, { exact: true })).toHaveCount(0); await restricted.close();
});

test('account profile choices survive privileged expiry and commit only after inline reconfirmation', async ({ page, context }) => {
  await login(page);
  const target = await db.user.findUniqueOrThrow({ where: { email: f.technicianEmail } });
  await page.goto(`/settings/users/${target.id}`);
  const form = page.getByRole('form', { name: 'Modifica profilo', exact: true });
  await form.getByRole('textbox', { name: 'Nome', exact: true }).fill('Tecnico sintetico corretto');
  await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await form.getByRole('button', { name: 'Salva profilo', exact: true }).click();
  const inline = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(inline).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Tecnico sintetico corretto');
  expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).name).toBe(target.name);
  await inline.getByLabel('Password corrente', { exact: true }).fill(password);
  await inline.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(inline).toContainText('Identità confermata.');
  await form.getByRole('button', { name: 'Salva profilo', exact: true }).click();
  await expect(form).toContainText('Profilo aggiornato.');
  await page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Tecnico sintetico corretto');
});

test('selective client sharing keeps recipient and fields across expiry and grants only that selection', async ({ page, context }) => {
  await login(page);
  const target = await db.user.findUniqueOrThrow({ where: { email: f.technicianEmail } });
  await page.goto(`/clients/${f.clientId}/sharing`);
  await page.getByRole('combobox', { name: 'Persona esistente', exact: true }).selectOption(target.id);
  const choice = page.getByRole('checkbox', { name: 'Denominazione', exact: true });
  await choice.check();
  await page.getByRole('button', { name: 'Anteprima come destinatario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Riepilogo e anteprima', exact: true })).toBeVisible();
  await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await page.getByRole('checkbox', { name: /Confermo personalmente i campi del cliente/ }).check();
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  const inline = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(inline).toBeVisible(); await expect(choice).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Persona esistente', exact: true })).toHaveValue(target.id);
  await inline.getByLabel('Password corrente', { exact: true }).fill(password);
  await inline.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(inline).toContainText('Identità confermata.');
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Accesso confermato:' })).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Persona esistente', exact: true }).selectOption(target.id);
  await expect(choice).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Stato', exact: true })).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Bozza dalla selezione registrata' })).toBeVisible();
  expect(await db.selectiveClientGrant.count({ where: { clientId: f.clientId, recipientId: target.id } })).toBe(1);
});

test('Admin restores a removed identity through its archive while access stays disabled', async ({ page }) => {
  await login(page);
  const target = await db.user.findUniqueOrThrow({ where: { email: f.technicianEmail } });
  await page.goto(`/settings/users/${target.id}`);
  await page.getByRole('checkbox', { name: 'Conservo storico e attività nella coda amministrativa.', exact: true }).check();
  await page.getByRole('button', { name: 'Rimuovi account', exact: true }).click();
  await expect.poll(async () => Boolean((await db.user.findUniqueOrThrow({ where: { id: target.id } })).deletedAt)).toBe(true);
  await page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Ripristino l’identità conservando l’accesso disattivato.', exact: true }).check();
  await page.getByRole('button', { name: 'Ripristina account disattivato', exact: true }).click();
  await expect.poll(async () => (await db.user.findUniqueOrThrow({ where: { id: target.id } })).deletedAt).toBe(null);
  await page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Modifica profilo', exact: true })).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false);
  expect(await db.auditLog.count({ where: { entityId: target.id, event: 'user_restored_inactive' } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: target.id, event: 'user_removed' } })).toBe(1);
});

test('Admin selects one open access session and preserves the others', async ({ page }) => {
  await login(page);
  const target = await db.user.create({ data: { name: 'Account accessi sintetico', email: 'sessions-' + Date.now() + '@example.test', role: 'consulente', passwordHash: 'synthetic-not-for-login' } });
  await syntheticSession(db, target); await syntheticSession(db, target);
  await page.goto('/settings/users/' + target.id);
  const panel = page.getByRole('region', { name: 'Sessioni aperte dell’account', exact: true });
  const form = panel.getByRole('form', { name: 'Revoca singolo accesso 1', exact: true });
  const selected = await form.locator('input[name="targetSessionId"]').inputValue();
  await form.getByRole('button', { name: 'Revoca questo accesso', exact: true }).click();
  await expect(form).toContainText('Operazione account registrata.');
  expect((await db.internalSession.findUniqueOrThrow({ where: { id: selected } })).revokedAt).not.toBeNull();
  expect(await db.internalSession.count({ where: { userId: target.id, revokedAt: null } })).toBe(1);
  await page.getByRole('link', { name: 'Riapri account e permessi', exact: true }).click();
  await expect(panel.locator('input[name="targetSessionId"]')).toHaveCount(1);
  await expect(panel.locator('input[name="targetSessionId"][value="' + selected + '"]')).toHaveCount(0);
});

async function browserCommunicationFile() {
  const actor = await db.user.findUniqueOrThrow({ where: { email: f.adminEmail } });
  const session = await syntheticSession(db, actor);
  const mailbox = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled")
    VALUES ('ordinary-email',${actor.id},${mailbox.id}::uuid,true)
    ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
  const lead = await db.lead.create({ data: { firstName: 'Fonte browser', lastName: 'Sintetica', email: randomUUID() + '@synthetic.invalid' } });
  const context = { kind: 'LEAD' as const, id: lead.id }, id = randomUUID();
  await storeCommunicationFile(db, session.session, { id, context, classification: 'ORDINARY' },
    new File(['SYNTHETIC_BROWSER_ORIGINAL'], 'fonte-browser.txt', { type: 'text/plain' }));
  const source = await db.communicationContextFile.findUniqueOrThrow({ where: { id } });
  return { actor, session: session.session, source, context, lead };
}

test('file replacement keeps selected bytes, destination and choices through expired confirmation and reopens persisted metadata', async ({ page, context }) => {
  const source = await browserCommunicationFile();
  const target = await db.client.create({ data: { type: 'societa', displayName: 'Destinazione file browser ' + randomUUID() } });
  await login(page); await page.goto('/admin/communication-files/' + source.source.id);
  const contents = Buffer.from('SYNTHETIC_BROWSER_REPLACEMENT');
  await page.getByLabel('Nuovo contenuto, facoltativo', { exact: false }).setInputFiles({ name: 'sostituita.txt', mimeType: 'text/plain', buffer: contents });
  await page.getByLabel('Nome della nuova versione', { exact: true }).fill('corretta-browser.txt');
  await page.getByLabel('Tipo di contesto', { exact: true }).selectOption('CLIENT');
  await page.getByLabel('Cerca per nome', { exact: true }).fill(target.displayName);
  await page.getByRole('button', { name: 'Cerca destinazione', exact: true }).click();
  await page.getByRole('button', { name: 'Cliente: ' + target.displayName, exact: true }).click();
  await page.getByLabel('Motivo della correzione o del recupero', { exact: true }).fill('Versione sintetica confermata nel browser');
  const confirm = page.getByRole('checkbox', { name: /Confermo la nuova versione e la destinazione indicate/ });
  await confirm.check(); await context.clearCookies({ name: 'fai_crm_privileged_step_up' });
  await page.getByRole('button', { name: 'Registra nuova versione', exact: true }).click();
  const inline = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro', exact: true });
  await expect(inline).toBeVisible(); await expect(confirm).toBeChecked();
  await expect(page.getByLabel('Nome della nuova versione', { exact: true })).toHaveValue('corretta-browser.txt');
  await expect(page.getByText('Selezionato: sostituita.txt', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Destinazione scelta', { exact: true })).toContainText(target.displayName);
  expect((await db.communicationContextFile.findUniqueOrThrow({ where: { id: source.source.id } })).revokedAt).toBe(null);
  await inline.getByLabel('Password corrente', { exact: true }).fill(password);
  await inline.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(inline).toContainText('Identità confermata.');
  await page.getByRole('button', { name: 'Registra nuova versione', exact: true }).click();
  const versionId = new URL(page.url()).searchParams.get('version')!;
  await page.getByRole('link', { name: 'Apri la nuova versione registrata', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/admin/communication-files/' + versionId));
  await expect(page.getByLabel('Nome della nuova versione', { exact: true })).toHaveValue('corretta-browser.txt');
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const saved = await db.communicationContextFile.findUniqueOrThrow({ where: { id } });
  expect(saved.clientId).toBe(target.id); expect(saved.sha256).toBe(createHash('sha256').update(contents).digest('hex'));
  expect((await db.communicationContextFile.findUniqueOrThrow({ where: { id: source.source.id } })).revokedAt).not.toBe(null);
});

test('a lost file-version response recovers its single receipt after reload without resending bytes', async ({ page }) => {
  const source = await browserCommunicationFile();
  await login(page); await page.goto('/admin/communication-files/' + source.source.id);
  const before = new URL(page.url()), commandId = before.searchParams.get('command')!, versionId = before.searchParams.get('version')!;
  await page.getByLabel('Nome della nuova versione', { exact: true }).fill('versione-recuperata-browser.txt');
  await page.getByLabel('Motivo della correzione o del recupero', { exact: true }).fill('Risposta sintetica interrotta dopo commit');
  await page.getByRole('checkbox', { name: /Confermo la nuova versione e la destinazione indicate/ }).check();
  let posts = 0, discarded = false; const pattern = '**/admin/communication-files/**';
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; await route.fetch(); await route.abort('failed'); discarded = true;
  });
  await page.getByRole('button', { name: 'Registra nuova versione', exact: true }).click();
  await expect.poll(() => discarded).toBe(true);
  await page.unroute(pattern); await page.reload();
  await expect(page.getByRole('button', { name: 'Registra nuova versione', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Verifica esito registrato', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operazione già registrata.');
  await page.getByRole('link', { name: 'Apri la nuova versione registrata', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/admin/communication-files/' + versionId));
  expect(await db.communicationContextFile.count({ where: { id: versionId } })).toBe(1);
  expect(await db.adminRecordRevision.count({ where: { commandId } })).toBe(1); expect(posts).toBe(1);
});

test('received-source annotation and revoked-file recovery keep immutable history visible after reopening', async ({ page }) => {
  const source = await browserCommunicationFile();
  const message = await storedNoticeMessage(db, { leadId: source.lead.id, authorId: source.actor.id });
  const incoming = await linkedOrdinaryNoticeReply(db, message.message.id, message.mailbox.id, source.actor.id);
  await login(page); await page.goto('/admin/records/CommunicationReply/' + incoming.reply.id);
  await expect(page.getByLabel('Operazione', { exact: true })).toHaveValue('RECTIFY');
  await expect(page.getByRole('option', { name: 'Correggi i dati operativi', exact: true })).toHaveCount(0);
  await page.getByLabel('Motivazione della correzione', { exact: true }).fill('Rettifica annotata della fonte sintetica ricevuta');
  await save(page); await page.getByRole('link', { name: 'Riapri e verifica il salvataggio', exact: true }).click();
  await expect(page.getByText('Rettifica annotata della fonte sintetica ricevuta', { exact: true })).toBeVisible();
  expect(await db.communicationReply.findUniqueOrThrow({ where: { id: incoming.reply.id } })).toEqual(incoming.reply);
  await revokeCommunicationFile(db, source.session, { id: source.source.id, context: source.context, sha256: source.source.sha256 });
  const revoked = await db.communicationContextFile.findUniqueOrThrow({ where: { id: source.source.id } });
  await page.goto('/admin/communication-files/' + source.source.id);
  await expect(page.getByLabel('Operazione', { exact: true })).toHaveValue('RESTORE');
  await page.getByLabel('Motivo della correzione o del recupero', { exact: true }).fill('Recupero sintetico della versione conservata');
  await page.getByRole('checkbox', { name: /Confermo la nuova versione e la destinazione indicate/ }).check();
  await page.getByRole('button', { name: 'Registra nuova versione', exact: true }).click();
  const versionId = new URL(page.url()).searchParams.get('version')!;
  await page.getByRole('link', { name: 'Apri la nuova versione registrata', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/admin/communication-files/' + versionId));
  const id = new URL(page.url()).pathname.split('/').pop()!;
  expect(id).not.toBe(revoked.id);
  expect((await db.communicationContextFile.findUniqueOrThrow({ where: { id } })).sha256).toBe(revoked.sha256);
  expect(await db.communicationContextFile.findUniqueOrThrow({ where: { id: revoked.id } })).toEqual(revoked);
  await expect(page.getByRole('link', { name: 'Apri la versione precedente', exact: true })).toBeVisible();
});

test('native upload and revocation recover their outcomes after lost responses without duplicate file effects', async ({ page }) => {
  const source = await browserCommunicationFile();
  await login(page); await page.goto('/communications?kind=LEAD&practice=' + source.lead.id);
  await page.getByText('Allegati del contesto', { exact: true }).click();
  const upload = page.locator('form').filter({ has: page.getByRole('button', { name: 'Carica allegato nel contesto', exact: true }) });
  const id = await upload.locator('input[name="id"]').inputValue();
  await upload.getByLabel('Allegato da caricare', { exact: true }).setInputFiles({ name: 'esito-nativo.txt', mimeType: 'text/plain', buffer: Buffer.from('SYNTHETIC_NATIVE_OUTCOME') });
  let lost = false, posts = 0; const pattern = '**/communications?*';
  const lose = async () => page.route(pattern, async route => {
    if(route.request().method()!=='POST')return route.continue();
    posts++;await route.fetch();await route.abort('failed');lost=true;
  });
  await lose(); await upload.getByRole('button', { name: 'Carica allegato nel contesto', exact: true }).click();
  await expect.poll(()=>lost).toBe(true);await page.unroute(pattern);await page.reload();
  const recovery = page.getByRole('region', { name: 'Verifica operazione allegato', exact: true });
  await recovery.getByRole('button', { name: 'Verifica esito allegato', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Operazione già registrata.' })).toBeVisible();
  expect(await db.communicationContextFile.count({ where: { id } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: id, event: 'communication_file_uploaded' } })).toBe(1);
  await page.getByRole('button', { name: 'Prepara un’altra operazione sugli allegati', exact: true }).click();
  const item = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Scarica esito-nativo.txt', exact: true }) });
  await item.getByText('Revoca disponibilità', { exact: true }).click();
  await item.getByRole('checkbox', { name: 'Confermo la revoca di questo allegato.', exact: true }).check();
  lost=false;await lose();await item.getByRole('button', { name: 'Conferma revoca', exact: true }).click();
  await expect.poll(()=>lost).toBe(true);await page.unroute(pattern);await page.reload();
  await recovery.getByRole('button', { name: 'Verifica esito allegato', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Operazione già registrata.' })).toBeVisible();
  expect((await db.communicationContextFile.findUniqueOrThrow({ where: { id } })).revokedAt).not.toBe(null);
  expect(await db.auditLog.count({ where: { entityId: id, event: 'communication_file_revoked' } })).toBe(1);expect(posts).toBe(2);
  await expect(page.getByRole('button', { name: 'Scarica esito-nativo.txt', exact: true })).toHaveCount(0);
});

test('an interrupted native upload can be closed before a fresh choice and its late command cannot create the file', async ({ page }) => {
  const source = await browserCommunicationFile();
  await login(page);await page.goto('/communications?kind=LEAD&practice=' + source.lead.id);
  await page.getByText('Allegati del contesto', { exact: true }).click();
  const upload = page.locator('form').filter({ has: page.getByRole('button', { name: 'Carica allegato nel contesto', exact: true }) });
  const id = await upload.locator('input[name="id"]').inputValue();
  await upload.getByLabel('Allegato da caricare', { exact: true }).setInputFiles({ name: 'tentativo-chiuso.txt', mimeType: 'text/plain', buffer: Buffer.from('SYNTHETIC_CLOSED_UPLOAD') });
  const pattern='**/communications?*';
  await page.route(pattern,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await upload.getByRole('button', { name: 'Carica allegato nel contesto', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Verifica operazione allegato', exact: true })).toBeVisible();
  await page.unroute(pattern);await page.reload();
  const recovery=page.getByRole('region', { name: 'Verifica operazione allegato', exact: true });
  await recovery.getByRole('checkbox', { name: 'Chiudi il tentativo solo se non ha prodotto l’operazione.', exact: true }).check();
  await recovery.getByRole('button', { name: 'Riconcilia e chiudi operazione allegato', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Tentativo chiuso senza modifica del file' })).toBeVisible();
  expect((await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId:id } })).operation).toBe('CLOSE');
  await expect(storeCommunicationFile(db,source.session,{id,context:source.context,classification:'ORDINARY'},
    new File(['SYNTHETIC_CLOSED_UPLOAD'],'tentativo-chiuso.txt',{type:'text/plain'}))).rejects.toThrow('CONFLICT');
  expect(await db.communicationContextFile.findUnique({where:{id}})).toBe(null);
  await page.getByRole('button', { name: 'Prepara un’altra operazione sugli allegati', exact: true }).click();
  const fresh=await upload.locator('input[name="id"]').inputValue();expect(fresh).not.toBe(id);
  await upload.getByLabel('Allegato da caricare', { exact: true }).setInputFiles({name:'nuovo-tentativo.txt',mimeType:'text/plain',buffer:Buffer.from('SYNTHETIC_NEW_UPLOAD')});
  await upload.getByRole('button', { name: 'Carica allegato nel contesto', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText:'Operazione registrata.' })).toBeVisible();
  expect(await db.communicationContextFile.count({where:{id:fresh}})).toBe(1);
});

async function lifecycleChoice(page:Page,state:string,note='Cambio di stato sintetico verificato nel browser'){
  await page.getByRole('combobox',{name:'Nuovo stato',exact:true}).selectOption(state);
  await page.getByRole('textbox',{name:'Motivazione',exact:true}).fill(note);
  await page.getByRole('checkbox',{name:'Confermo il cambio di stato e la conservazione delle prove originali.',exact:true}).check();
}
async function lifecycleSave(page:Page){
  await page.getByRole('button',{name:'Registra stato amministrativo',exact:true}).click();
  await expect(page.getByRole('link',{name:'Riapri e verifica lo stato',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Riapri e verifica lo stato',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Nuovo stato',exact:true})).toBeEnabled();
}
test('lifecycle keeps the selected state and reason through inline confirmation, then reopens block archive trash and restore',async({page,context})=>{
  const actor=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),source=await adminHistoryFixture(db,actor.id);
  await login(page);const path='/admin/lifecycle/ControlledIntake/'+source.intake.id;await page.goto(path);
  await lifecycleChoice(page,'BLOCKED','Motivazione conservata dopo riconferma');
  await context.clearCookies({name:'fai_crm_privileged_step_up'});
  await page.getByRole('button',{name:'Registra stato amministrativo',exact:true}).click();
  const confirmation=page.getByRole('region',{name:'Conferma identità senza lasciare il lavoro',exact:true});
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Nuovo stato',exact:true})).toHaveValue('BLOCKED');
  await expect(page.getByRole('textbox',{name:'Motivazione',exact:true})).toHaveValue('Motivazione conservata dopo riconferma');
  await confirmation.getByLabel('Password corrente',{exact:true}).fill(password);
  await confirmation.getByRole('button',{name:'Conferma identità e conserva le scelte',exact:true}).click();
  await expect(confirmation).toContainText('Identità confermata.');
  await lifecycleSave(page);
  for(const state of ['ARCHIVED','TRASHED','ACTIVE']){
    await lifecycleChoice(page,state);await lifecycleSave(page);
    expect((await db.adminOperationalState.findUniqueOrThrow({where:{model_recordId:{model:'ControlledIntake',recordId:source.intake.id}}})).state).toBe(state);
  }
  expect(await db.adminRecordRevision.count({where:{model:'ControlledIntake',recordId:source.intake.id}})).toBe(4);
  expect(await db.controlledIntake.findUniqueOrThrow({where:{id:source.intake.id}})).toEqual(source.intake);
  await page.goto('/admin/lifecycle?model=ControlledIntake&state=ACTIVE&query='+source.intake.id);
  await expect(page.locator('a[href="'+path+'"]')).toHaveCount(1);
});
test('a lost lifecycle response is recovered after reload with a single persisted transition',async({page})=>{
  const actor=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),source=await adminHistoryFixture(db,actor.id);
  await login(page);await page.goto('/admin/lifecycle/ControlledIntake/'+source.intake.id);
  const commandId=new URL(page.url()).searchParams.get('command')!;await lifecycleChoice(page,'ARCHIVED');
  let lost=false,posts=0;const pattern='**/admin/lifecycle/ControlledIntake/**';
  await page.route(pattern,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    posts++;await route.fetch();lost=true;await route.abort('failed');
  });
  await page.getByRole('button',{name:'Registra stato amministrativo',exact:true}).click();
  await expect.poll(()=>lost).toBe(true);await page.unroute(pattern);await page.reload();
  await page.getByRole('button',{name:'Verifica esito registrato',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Operazione già registrata.');
  expect(posts).toBe(1);expect(await db.adminRecordRevision.count({where:{commandId}})).toBe(1);
  expect(await db.auditLog.count({where:{id:'admin-record:'+commandId}})).toBe(1);
  await page.getByRole('link',{name:'Riapri e verifica lo stato',exact:true}).click();
  await expect(page.getByText('Archiviato',{exact:true}).first()).toBeVisible();
});
test('an interrupted lifecycle attempt is closed before a new command and a delayed old writer is denied',async({page})=>{
  const actor=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),person=await syntheticSession(db,actor),source=await adminHistoryFixture(db,actor.id);
  const before=await readAdminOperationalState(db,person.session,'ControlledIntake',source.intake.id);
  await login(page);await page.goto('/admin/lifecycle/ControlledIntake/'+source.intake.id);
  const commandId=new URL(page.url()).searchParams.get('command')!,pattern='**/admin/lifecycle/ControlledIntake/**';
  await lifecycleChoice(page,'BLOCKED');await page.route(pattern,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'Registra stato amministrativo',exact:true}).click();
  await expect(page.getByRole('button',{name:'Verifica esito registrato',exact:true})).toBeVisible();
  await page.unroute(pattern);await page.reload();
  await page.getByRole('checkbox',{name:'Chiudi il tentativo soltanto se non ha prodotto una modifica.',exact:true}).check();
  await page.getByRole('button',{name:'Riconcilia e chiudi il tentativo',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza modifica.');
  const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
  await expect(saveAdminOperationalState(db,person.session,{commandId,model:'ControlledIntake',id:source.intake.id,
    state:'BLOCKED',expectedVersion:before.expectedVersion,reason:'Late synthetic writer',confirmed:true},
    {key,sessionToken:person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:actor.id,sessionToken:person.token,role:'admin'})})).rejects.toThrow('CLOSED');
  await page.getByRole('link',{name:'Riapri i dati correnti per una nuova operazione',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('command')).not.toBe(commandId);
  const fresh=new URL(page.url()).searchParams.get('command');expect(fresh).not.toBe(commandId);
  await lifecycleChoice(page,'BLOCKED');await lifecycleSave(page);
  expect((await db.adminOperationalState.findUniqueOrThrow({where:{model_recordId:{model:'ControlledIntake',recordId:source.intake.id}}})).version).toBe(1);
});
test('native dossier actions disappear while its readiness is blocked and reappear after explicit restore',async({page})=>{
  const actor=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),person=await syntheticSession(db,actor);
  const source=await lifecycleReadinessFixture(db,person.session);
  await login(page);const path='/admin/lifecycle/PracticeReadiness/'+source.practice.id;
  await page.goto(path);await lifecycleChoice(page,'BLOCKED');await lifecycleSave(page);
  await page.goto('/client-dossiers/'+source.dossier.id);
  await expect(page.getByRole('status')).toContainText('La pratica o l’acquisizione collegata è sospesa.');
  await expect(page.getByRole('button',{name:'Salva come nuova versione',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Salva responsabilità del servizio',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Gestisci lo stato della pratica',exact:true}).click();
  await lifecycleChoice(page,'ACTIVE');await lifecycleSave(page);
  await page.goto('/client-dossiers/'+source.dossier.id);
  await expect(page.getByRole('button',{name:'Salva come nuova versione',exact:true})).toBeVisible();
  expect((await db.clientDossier.findUniqueOrThrow({where:{id:source.dossier.id}})).currentVersionId).toBe(source.version.id);
});

async function browserPrivateMetadata(){
  const user=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),person={user,...await syntheticSession(db,user)};
  return {person,...await lifecyclePrivateDocumentFixture(db,person)};
}
async function metadataChoice(page:Page,title:string,note='Correzione privata sintetica da browser'){
  await page.getByRole('textbox',{name:'Titolo amministrativo',exact:true}).fill(title);
  await page.getByRole('textbox',{name:'Motivazione',exact:true}).fill(note);
  await page.getByRole('checkbox',{name:'Confermo la correzione, la conservazione della fonte e l’invalidazione delle vecchie selezioni.',exact:true}).check();
}
test('private metadata survives inline confirmation and reopens the correction and an explicit restored version',async({page,context})=>{
  const source=await browserPrivateMetadata(),id=source.receipt.documentId,original=await db.document.findUniqueOrThrow({where:{id}});
  await login(page);await page.goto('/clients/'+source.client.id+'/acquired-documents');
  await page.getByRole('link',{name:'Correggi metadati e consulta le revisioni',exact:true}).click();
  await metadataChoice(page,'Titolo privato corretto nel browser','Motivazione privata conservata');
  await page.getByRole('combobox',{name:'Classificazione amministrativa',exact:true}).selectOption('OTHER_CONFIDENTIAL');
  await page.getByLabel('Scadenza amministrativa',{exact:true}).fill('2030-01-02T10:30');
  await page.getByRole('checkbox',{name:'Confermo la correzione, la conservazione della fonte e l’invalidazione delle vecchie selezioni.',exact:true}).check();
  await context.clearCookies({name:'fai_crm_privileged_step_up'});
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  const confirmation=page.getByRole('region',{name:'Conferma identità senza lasciare il lavoro',exact:true});
  await expect(confirmation).toBeVisible();await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue('Titolo privato corretto nel browser');
  await expect(page.getByLabel('Scadenza amministrativa',{exact:true})).toHaveValue('2030-01-02T10:30');
  await expect(page.getByRole('textbox',{name:'Motivazione',exact:true})).toHaveValue('Motivazione privata conservata');
  await confirmation.getByLabel('Password corrente',{exact:true}).fill(password);
  await confirmation.getByRole('button',{name:'Conferma identità e conserva le scelte',exact:true}).click();await expect(confirmation).toContainText('Identità confermata.');
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await page.getByRole('link',{name:'Riapri e verifica i metadati',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue('Titolo privato corretto nel browser');
  await page.getByRole('button',{name:'Riprendi i metadati originali nella bozza',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue(original.title);
  await page.getByRole('textbox',{name:'Motivazione',exact:true}).fill('Ripristino esplicito dei metadati originali');
  await page.getByRole('checkbox',{name:'Confermo la correzione, la conservazione della fonte e l’invalidazione delle vecchie selezioni.',exact:true}).check();
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await page.getByRole('link',{name:'Riapri e verifica i metadati',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Metadati correnti · revisione 2',exact:true})).toBeVisible();
  const after=await db.document.findUniqueOrThrow({where:{id}});
  expect({...after,selectiveEpoch:original.selectiveEpoch}).toEqual(original);expect(after.selectiveEpoch).toBe(original.selectiveEpoch+2);
  expect(await db.adminRecordRevision.count({where:{model:'AdminPrivateDocumentMetadata',recordId:id,operation:'UPDATE'}})).toBe(2);
  await page.getByRole('link',{name:'Torna ai documenti acquisiti',exact:true}).click();
  await expect(page.getByRole('link',{name:'Scarica documento acquisito',exact:true})).toBeVisible();
});
test('a lost private metadata response reconciles after reload with one source-preserving correction',async({page})=>{
  const source=await browserPrivateMetadata(),id=source.receipt.documentId;
  const preciseExpiry='2030-01-02T10:30:45.123Z',initial=await readAdminPrivateDocumentMetadata(db,source.person.session,id);
  const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
  await saveAdminPrivateDocumentMetadata(db,source.person.session,{commandId:randomUUID(),id,expectedVersion:initial.expectedVersion,
    values:{...initial.current.values,expiresAt:preciseExpiry},reason:'Scadenza sintetica con precisione originale',confirmed:true},
    {key,sessionToken:source.person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:source.person.user.id,sessionToken:source.person.token,role:'admin'})});
  await login(page);await page.goto('/admin/private-documents/'+id);await metadataChoice(page,'Metadato con esito recuperato');
  const commandId=new URL(page.url()).searchParams.get('command')!,pattern='**/admin/private-documents/**';let lost=false,posts=0;
  await page.route(pattern,async route=>{if(route.request().method()!=='POST')return route.continue();posts++;await route.fetch();lost=true;await route.abort('failed');});
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await expect.poll(()=>lost).toBe(true);await page.unroute(pattern);await page.reload();
  await page.getByRole('button',{name:'Verifica esito registrato',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Correzione già registrata.');
  expect(posts).toBe(1);expect(await db.adminRecordRevision.count({where:{commandId}})).toBe(1);
  expect(await db.auditLog.count({where:{id:'admin-record:'+commandId}})).toBe(1);
  await page.getByRole('link',{name:'Riapri e verifica i metadati',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue('Metadato con esito recuperato');
  expect((await readAdminPrivateDocumentMetadata(db,source.person.session,id)).current.values.expiresAt).toBe(preciseExpiry);
  await page.getByLabel('Scadenza amministrativa',{exact:true}).fill('2040-01-02T12:00');
  await page.getByRole('listitem').filter({hasText:'Revisione 1 ·'}).getByRole('button',{name:'Riprendi questi metadati nella bozza',exact:true}).click();
  await metadataChoice(page,'Metadato con scadenza ripresa dalla cronologia');
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await page.getByRole('link',{name:'Riapri e verifica i metadati',exact:true}).click();
  const restored=await readAdminPrivateDocumentMetadata(db,source.person.session,id);
  expect(restored.current.revision).toBe(3);expect(restored.current.values.expiresAt).toBe(preciseExpiry);
});
test('an interrupted private metadata attempt closes before a fresh operation and rejects the late command',async({page})=>{
  const source=await browserPrivateMetadata(),id=source.receipt.documentId;
  const before=await readAdminPrivateDocumentMetadata(db,source.person.session,id);
  await login(page);await page.goto('/admin/private-documents/'+id);await metadataChoice(page,'Metadato interrotto');
  const commandId=new URL(page.url()).searchParams.get('command')!,pattern='**/admin/private-documents/**';
  await page.route(pattern,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await expect(page.getByRole('button',{name:'Verifica esito registrato',exact:true})).toBeVisible();await page.unroute(pattern);await page.reload();
  await page.getByRole('checkbox',{name:'Chiudi il tentativo soltanto se non ha prodotto una correzione.',exact:true}).check();
  await page.getByRole('button',{name:'Riconcilia e chiudi il tentativo',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza correzione.');
  const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
  await expect(saveAdminPrivateDocumentMetadata(db,source.person.session,{commandId,id,expectedVersion:before.expectedVersion,
    values:{...before.current.values,title:'Metadato interrotto'},reason:'Tentativo tardivo sintetico',confirmed:true},
    {key,sessionToken:source.person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:source.person.user.id,sessionToken:source.person.token,role:'admin'})})).rejects.toThrow('CLOSED');
  await page.getByRole('link',{name:'Riapri i dati correnti per una nuova operazione',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('command')).not.toBe(commandId);
  await metadataChoice(page,'Nuova scelta dopo chiusura');
  await page.getByRole('button',{name:'Registra metadati amministrativi',exact:true}).click();
  await page.getByRole('link',{name:'Riapri e verifica i metadati',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Titolo amministrativo',exact:true})).toHaveValue('Nuova scelta dopo chiusura');
  expect(await db.adminRecordRevision.count({where:{model:'AdminPrivateDocumentMetadata',recordId:id,operation:'UPDATE'}})).toBe(1);
});

async function browserDraftContext(){
  const user=await db.user.findUniqueOrThrow({where:{email:f.adminEmail}}),person={user,...await syntheticSession(db,user)};
  const lead=await db.lead.create({data:{firstName:'Bozza browser sintetica',lastName:randomUUID(),assignedToId:user.id}});
  const client=await db.client.create({data:{displayName:'Cliente sostituzione browser '+randomUUID(),type:'societa'}});
  const source=await storedNoticeMessage(db,{leadId:lead.id,authorId:user.id});
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority"(id,"userId","mailboxId",enabled) VALUES('ordinary-email',${user.id},${source.mailbox.id}::uuid,true)
    ON CONFLICT(id) DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId",enabled=true,revision="OrdinaryEmailAuthority".revision+1`;
  return {person,lead,client,...source};
}
async function openDraftReplacement(page:Page,source:Awaited<ReturnType<typeof browserDraftContext>>){
  await page.goto('/communications?kind=LEAD&practice='+source.lead.id+'&focus='+source.message.id);
  await page.getByRole('link',{name:'Correggi il contesto di questa bozza',exact:true}).click();
  await page.getByLabel('Cerca destinazione',{exact:true}).fill(source.client.id);
  await page.getByRole('button',{name:'Cerca contesti disponibili',exact:true}).click();
  await page.getByRole('link',{name:source.client.displayName+' · prepara la sostituzione',exact:true}).click();
  await expect(page.locator('[data-draft-context-command][data-interactive-ready="true"]')).toBeVisible();
  await expect(page.locator('input[name="to"]')).toHaveValue('');
  await expect(page.locator('input[name="attachmentVersionId"]:checked,input[name="contextFileId"]:checked')).toHaveCount(0);
  await page.getByLabel('Mittente',{exact:true}).selectOption(source.mailbox.id);
  await page.getByLabel('Reply-To',{exact:true}).fill(source.mailbox.address);
  await page.locator('input[name="to"]').fill('chosen-recipient@invalid.test');
  await page.getByLabel('Oggetto',{exact:true}).fill('Oggetto sostitutivo da browser');
  await page.getByLabel('Testo esatto',{exact:true}).fill('Testo sostitutivo sintetico da browser');
  await page.getByLabel('Motivazione della sostituzione',{exact:true}).fill('Correzione esplicita del contesto sintetico');
  await page.getByRole('checkbox',{name:'Confermo il nuovo contesto, il testo e le selezioni esplicite, conservando l’originale in archivio.',exact:true}).check();
  return (await page.locator('[data-draft-context-command]').getAttribute('data-draft-context-command'))!;
}
test('draft replacement preserves target and fields through confirmation expiry and reopens one persisted destination',async({page,context})=>{
  const source=await browserDraftContext(),version=await db.communicationVersion.findFirstOrThrow({where:{messageId:source.message.id}});
  await login(page);const commandId=await openDraftReplacement(page,source);
  await context.clearCookies({name:'fai_crm_privileged_step_up'});
  await page.getByRole('button',{name:'Registra bozza sostitutiva',exact:true}).click();
  const confirmation=page.getByRole('region',{name:'Conferma identità senza lasciare il lavoro',exact:true});
  await expect(confirmation).toBeVisible();
  await expect(page.getByLabel('Testo esatto',{exact:true})).toHaveValue('Testo sostitutivo sintetico da browser');
  await expect(page.locator('input[name="to"]')).toHaveValue('chosen-recipient@invalid.test');
  await expect(page.getByLabel('Motivazione della sostituzione',{exact:true})).toHaveValue('Correzione esplicita del contesto sintetico');
  await confirmation.getByLabel('Password corrente',{exact:true}).fill(password);
  await confirmation.getByRole('button',{name:'Conferma identità e conserva le scelte',exact:true}).click();await expect(confirmation).toContainText('Identità confermata.');
  await page.getByRole('button',{name:'Registra bozza sostitutiva',exact:true}).click();
  await page.getByRole('link',{name:'Apri e verifica la bozza sostitutiva',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('focus='+commandId));await expect(page.getByRole('region',{name:'Testo del messaggio conservato',exact:true})).toHaveText('Testo sostitutivo sintetico da browser');
  expect((await db.approvedCommunication.findUniqueOrThrow({where:{id:commandId}})).clientId).toBe(source.client.id);
  expect(await db.communicationVersion.findUniqueOrThrow({where:{id:version.id}})).toEqual(version);
  expect((await readAdminOperationalState(db,source.person.session,'ApprovedCommunication',source.message.id)).state).toBe('ARCHIVED');
});
test('lost draft replacement response recovers one persisted destination without another POST',async({page})=>{
  const source=await browserDraftContext();await login(page);const commandId=await openDraftReplacement(page,source);
  let posts=0,lost=false;const pattern='**/*';
  await page.route(pattern,async route=>{if(route.request().method()!=='POST')return route.continue();posts++;await route.fetch();lost=true;await route.abort('failed');});
  await page.getByRole('button',{name:'Registra bozza sostitutiva',exact:true}).click();await expect.poll(()=>lost).toBe(true);
  await page.unroute(pattern);await expect(page.getByRole('button',{name:'Verifica esito della sostituzione',exact:true})).toBeVisible();await page.reload();
  await page.getByRole('button',{name:'Verifica esito della sostituzione',exact:true}).click();
  await page.getByRole('link',{name:'Apri e verifica la bozza sostitutiva',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('focus='+commandId));
  expect(posts).toBe(1);expect(await db.approvedCommunication.count({where:{id:commandId}})).toBe(1);
  expect(await db.adminRecordRevision.count({where:{commandId}})).toBe(1);
});
test('interrupted replacement closes before a new command and a late POST cannot create a duplicate',async({page})=>{
  const source=await browserDraftContext(),before=await readAdminDraftReplacement(db,source.person.session,source.message.id);
  await login(page);const commandId=await openDraftReplacement(page,source),pattern='**/*';
  await page.route(pattern,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'Registra bozza sostitutiva',exact:true}).click();
  await expect(page.getByRole('button',{name:'Verifica esito della sostituzione',exact:true})).toBeVisible();await page.unroute(pattern);await page.reload();
  await page.getByRole('checkbox',{name:'Chiudi il tentativo soltanto se non ha prodotto una bozza.',exact:true}).check();
  await page.getByRole('button',{name:'Riconcilia e chiudi la sostituzione',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Tentativo chiuso senza sostituzione');
  const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
  await expect(replaceAdminCommunicationDraft(db,source.person.session,{commandId,id:source.message.id,expectedVersion:before.expectedVersion,
    reason:'Tentativo tardivo sintetico',confirmed:true,draft:{context:{kind:'CLIENT',id:source.client.id},mailboxId:source.mailbox.id,replyTo:source.mailbox.address,
      to:['chosen-recipient@invalid.test'],cc:[],bcc:[],subject:'Oggetto sostitutivo da browser',body:'Testo sostitutivo sintetico da browser',
      classification:'ORDINARY',attachmentVersionIds:[],contextFileIds:[],recipientSelection:emptyCommunicationRecipientSelection()}},
    {key,sessionToken:source.person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:source.person.user.id,sessionToken:source.person.token,role:'admin'})})).rejects.toThrow('CLOSED');
  await page.getByRole('link',{name:'Prepara una nuova sostituzione',exact:true}).click();
  const fresh=await openDraftReplacement(page,source);expect(fresh).not.toBe(commandId);
  await page.getByRole('button',{name:'Registra bozza sostitutiva',exact:true}).click();
  await page.getByRole('link',{name:'Apri e verifica la bozza sostitutiva',exact:true}).click();
  expect(await db.approvedCommunication.count({where:{id:commandId}})).toBe(0);expect(await db.approvedCommunication.count({where:{id:fresh}})).toBe(1);
});
