import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { savePrivateDocumentFile } from '../../src/lib/storage';
const db = new PrismaClient(), root = process.env.FINANCIAL_PRIVACY_EVIDENCE!, password = process.env.FINANCIAL_PRIVACY_BROWSER_PASSWORD!;
type Fixture = { role: string; key: string; denied: string | null; userId: string; clientId: string; projectId: string; serviceId: string; contractId: string; paymentId: string; docs: { kind: string; id: string; versionId: string; title: string }[] };
const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')) as { synthetic: boolean; fixtures: Fixture[]; overrideDelegationDenied: boolean; blockedDelegationRoles: string[] };
async function documentContextScreens(page: Page, name: string) {
  for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(root, `${name}-${suffix}.png`), fullPage: true, caret: 'initial' });
  }
}
async function login(page: Page, role: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(`privacy-${role}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.FINANCIAL_PRIVACY_BROWSER_CONFIRMED).toBe('1'); expect(fixture.synthetic).toBe(true); expect(fixture.overrideDelegationDenied).toBe(true); expect(fixture.blockedDelegationRoles).toContain('direzione'); });
test.afterAll(async () => { await db.$disconnect(); });
for (const [name, width, height, role] of [['desktop', 1280, 900, 'admin'], ['mobile', 390, 844, 'amministrazione']] as const) {
  test.describe(`Native PDF preview ${name}`, () => {
    test.use({ viewport: { width, height } });
    test('Visualizza renders a valid private PDF and rechecks access on reopening', async ({ page, context }) => {
      const f = fixture.fixtures.find(f => f.role === role && !f.denied)!;
      const fixturePage = await context.newPage();
      await fixturePage.setContent('<!doctype html><html lang="it"><body style="font-family:sans-serif;color:#123466"><h1>Contratto sintetico</h1><p>Anteprima PDF leggibile nel CRM.</p><p>Documento di collaudo: nessun dato reale.</p></body></html>');
      const bytes = await fixturePage.pdf({ width: '600px', height: '360px', printBackground: true, margin: { top: '24px', right: '24px', bottom: '24px', left: '24px' } });
      await fixturePage.close();
      const fileName = `preview-contract-${name}.pdf`;
      const saved = await savePrivateDocumentFile({ file: new File([new Uint8Array(bytes)], fileName, { type: 'application/pdf' }), clientId: f.clientId, fileName });
      const doc = await db.document.create({ data: { ...saved, fileName, mimeType: 'application/pdf', type: 'application/pdf',
        title: `Contratto sintetico anteprima ${name}`, serviceArea: 'contratti', clientId: f.clientId, projectId: f.projectId, status: 'verificato', uploadedById: f.userId } });
      await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: doc.storagePath, checksum: doc.checksum } });
      await login(page, f.key); await page.goto(`/clients/${f.clientId}#documenti`);
      const link = page.locator(`#documenti a[href="/documents/${doc.id}/view"]`);
      await expect(link).toHaveText('Visualizza');
      const popupPromise = context.waitForEvent('page'); await link.click(); const viewer = await popupPromise;
      try {
        await expect.poll(async () => {
          for (const frame of viewer.frames()) {
            const rendered = await frame.evaluate(() => {
              const pdf = document.querySelector('pdf-viewer') as (HTMLElement & { loadState_?: string; documentDimensions?: { pageDimensions?: Array<{ width: number; height: number }> } }) | null;
              const pages = pdf?.documentDimensions?.pageDimensions;
              // Chromium's reactive showErrorDialog accessor is not exposed in
              // every build. Inspect the actual error UI and positive renderer state.
              return pdf?.loadState_ === 'success' && !!pdf.shadowRoot && !pdf.shadowRoot.querySelector('viewer-error-dialog')
                && pages?.length === 1 && pages[0].width >= 600 && pages[0].height >= 360;
            }).catch(() => false);
            if (rendered) return true;
          }
          return false;
        }, { timeout: 60_000, message: 'Native PDF renderer must load one actual page, not only return PDF bytes' }).toBe(true);
        expect(viewer.viewportSize()).toEqual({ width, height });
        await viewer.screenshot({ path: join(root, `private-pdf-view-${name}.png`), fullPage: true });
        const response = await page.request.get(`/documents/${doc.id}/view`);
        expect(response.status()).toBe(200); expect(await response.body()).toEqual(bytes);
        expect(response.headers()['content-disposition']).toContain('inline');
        expect(response.headers()['content-security-policy']).toContain('sandbox');
        expect(response.headers()['cache-control']).toContain('no-store');
        expect(await db.auditLog.count({ where: { actorId: f.userId, entityId: doc.id, event: 'document_view' } })).toBeGreaterThanOrEqual(2);
        expect(await db.auditLog.count({ where: { actorId: f.userId, entityId: doc.id, event: 'document_download' } })).toBe(0);
        await db.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
        const denied = await viewer.reload(); expect(denied?.status()).toBe(404);
        await expect(viewer.getByText('Documento non disponibile', { exact: true })).toBeVisible();
        writeFileSync(join(root, `private-pdf-proof-${name}.json`), JSON.stringify({ synthetic: true, role, viewport: { width, height }, nativePdfPageRendered: true, exactBytes: true, privateHeaders: true, viewAuditOnly: true, reopeningDeletedDocumentDenied: true }));
      } catch (error) {
        await viewer.screenshot({ path: join(root, `private-pdf-failure-${name}.png`), fullPage: true }).catch(() => undefined);
        const frames = await Promise.all(viewer.frames().map(async frame => ({ url: frame.url(), state: await frame.evaluate(() => {
          const pdf = document.querySelector('pdf-viewer') as (HTMLElement & { loadState_?: string; showErrorDialog?: boolean; documentDimensions?: unknown }) | null;
          return { found: !!pdf, loadState: pdf?.loadState_, showErrorDialog: pdf?.showErrorDialog, dimensions: pdf?.documentDimensions };
        }).catch(() => null) })));
        writeFileSync(join(root, `private-pdf-failure-${name}.json`), JSON.stringify({ synthetic: true, frames }));
        throw error;
      } finally { await viewer.close(); }
    });
  });
}
for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]] as const) test(`${name}: Visualizza renders actual private image bytes and revocation blocks reopening`, async ({ page, context }) => {
  const f = fixture.fixtures.find(f => f.role === 'admin' && !f.denied)!;
  await page.setViewportSize({ width, height }); await login(page, f.key);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 240;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, 600, 240);
    drawing.fillStyle = '#123466'; drawing.font = '26px sans-serif';
    drawing.fillText('Anteprima documento sintetico', 25, 70);
    drawing.font = '18px sans-serif'; drawing.fillText('Contenuto visibile nel browser · nessun dato reale', 25, 120);
    return canvas.toDataURL('image/png');
  });
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64'), fileName = `preview-${name}.png`;
  const file = new File([bytes], fileName, { type: 'image/png' });
  const saved = await savePrivateDocumentFile({ file, clientId: f.clientId, fileName });
  const doc = await db.document.create({ data: { ...saved, fileName, mimeType: 'image/png', type: 'image/png',
    title: `Anteprima sintetica ${name}`, serviceArea: 'contratti', clientId: f.clientId, projectId: f.projectId, status: 'verificato', uploadedById: f.userId } });
  await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: doc.storagePath, checksum: doc.checksum } });
  await page.goto(`/clients/${f.clientId}#documenti`);
  const link = page.locator(`#documenti a[href="/documents/${doc.id}/view"]`);
  await expect(link).toHaveText('Visualizza');
  const popupPromise = context.waitForEvent('page'); await link.click(); const viewer = await popupPromise;
  // A new tab starts with the context viewport, not page.setViewportSize().
  await viewer.setViewportSize({ width, height });
  await viewer.waitForLoadState('load');
  await expect(viewer.locator('img')).toBeVisible();
  await expect.poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 600 && img.naturalHeight === 240)).toBe(true);
  expect(viewer.viewportSize()).toEqual({ width, height });
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await viewer.screenshot({ path: join(root, `private-document-view-${name}.png`), fullPage: true });
  const viewed = await page.request.get(`/documents/${doc.id}/view`); expect(viewed.status()).toBe(200);
  expect(await viewed.body()).toEqual(bytes);
  expect(await db.auditLog.count({ where: { actorId: f.userId, entityId: doc.id, event: 'document_view' } })).toBeGreaterThanOrEqual(2);
  expect(await db.auditLog.count({ where: { actorId: f.userId, entityId: doc.id, event: 'document_download' } })).toBe(0);
  await db.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
  const denied = await viewer.reload(); expect(denied?.status()).toBe(404); await expect(viewer.locator('img')).toHaveCount(0);
  await viewer.close();
});
for (const f of fixture.fixtures.filter(f => !f.denied)) test(`${f.role}: real lists, details, HTML, report and versioned downloads obey the ceiling`, async ({ page }) => {
  await login(page, f.role);
  const financial = ['admin', 'amministrazione'].includes(f.role);
  const progress = await page.goto(`/progress?client=${f.clientId}`); expect(progress?.status()).toBe(200);
  const progressHtml = await progress!.text();
  expect(progressHtml.includes(`data-progress-contract="${f.contractId}"`)).toBe(financial);
  if (!financial) {
    expect(progressHtml).not.toContain(f.contractId); expect(progressHtml).not.toContain(f.paymentId);
    expect(progressHtml).not.toContain(`CONTRACT_SECRET_${f.role}`); expect(progressHtml).not.toContain(`PAYMENT_SECRET_${f.role}`);
    expect(progressHtml).not.toContain('pagato');
  }
  for (const document of f.docs) {
    const expected = financial || document.kind === 'ordinary' ? 200 : 403;
    for (const suffix of ['', `?versionId=${document.versionId}`]) {
      const response = await page.request.get(`/documents/${document.id}/download${suffix}`);
      expect(response.status(), `${f.role}/${document.kind}${suffix}`).toBe(expected);
      if (expected === 200) expect(response.headers()['content-disposition']).toContain('attachment');
      const view = await page.request.get(`/documents/${document.id}/view${suffix}`);
      expect(view.status(), `${f.role}/inline/${document.kind}${suffix}`).toBe(expected === 200 && document.kind === 'archive' ? 415 : expected);
      if (view.status() === 200) {
        expect(view.headers()['content-disposition']).toContain('inline');
        expect(view.headers()['content-type']).toBe('application/pdf');
        expect(view.headers()['cache-control']).toContain('no-store');
        expect(view.headers()['content-security-policy']).toContain('sandbox');
        expect(await view.body()).toEqual(await response.body());
      }
    }
  }
  for (const route of [`/clients/${f.clientId}`, '/documents', `/search?q=${encodeURIComponent(f.docs[0].title)}`]) {
    const response = await page.goto(route); expect(response?.status()).toBe(200);
    const html = await response!.text();
    await expect(page.getByText(f.docs[0].title, { exact: false }).first()).toBeVisible();
    if (!financial) {
      for (const doc of f.docs.filter(x => x.kind !== 'ordinary')) expect(html).not.toContain(doc.title);
      expect(html).not.toContain(`PRIVATE_NOTE_${f.role}`);
      expect(html).not.toContain(`CONTRACT_SECRET_${f.role}`);
      expect(html).not.toContain(`PAYMENT_SECRET_${f.role}`);
    }
  }
  for (const document of f.docs.filter(x => x.kind !== 'ordinary')) {
    // Search each exact filename, so the result limit cannot hide a leaked row.
    const query = `${document.kind}-${f.role}.${document.kind === 'archive' ? 'zip' : 'pdf'}`;
    const response = await page.goto(`/search?q=${encodeURIComponent(query)}`);
    expect(response?.status()).toBe(200);
    if (financial) await expect(page.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
    else expect(await response!.text()).not.toContain(document.title);
  }
  for (const route of [`/contracts/${f.contractId}`, '/contracts', '/payments', '/audit-log']) {
    await page.goto(route);
    if (!financial) { expect(new URL(page.url()).pathname).toBe('/dashboard'); expect(await page.content()).not.toContain(`CONTRACT_SECRET_${f.role}`); }
    else expect(new URL(page.url()).pathname).toBe(route);
  }
  const report = await page.request.get(`/clients/${f.clientId}/operational-report`); expect(report.status()).toBe(200);
  if (!financial) {
    const text = await report.text();
    for (const doc of f.docs.filter(x => x.kind !== 'ordinary')) expect(text).not.toContain(doc.title);
    expect(text).not.toContain(`PRIVATE_NOTE_${f.role}`); expect(text).not.toContain('pagato');
  }
  const beforeHold = await db.client.findUniqueOrThrow({ where: { id: f.clientId } });
  await db.client.update({ where: { id: f.clientId }, data: { status: 'sospeso' } });
  try {
    const response = await page.goto(`/clients/${f.clientId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText('Operatività sospesa. Rivolgiti al responsabile per la verifica interna.', { exact: true })).toBeVisible();
    if (!financial) {
      const html = await response!.text();
      for (const marker of [f.contractId, f.paymentId, `CONTRACT_SECRET_${f.role}`, `PAYMENT_SECRET_${f.role}`, 'in attesa di pagamento verificato']) expect(html).not.toContain(marker);
    }
  } finally {
    await db.client.update({ where: { id: f.clientId }, data: { status: beforeHold.status } });
  }
});

for (const f of fixture.fixtures.filter(f => f.denied)) test(`${f.key}: individual deny applies to HTML, exports, handoff and both download routes`, async ({ page }) => {
  await login(page, f.key);
  const canReadContract = f.role === 'amministrazione' && f.denied !== 'contract.read';
  const canReadPayment = f.role === 'amministrazione' && f.denied !== 'payment.read';
  const progress = await page.goto(`/progress?client=${f.clientId}`); expect(progress?.status()).toBe(200);
  const progressHtml = await progress!.text();
  expect(progressHtml.includes(`data-progress-contract="${f.contractId}"`)).toBe(canReadContract);
  if (!canReadContract) expect(progressHtml).not.toContain(f.contractId);
  if (!canReadPayment) { expect(progressHtml).not.toContain('pagato'); expect(progressHtml).not.toContain('Pagamenti:'); }
  const permitted = (kind: string) => kind === 'ordinary' || (['signed', 'labelled'].includes(kind) && canReadContract) || (kind === 'paid' && canReadPayment);
  for (const doc of f.docs) {
    for (const suffix of ['', `?versionId=${doc.versionId}`]) {
      expect((await page.request.get(`/documents/${doc.id}/download${suffix}`)).status(), `${f.key}/${doc.kind}${suffix}`).toBe(permitted(doc.kind) ? 200 : 403);
    }
  }
  for (const path of [`/clients/${f.clientId}`, '/documents', `/search?q=${encodeURIComponent(f.key)}`]) {
    const response = await page.goto(path); expect(response?.status()).toBe(200);
    const html = await response!.text();
    expect(html).toContain(f.docs.find(d => d.kind === 'ordinary')!.title);
    for (const doc of f.docs.filter(d => !permitted(d.kind))) expect(html).not.toContain(doc.title);
    expect(html).not.toContain(`PRIVATE_NOTE_${f.key}`);
    if (!canReadContract) expect(html).not.toContain(`CONTRACT_SECRET_${f.key}`);
    if (!canReadPayment) expect(html).not.toContain(`PAYMENT_SECRET_${f.key}`);
  }
  const report = await page.request.get(`/clients/${f.clientId}/operational-report`);
  expect(report.status()).toBe(200);
  const reportText = await report.text();
  expect(reportText).toContain(f.docs.find(d => d.kind === 'ordinary')!.title);
  for (const doc of f.docs.filter(d => !permitted(d.kind))) expect(reportText).not.toContain(doc.title);
  if (!canReadPayment) expect(reportText).not.toContain('pagato');
  const handoff = await page.goto(`/services/${f.serviceId}/handoff`); expect(handoff?.status()).toBe(200);
  const handoffHtml = await handoff!.text();
  expect(handoffHtml).toContain('Verifica tecnica sintetica');
  expect(handoffHtml.includes(`SERVICE_SCOPE_${f.key}`)).toBe(canReadContract);
  for (const kind of ['signed', 'paid']) {
    const doc = f.docs.find(d => d.kind === kind)!;
    expect(handoffHtml.includes(`/documents/${doc.id}/download`)).toBe(permitted(kind));
    if (!permitted(kind)) expect(handoffHtml).not.toContain(doc.id);
  }
});

test('admin selects three files once, including ZIP and a PDF larger than 1 MB; each persists with a version and audit', async ({ page }) => {
  await login(page, 'admin'); await page.goto('/documents');
  const admin = fixture.fixtures.find(x => x.role === 'admin')!;
  const form = page.locator('form').filter({ has: page.locator('input[type="file"]') }).first();
  await form.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await form.locator('select[name="clientId"]').selectOption(admin.clientId);
  const files = [
    { name: 'multi-synthetic-large.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024, 32), Buffer.from('\n%%EOF')]) },
    { name: 'multi-synthetic-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic batch note') },
    { name: 'multi-synthetic-archive.zip', mimeType: 'application/zip', buffer: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') },
  ];
  await form.locator('input[type="file"]').setInputFiles(files);
  await expect(form.getByRole('list', { name: 'Esito caricamenti' })).toContainText('multi-synthetic-archive.zip: Pronto');
  await form.getByRole('button', { name: 'Carica in storage privato' }).click();
  for (const file of files) await expect(page.getByRole('list', { name: 'Esito caricamenti' }).getByText(`${file.name}: Caricato`, { exact: true })).toBeVisible();
  for (const file of files) {
    const docs = await db.document.findMany({ where: { clientId: admin.clientId, fileName: file.name } }); expect(docs).toHaveLength(1);
    expect(await db.documentVersion.count({ where: { documentId: docs[0].id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: docs[0].id, event: 'document_upload' } })).toBe(1);
    if (file.name.endsWith('.zip')) expect(docs[0].documentCategory).toBe('archivio_riservato');
    const download = await page.request.get(`/documents/${docs[0].id}/download`); expect(download.status()).toBe(200); expect(await download.body()).toEqual(file.buffer);
  }
  writeFileSync(join(root, 'upload-browser-proof.json'), JSON.stringify({ synthetic: true, multipleFiles: 3, zipRetainedWithoutExtraction: true, largeFile: true, versionsAndAudits: true }));
});

test('an excluded role cannot upload an archive even with document.upload and its own assigned context', async ({ page }) => {
  await login(page, 'consulente'); await page.goto('/documents');
  const f = fixture.fixtures.find(x => x.role === 'consulente')!;
  const form = page.locator('form').filter({ has: page.locator('input[type="file"]') }).first();
  await form.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await form.locator('select[name="clientId"]').selectOption(f.clientId);
  await form.locator('input[type="file"]').setInputFiles({ name: 'denied-archive.zip', mimeType: 'application/zip', buffer: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') });
  await form.getByRole('button', { name: 'Carica in storage privato' }).click();
  await expect(page.getByRole('list', { name: 'Esito caricamenti' })).toContainText('Risorsa non disponibile');
  expect(await db.document.count({ where: { clientId: f.clientId, fileName: 'denied-archive.zip' } })).toBe(0);
});

test('practice upload retains exact context and ordinary technician opens the file without a selective grant; revocation wins', async ({ browser }) => {
  const admin = fixture.fixtures.find(f => f.role === 'admin' && !f.denied)!;
  const tech = fixture.fixtures.find(f => f.role === 'consulente' && !f.denied)!;
  const ac = await browser.newContext(), tc = await browser.newContext(), other = await browser.newContext();
  const a = await ac.newPage(), t = await tc.newPage(), o = await other.newPage();
  const practice = await db.technicalPractice.create({ data: { clientId: tech.clientId, projectId: tech.projectId,
    clientServiceId: tech.serviceId, title: 'Contesto documentale sintetico', practiceType: 'synthetic', targetEntity: 'synthetic',
    technicalOwnerId: tech.userId, createdById: admin.userId } });
  try {
    await login(a, admin.key); await login(t, tech.key); await login(o, 'backoffice');
    await a.goto(`/projects/${tech.projectId}/technical-handoff`);
    await expect(a.getByRole('heading', { name: 'Documenti per il lavoro tecnico', exact: true })).toBeVisible();
    await expect(a.getByRole('link', { name: 'Carica documenti per il progetto', exact: true })).toHaveAttribute('href', `/documents/new?clientId=${tech.clientId}&projectId=${tech.projectId}`);
    await documentContextScreens(a, 'document-handoff');
    await a.goto(`/technical-office/practices/${practice.id}`);
    await a.getByRole('link', { name: 'Carica documenti per questa pratica', exact: true }).click();
    await expect(a.getByRole('heading', { name: 'Carica documenti nel contesto', exact: true })).toBeVisible();
    const form = a.locator('form').filter({ has: a.locator('input[type=file]') });
    await form.locator('[data-interactive-ready=true]').waitFor({ state: 'attached' });
    await expect(form.locator('[name=clientId]')).toHaveValue(tech.clientId);
    await expect(form.getByRole('combobox', { name: 'Progetto del documento', exact: true })).toHaveValue(tech.projectId);
    await expect(form.getByRole('combobox', { name: 'Servizio del documento', exact: true })).toHaveValue(tech.serviceId);
    await documentContextScreens(a, 'document-context-upload');
    const file = { name: 'ordinary-practice-context.txt', mimeType: 'text/plain', buffer: Buffer.from('Documento tecnico sintetico collegato esattamente alla pratica') };
    await form.locator('input[type=file]').setInputFiles(file);
    await form.getByRole('button', { name: 'Carica in storage privato', exact: true }).click();
    await expect(a.getByRole('list', { name: 'Esito caricamenti' })).toContainText(`${file.name}: Caricato`);
    const docs = await db.document.findMany({ where: { fileName: file.name, clientId: tech.clientId } }); expect(docs).toHaveLength(1);
    const doc = docs[0]; expect(doc.projectId).toBe(tech.projectId); expect(doc.clientServiceId).toBe(tech.serviceId);
    expect(await db.documentVersion.count({ where: { documentId: doc.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: doc.id, event: 'document_upload' } })).toBe(1);
    await t.goto(`/technical-office/practices/${practice.id}`);
    const view = t.locator(`a[href="/documents/${doc.id}/view"]`); await expect(view).toBeVisible();
    const opened = tc.waitForEvent('page'); await view.click(); const viewer = await opened;
    await expect(viewer.locator('body')).toContainText(file.buffer.toString());
    const download = await t.request.get(`/documents/${doc.id}/download`);
    expect(download.status()).toBe(200); expect(await download.body()).toEqual(file.buffer);
    for (const intent of ['view', 'download']) {
      const denied = await o.request.get(`/documents/${doc.id}/${intent}`);
      expect(denied.status()).toBe(403); expect(await denied.text()).toBe('Documento non disponibile');
      expect(denied.headers()['cache-control']).toContain('no-store');
    }
    const before = await db.auditLog.count({ where: { actorId: tech.userId, entityId: doc.id, event: { in: ['document_view', 'document_download'] } } });
    await db.userPermissionOverride.update({ where: { userId_permission: { userId: tech.userId, permission: 'document.download' } }, data: { allowed: false } });
    expect((await viewer.reload())?.status()).toBe(403);
    await expect(viewer.locator('body')).toHaveText('Documento non disponibile');
    const revokedDownload = await t.request.get(`/documents/${doc.id}/download`);
    expect(revokedDownload.status()).toBe(403); expect(await revokedDownload.text()).toBe('Documento non disponibile');
    expect(revokedDownload.headers()['cache-control']).toContain('no-store');
    expect(await db.auditLog.count({ where: { actorId: tech.userId, entityId: doc.id, event: { in: ['document_view', 'document_download'] } } })).toBe(before);
    await viewer.close();
    writeFileSync(join(root, 'document-context-ordinary-proof.json'), JSON.stringify({ synthetic: true, exactContext: true, persistedOnce: true,
      versionAndAuditOnce: true, nativeTechnicianPreview: true, exactDownloadBytes: true, otherTechnicianDenied: true, openSessionRevocation: true, newSelectiveGrants: 0 }));
  } finally {
    await db.userPermissionOverride.update({ where: { userId_permission: { userId: tech.userId, permission: 'document.download' } }, data: { allowed: true } });
    await ac.close(); await tc.close(); await other.close();
  }
});

test('commercial upload uses existing capability and own client only; revoked capability stops an already open form', async ({ page }) => {
  const sales = fixture.fixtures.find(f => f.role === 'commerciale' && !f.denied)!;
  const foreign = fixture.fixtures.find(f => f.role === 'backoffice' && !f.denied)!;
  await login(page, sales.key); await page.goto(`/clients/${sales.clientId}#documenti`);
  const dossier = page.locator('#documenti');
  await expect(dossier.getByRole('combobox', { name: 'Progetto del documento', exact: true }).locator('option')).toHaveCount(1);
  await expect(dossier.getByRole('combobox', { name: 'Servizio del documento', exact: true }).locator('option')).toHaveCount(1);
  const own = `/documents/new?clientId=${sales.clientId}`;
  await page.goto(own);
  const form = page.locator('form').filter({ has: page.locator('input[type=file]') });
  await form.locator('[data-interactive-ready=true]').waitFor({ state: 'attached' });
  await expect(form.getByRole('combobox', { name: 'Progetto del documento', exact: true }).locator('option')).toHaveCount(1);
  await expect(form.getByRole('combobox', { name: 'Servizio del documento', exact: true }).locator('option')).toHaveCount(1);
  await documentContextScreens(page, 'commercial-owned-document-context');
  const file = { name: 'commercial-own-client.txt', mimeType: 'text/plain', buffer: Buffer.from('Documento sintetico del solo cliente commerciale') };
  await form.locator('input[type=file]').setInputFiles(file); await form.getByRole('button', { name: 'Carica in storage privato', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Esito caricamenti' })).toContainText(`${file.name}: Caricato`);
  const docs = await db.document.findMany({ where: { clientId: sales.clientId, fileName: file.name } }); expect(docs).toHaveLength(1);
  expect(docs[0].projectId).toBeNull(); expect(docs[0].clientServiceId).toBeNull();
  expect(await db.auditLog.count({ where: { entityId: docs[0].id, event: 'document_upload' } })).toBe(1);
  for (const query of [`clientId=${foreign.clientId}`, `clientId=${sales.clientId}&projectId=${foreign.projectId}`, `clientId=${sales.clientId}&projectId=${sales.projectId}`]) {
    const denied = await page.goto('/documents/new?' + query); expect(denied?.status()).toBe(404);
    await expect(page.locator('input[type=file]')).toHaveCount(0);
    expect(await page.content()).not.toContain(`Synthetic privacy ${foreign.key}`);
  }
  await page.goto(own); await form.locator('[data-interactive-ready=true]').waitFor({ state: 'attached' });
  await form.locator('input[type=file]').setInputFiles({ ...file, name: 'revoked-commercial-upload.txt' });
  const before = await db.document.count({ where: { clientId: sales.clientId } });
  try {
    await db.userPermissionOverride.update({ where: { userId_permission: { userId: sales.userId, permission: 'document.upload' } }, data: { allowed: false } });
    await form.getByRole('button', { name: 'Carica in storage privato', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Esito caricamenti' })).toContainText('Risorsa non disponibile');
    expect(await db.document.count({ where: { clientId: sales.clientId } })).toBe(before);
    expect(await db.auditLog.count({ where: { actorId: sales.userId, event: 'document_upload', entityId: { not: docs[0].id } } })).toBe(0);
  } finally {
    await db.userPermissionOverride.update({ where: { userId_permission: { userId: sales.userId, permission: 'document.upload' } }, data: { allowed: true } });
  }
  writeFileSync(join(root, 'document-context-commercial-proof.json'), JSON.stringify({ synthetic: true, existingPermissionOverride: true,
    ownClientUpload: true, noProjectWriteGranted: true, foreignContextDenied: true, openFormRevocation: true }));
});

async function technicalFootprint(clientId: string) {
  const practices = await db.technicalPractice.findMany({ where: { clientId }, orderBy: { id: 'asc' } });
  const audits = await db.auditLog.findMany({ where: { entityId: { in: practices.map(p => p.id) } }, orderBy: { id: 'asc' } });
  return { practices, audits };
}

for (const role of ['admin', 'consulente']) for (const action of ['create', 'edit', 'status'] as const) {
  test(`P2-01 ${role}: real ${action} action on a page opened before suspension preserves rows and audit`, async ({ page }) => {
    const f = fixture.fixtures.find(item => item.role === role && !item.denied)!;
    await login(page, role);
    const practice = await db.technicalPractice.create({ data: { clientId: f.clientId, title: `Synthetic held ${role} ${action}`, practiceType: 'synthetic', targetEntity: 'synthetic', technicalOwnerId: f.userId, createdById: f.userId } });
    await page.goto(action === 'create' ? '/technical-office/practices?new=1' : `/technical-office/practices/${practice.id}`);
    const buttonName = action === 'create' ? 'Crea pratica' : action === 'edit' ? 'Salva dati' : 'Salva stato';
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: buttonName, exact: true }) });
    await expect(form).toBeVisible();
    if (action === 'create') {
      await form.locator('[name="clientId"]').selectOption(f.clientId);
      await form.locator('[name="title"]').fill(`Forbidden held creation ${role}`);
      await form.locator('[name="practiceType"]').fill('synthetic');
      await form.locator('[name="targetEntity"]').fill('synthetic');
    }
    if (action === 'status') await form.locator('[name="status"]').selectOption('presentata');
    else {
      // Exercise the actual server action with an explicitly supplied status,
      // including the creation/edit forms that do not normally render it.
      await form.evaluate(node => { const field = document.createElement('input'); field.type = 'hidden'; field.name = 'status'; field.value = 'presentata'; node.appendChild(field); });
    }
    // The browser already holds the form; only the authoritative DB changes.
    await db.client.update({ where: { id: f.clientId }, data: { status: 'sospeso' } });
    const before = await technicalFootprint(f.clientId);
    try {
      // Capture inside the page before Next consumes the error and navigates.
      // Chromium can discard Network.getResponseBody even in its response event.
      // The native fetch runs exactly once; its request and returned response are
      // unchanged. Read only a clone, without mocking or replaying the action.
      const captured: { status: number; body: string }[] = [];
      await page.exposeFunction('__captureHeldClientAction', (response: { status: number; body: string }) => { captured.push(response); });
      await page.evaluate(() => {
        const nativeFetch = window.fetch.bind(window);
        const capture = (window as unknown as { __captureHeldClientAction: (response: { status: number; body: string }) => Promise<void> }).__captureHeldClientAction;
        window.fetch = async (input, init) => {
          const response = await nativeFetch(input, init);
          const request = input instanceof Request ? input : undefined;
          const headers = new Headers(init?.headers ?? request?.headers);
          if ((init?.method ?? request?.method ?? 'GET').toUpperCase() === 'POST' && headers.has('next-action')) {
            await capture({ status: response.status, body: await response.clone().text() });
          }
          return response;
        };
      });
      let actionRequests = 0;
      page.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) actionRequests += 1; });
      await form.getByRole('button', { name: buttonName, exact: true }).click();
      await expect.poll(() => captured.length).toBe(1);
      expect(actionRequests).toBe(1);
      const response = captured[0];
      expect(response.status).toBe(500);
      expect(await technicalFootprint(f.clientId)).toEqual(before);
      // Check the actual RSC denial and guard, independently of Chromium's
      // accented-text representation in the development error envelope.
      const failureLine = response.body.split('\n').find(line => /^[0-9a-f]+:E\{/.test(line));
      expect(failureLine).toBeTruthy();
      const failure = JSON.parse(failureLine!.slice(failureLine!.indexOf('{'))) as { name: string; message: string; stack: Array<[string, ...unknown[]]> };
      expect(failure.name).toBe('UserFacingActionError');
      expect(failure.message).toContain('sospesa. Rivolgiti al responsabile per la verifica interna.');
      expect(failure.stack.some(frame => frame[0].trim() === 'assertTechnicalPracticeOperational')).toBe(true);
    } finally { await db.client.update({ where: { id: f.clientId }, data: { status: 'attivo' } }); }
  });
}

test('P2-01 real preparation, ordinary preparation edit and stopping actions remain available during hold', async ({ page }) => {
  const f = fixture.fixtures.find(item => item.role === 'admin')!;
  await login(page, 'admin');
  await db.client.update({ where: { id: f.clientId }, data: { status: 'sospeso' } });
  try {
    await page.goto('/technical-office/practices?new=1');
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Crea pratica', exact: true }) });
    await form.locator('[name="clientId"]').selectOption(f.clientId);
    await form.locator('[name="title"]').fill('Synthetic preparation during hold');
    await form.locator('[name="practiceType"]').fill('synthetic');
    await form.locator('[name="targetEntity"]').fill('synthetic');
    await form.getByRole('button', { name: 'Crea pratica', exact: true }).click();
    await expect(page).toHaveURL(/\/technical-office\/practices\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    expect((await db.technicalPractice.findUniqueOrThrow({ where: { id } })).status).toBe('da_progettare');
    const edit = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva dati', exact: true }) });
    await edit.locator('[name="title"]').fill('Synthetic preparation edited during hold');
    let pending = page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action']));
    await edit.getByRole('button', { name: 'Salva dati', exact: true }).click();
    expect((await pending).status()).toBe(200);
    expect((await db.technicalPractice.findUniqueOrThrow({ where: { id } })).title).toBe('Synthetic preparation edited during hold');
    for (const status of ['respinta', 'archiviata']) {
      await page.goto(`/technical-office/practices/${id}`);
      const stateForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva stato', exact: true }) });
      await stateForm.locator('[name="status"]').selectOption(status);
      pending = page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action']));
      await stateForm.getByRole('button', { name: 'Salva stato', exact: true }).click();
      expect((await pending).status()).toBe(200);
      expect((await db.technicalPractice.findUniqueOrThrow({ where: { id } })).status).toBe(status);
    }
    expect(await db.auditLog.count({ where: { entityId: id, event: 'technical_practice_create' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: id, event: 'technical_practice_update' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: id, event: 'technical_practice_status_change' } })).toBe(2);
  } finally { await db.client.update({ where: { id: f.clientId }, data: { status: 'attivo' } }); }
});


test('open financial session loses contracts, payment bytes and metadata immediately after role changes to Direzione', async ({ page }) => {
  const f = fixture.fixtures.find(item => item.role === 'amministrazione' && !item.denied)!;
  await login(page, f.key);
  await page.goto(`/contracts/${f.contractId}`);
  await expect(page).toHaveURL(new RegExp(`/contracts/${f.contractId}$`));
  const protectedDocs = f.docs.filter(doc => doc.kind !== 'ordinary');
  for (const doc of protectedDocs) expect((await page.request.get(`/documents/${doc.id}/download`)).status()).toBe(200);
  await db.user.update({ where: { id: f.userId }, data: { role: 'direzione' } });
  try {
    const auditFilter = { actorId: f.userId, event: { in: ['document_download', 'document_view', 'document_sensitive_access'] }, entityId: { in: protectedDocs.map(doc => doc.id) } };
    const before = await db.auditLog.count({ where: auditFilter });
    for (const doc of protectedDocs) for (const suffix of ['', `?versionId=${doc.versionId}`]) {
      expect((await page.request.get(`/documents/${doc.id}/download${suffix}`)).status()).toBe(403);
      expect((await page.request.get(`/documents/${doc.id}/view${suffix}`)).status()).toBe(403);
    }
    expect(await db.auditLog.count({ where: auditFilter })).toBe(before);
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const path of ['/contracts', '/payments', '/audit-log']) {
      await page.goto(path); await expect(page).toHaveURL(/\/dashboard$/);
    }
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      const response = await page.goto(`/clients/${f.clientId}`);
      expect(response?.status()).toBe(200);
      const html = await response!.text();
      for (const doc of protectedDocs) expect(html).not.toContain(doc.title);
      expect(html).not.toContain(`CONTRACT_SECRET_${f.key}`);
      expect(html).not.toContain(`PAYMENT_SECRET_${f.key}`);
      const ordinary = f.docs.find(doc => doc.kind === 'ordinary')!;
      await expect(page.getByText(ordinary.title, { exact: false }).first()).toBeVisible();
      expect((await page.request.get(`/documents/${ordinary.id}/download`)).status()).toBe(200);
      if (name === 'mobile') {
        const documents = page.locator('#documenti');
        const scroller = documents.getByLabel('Tabella scorrevole orizzontalmente');
        await scroller.scrollIntoViewIfNeeded();
        await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await expect(documents.getByRole('link', { name: 'Scarica', exact: true })).toBeInViewport();
        await documents.getByRole('link', { name: 'Scarica', exact: true }).click({ trial: true });
        await scroller.evaluate(element => { element.scrollLeft = 0; });
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      expect(layout.width).toBeLessThanOrEqual(layout.viewport + 1);
      writeFileSync(join(root, `direzione-operational-${name}-layout.json`), JSON.stringify(layout));
      await page.screenshot({ path: join(root, `direzione-operational-${name}.png`), fullPage: true });
    }
    writeFileSync(join(root, 'financial-ceiling-session-proof.json'), JSON.stringify({ synthetic: true, roleChangedWithoutNewLogin: true, currentAndVersionedDownloadsDenied: true, deniedDownloadAuditUnchanged: true, ordinaryDocumentPreserved: true }));
  } finally { await db.user.update({ where: { id: f.userId }, data: { role: 'amministrazione' } }); }
});
