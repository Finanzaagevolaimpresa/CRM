import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, type OrdinaryEmailAuthority } from '@prisma/client';
import { documentFixture } from './fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { confirmOperationalDocument, createOperationalProforma, readOperationalDocument } from '../../src/lib/operational-documents';
import { prepareOperationalProformaEmail, readOperationalDocumentDelivery, recordOperationalProformaArchive } from '../../src/lib/operational-document-delivery';
import { submitApprovedMessage } from '../../src/lib/approved-communications';
import { previewDriveFolder, confirmDriveFolder } from '../../src/lib/drive-folder-library';
import { readPrivateDocumentBounded } from '../../src/lib/storage';
import { canAccessFinancialDocument } from '../../src/lib/financial-document-access';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled };
let f: Awaited<ReturnType<typeof documentFixture>>, previousAuthority: OrdinaryEmailAuthority | null, mailboxId: string;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); f = await documentFixture(db);
  mailboxId = (await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } })).id;
  previousAuthority = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  mkdirSync('test-results/operational-documents', { recursive: true });
  writeFileSync(join('test-results/operational-documents', 'authority-' + f.admin.user.id + '.json'), JSON.stringify(previousAuthority));
  await db.ordinaryEmailAuthority.upsert({ where: { id: 'ordinary-email' }, create: { id: 'ordinary-email', userId: f.admin.user.id, mailboxId, enabled: true },
    update: { userId: f.admin.user.id, mailboxId, enabled: true, revision: { increment: 1 } } });
});
after(async () => {
  if (enabled && f) {
    const current = await db.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
    assert.equal(current?.userId, f.admin.user.id, 'The isolated authority fixture must not overlap another suite');
    if (previousAuthority) await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: { ...previousAuthority, revision: { increment: 1 } } });
    else await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: { enabled: false, revision: { increment: 1 } } });
  }
  await db.$disconnect();
});
async function proforma(confirm = true) {
  const contract = await f.create(), source = await readOperationalDocument(db, f.owner.session, contract.id);
  await confirmOperationalDocument(db, f.owner.session, { commandId: randomUUID(), documentId: contract.id, contentHash: source.row.contentHash, confirmed: true });
  const made = await createOperationalProforma(db, f.owner.session, { commandId: randomUUID(), documentId: contract.id, contentHash: source.row.contentHash,
    templateCommandId: f.proformaPublication.commandId, dueDate: '2027-04-30', confirmed: true });
  const data = await readOperationalDocument(db, f.admin.session, made.id);
  if (confirm) await confirmOperationalDocument(db, f.admin.session, { commandId: randomUUID(), documentId: made.id, contentHash: data.row.contentHash, confirmed: true });
  return data;
}
const emailInput = (row: { id: string; contentHash: string }) => ({ commandId: randomUUID(), documentId: row.id, contentHash: row.contentHash, confirmed: true,
  mailboxId, to: 'cliente-sintetico@invalid.test', subject: 'Proforma sintetica da approvare', body: 'Allegato sintetico per prova isolata, nessun invio reale.' });
async function folder(clientId: string, people = [f.admin.user.id], technicalContentReviewed = false) {
  const id = randomUUID(), details = { clientId, title: 'Archivio proforma sintetico', url: 'https://drive.google.com/drive/folders/synthetic_archive_' + id.replaceAll('-', ''),
    people, technicalContentReviewed, expiresAt: null };
  for (const [version, operation] of (['SAVE_DRAFT', 'ACTIVATE'] as const).entries()) {
    const command = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId: id, expectedVersion: version, operation, details };
    const preview = await previewDriveFolder(db, f.admin.session, command);
    await confirmDriveFolder(db, f.admin.session, command, preview.digest, clientProof(f.admin));
  }
  return id;
}
test('proforma confermata prepara una sola bozza nativa con esatto PDF finanziario e nessun invio', options, async () => {
  const data = await proforma(), input = emailInput(data.row);
  await assert.rejects(prepareOperationalProformaEmail(db, f.owner.session, input, clientProof(f.owner)));
  await assert.rejects(prepareOperationalProformaEmail(db, f.technical.session, input, clientProof(f.technical)));
  const first = await prepareOperationalProformaEmail(db, f.admin.session, input, clientProof(f.admin));
  const again = await prepareOperationalProformaEmail(db, f.admin.session, { ...input, commandId: randomUUID() }, clientProof(f.admin));
  assert.equal(first.messageId, again.messageId); assert(again.replay);
  await assert.rejects(prepareOperationalProformaEmail(db, f.admin.session, { ...input, commandId: randomUUID(), to: 'diverso@invalid.test' }, clientProof(f.admin)));
  const message = await db.approvedCommunication.findUniqueOrThrow({ where: { id: first.messageId }, include: { versions: true } });
  assert.equal(message.state, 'DRAFT'); assert.equal(message.versions.length, 1);
  const snapshot = message.versions[0].snapshot as { attachments: { documentId: string; versionId: string; sha256: string }[] };
  assert.equal(snapshot.attachments.length, 1);
  const attachment = await db.document.findUniqueOrThrow({ where: { id: snapshot.attachments[0].documentId } });
  assert.equal(attachment.documentCategory, 'fattura'); assert.equal(await canAccessFinancialDocument(db, f.owner.session, attachment), false);
  const bytes = await readPrivateDocumentBounded(attachment.storagePath, 5_000_000);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.attachments[0].sha256); assert(bytes.subarray(0,5).equals(Buffer.from('%PDF-')));
  assert.equal(await db.communicationAttempt.count({ where: { messageId: first.messageId } }), 0);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: first.messageId } }), 0);
  const view = await readOperationalDocumentDelivery(db, f.admin.session, data.row.id);
  assert.equal(view.email?.native?.state, 'DRAFT'); assert.equal(view.email?.native?.receipts.length, 0);
  assert.equal((await readOperationalDocumentDelivery(db, f.owner.session, data.row.id)).email?.native, null);
  await submitApprovedMessage(db, f.admin.session, { messageId: message.id, expectedRevision: 1, snapshotHash: message.versions[0].snapshotHash });
  assert.equal((await readOperationalDocumentDelivery(db, f.admin.session, data.row.id)).email?.native?.state, 'PENDING');
  assert.equal(await db.communicationApproval.count({ where: { versionId: message.versions[0].id } }), 0);
});
test('proforma non confermata e operatore senza autorità posta non producono bozze', options, async () => {
  const data = await proforma(false), input = emailInput(data.row);
  await assert.rejects(prepareOperationalProformaEmail(db, f.admin.session, input, clientProof(f.admin)));
  assert.equal((await readOperationalDocumentDelivery(db, f.admin.session, data.row.id)).email, null);
  const confirmed = await proforma();
  const actor = await documentFixture(db);
  await assert.rejects(prepareOperationalProformaEmail(db, actor.admin.session, emailInput(confirmed.row), clientProof(actor.admin)));
  assert.equal((await readOperationalDocumentDelivery(db, f.admin.session, confirmed.row.id)).email, null);
});
test('archivio Drive richiede hash, cartella del cliente ed evidenza; il link resta nel perimetro attuale', options, async () => {
  const data = await proforma(), folderId = await folder(f.client.id), view = await readOperationalDocumentDelivery(db, f.admin.session, data.row.id);
  const input = { commandId: randomUUID(), documentId: data.row.id, contentHash: data.row.contentHash, confirmed: true, folderId,
    fileUrl: 'https://drive.google.com/file/d/synthetic_archived_pdf_' + randomUUID().replaceAll('-', '') + '/view', pdfSha256: view.pdfSha256,
    evidence: 'Prova sintetica: hash, cartella e accessi verificati nel fixture; nessuna richiesta Google.', occurredAt: new Date(Date.now() - 1000).toISOString(), folderMembershipConfirmed: true, accessConfirmed: true };
  await assert.rejects(recordOperationalProformaArchive(db, f.admin.session, { ...input, pdfSha256: '0'.repeat(64) }, clientProof(f.admin)));
  await assert.rejects(recordOperationalProformaArchive(db, f.admin.session, { ...input, accessConfirmed: false }, clientProof(f.admin)));
  const wrongClient = await db.client.create({ data: { type: 'societa', displayName: 'Archivio diverso sintetico' } });
  await assert.rejects(recordOperationalProformaArchive(db, f.admin.session, { ...input, folderId: await folder(wrongClient.id) }, clientProof(f.admin)));
  await db.userPermissionOverride.create({ data: { userId: f.technical.user.id, permission: 'drive_folders.read', allowed: true } });
  const technicalFolder = await folder(f.client.id, [f.technical.user.id], true);
  await assert.rejects(recordOperationalProformaArchive(db, f.admin.session, { ...input, folderId: technicalFolder }, clientProof(f.admin)));
  await recordOperationalProformaArchive(db, f.admin.session, input, clientProof(f.admin));
  assert((await recordOperationalProformaArchive(db, f.admin.session, { ...input, commandId: randomUUID() }, clientProof(f.admin))).replay);
  assert.equal((await readOperationalDocumentDelivery(db, f.admin.session, data.row.id)).archives.length, 1);
  assert.equal((await readOperationalDocumentDelivery(db, f.owner.session, data.row.id)).archives.length, 0);
  await assert.rejects(readOperationalDocumentDelivery(db, f.technical.session, data.row.id));
  const row = await db.adminRecordRevision.findUniqueOrThrow({ where: { commandId: input.commandId } });
  await assert.rejects(db.adminRecordRevision.update({ where: { commandId: row.commandId }, data: { reason: 'tampered' } }));
  const disable = { protocol: 'DRIVE_FOLDER_REFERENCE_V1', commandId: randomUUID(), folderId, expectedVersion: 2, operation: 'DISABLE' };
  const preview = await previewDriveFolder(db, f.admin.session, disable);
  await confirmDriveFolder(db, f.admin.session, disable, preview.digest, clientProof(f.admin));
  assert.equal((await readOperationalDocumentDelivery(db, f.admin.session, data.row.id)).archives.length, 0);
});
