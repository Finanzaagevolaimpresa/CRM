import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), evidence = process.env.ADMIN_RECORD_EVIDENCE!;
const f: { adminEmail: string; technicianEmail: string; clientId: string; projects: { id: string; title: string }[] } = JSON.parse(readFileSync(join(evidence, 'fixture.json'), 'utf8'));
const password = process.env.ADMIN_RECORD_BROWSER_PASSWORD!;
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
  await page.getByRole('textbox', { name: 'Categoria', exact: true }).fill('software');
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
  let posts = 0; const pattern = '**/admin/records/Project/**';
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Salva operazione', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect.poll(() => db.adminRecordRevision.count({ where: { commandId } })).toBe(1);
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
