import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syntheticSession } from '../selective-sharing/fixtures';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { paymentCorrectionFixture } from './payment-fixture';
import { romeDateTimeInput } from '../../src/lib/rome-date-time';
const db = new PrismaClient(), evidence = process.env.ADMIN_RECORD_EVIDENCE!;
const f: { adminEmail: string; technicianEmail: string; commandsEmail: string; clientId: string; projects: { id: string; title: string }[] } = JSON.parse(readFileSync(join(evidence, 'fixture.json'), 'utf8'));
const password = process.env.ADMIN_RECORD_BROWSER_PASSWORD!;

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
  await proof.getByLabel('Data effettiva della rettifica documentata · Europe/Rome', { exact: true }).fill(romeDateTimeInput(new Date(payment.effectiveAt)));
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
test('create, trash and restore an expense without duplicating identity or losing its amount', async ({ page }) => {
  await login(page); await page.goto('/admin/records/ProjectExpense/new');
  await page.getByRole('combobox', { name: 'Progetto', exact: true }).selectOption(f.projects[2].id);
  await page.getByRole('combobox', { name: 'Categoria', exact: true }).selectOption('software');
  await page.getByRole('textbox', { name: 'Descrizione', exact: true }).fill('Voce browser sintetica');
  await page.getByRole('spinbutton', { name: 'Importo', exact: true }).fill('123.45'); await reason(page);
  const id = new URL(page.url()).searchParams.get('draft')!; await save(page);
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
