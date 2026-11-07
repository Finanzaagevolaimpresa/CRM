import { test, expect, type Page, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient();
type Person = { id: string; email: string; name: string };
const f = JSON.parse(readFileSync(path.join(process.env.FOLDER_EVIDENCE!, 'fixture.json'), 'utf8')) as {
  clientId: string; emptyClientId: string; people: Record<string, Person>;
};
const password = process.env.FOLDER_BROWSER_PASSWORD!, origin = process.env.APP_ORIGIN!;
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.afterAll(async () => db.$disconnect());
async function session(browser: Browser, name: string, stepUp = false) {
  const context = await browser.newContext();
  // The feature opens a reference. No Google authentication, playback or external
  // folder content is simulated as a real-world PASS; all egress is rejected.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(f.people[name].email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  if (stepUp) await confirmIdentity(page);
  return { page, context };
}
async function confirmIdentity(page: Page) {
  await page.goto('/settings/security'); await page.getByLabel('Password corrente', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Conferma per 30 minuti', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rimuovi conferma', exact: true })).toBeVisible();
}
async function editor(page: Page, id: string) {
  await page.goto('/drive-folders/manage/' + id);
  await page.locator('[data-testid="drive-folder-editor"][data-interactive-ready="true"]').waitFor();
}
async function confirm(page: Page, operation: string) {
  await page.getByRole('button', { name: operation, exact: true }).click();
  await page.getByLabel('Confermo il riepilogo esatto', { exact: true }).check();
  await page.getByRole('button', { name: 'Conferma operazione', exact: true }).click();
  const saved = page.getByRole('link', { name: 'Riapri la scheda salvata', exact: true });
  await expect(saved).toBeVisible();
  const href = (await saved.getAttribute('href'))!; await saved.click();
  await expect(page).toHaveURL(new RegExp(href + '$'));
  await page.locator('[data-testid="drive-folder-editor"][data-interactive-ready="true"]').waitFor();
  return href.split('/').at(-1)!;
}
async function form(page: Page, title: string) {
  await page.getByLabel('Cliente / account', { exact: true }).selectOption(f.clientId);
  await page.getByLabel('Titolo del fascicolo', { exact: true }).fill(title);
  await page.getByLabel('Link della cartella Google Drive', { exact: true }).fill('https://drive.google.com/drive/folders/synthetic_browser_' + title.replaceAll(' ', '_'));
  await page.getByLabel(new RegExp(f.people.commercial.email.replaceAll('.', '\\.'))).check();
  await page.getByLabel(new RegExp(f.people.technical.email.replaceAll('.', '\\.'))).check();
  await page.getByLabel(/Ho verificato cartella, sottocartelle/).check();
}
async function direct(page: Page, id: string, method = 'GET') {
  return page.request.fetch('/drive-folders/' + id + '/open', { method, maxRedirects: 0 });
}

test('normal Admin path: one reference across library/client, selection, search, reload, revocation and restore', async ({ browser }) => {
  const admin = await session(browser, 'admin', true), commercial = await session(browser, 'commercial'), technical = await session(browser, 'technical'), outsider = await session(browser, 'outsider'), disabled = await session(browser, 'disabled');
  try {
    await admin.page.goto('/clients/' + f.emptyClientId);
    await expect(admin.page.getByText('Nessun fascicolo collegato', { exact: true })).toBeVisible();
    const clientEntry = admin.page.getByRole('link', { name: 'Collega cartella Drive a questo cliente', exact: true });
    await expect(clientEntry).toHaveAttribute('href', '/drive-folders/manage/new?client=' + f.emptyClientId);
    // Follow the actual client entry point. Starting a second document navigation
    // while Next hydrates this client page can abort it before the editor loads.
    await clientEntry.click();
    await expect(admin.page).toHaveURL(origin + '/drive-folders/manage/new?client=' + f.emptyClientId);
    await admin.page.locator('[data-testid="drive-folder-editor"][data-interactive-ready="true"]').waitFor();
    await expect(admin.page.getByLabel('Cliente / account', { exact: true })).toHaveValue(f.emptyClientId);
    await form(admin.page, 'Synthetic Alpha Folder');
    await expect(admin.page.getByLabel(new RegExp(f.people.disabled.email.replaceAll('.', '\\.')))).toBeDisabled();
    const id = await confirm(admin.page, 'Salva bozza privata');
    await commercial.page.goto('/drive-folders'); await expect(commercial.page.getByText('Synthetic Alpha Folder', { exact: true })).toHaveCount(0);
    expect((await direct(commercial.page, id)).status()).toBe(404);
    await confirm(admin.page, 'Attiva per le persone scelte');
    for (const { page } of [commercial, technical]) {
      await page.goto('/drive-folders'); await expect(page.getByRole('heading', { name: 'Synthetic Alpha Folder', exact: true })).toBeVisible();
      await page.reload(); await expect(page.getByRole('heading', { name: 'Synthetic Alpha Folder', exact: true })).toBeVisible();
      await page.getByLabel('Cerca cliente o titolo').fill('Alpha'); await page.getByRole('button', { name: 'Cerca', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Synthetic Alpha Folder', exact: true })).toBeVisible();
      const response = await direct(page, id); expect(response.status()).toBe(302);
      expect(response.headers().location).toBe('https://drive.google.com/drive/folders/synthetic_browser_Synthetic_Alpha_Folder');
      expect(response.headers()['cache-control']).toContain('no-store'); expect((await direct(page, id, 'HEAD')).status()).toBe(302);
      expect((await page.request.get('/drive-folders/manage/' + id)).status()).toBe(404);
    }
    await commercial.page.goto('/clients/' + f.clientId);
    await expect(commercial.page.locator('#file-condivisi [data-folder-id="' + id + '"]')).toHaveCount(1);
    await outsider.page.goto('/drive-folders?q=Alpha'); await expect(outsider.page.getByText('Synthetic Alpha Folder', { exact: true })).toHaveCount(0);
    expect((await direct(outsider.page, id)).status()).toBe(404);
    expect((await direct(disabled.page, id, 'HEAD')).status()).toBe(404);
    expect((await technical.page.request.get('/payments')).status()).toBe(404);
    expect((await technical.page.request.get('/contracts')).status()).toBe(404);
    await confirm(admin.page, 'Disabilita il riferimento CRM');
    for (const { page } of [commercial, technical]) { await page.goto('/drive-folders'); await expect(page.getByText('Synthetic Alpha Folder', { exact: true })).toHaveCount(0); expect((await direct(page, id)).status()).toBe(404); }
    await confirm(admin.page, 'Attiva per le persone scelte'); expect((await direct(commercial.page, id)).status()).toBe(302);
    await confirm(admin.page, 'Disabilita il riferimento CRM');
    expect(await db.adminRecordRevision.count({ where: { model: 'DriveFolderReference', recordId: id, operation: 'CREATE' } })).toBe(1);
    expect(await db.document.count()).toBe(0); expect(await db.videoEntry.count()).toBe(0);
  } finally { for (const item of [admin, commercial, technical, outsider, disabled]) await item.context.close(); }
});
test('ordinary UI identity reconfirmation preserves choices and terminally closes the first attempt', async ({ browser }) => {
  const admin = await session(browser, 'admin');
  try {
    await editor(admin.page, 'new'); await form(admin.page, 'Synthetic Continued Folder');
    await admin.page.getByRole('button', { name: 'Salva bozza privata', exact: true }).click();
    await admin.page.getByLabel('Confermo il riepilogo esatto', { exact: true }).check();
    await admin.page.getByRole('button', { name: 'Conferma operazione', exact: true }).click();
    await expect(admin.page.getByText(/Tentativo chiuso senza modifica/)).toBeVisible();
    await expect(admin.page.getByLabel('Titolo del fascicolo', { exact: true })).toHaveValue('Synthetic Continued Folder');
    await admin.page.getByLabel('Password corrente', { exact: true }).fill(password);
    await admin.page.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
    const id = await confirm(admin.page, 'Salva bozza privata');
    await admin.page.reload(); await expect(admin.page.getByLabel('Titolo del fascicolo', { exact: true })).toHaveValue('Synthetic Continued Folder');
    expect(await db.adminRecordRevision.count({ where: { model: 'DriveFolderReference', recordId: id, operation: 'CLOSE' } })).toBe(1);
    expect(await db.adminRecordRevision.count({ where: { model: 'DriveFolderReference', recordId: id, operation: 'CREATE' } })).toBe(1);
  } finally { await admin.context.close(); }
});
