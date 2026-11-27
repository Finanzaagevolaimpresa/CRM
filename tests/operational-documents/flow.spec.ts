import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { readPrivateDocumentBounded } from '../../src/lib/storage';
const db = new PrismaClient(), evidence = resolve(process.env.OPERATIONAL_DOCUMENT_EVIDENCE ?? 'test-results/operational-documents');
const fixture = JSON.parse(readFileSync(join(evidence, 'fixture.json'), 'utf8')) as { leadId: string; clientId: string; companyName: string;
  templateId: string; templateCommandId: string; proformaTemplateCommandId: string; serviceRevisionId: string; admin: { id: string; email: string };
  owner: { id: string; email: string }; other: { id: string; email: string }; technical: { id: string; email: string };
  emailProforma: { id: string; contentHash: string }; mailbox: { id: string; address: string };
  nonAuthority: { id: string; email: string };
  technicalFolder: { id: string; title: string; url: string; projectId: string } };
async function login(page: Page, email: string) {
  const origin = new URL(process.env.APP_ORIGIN!).origin;
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto('/login'); await page.locator('[data-interactive-ready="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('synthetic-document-browser-only-2026');
  await page.getByRole('button', { name: 'Login interno', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard$/);
}
test.afterAll(() => db.$disconnect());
test('Admin duplica e pubblica un modello con conferma personale senza perdere il contenuto', async ({ page }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const original = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: fixture.templateCommandId } });
  await login(page, fixture.admin.email);
  await page.goto('/document-library/templates/new?duplicate=' + fixture.templateId);
  const title = 'Copia modello autorizzata · prova browser';
  await page.getByLabel('Nome modello', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Duplica come bozza', exact: true }).click();
  const identity = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro' });
  await expect(identity).toBeVisible();
  await identity.getByLabel('Password corrente', { exact: true }).fill('synthetic-document-browser-only-2026');
  await identity.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
  await expect(identity.getByRole('button', { name: 'Riconferma identità se la finestra è scaduta' })).toBeVisible();
  await expect(page.getByLabel('Nome modello', { exact: true })).toHaveValue(title);
  await page.getByRole('button', { name: 'Duplica come bozza', exact: true }).click();
  await expect(page).toHaveURL(/\/document-library\/templates\/[a-f0-9-]{36}$/);
  const newTemplateId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(newTemplateId).not.toBe(fixture.templateId);
  await page.locator('input[name="approved"]').check();
  await page.getByRole('button', { name: 'Pubblica modello autorizzato', exact: true }).click();
  await expect(page.getByText(/Versione 2 · Pubblicata/)).toBeVisible();
  expect(await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: fixture.templateCommandId } })).toEqual(original);
  writeFileSync(join(evidence, 'admin-template-receipt.json'), JSON.stringify({ synthetic: true, originalTemplateId: fixture.templateId,
    newTemplateId, publication: 'PASS', stepUpPreservesChoices: 'PASS', originalUnchanged: true }));
});

test('tecnico apre solo il riferimento del fascicolo assegnato, senza accedere ai dati finanziari', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const context = await browser.newContext(), outsiderContext = await browser.newContext();
  try {
    const page = await context.newPage(), outsider = await outsiderContext.newPage();
    await login(page, fixture.technical.email); await login(outsider, fixture.other.email);
    await page.goto('/drive-folders');
    const card = page.locator('[data-folder-id="' + fixture.technicalFolder.id + '"]');
    await expect(card.getByRole('heading', { name: fixture.technicalFolder.title, exact: true })).toBeVisible();
    await card.getByRole('link', { name: 'Dettaglio del riferimento', exact: true }).click();
    await expect(page.getByRole('heading', { name: fixture.technicalFolder.title, exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'technical-drive-page.png'), fullPage: true });
    await expect(page.getByRole('link', { name: 'Apri cartella Drive', exact: true })).toHaveAttribute('href', '/drive-folders/' + fixture.technicalFolder.id + '/open');
    // Stop at the authorized redirect: a local test cannot attest Google ACLs or folder contents.
    const response = await page.request.get('/drive-folders/' + fixture.technicalFolder.id + '/open', { maxRedirects: 0 });
    expect(response.status()).toBe(302); expect(response.headers().location).toBe(fixture.technicalFolder.url);
    expect((await outsider.request.get('/drive-folders/' + fixture.technicalFolder.id + '/open', { maxRedirects: 0 })).status()).toBe(404);
    expect((await page.request.get('/document-library', { maxRedirects: 0 })).status()).toBe(404);
    expect((await page.request.get('/drive-folders/manage/' + fixture.technicalFolder.id, { maxRedirects: 0 })).status()).toBe(404);
    const project = await db.project.findUniqueOrThrow({ where: { id: fixture.technicalFolder.projectId } });
    expect(project.consultantId).toBe(fixture.technical.id); expect(project.clientId).toBe(fixture.clientId);
    writeFileSync(join(evidence, 'technical-drive-receipt.json'), JSON.stringify({ synthetic: true, folderId: fixture.technicalFolder.id,
      projectId: project.id, crmAdmission: 'PASS', googleAclAndContents: 'NOT_TESTED', financialAccess: 'DENIED', outsider: 'DENIED' }));
  } finally { await context.close(); await outsiderContext.close(); }
});
test('commerciale genera bozza da modello, conferma e prepara PDF; gli altri ruoli non vedono il documento', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext()));
  try {
    const [owner, other, technical] = await Promise.all(contexts.map(context => context.newPage()));
    await login(owner, fixture.owner.email); await login(other, fixture.other.email); await login(technical, fixture.technical.email);
    await owner.goto('/document-library/new?lead=' + fixture.leadId);
    await owner.getByLabel('Modello approvato', { exact: true }).selectOption(fixture.templateCommandId);
    await owner.getByLabel('Catalogo o incarico', { exact: true }).selectOption('service:' + fixture.serviceRevisionId);
    await owner.getByRole('button', { name: 'Precompila dai dati esistenti', exact: true }).click();
    await expect(owner.locator('input[name="denominazione"]')).toHaveValue(fixture.companyName);
    await expect(owner.locator('input[name="partita_iva"]')).toHaveValue('12345678903');
    await owner.locator('input[name="rate"]').fill('Saldo unico alla scadenza concordata');
    await owner.locator('input[name="termsConfirmed"]').check();
    await owner.getByRole('button', { name: 'Genera bozza indipendente', exact: true }).click();
    await expect(owner).toHaveURL(/\/document-library\/[a-f0-9-]{36}$/);
    const documentId = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(owner.getByText('Bozza da verificare', { exact: true })).toBeVisible();
    await owner.locator('input[name="confirmed"]').check();
    await owner.getByRole('button', { name: 'Conferma contenuto', exact: true }).click();
    await expect(owner.getByText('Contenuto confermato', { exact: true })).toBeVisible();
    await owner.getByLabel('Modello proforma approvato', { exact: true }).selectOption(fixture.proformaTemplateCommandId);
    await owner.getByLabel('Scadenza proforma', { exact: true }).fill('2027-02-28');
    await owner.locator('input[name="confirmed"]').check();
    await owner.getByRole('button', { name: 'Prepara proforma PDF', exact: true }).click();
    await expect(owner.getByRole('heading', { name: 'Proforma · ' + fixture.companyName })).toBeVisible();
    const proformaId = new URL(owner.url()).pathname.split('/').at(-1)!;
    await owner.screenshot({ path: join(evidence, 'proforma-page.png'), fullPage: true });
    const pdf = await owner.request.get('/document-library/' + proformaId + '/pdf');
    expect(pdf.status()).toBe(200); expect(pdf.headers()['content-type']).toBe('application/pdf');
    const bytes = await pdf.body(); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    writeFileSync(join(evidence, 'synthetic-proforma.pdf'), bytes);
    await owner.goto('/document-library/' + documentId);
    await owner.getByLabel('Modello proforma approvato', { exact: true }).selectOption(fixture.proformaTemplateCommandId);
    await owner.getByLabel('Scadenza proforma', { exact: true }).fill('2027-02-28');
    await owner.locator('input[name="confirmed"]').check(); await owner.getByRole('button', { name: 'Prepara proforma PDF', exact: true }).click();
    await expect(owner).toHaveURL(new RegExp('/document-library/' + proformaId + '$'));
    await owner.reload(); await expect(owner.getByRole('heading', { name: 'Proforma · ' + fixture.companyName })).toBeVisible();
    for (const page of [other, technical]) {
      const denied = await page.request.get('/document-library/' + proformaId + '/pdf'); expect(denied.status()).toBe(404);
      await page.goto('/document-library/' + documentId); await expect(page.getByText(fixture.companyName, { exact: true })).toHaveCount(0);
    }
    expect(await db.operationalDocument.count({ where: { sourceDocumentId: documentId, dueDate: '2027-02-28' } })).toBe(1);
    expect(await db.operationalDocumentDecision.count({ where: { documentId } })).toBe(1);
    writeFileSync(join(evidence, 'browser-receipt.json'), JSON.stringify({ synthetic: true, documentId, proformaId, bytes: bytes.length, repeatedProforma: 'same', unauthorized: ['other', 'technical'] }));
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('Admin prepara email dalla proforma confermata e richiede approvazione con PDF esatto; il commerciale non può inviare il comando', async ({ browser }) => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const previousAuthority = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  let authorityPrepared = false;
  try {
    await db.ordinaryEmailAuthority.upsert({ where: { id: 'ordinary-email' },
      create: { id: 'ordinary-email', userId: fixture.admin.id, mailboxId: fixture.mailbox.id, enabled: true },
      update: { userId: fixture.admin.id, mailboxId: fixture.mailbox.id, enabled: true, revision: { increment: 1 } } });
    authorityPrepared = true;
    const [admin, owner, nonAuthority] = await Promise.all(contexts.map(context => context.newPage()));
    await login(admin, fixture.admin.email); await login(owner, fixture.owner.email); await login(nonAuthority, fixture.nonAuthority.email);
    const documentPath = '/document-library/' + fixture.emailProforma.id;
    await admin.goto(documentPath); await owner.goto(documentPath);
    await expect(admin.getByText('Contenuto confermato', { exact: true })).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Prepara bozza email con PDF', exact: true })).toHaveCount(0);
    const subject = 'Proforma sintetica browser · ' + fixture.emailProforma.id;
    async function prepareForm(page: Page) {
      await page.getByLabel('Mittente aziendale', { exact: true }).selectOption(fixture.mailbox.id);
      await page.getByLabel('Destinatario', { exact: true }).fill('proforma-browser@invalid.test');
      await page.getByLabel('Oggetto', { exact: true }).fill(subject);
      await page.getByLabel('Testo autorizzato per il caso', { exact: true }).fill('Prova sintetica del percorso di approvazione, senza alcun invio reale.');
      await page.getByRole('checkbox', { name: /^Ho verificato destinatario, testo e anteprima PDF/ }).check();
      const button = page.getByRole('button', { name: 'Prepara bozza email con PDF', exact: true });
      await button.click();
      const identity = page.getByRole('region', { name: 'Conferma identità senza lasciare il lavoro' });
      await expect(identity).toBeVisible();
      await identity.getByLabel('Password corrente', { exact: true }).fill('synthetic-document-browser-only-2026');
      await identity.getByRole('button', { name: 'Conferma identità e conserva le scelte', exact: true }).click();
      await expect(identity.getByRole('button', { name: 'Riconferma identità se la finestra è scaduta' })).toBeVisible();
      await expect(page.getByLabel('Oggetto', { exact: true })).toHaveValue(subject);
      return button;
    }
    // A different Admin has valid personal proof but lacks the sender authority.
    await nonAuthority.goto(documentPath);
    await (await prepareForm(nonAuthority)).click();
    await expect(nonAuthority.getByRole('alert').filter({ hasText: /^Bozza non confermata\./ })).toBeVisible();
    expect(await db.adminRecordRevision.count({ where: { model: 'OperationalDocumentDelivery', recordId: fixture.emailProforma.id } })).toBe(0);
    expect(await db.approvedCommunication.count({ where: { clientId: fixture.clientId } })).toBe(0);
    const prepare = await prepareForm(admin);
    const pendingRequest = admin.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === documentPath && Boolean(request.headers()['next-action']));
    await prepare.click(); const request = await pendingRequest;
    await expect(admin.getByText(/^Stato verificato nella posta: Bozza\./)).toBeVisible();
    const journal = await db.adminRecordRevision.findFirstOrThrow({ where: { model: 'OperationalDocumentDelivery', recordId: fixture.emailProforma.id }, orderBy: { createdAt: 'desc' } });
    const saved = journal.after as { email: { messageId: string; attachmentId: string; attachmentVersionId: string; pdfSha256: string } };
    const message = await db.approvedCommunication.findUniqueOrThrow({ where: { id: saved.email.messageId }, include: { versions: true } });
    expect(message.state).toBe('DRAFT'); expect(message.currentRevision).toBe(1); expect(message.versions).toHaveLength(1);
    const snapshot = message.versions[0].snapshot as { subject: string; to: string[]; classification: string; attachments: { documentId: string; versionId: string; sha256: string }[] };
    expect(snapshot.subject).toBe(subject); expect(snapshot.to).toEqual(['proforma-browser@invalid.test']);
    expect(snapshot.classification).toBe('SENSITIVE'); expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0].versionId).toBe(saved.email.attachmentVersionId);
    const attachment = await db.document.findUniqueOrThrow({ where: { id: saved.email.attachmentId } });
    expect(attachment.documentCategory).toBe('fattura');
    const bytes = await readPrivateDocumentBounded(attachment.storagePath, 5_000_000);
    const pdf = await admin.request.get(documentPath + '/pdf'); expect(pdf.status()).toBe(200);
    expect(bytes.equals(await pdf.body())).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(saved.email.pdfSha256);
    expect(snapshot.attachments[0].sha256).toBe(saved.email.pdfSha256);
    // Replay the real Admin action with the commercial actor's browser cookies.
    const payload = request.postData(); expect(payload).not.toBeNull();
    const denied = await owner.evaluate(async input => {
      const response = await fetch(input.path, { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: input.headers, body: input.body });
      return { status: response.status, text: await response.text(), redirect: response.headers.get('x-action-redirect') };
    }, { path: documentPath, headers: { 'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'] }, body: payload! });
    expect([200, 403, 404]).toContain(denied.status); expect(denied.redirect).toBeNull();
    if (denied.status === 200) expect(denied.text).toContain('Conferma la tua identità');
    expect(denied.text).not.toContain(saved.email.messageId);
    expect(await db.approvedCommunication.findUniqueOrThrow({ where: { id: saved.email.messageId }, include: { versions: true } })).toEqual(message);
    expect(await db.adminRecordRevision.count({ where: { model: 'OperationalDocumentDelivery', recordId: fixture.emailProforma.id } })).toBe(1);
    await admin.getByRole('link', { name: 'Apri bozza, approvazioni e ricevute', exact: true }).click();
    await expect(admin.getByRole('heading', { name: subject + ' · v1', exact: true })).toBeVisible();
    await admin.getByRole('button', { name: 'Richiedi approvazione admin', exact: true }).click();
    await expect(admin.getByRole('button', { name: 'Approva versione 1', exact: true })).toBeVisible();
    expect((await db.approvedCommunication.findUniqueOrThrow({ where: { id: message.id } })).state).toBe('PENDING');
    expect(await db.communicationApproval.count({ where: { versionId: message.versions[0].id } })).toBe(0);
    expect(await db.communicationAttempt.count({ where: { messageId: message.id } })).toBe(0);
    expect(await db.ordinaryEmailAttempt.count({ where: { messageId: message.id } })).toBe(0);
    expect(await db.documentVersion.count({ where: { documentId: attachment.id } })).toBe(1);
    await admin.goto(documentPath);
    await expect(admin.getByText(/^Stato verificato nella posta: In approvazione\./)).toBeVisible();
    const pendingPdf = await admin.request.get(documentPath + '/pdf'); expect(pendingPdf.status()).toBe(200);
    expect(bytes.equals(await pendingPdf.body())).toBe(true);
    await admin.screenshot({ path: join(evidence, 'proforma-email-pending.png'), fullPage: true });
    writeFileSync(join(evidence, 'proforma-email-receipt.json'), JSON.stringify({ synthetic: true, documentId: fixture.emailProforma.id,
      messageId: message.id, state: 'PENDING', pdfSha256: saved.email.pdfSha256, exactPdf: true, approvals: 0, manualAttempts: 0,
      channelAttempts: 0, unauthorizedReplay: 'DENIED', adminWithoutSenderAuthority: 'DENIED', actualSend: 'NOT_PERFORMED' }));
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (authorityPrepared) {
      const current = await db.ordinaryEmailAuthority.findUniqueOrThrow({ where: { id: 'ordinary-email' } });
      expect(current.userId, 'Synthetic authority must not overlap another suite').toBe(fixture.admin.id);
      await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: previousAuthority
        ? { userId: previousAuthority.userId, mailboxId: previousAuthority.mailboxId, enabled: previousAuthority.enabled, revision: { increment: 1 } }
        : { enabled: false, revision: { increment: 1 } } });
    }
  }
});
