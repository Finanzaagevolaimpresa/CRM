import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), root = process.env.FINANCIAL_PRIVACY_EVIDENCE!, password = process.env.FINANCIAL_PRIVACY_BROWSER_PASSWORD!;
type Fixture = { role: string; userId: string; clientId: string; projectId: string; serviceId: string; contractId: string; paymentId: string; docs: { kind: string; id: string; versionId: string; title: string }[] };
const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')) as { synthetic: boolean; fixtures: Fixture[]; overrideDelegationDenied: boolean };
async function login(page: Page, role: string) {
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(`privacy-${role}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.beforeAll(async () => { await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.FINANCIAL_PRIVACY_BROWSER_CONFIRMED).toBe('1'); expect(fixture.synthetic).toBe(true); expect(fixture.overrideDelegationDenied).toBe(true); });
test.afterAll(async () => { await db.$disconnect(); });
for (const f of fixture.fixtures) test(`${f.role}: real lists, details, HTML, report and versioned downloads obey the ceiling`, async ({ page }) => {
  await login(page, f.role);
  const financial = ['admin', 'amministrazione', 'direzione'].includes(f.role);
  for (const document of f.docs) {
    const expected = financial || document.kind === 'ordinary' ? 200 : 403;
    for (const suffix of ['', `?versionId=${document.versionId}`]) {
      const response = await page.request.get(`/documents/${document.id}/download${suffix}`);
      expect(response.status(), `${f.role}/${document.kind}${suffix}`).toBe(expected);
      if (expected === 200) expect(response.headers()['content-disposition']).toContain('attachment');
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
