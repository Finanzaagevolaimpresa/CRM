import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type Page } from '@playwright/test';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

import { savePrivateDocumentFile } from '../../src/lib/storage';

const db = new PrismaClient(), evidence = process.env.SELECTIVE_PRACTICE_EVIDENCE!, password = process.env.SELECTIVE_PRACTICE_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(path.join(evidence, 'fixture.json'), 'utf8')) as {
  synthetic: boolean; adminId: string; adminEmail: string; rows: { practiceId: string; label: string; readerId: string; readerEmail: string;
    privateNote: string; clientId: string; clientLabel: string; projectId: string; projectTitle: string; otherPracticeId: string; otherLabel: string; documents: { id: string; versionId: string; title: string; content: string; financial: boolean }[] }[];
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
  await page.locator('[data-testid="practice-sharing"][data-interactive-ready="true"]').waitFor();
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
  await page.getByLabel('Confermo personalmente i campi, le versioni dei documenti, il destinatario e l’effetto sui permessi.').check();
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

async function prepareDocument(page: Page, row: typeof f.rows[number], document: typeof row.documents[number], download: boolean) {
  await page.goto('/technical-office/practices/' + row.practiceId + '/sharing');
  await page.locator('[data-testid="practice-sharing"][data-interactive-ready="true"]').waitFor();
  await page.getByLabel('Persona esistente').selectOption(row.readerId);
  const choice = page.getByLabel(document.title + ' · versione 1', { exact: false });
  await choice.check();
  const card = choice.locator('xpath=../..');
  if (download) await card.getByLabel('Consenti anche il download di questa versione', { exact: true }).check();
  await page.getByRole('button', { name: 'Anteprima come destinatario', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Riepilogo e anteprima', exact: true });
  await expect(preview).toBeVisible(); await expect(preview).toContainText(document.title);
  await expect(preview).not.toContainText(row.label); await expect(preview).not.toContainText(row.privateNote);
  await expect(preview.locator('dt')).toHaveCount(0);
  await page.getByLabel('Confermo personalmente i campi, le versioni dei documenti, il destinatario e l’effetto sui permessi.').check();
}

test('exact document-only native selection, inline bytes, direct URL denial and revocation on an open session', async ({ browser }) => {
  const row = f.rows[3], document = row.documents[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await prepareDocument(admin, row, document, false);
  await admin.screenshot({ path: path.join(evidence, 'practice-document-preview-desktop.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: path.join(evidence, 'practice-document-preview-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(1);
  await reader.goto('/shared-practices/' + row.practiceId);
  await expect(reader.getByRole('heading', { name: 'Documenti condivisi', exact: true })).toBeVisible();
  await expect(reader.locator('dt')).toHaveCount(0);
  await expect(reader.getByRole('link', { name: 'Scarica versione' })).toHaveCount(0);
  const html = await reader.content();
  for (const text of [row.label, row.privateNote, row.clientLabel, row.documents[1].title, row.documents[2].title]) expect(html).not.toContain(text);
  const url = `/shared-practices/${row.practiceId}/documents/${document.versionId}`;
  const response = await rc.request.get(url); expect(response.status()).toBe(200);
  expect(await response.text()).toBe(document.content); expect(response.headers()['cache-control']).toBe('private, no-store, max-age=0');
  expect(response.headers()['content-disposition']).toMatch(/^inline;/);
  expect((await rc.request.get(url + '?download=1')).status()).toBe(404);
  expect((await rc.request.get(`/shared-practices/${row.practiceId}/documents/${row.documents[1].versionId}`)).status()).toBe(404);
  expect((await rc.request.get(`/shared-practices/${row.otherPracticeId}/documents/${document.versionId}`)).status()).toBe(404);
  await reader.screenshot({ path: path.join(evidence, 'practice-document-recipient-desktop.png'), fullPage: true });
  await reader.setViewportSize({ width: 390, height: 844 });
  expect(await reader.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: path.join(evidence, 'practice-document-recipient-mobile.png'), fullPage: true });
  await admin.reload(); await admin.getByLabel('Confermo la revoca. Le copie già acquisite non possono essere recuperate.').check();
  await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
  await expect.poll(async () => (await db.selectivePracticeGrant.findFirstOrThrow({ where: { practiceId: row.practiceId } })).revokedAt !== null).toBe(true);
  expect((await rc.request.get(url)).status()).toBe(404);
  await reader.reload(); await expect(reader.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  await ac.close(); await rc.close();
});

test('financial selected version download is personal and stops immediately after the recipient role changes', async ({ browser }) => {
  const row = f.rows[4], document = row.documents[2], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await prepareDocument(admin, row, document, true);
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(1);
  const url = `/shared-practices/${row.practiceId}/documents/${document.versionId}?download=1`;
  const downloaded = await rc.request.get(url); expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toBe(document.content); expect(downloaded.headers()['content-disposition']).toMatch(/^attachment;/);
  await db.user.update({ where: { id: row.readerId }, data: { role: 'direzione' } });
  expect((await rc.request.get(url)).status()).toBe(404);
  await reader.goto('/shared-practices/' + row.practiceId); await expect(reader.getByText('Selezione non disponibile', { exact: true })).toBeVisible();
  await ac.close(); await rc.close();
});

test('native preview cannot approve a changed document and a future version never inherits access', async ({ browser }) => {
  const row = f.rows[5], document = row.documents[0], ac = await browser.newContext(), rc = await browser.newContext();
  const admin = await ac.newPage(), reader = await rc.newPage();
  await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
  await prepareDocument(admin, row, document, false);
  const before = await db.document.findUniqueOrThrow({ where: { id: document.id } });
  await db.document.update({ where: { id: document.id }, data: { containsSensitiveData: true } });
  await db.document.update({ where: { id: document.id }, data: { containsSensitiveData: false, updatedAt: before.updatedAt } });
  const post = admin.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/sharing'));
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click(); await post;
  expect(await db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(0);
  await prepareDocument(admin, row, document, false);
  await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
  await expect.poll(() => db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(1);
  const current = await db.documentVersion.findUniqueOrThrow({ where: { id: document.versionId } });
  const newer = await db.documentVersion.create({ data: { documentId: document.id, version: 2, storagePath: current.storagePath, checksum: current.checksum } });
  for (const version of [document.versionId, newer.id]) expect((await rc.request.get(`/shared-practices/${row.practiceId}/documents/${version}`)).status()).toBe(404);
  await ac.close(); await rc.close();
});

for (const [name, width, height, format, index] of [['desktop', 1280, 900, 'pdf', 6], ['mobile', 390, 844, 'png', 7]] as const) {
  test.describe(`Actual selected ${format} ${name}`, () => {
    test('native file link renders selected bytes and an open-session revocation prevents reopening', async ({ browser }) => {
      const row = f.rows[index], document = row.documents[0];
      const ac = await browser.newContext({ viewport: { width, height } }), rc = await browser.newContext({ viewport: { width, height } });
      const admin = await ac.newPage(), reader = await rc.newPage();
      await admin.setContent('<!doctype html><html lang="it"><body style="font-family:sans-serif;color:#123466"><h1>Documento selezionato</h1><p>Anteprima PDF della sola versione autorizzata.</p><p>Collaudo sintetico: nessun dato reale.</p></body></html>');
      const bytes = format === 'pdf'
        ? await admin.pdf({ width: '600px', height: '360px', printBackground: true, margin: { top: '24px', right: '24px', bottom: '24px', left: '24px' } })
        : Buffer.from((await admin.evaluate(() => {
          const canvas = window.document.createElement('canvas'); canvas.width = 600; canvas.height = 240;
          const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, 600, 240);
          drawing.fillStyle = '#123466'; drawing.font = '26px sans-serif'; drawing.fillText('Versione documentale selezionata', 25, 70);
          drawing.font = '18px sans-serif'; drawing.fillText('Solo il contenuto autorizzato · prova sintetica', 25, 120);
          return canvas.toDataURL('image/png');
        })).split(',')[1], 'base64');
      const fileName = `selected-preview-${name}.${format}`, mimeType = format === 'pdf' ? 'application/pdf' : 'image/png';
      const saved = await savePrivateDocumentFile({ file: new File([new Uint8Array(bytes)], fileName, { type: mimeType }), fileName, clientId: row.clientId });
      await db.document.update({ where: { id: document.id }, data: { ...saved, fileName, mimeType } });
      await db.documentVersion.update({ where: { id: document.versionId }, data: { storagePath: saved.storagePath, checksum: saved.checksum } });
      await login(admin, f.adminEmail, true); await login(reader, row.readerEmail);
      await prepareDocument(admin, row, document, false);
      await admin.getByRole('button', { name: 'Conferma accesso selettivo', exact: true }).click();
      await expect.poll(() => db.selectivePracticeGrant.count({ where: { practiceId: row.practiceId } })).toBe(1);
      await reader.goto('/shared-practices/' + row.practiceId);
      expect(await db.auditLog.count({ where: { actorId: row.readerId, entityId: document.id, event: 'selective_practice_document_view' } })).toBe(0);
      const url = `/shared-practices/${row.practiceId}/documents/${document.versionId}`;
      const link = reader.getByRole('link', { name: 'Consulta versione', exact: true });
      await expect(link).toHaveAttribute('href', url); await expect(link).toHaveAttribute('target', '_blank');
      const popup = rc.waitForEvent('page'); await link.click(); const viewer = await popup;
      try {
        if (format === 'png') {
          await expect(viewer.locator('img')).toBeVisible();
          await expect.poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 600 && img.naturalHeight === 240)).toBe(true);
          expect(await viewer.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } else {
          await expect.poll(async () => {
            for (const frame of viewer.frames()) {
              if (await frame.evaluate(() => {
                const pdf = window.document.querySelector('pdf-viewer') as (HTMLElement & { loadState_?: string; documentDimensions?: { pageDimensions?: Array<{ width: number; height: number }> } }) | null;
                const pages = pdf?.documentDimensions?.pageDimensions;
                return pdf?.loadState_ === 'success' && !!pdf.shadowRoot && !pdf.shadowRoot.querySelector('viewer-error-dialog')
                  && pages?.length === 1 && pages[0].width >= 600 && pages[0].height >= 360;
              }).catch(() => false)) return true;
            }
            return false;
          }, { timeout: 60_000, message: 'Selected PDF must render one actual page' }).toBe(true);
        }
        expect(viewer.viewportSize()).toEqual({ width, height });
        await viewer.screenshot({ path: path.join(evidence, `selected-file-render-${name}.png`), fullPage: true });
        const response = await rc.request.get(url); expect(response.status()).toBe(200); expect(await response.body()).toEqual(bytes);
        expect(response.headers()['content-security-policy']).toContain('sandbox');
        expect(response.headers()['cache-control']).toContain('no-store');
        expect((await rc.request.get(url + '?download=1')).status()).toBe(404);
        expect((await rc.request.get(`/shared-practices/${row.otherPracticeId}/documents/${document.versionId}`)).status()).toBe(404);
        await admin.reload(); await admin.getByLabel('Confermo la revoca. Le copie già acquisite non possono essere recuperate.').check();
        await admin.getByRole('button', { name: 'Revoca accesso', exact: true }).click();
        await expect.poll(async () => (await db.selectivePracticeGrant.findFirstOrThrow({ where: { practiceId: row.practiceId } })).revokedAt !== null).toBe(true);
        const denied = await viewer.reload(); expect(denied?.status()).toBe(404);
        await expect(viewer.getByText('Documento non disponibile', { exact: true })).toBeVisible();
        writeFileSync(path.join(evidence, `selected-file-proof-${name}.json`), JSON.stringify({ synthetic: true, format, viewport: { width, height }, selectedBytesRendered: true, exactBytes: true, downloadDenied: true, siblingPracticeSelectionDenied: true, revocationDeniedOnOpenSession: true }));
      } catch (error) {
        await viewer.screenshot({ path: path.join(evidence, `selected-file-failure-${name}.png`), fullPage: true }).catch(() => undefined);
        writeFileSync(path.join(evidence, `selected-file-failure-${name}.json`), JSON.stringify({ synthetic: true, frames: viewer.frames().map(frame => frame.url()) }));
        throw error;
      } finally { await ac.close(); await rc.close(); }
    });
  });
}
