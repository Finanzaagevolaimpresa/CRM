import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient(), root = process.env.CONTRACT_SIGNATURE_EVIDENCE!, password = process.env.CONTRACT_SIGNATURE_BROWSER_PASSWORD!;
const f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
test.afterAll(async () => { await db.$disconnect(); });
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) console.log('Synthetic CRM page at failure:', await page.locator('body').innerText());
});

async function loginProgressReader(page: Page, email = 'signature-admin@example.test') {
  await page.goto('/login');
  await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login interno' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('progress omits contracts and declaration HTML when the referenced project is deleted, missing or from another client', async ({ page }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const client = await db.client.create({ data: { displayName: 'Synthetic project-link projection', type: 'societa' } });
  const otherClient = await db.client.create({ data: { displayName: 'Synthetic foreign project client', type: 'societa' } });
  const active = await db.project.create({ data: { clientId: client.id, title: 'Synthetic active project' } });
  const deleted = await db.project.create({ data: { clientId: client.id, title: 'Synthetic deleted project', deletedAt: new Date() } });
  const foreign = await db.project.create({ data: { clientId: otherClient.id, title: 'Synthetic foreign project' } });
  const actor = await db.user.create({ data: { name: `HIDDEN_DECLARATION_AUTHOR_${randomUUID()}`, email: `hidden-${randomUUID()}@example.test`, role: 'admin', passwordHash: 'synthetic-unusable' } });
  const hidden = [];
  for (const projectId of [deleted.id, `missing-${randomUUID()}`, foreign.id]) {
    const contract = await db.contract.create({ data: { clientId: client.id, projectId, contractNumber: `HIDDEN_CONTRACT_${randomUUID()}`,
      serviceName: 'Synthetic hidden financial record', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } });
    const source = `HIDDEN_DECLARATION_SOURCE_${randomUUID()}`;
    const declaration = await db.auditLog.create({ data: { actorId: actor.id, entityType: 'Contract', entityId: contract.id, event: 'contract_signature_declared',
      after: { version: 1, evidenceKind: 'DECLARED_NOT_VERIFIED', sequence: 1, previousDeclarationId: null, declaredSignedAt: '2026-01-01', source, requestFingerprint: 'a'.repeat(64) } } });
    hidden.push({ contract, source, declaration });
  }
  const visible = [];
  for (const projectId of [active.id, null]) visible.push(await db.contract.create({ data: { clientId: client.id, projectId,
    contractNumber: `VISIBLE_CONTRACT_${randomUUID()}`, serviceName: 'Synthetic visible financial record', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } }));
  await loginProgressReader(page);
  for (const row of hidden) {
    await page.goto(`/contracts/${row.contract.id}`);
    await expect(page.getByRole('heading', { name: 'Contratto non trovato', exact: true })).toBeVisible();
  }
  const response = await page.goto(`/progress?client=${client.id}`);
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  await expect(page.locator('[data-progress-contract]')).toHaveCount(2);
  for (const contract of visible) await expect(page.locator(`[data-progress-contract="${contract.id}"]`)).toBeVisible();
  for (const row of hidden) {
    await expect(page.locator(`[data-progress-contract="${row.contract.id}"]`)).toHaveCount(0);
    for (const marker of [row.contract.id, row.contract.contractNumber, row.source, actor.name]) expect(html).not.toContain(marker);
    expect(await db.contract.findUniqueOrThrow({ where: { id: row.contract.id } })).toEqual(row.contract);
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: row.declaration.id } })).toEqual(row.declaration);
  }
  await page.screenshot({ path: join(root, 'progress-project-links.png'), fullPage: true });
});

test('progress includes only payments whose client matches the displayed contract, including raw HTML', async ({ page }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const client = await db.client.create({ data: { displayName: 'Synthetic payment-link projection', type: 'societa' } });
  const otherClient = await db.client.create({ data: { displayName: 'Synthetic inconsistent payment client', type: 'societa' } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(), serviceName: 'Synthetic payment comparison', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } });
  const invalidOnly = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(), serviceName: 'Synthetic invalid-only payments', taxableAmount: '100', vatAmount: '22', totalAmount: '122' } });
  const good = await db.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: '100', vatAmount: '22', totalAmount: '122', status: 'da_incassare' } });
  const bad = await db.payment.create({ data: { contractId: contract.id, clientId: otherClient.id, taxableAmount: '100', vatAmount: '22', totalAmount: '122', status: 'incassato' } });
  const badOnly = await db.payment.create({ data: { contractId: invalidOnly.id, clientId: otherClient.id, taxableAmount: '100', vatAmount: '22', totalAmount: '122', status: 'stornato' } });
  await loginProgressReader(page);
  const response = await page.goto(`/progress?client=${client.id}`);
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  const card = page.locator(`[data-progress-contract="${contract.id}"]`);
  await expect(card).toContainText('Pagamenti: da incassare');
  await expect(card).not.toContainText('incassato');
  await expect(page.locator(`[data-progress-contract="${invalidOnly.id}"]`)).toContainText('Nessun pagamento registrato');
  for (const marker of ['incassato', 'stornato', bad.id, badOnly.id]) expect(html).not.toContain(marker);
  for (const payment of [good, bad, badOnly]) expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment);
  await page.screenshot({ path: join(root, 'progress-payment-links.png'), fullPage: true });
});

test('progress retains independent contract and payment permission denials', async ({ page, context }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'signature-admin@example.test' } });
  for (const denied of ['contract.read', 'payment.read'] as const) {
    const user = await db.user.create({ data: { name: 'Synthetic financial projection reader', email: `progress-${randomUUID()}@example.test`, role: 'amministrazione', active: true, passwordHash: admin.passwordHash } });
    await db.userPermissionOverride.create({ data: { userId: user.id, permission: denied, allowed: false } });
    await context.clearCookies();
    await loginProgressReader(page, user.email);
    const response = await page.goto(`/progress?client=${f.clientId}`);
    expect(response?.status()).toBe(200);
    const html = await response!.text();
    const card = page.locator(`[data-progress-contract="${f.contractId}"]`);
    if (denied === 'contract.read') {
      await expect(card).toHaveCount(0);
      expect(html).not.toContain(f.contractId);
    } else {
      await expect(card).toBeVisible();
      await expect(card).not.toContainText('Pagamenti:');
      expect(html).not.toContain('da incassare');
    }
  }
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
  await expect(page.locator('[data-contract-operational-state]')).toHaveText('Operatività sospesa · firma da raccordare e pagamento da verificare');
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
  await expect(page.locator('[data-contract-operational-state]')).toHaveText('Operatività sospesa · in attesa di pagamento verificato');
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
