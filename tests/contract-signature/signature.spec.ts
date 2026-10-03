import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), root = process.env.CONTRACT_SIGNATURE_EVIDENCE!, password = process.env.CONTRACT_SIGNATURE_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
test.afterAll(async () => { await db.$disconnect(); });
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) console.log('Synthetic CRM page at failure:', await page.locator('body').innerText());
});

test('lost upload response and exact HTTP replay reconcile to the same saved document', async ({ page, context }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const client = await db.client.create({ data: { displayName: 'Synthetic uncertain upload', type: 'societa' } });
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill('signature-admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/clients/${client.id}`);
  const upload = page.locator('#documenti form');
  await upload.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await upload.locator('input[name="file"]').setInputFiles({ name: 'uncertain-synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic uncertainty checkpoint\n%%EOF\n') });
  await upload.locator('input[name="title"]').fill('Synthetic uncertain document');
  await upload.locator('select[name="serviceArea"]').selectOption('contratti');
  await upload.locator('input[name="documentCategory"]').fill('contratti');
  await upload.locator('input[name="containsSensitiveData"]').check();
  let interrupted = false;
  await page.route(`**/clients/${client.id}`, async route => {
    if (!interrupted && route.request().method() === 'POST' && route.request().headers()['next-action']) {
      interrupted = true;
      const response = await route.fetch(); expect(response.status()).toBe(200);
      // Identical HTTP replay after commit must reconcile, even before reopening.
      const replay = await route.fetch(); expect(replay.status()).toBe(200);
      expect(await replay.text()).toContain('\"ok\":true');
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await upload.getByRole('button', { name: 'Carica', exact: true }).click();
  await expect(upload.getByRole('list', { name: 'Esito caricamenti' })).toContainText('Esito non confermato');
  expect(interrupted).toBe(true);
  const document = await db.document.findFirstOrThrow({ where: { clientId: client.id, title: 'Synthetic uncertain document' } });
  const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: document.id } });
  await page.close(); page = await context.newPage();
  await page.goto(`/clients/${client.id}`);
  await expect(page.locator('#documenti table').getByRole('row').filter({ hasText: 'Synthetic uncertain document' })).toHaveCount(1);
  expect((await page.request.get(`/documents/${document.id}/download?versionId=${version.id}`)).status()).toBe(200);
  expect(await db.document.count({ where: { clientId: client.id } })).toBe(1);
  expect(await db.documentVersion.count({ where: { documentId: document.id } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: document.id, event: 'document_upload' } })).toBe(1);
  await page.screenshot({ path: join(root, 'uncertain-upload-reconciled.png'), fullPage: true });
  writeFileSync(join(root, 'uncertain-upload-proof.json'), JSON.stringify({ synthetic: true, responseDiscardedAfterCommit: true,
    clientId: client.id, documentId: document.id, versionId: version.id, reopened: true, resendCount: 0, documents: 1, versions: 1, successfulAudits: 1 }));
});
test('declared signature survives reopening, then an existing signed document is linked while payment stays pending', async ({ page, context }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); expect(process.env.CONTRACT_SIGNATURE_DB_CONFIRMED).toBe('1'); expect(f.synthetic).toBe(true);
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill('signature-admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click(); await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/contracts/${f.contractId}`);
  const declaration = page.locator('form').filter({ has: page.getByRole('button', { name: 'Salva dichiarazione da verificare' }) });
  await declaration.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await declaration.getByLabel('Data della firma dichiarata').fill('2026-01-01');
  await declaration.getByLabel('Fonte della dichiarazione').fill('Comunicazione sintetica del cliente del 2 gennaio; PDF non ancora acquisito');
  await declaration.getByRole('checkbox').check();
  await declaration.getByRole('button', { name: 'Salva dichiarazione da verificare' }).click();
  await expect(page.getByText('Dichiarazione corrente — da verificare sul documento')).toBeVisible();
  const beforeUpload = await db.contract.findUniqueOrThrow({ where: { id: f.contractId } });
  expect(beforeUpload.status).toBe('da_preparare'); expect(beforeUpload.signedAt).toBeNull();
  expect(await db.document.count({ where: { clientId: f.clientId } })).toBe(0);
  await page.screenshot({ path: join(root, 'declaration-before-upload.png'), fullPage: true });
  await page.close(); page = await context.newPage();
  await page.goto(`/contracts/${f.contractId}`);
  await expect(page.getByText('Dichiarazione corrente — da verificare sul documento')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri documenti del cliente' })).toBeVisible();
  await page.getByRole('link', { name: 'Apri documenti del cliente' }).click();
  const upload = page.locator('#documenti form');
  await upload.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await upload.locator('input[name="file"]').setInputFiles({ name: 'synthetic-signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n') });
  await upload.locator('input[name="title"]').fill('Synthetic signed contract');
  await upload.locator('select[name="serviceArea"]').selectOption('contratti');
  await upload.locator('input[name="documentCategory"]').fill('contratti');
  await upload.locator('input[name="containsSensitiveData"]').check();
  await upload.getByRole('button', { name: 'Carica', exact: true }).click();
  await expect(upload.getByRole('list', { name: 'Esito caricamenti' })).toContainText('synthetic-signed.pdf: Caricato');
  // The document cell contains both its title and nested file-name text.
  const uploadedRow = page.locator('#documenti table').getByRole('row').filter({ hasText: 'Synthetic signed contract' });
  await expect(uploadedRow).toHaveCount(1);
  await expect(uploadedRow.getByRole('link', { name: 'Scarica', exact: true })).toBeVisible();
  await page.close(); page = await context.newPage();
  await page.goto(`/contracts/${f.contractId}`);
  const document = await db.document.findFirstOrThrow({ where: { clientId: f.clientId, title: 'Synthetic signed contract' } });
  const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: document.id } });
  await page.getByLabel('Documento firmato *', { exact: true }).selectOption(version.id);
  await page.getByLabel('Data della firma *', { exact: true }).fill('2026-01-01');
  await page.getByRole('checkbox', { name: 'Confermo che il documento selezionato è il contratto già firmato da collegare a questa scheda.' }).check();
  await page.screenshot({ path: join(root, 'signature-before.png'), fullPage: true });
  await page.getByRole('button', { name: 'Registra firma già acquisita', exact: true }).click();
  await expect(page.getByText('La firma è registrata. Il pagamento si verifica separatamente nella sezione Pagamenti.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registra firma già acquisita', exact: true })).toHaveCount(0);
  const saved = await db.contract.findUniqueOrThrow({ where: { id: f.contractId } });
  expect(saved.status).toBe('firmato'); expect(saved.signedDocumentId).toBe(document.id);
  expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).status).toBe('da_incassare');
  expect(await db.auditLog.count({ where: { entityId: f.contractId, event: 'contract_signature_recorded' } })).toBe(1);
  expect(await db.practiceReadiness.count({ where: { clientId: f.clientId } })).toBe(0);
  await page.screenshot({ path: join(root, 'signature-after.png'), fullPage: true });
  writeFileSync(join(root, 'browser-proof.json'), JSON.stringify({ synthetic: true, contractId: f.contractId, documentId: document.id, versionId: version.id,
    explicitDeclaration: true, declarationDidNotSign: true, reopenedBeforeUpload: true, reopenedAfterUpload: true,
    realDocumentUpload: true, signatureLinked: true, paymentStillPending: true, oneAudit: true, noPracticeStarted: true }));
});
