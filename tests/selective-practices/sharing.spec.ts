import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

const db = new PrismaClient(), evidence = process.env.SELECTIVE_PRACTICE_EVIDENCE!, password = process.env.SELECTIVE_PRACTICE_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: { practiceId: string; label: string; readerId: string; readerEmail: string;
    privateNote: string; clientId: string; clientLabel: string; projectId: string; projectTitle: string; otherPracticeId: string; otherLabel: string }[];
  assignments: { owner: 'technical' | 'commercial'; state: 'active' | 'revoked' | 'expired'; readerId: string; readerEmail: string;
    expiresAt: string | null; restricted: { id: string; title: string; grantId: string }[]; siblings: { id: string; title: string }[] }[];
};
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
async function prepare(page: Page, row: typeof f.rows[number]) {
  await page.goto('/technical-office/practices/' + row.practiceId + '/sharing');
  await page.getByLabel('Persona esistente').selectOption(row.readerId);
  await page.getByLabel('Titolo', { exact: true }).check(); await page.getByLabel('Stato', { exact: true }).check();
  await page.getByRole('button', { name: 'Anteprima come destinatario' }).click();
  const preview = page.getByRole('region', { name: 'Riepilogo e anteprima', exact: true });
  await expect(preview).toBeVisible(); await expect(preview).toContainText(row.label);
  await expect(preview).not.toContainText(row.privateNote); await expect(preview).not.toContainText(row.clientLabel);
  await expect(page.getByLabel('Persona esistente')).toHaveValue(row.readerId);
  await expect(page.getByLabel('Titolo', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Stato', { exact: true })).toBeChecked();
  expect(await db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(0);
  await page.getByLabel('Confermo personalmente i campi, il destinatario e l’effetto sui permessi.').check();
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(f.synthetic).toBe(true); });
test.afterAll(async () => db.$disconnect());

test('native selected practice fields, indirect denials, open-session revocation and responsive UI', async ({ browser }) => {
  const row = f.rows[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await reader.goto('/technical-office/practices/' + row.practiceId); await expect(reader.getByText(row.label, { exact: true }).first()).toBeVisible();
  await prepare(admin, row);
  await admin.getByLabel('Stato', { exact: true }).uncheck();
  await expect(admin.getByRole('region', { name: 'Riepilogo e anteprima', exact: true })).toHaveCount(0);
  await prepare(admin, row);
  await admin.screenshot({ path: path.join(evidence, 'selective-practice-preview-desktop.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'selective-practice-preview-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(1);
  const urls = ['/technical-office/practices', '/technical-office/practices/' + row.practiceId,
    '/technical-office/practices/' + row.practiceId + '/edit', '/clients/' + row.clientId,
    '/projects/' + row.projectId, '/dashboard', '/notifications', '/assignments', '/assignments?kind=TechnicalPractice', '/communications',
    '/search?q=' + encodeURIComponent(row.label)];
  for (const url of urls) {
    const response = await rc.request.get(url); expect(response.status(), url).toBeLessThan(500);
    const html = await response.text();
    if (!url.startsWith('/search?')) expect(html, url).not.toContain(row.label);
    else expect(html).not.toContain('href="/technical-office/practices/' + row.practiceId + '"');
    expect(html, url).not.toContain(row.privateNote);
  }
  expect(await (await rc.request.get('/technical-office/practices/' + row.otherPracticeId)).text()).toContain(row.otherLabel);
  expect(await (await rc.request.get('/clients/' + row.clientId)).text()).toContain(row.clientLabel);
  expect(await (await rc.request.get('/projects/' + row.projectId)).text()).toContain(row.projectTitle);
  expect((await rc.request.get('/technical-office/practices/' + row.practiceId + '/sharing')).status()).toBe(404);
  await reader.goto('/shared-practices/' + row.practiceId); await expect(reader.getByText(row.label, { exact: true })).toBeVisible();
  expect(await reader.locator('dt').count()).toBe(2);
  expect(await reader.content()).not.toContain(row.privateNote); expect(await reader.content()).not.toContain(row.clientLabel);
  await reader.screenshot({ path: path.join(evidence, 'selective-practice-recipient-desktop.png'), fullPage: true });
  await reader.setViewportSize({ width: 390, height: 844 });
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: path.join(evidence, 'selective-practice-recipient-mobile.png'), fullPage: true });
  await admin.reload(); await admin.getByLabel('Confermo la revoca. Le copie già acquisite non possono essere recuperate.').check();
  await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
  await expect.poll(async () => (await db.selectivePracticeGrant.findFirstOrThrow({ where: { practiceId: row.practiceId } })).revokedAt !== null).toBe(true);
  await reader.reload(); await expect(reader.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  expect(await reader.content()).not.toContain(row.label);
  expect(await (await rc.request.get('/technical-office/practices/' + row.practiceId)).text()).not.toContain(row.label);
  await ac.close(); await rc.close();
});
test('lost native response reconciles the recorded command without automatic resubmission', async ({ browser }) => {
  const row = f.rows[1], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  let forwarded = 0, done!: () => void, failed!: (error: unknown) => void;
  const lost = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
  await page.route('**/technical-office/practices/**', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    forwarded++;
    try { const response = await route.fetch({ maxRedirects: 0 }); expect(response.status()).toBeLessThan(500); await route.abort('failed'); done(); }
    catch (error) { failed(error); }
  });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click(); await lost;
  expect(new URL(page.url()).searchParams.get('commandId')).toBeTruthy();
  await page.unroute('**/technical-office/practices/**'); await page.reload();
  await expect(page.getByText('Operazione registrata: selezione, revisione 1. Lo stato corrente è riportato sotto.', { exact: true })).toBeVisible();
  expect(forwarded).toBe(1); expect(await db.selectivePracticeCommand.count({ where: { practiceId: row.practiceId } })).toBe(1);
  expect(await db.selectivePracticeRevision.count({ where: { grant: { practiceId: row.practiceId } } })).toBe(1);
  await context.close();
});
test('revoked session with an open native confirmation cannot create a practice grant', async ({ browser }) => {
  const row = f.rows[2], context = await browser.newContext(), page = await context.newPage();
  await login(page, f.adminEmail, true); await prepare(page, row);
  await db.internalSession.updateMany({ where: { userId: f.adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  await page.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(0);
  await context.close();
});

for (const owner of ['technical', 'commercial'] as const) {
  for (const state of ['active', 'revoked', 'expired'] as const) {
    test(`native practice assignments: ${owner} owner, ${state} status-only selection`, async ({ browser }) => {
      const row = f.assignments.find(item => item.owner === owner && item.state === state)!;
      expect(row).toBeTruthy();
      if (row.expiresAt) await expect.poll(() => Date.now() >= Date.parse(row.expiresAt!), { timeout: 20_000 }).toBe(true);
      const context = await browser.newContext(), page = await context.newPage();
      await login(page, row.readerEmail);
      const selected = row.restricted[0];
      const grant = await db.selectivePracticeGrant.findUniqueOrThrow({ where: { id: selected.grantId } });
      expect((grant.payload as { selection: { fields: string[] } }).selection.fields).toEqual(['status']);
      expect(grant.revokedAt !== null).toBe(state === 'revoked');
      await page.goto('/shared-practices/' + selected.id);
      if (state === 'active') expect(await page.locator('dt').count()).toBe(1);
      else await expect(page.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
      expect(await page.content()).not.toContain(selected.title);
      const route = '/assignments?kind=TechnicalPractice';
      await page.goto(route);
      await expect(page.getByRole('heading', { name: 'Pratiche assegnate', exact: true })).toBeVisible();
      const checkPage = async (siblings: typeof row.siblings) => {
        const html = await page.content();
        for (const restricted of row.restricted) {
          expect(html).not.toContain(restricted.title);
          await expect(page.locator(`a[href="/assignments/TechnicalPractice/${restricted.id}"]`)).toHaveCount(0);
        }
        await expect(page.locator('a[href^="/assignments/TechnicalPractice/"]')).toHaveCount(siblings.length);
        for (const sibling of siblings) await expect(page.getByRole('link', { name: sibling.title, exact: true })).toBeVisible();
      };
      await checkPage(row.siblings.slice(0, 25));
      if (row.siblings.length > 25) {
        await page.screenshot({ path: path.join(evidence, 'selective-practice-assignments-desktop.png'), fullPage: true });
        await page.getByRole('link', { name: 'Altre assegnazioni', exact: true }).click();
        await expect(page).toHaveURL(url => url.searchParams.get('after') === row.siblings[24].id);
        await checkPage(row.siblings.slice(25));
        await expect(page.getByRole('link', { name: 'Altre assegnazioni', exact: true })).toHaveCount(0);
        await page.setViewportSize({ width: 390, height: 844 }); await page.goto(route);
        await checkPage(row.siblings.slice(0, 25));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: path.join(evidence, 'selective-practice-assignments-mobile.png'), fullPage: true });
      }
      await context.close();
    });
  }
}
