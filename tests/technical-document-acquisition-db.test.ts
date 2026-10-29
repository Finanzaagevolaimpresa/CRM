import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { readTechnicalWork, readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { previewTechnicalUpload, confirmTechnicalUpload, readOwnTechnicalUploads } from '../src/lib/technical-upload-service';
import { readTechnicalUploadReviewQueue, previewTechnicalUploadReview, confirmTechnicalUploadReview } from '../src/lib/technical-upload-review-service';
import { previewTechnicalDocumentAcquisition, confirmTechnicalDocumentAcquisition, readTechnicalDocumentAcquisitionOutcome } from '../src/lib/technical-document-acquisition-service';
import { listPersonalAcquiredDocuments, readPersonalAcquiredDocument } from '../src/lib/technical-document-acquired-access';
import { readOrdinaryDocument } from '../src/lib/ordinary-document-download';
import { appendDocumentVersion, documentVersionPage } from '../src/lib/document-version-service';
import { DocumentVersionError } from '../src/lib/document-version-contract';
import { previewClientSharing, readSharedClientDocument, readClientSharing } from '../src/lib/selective-client-access';
import { grantClient } from './selective-clients/fixtures';
import { readPrivateDocumentBounded } from '../src/lib/storage';
import { withTechnicalAssignmentManagementRead } from '../src/lib/technical-assignment-transaction';
import { loadTechnicalDocumentAcquisition } from '../src/lib/technical-document-acquisition-persistence';
import { grantPractice } from './selective-practices/fixtures';
import { readPracticeSharing, readSharedPracticeDocument } from '../src/lib/selective-practice-access';
import { officeBytes } from './technical-uploads/office-fixture';

const enabled = process.env.TECHNICAL_ACQUISITION_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Person, root: string;
const bytes = Buffer.from('ACQUISIZIONE_PRIVATA_SINTETICA_221');
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].n, 72n);
  root = await realpath(process.env.LOCAL_DOCUMENT_STORAGE_ROOT!);
  assert(root.startsWith(await realpath(process.env.RUNNER_TEMP!) + path.sep));
  assert(path.basename(root).startsWith('fai-upload-db-only-'));
  const [binding] = await db.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment'`;
  if (binding) { const user = await db.user.findUniqueOrThrow({ where: { id: binding.userId } }); admin = { user, ...await syntheticSession(db, user) }; }
  else { admin = await syntheticAuthority(db); await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`; }
  await db.selectiveClientAuthority.create({ data: { id: 'client-sharing', userId: admin.user.id, enabled: true } });
  await db.selectivePracticeAuthority.create({ data: { id: 'practice-sharing', userId: admin.user.id, enabled: true } });
});
after(async () => db.$disconnect());
async function fixture(verdict: 'APPROVE_PRIVATE' | 'REJECT_PRIVATE' = 'APPROVE_PRIVATE', file = { name: 'Elaborato.txt', bytes }) {
  const f = await technicalFixture(db, admin), target = technicalTarget(f), ref = { ...target, recipientId: f.techA.user.id };
  const setup = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
  const input = { commandId: randomUUID(), targetId: target.targetId, expectedRevision: 0,
    expectedContextSha256: setup.contextSha256, expectedRecipientEpoch: setup.recipient!.epoch,
    selection: { kind: target.kind, userId: f.techA.user.id, responsibility: 'supporto', actions: ['upload_document'],
      readableFields: ['title'], editableFields: [], documents: [], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      uploadProfile: { purpose: 'Deposito sintetico', formats: ['.' + file.name.split('.').at(-1)], maxFileBytes: 1024, maxFilesPerRevision: 2,
        maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' } }, reason: 'Decisione sintetica' };
  const assignment = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, assignment.token, true);
  const state = await readOwnTechnicalUploads(db, f.techA.session, target);
  const upload = await previewTechnicalUpload(db, f.techA.session, target, { commandId: randomUUID(), assignmentId: state.assignmentId,
    assignmentRevision: state.assignmentRevision, expectedContextSha256: state.contextSha256, title: 'Elaborato da acquisire', action: 'deposit_private_document' }, file.name, file.bytes);
  await confirmTechnicalUpload(db, f.techA.session, target, upload.command, upload.token, file.bytes, true);
  const queue = await readTechnicalUploadReviewQueue(db, admin.session, ref), d = queue.deposits[0];
  const review = await previewTechnicalUploadReview(db, admin.session, ref, { commandId: randomUUID(), submissionCommandId: d.commandId,
    sourceSha256: d.sourceSha256, verdict, reason: 'Esame sintetico della versione esatta' });
  await confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true);
  const reviewed = (await readTechnicalUploadReviewQueue(db, admin.session, ref)).deposits[0];
  const command = { commandId: randomUUID(), submissionCommandId: d.commandId, sourceSha256: d.sourceSha256,
    reviewCommandId: reviewed.review!.commandId, reviewSha256: reviewed.review!.sha256,
    classification: 'TECHNICAL_DOCUMENT' as const, title: 'File acquisito privato', expiresAt: null, visibility: 'ADMIN_PRIVATE' as const };
  return { ...f, target, ref, command };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function acquire(f: Fixture, classification = 'TECHNICAL_DOCUMENT') {
  const p = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, { ...f.command, classification });
  const receipt = await confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, p.command, p.token, true);
  return { p, receipt };
}
async function count() {
  const [r] = await db.$queryRaw<Array<{ acquisitions: bigint; documents: bigint; versions: bigint; audits: bigint }>>`SELECT
    (SELECT count(*) FROM "TechnicalDocumentAcquisition") AS acquisitions, (SELECT count(*) FROM "Document") AS documents,
    (SELECT count(*) FROM "DocumentVersion") AS versions, (SELECT count(*) FROM "AuditLog" WHERE event='technical_document_acquired_private') AS audits`;
  return r;
}
test('approved exact bytes become one private canonical version, without grants, copies, notifications or email', options, async () => {
  const f = await fixture(), before = await count(), mails = await db.approvedCommunication.count(), notices = await db.recordUpdateDelivery.count();
  const { receipt } = await acquire(f), after = await count();
  for (const key of ['acquisitions', 'documents', 'versions', 'audits'] as const) assert.equal(after[key], before[key] + 1n);
  const d = await db.document.findUniqueOrThrow({ where: { id: receipt.documentId } }), v = await db.documentVersion.findUniqueOrThrow({ where: { id: receipt.versionId } });
  const [source] = await db.$queryRaw<Array<{ storageKey: string }>>`SELECT "storageKey" FROM "TechnicalUploadSubmission" WHERE "commandId"=${f.command.submissionCommandId}::uuid`;
  assert.equal(d.storagePath, source.storageKey); assert.equal(v.storagePath, source.storageKey); assert.equal(d.selectiveEpoch, 2);
  assert.equal(d.visibilityLevel, 'technical_admin_private_v1'); assert.equal(d.mimeType, 'text/plain');
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, d.id)).bytes, bytes);
  assert.equal((await listPersonalAcquiredDocuments(db, admin.session, f.client.id))[0].id, d.id);
  assert.equal(await db.approvedCommunication.count(), mails); assert.equal(await db.recordUpdateDelivery.count(), notices);
  const other = await syntheticPerson(db, 'Altro Admin sintetico');
  for (const person of [admin, other, f.techA, f.techB, f.salesA, f.salesB]) await assert.rejects(readOrdinaryDocument(db, person.session, d.id, null));
  for (const person of [other, f.techA, f.techB, f.salesA, f.salesB]) await assert.rejects(readPersonalAcquiredDocument(db, person.session, d.id));
  assert.equal((await readOwnTechnicalUploads(db, f.techA.session, f.target)).deposits.length, 1);
});
test('lost response returns the original receipt; competing commands cannot duplicate the canonical version', options, async () => {
  const f = await fixture(), p = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, f.command);
  const q = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, { ...f.command, commandId: randomUUID() });
  const before = await count(), results = await Promise.allSettled([p, q].map(x => confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, x.command, x.token, true)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const index = results.findIndex(x => x.status === 'fulfilled'), original = [p, q][index], r = results[index]; assert.equal(r.status, 'fulfilled');
  if (r.status !== 'fulfilled') throw new Error('MISSING_SYNTHETIC_RECEIPT');
  assert.deepEqual(await confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, original.command, original.token, true), r.value);
  assert.deepEqual(await readTechnicalDocumentAcquisitionOutcome(db, admin.session, f.ref, original.command.commandId), { status: 'RECORDED', receipt: r.value });
  assert.equal((await count()).acquisitions, before.acquisitions + 1n);
  await assert.rejects(confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, { ...original.command, title: 'Diverso' }, original.token, true));
});
test('rejected review and changed classification, session, title or confirmation cannot acquire', options, async () => {
  const rejected = await fixture('REJECT_PRIVATE'); await assert.rejects(previewTechnicalDocumentAcquisition(db, admin.session, rejected.ref, rejected.command));
  const f = await fixture(), p = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, f.command), before = await count();
  for (const patch of [{ classification: 'CONTRACT' }, { title: 'Alterato' }, { sourceSha256: 'f'.repeat(64) }, { expiresAt: new Date(Date.now() - 1000).toISOString() }])
    await assert.rejects(confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, { ...p.command, ...patch }, p.token, true));
  await assert.rejects(confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, p.command, p.token, false));
  const second = { user: admin.user, ...await syntheticSession(db, admin.user) };
  await assert.rejects(confirmTechnicalDocumentAcquisition(db, second.session, leadProof(second), f.ref, p.command, p.token, true));
  assert.deepEqual(await count(), before);
});
test('revocation and owner change with preview open prevent acquisition without changing existing documents', options, async () => {
  for (const mode of ['revoke', 'owner']) {
    const f = await fixture(), p = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, f.command), before = await count();
    if (mode === 'revoke') await revokeTechnical(db, admin, f.target, f.techA);
    else await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId: f.techB.user.id } });
    await assert.rejects(confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, p.command, p.token, true));
    assert.deepEqual(await count(), before);
    assert.deepEqual(await readTechnicalDocumentAcquisitionOutcome(db, admin.session, f.ref, p.command.commandId), { status: 'NOT_OBSERVED' });
  }
});
test('changed physical bytes fail before acquisition and after acquisition before personal read', options, async () => {
  const f = await fixture(), p = await previewTechnicalDocumentAcquisition(db, admin.session, f.ref, f.command);
  const [s] = await db.$queryRaw<Array<{ storageKey: string }>>`SELECT "storageKey" FROM "TechnicalUploadSubmission" WHERE "commandId"=${f.command.submissionCommandId}::uuid`;
  const file = path.resolve(root, s.storageKey); assert(file.startsWith(root + path.sep)); const original = await readFile(file);
  try { await writeFile(file, Buffer.alloc(original.length, 120)); await assert.rejects(confirmTechnicalDocumentAcquisition(db, admin.session, leadProof(admin), f.ref, p.command, p.token, true)); }
  finally { await writeFile(file, original); }
  const { receipt } = await acquire(f);
  try { await writeFile(file, Buffer.alloc(original.length, 121)); await assert.rejects(readPersonalAcquiredDocument(db, admin.session, receipt.documentId)); }
  finally { await writeFile(file, original); }
});
test('exact technical selection makes the approved file usable; omitted, foreign and download paths stay denied', options, async () => {
  const f = await fixture(), { receipt } = await acquire(f);
  await assignTechnical(db, admin, f.target, f.techA, { documents: [{ fileId: receipt.versionId, allowDownload: false }] });
  await assignTechnical(db, admin, f.target, f.techB);
  assert.equal((await readTechnicalWork(db, f.techA.session, f.target)).documents[0].fileId, receipt.versionId);
  assert.deepEqual((await readTechnicalWorkDocument(db, f.techA.session, f.target, receipt.versionId, false, readPrivateDocumentBounded)).bytes, bytes);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, receipt.versionId, true, readPrivateDocumentBounded));
  for (const person of [f.techB, f.salesA, f.salesB]) await assert.rejects(readTechnicalWorkDocument(db, person.session, f.target, receipt.versionId, false, readPrivateDocumentBounded));
  await revokeTechnical(db, admin, f.target, f.techA);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, receipt.versionId, false, readPrivateDocumentBounded));
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, receipt.documentId)).bytes, bytes);
});
test('client sharing selects the exact technical file for one commercial, preserving separation and download choice', options, async () => {
  const f = await fixture(), { receipt } = await acquire(f);
  const input = { version: 4, clientId: f.client.id, recipientId: f.salesA.user.id, commandId: randomUUID(), revision: 0,
    fields: [], companies: [], people: [], documents: [{ versionId: receipt.versionId, download: false }], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  await grantClient(db, admin, input);
  assert.equal((await readClientSharing(db, f.salesA.session, f.client.id)).documents.length, 1);
  assert.deepEqual((await readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, false, readPrivateDocumentBounded)).bytes, bytes);
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, readPrivateDocumentBounded));
  await assert.rejects(readSharedClientDocument(db, f.salesB.session, f.client.id, receipt.versionId, false, readPrivateDocumentBounded));
  await db.user.update({ where: { id: f.salesA.user.id }, data: { active: false } });
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, false, readPrivateDocumentBounded));
});
test('contract and payment classification cannot be selected for technicians or commercial even with a misleading filename', options, async () => {
  for (const classification of ['CONTRACT', 'PAYMENT']) {
    const f = await fixture(), { receipt } = await acquire(f, classification);
    for (const person of [f.techA, f.techB]) assert(!(await readTechnicalAssignmentManagement(db, admin.session, f.target, person.user.id)).documentOptions.some(d => d.fileId === receipt.versionId));
    await assert.rejects(previewClientSharing(db, admin.session, { version: 4, clientId: f.client.id, recipientId: f.salesA.user.id,
      commandId: randomUUID(), revision: 0, fields: [], companies: [], people: [], documents: [{ versionId: receipt.versionId, download: true }], expiresAt: null }));
    const accounting = await syntheticPerson(db, 'Amministrazione sintetica', 'amministrazione');
    await grantClient(db, admin, { version: 4, clientId: f.client.id, recipientId: accounting.user.id, commandId: randomUUID(), revision: 0,
      fields: [], companies: [], people: [], documents: [{ versionId: receipt.versionId, download: true }], expiresAt: null });
    assert.deepEqual((await readSharedClientDocument(db, accounting.session, f.client.id, receipt.versionId, true, readPrivateDocumentBounded)).bytes, bytes);
  }
});
test('canonical source, classification and version cannot be relabelled, replaced or deleted through generic writers', options, async () => {
  const f = await fixture(), { receipt } = await acquire(f), d = await db.document.findUniqueOrThrow({ where: { id: receipt.documentId } });
  const beforeVersions = await count();
  const deniedVersion = (e: unknown) => e instanceof DocumentVersionError && e.code === 'DENIED';
  await assert.rejects(documentVersionPage(db, admin.session, d.id), deniedVersion);
  await assert.rejects(appendDocumentVersion(db, admin.session, {
    documentId: d.id, requestId: randomUUID(), expectedHash: 'a'.repeat(64), confirmed: true,
  }, new File(['Nuova versione non ammessa'], d.fileName, { type: d.mimeType })), deniedVersion);
  assert.deepEqual(await count(), beforeVersions);
  for (const data of [{ visibilityLevel: 'interno' }, { title: 'Sostituito' }, { documentCategory: 'altro' }, { clientId: f.otherClient.id }, { deletedAt: new Date() }])
    await assert.rejects(db.document.update({ where: { id: d.id }, data }));
  await assert.rejects(db.document.delete({ where: { id: d.id } }));
  await assert.rejects(db.documentVersion.update({ where: { id: receipt.versionId }, data: { checksum: 'a'.repeat(64) } }));
  await assert.rejects(db.documentVersion.create({ data: { documentId: d.id, version: 2, storagePath: d.storagePath, checksum: d.checksum } }));
  await assert.rejects(db.$executeRaw`DELETE FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${receipt.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalDocumentAcquisition" SET record=record WHERE "commandId"=${receipt.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`TRUNCATE "TechnicalDocumentAcquisition"`);
  await db.$executeRaw`UPDATE "Document" SET "selectiveEpoch"="selectiveEpoch"+1 WHERE id=${d.id}`;
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, d.id)).bytes, bytes);
});
test('orphan private documents and extra versions fail atomically; missing acquisition audit denies all reads', options, async () => {
  const f = await fixture(), { receipt } = await acquire(f), before = await count(), d = await db.document.findUniqueOrThrow({ where: { id: receipt.documentId } });
  await assert.rejects(db.document.create({ data: { ...d, id: randomUUID() } }));
  assert.deepEqual(await count(), before);
  await db.$transaction(async tx => { await tx.auditLog.delete({ where: { id: receipt.commandId } });
    await assert.rejects(loadTechnicalDocumentAcquisition(tx, { key: leadProof(admin).key }, receipt.commandId));
    throw new Error('SYNTHETIC_FAULT_ROLLBACK'); }).catch(e => assert.match(String(e), /SYNTHETIC_FAULT_ROLLBACK/));
  assert.deepEqual((await readPersonalAcquiredDocument(db, admin.session, receipt.documentId)).bytes, bytes);
});
test('current lifecycle and personal authority revocation close acquired views without erasing provenance', options, async () => {
  const f = await fixture(), { receipt } = await acquire(f);
  await db.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  await assert.rejects(readPersonalAcquiredDocument(db, admin.session, receipt.documentId));
  assert.deepEqual(await listPersonalAcquiredDocuments(db, admin.session, f.client.id), []);
  await withTechnicalAssignmentManagementRead(db, admin.session, f.target.kind, null, async (tx, state) => assert(await loadTechnicalDocumentAcquisition(tx, state, receipt.commandId)));
});

test('Office metadata alone grants no bytes; explicit technical download works and revocation closes it', options, async () => {
  const f = await fixture('APPROVE_PRIVATE', { name: 'Relazione.docx', bytes: officeBytes }), { receipt } = await acquire(f);
  const fileId = receipt.versionId;
  await assignTechnical(db, admin, f.target, f.techA, { documents: [{ fileId, allowDownload: false }] });
  assert.equal((await readTechnicalWork(db, f.techA.session, f.target)).documents[0].fileName, 'Relazione.docx');
  let reads = 0;
  const storage = async (key: string, limit: number) => { reads++; return readPrivateDocumentBounded(key, limit); };
  for (const download of [false, true]) await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, fileId, download, storage));
  assert.equal(reads, 0);
  await assignTechnical(db, admin, f.target, f.techA, { documents: [{ fileId, allowDownload: true }] });
  const result = await readTechnicalWorkDocument(db, f.techA.session, f.target, fileId, true, storage);
  assert.deepEqual(result.bytes, officeBytes); assert.equal(result.contentType, 'application/octet-stream');
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, fileId, false, storage));
  for (const person of [f.techB, f.salesA, f.salesB])
    await assert.rejects(readTechnicalWorkDocument(db, person.session, f.target, fileId, true, storage));
  assert.equal(reads, 1);
  await revokeTechnical(db, admin, f.target, f.techA);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, f.target, fileId, true, storage));
  assert.equal(reads, 1); assert.equal((await readPersonalAcquiredDocument(db, admin.session, receipt.documentId)).previewMime, null);
});

test('client Office sharing requires its own download decision and rechecks physical bytes and current lifecycle', options, async () => {
  const f = await fixture('APPROVE_PRIVATE', { name: 'Relazione.docx', bytes: officeBytes }), { receipt } = await acquire(f);
  const input = { version: 4, clientId: f.client.id, recipientId: f.salesA.user.id, commandId: randomUUID(), revision: 0,
    fields: [], companies: [], people: [], documents: [{ versionId: receipt.versionId, download: false }], expiresAt: null };
  await grantClient(db, admin, input);
  assert.equal((await readClientSharing(db, f.salesA.session, f.client.id)).documents[0].fileName, 'Relazione.docx');
  let reads = 0;
  const storage = async (key: string, limit: number) => { reads++; return readPrivateDocumentBounded(key, limit); };
  for (const download of [false, true]) await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, download, storage));
  assert.equal(reads, 0);
  // The commercial role does not carry document.download. A per-version
  // selection must not manufacture that independent permission.
  await assert.rejects(grantClient(db, admin, { ...input, commandId: randomUUID(), revision: 1, documents: [{ versionId: receipt.versionId, download: true }] }));
  const permission = await db.userPermissionOverride.create({ data: { userId: f.salesA.user.id, permission: 'document.download', allowed: true } });
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage));
  assert.equal(reads, 0);
  await grantClient(db, admin, { ...input, commandId: randomUUID(), revision: 1, documents: [{ versionId: receipt.versionId, download: true }] });
  const result = await readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage);
  assert.deepEqual(result.bytes, officeBytes); assert.equal(result.contentType, 'application/octet-stream');
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, false, storage));
  await assert.rejects(readSharedClientDocument(db, f.salesB.session, f.client.id, receipt.versionId, true, storage));
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.otherClient.id, receipt.versionId, true, storage));
  assert.equal(reads, 1);
  const doc = await db.document.findUniqueOrThrow({ where: { id: receipt.documentId } }), file = path.resolve(root, doc.storagePath);
  assert(file.startsWith(root + path.sep));
  await writeFile(file, Buffer.from('ALTERED_OFFICE_BYTES'));
  try { await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage)); }
  finally { await writeFile(file, officeBytes); }
  await db.userPermissionOverride.update({ where: { id: permission.id }, data: { allowed: false } });
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage));
  await db.userPermissionOverride.update({ where: { id: permission.id }, data: { allowed: true } });
  await grantClient(db, admin, { ...input, commandId: randomUUID(), revision: 2, documents: [{ versionId: receipt.versionId, download: true }] });
  assert.deepEqual((await readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage)).bytes, officeBytes);
  await db.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  await assert.rejects(readSharedClientDocument(db, f.salesA.session, f.client.id, receipt.versionId, true, storage));
});

test('practice download selects an exact Office version without opening the client or a sibling practice', options, async () => {
  const f = await fixture('APPROVE_PRIVATE', { name: 'Relazione.docx', bytes: officeBytes }), { receipt } = await acquire(f);
  const input = { version: 2, practiceId: f.practice.id, recipientId: f.techB.user.id, commandId: randomUUID(), revision: 0,
    fields: [], documents: [{ versionId: receipt.versionId, download: false }], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  await grantPractice(db, admin, input);
  assert.equal((await readPracticeSharing(db, f.techB.session, f.practice.id)).documents.length, 1);
  for (const download of [false, true]) await assert.rejects(readSharedPracticeDocument(db, f.techB.session, f.practice.id, receipt.versionId, download, readPrivateDocumentBounded));
  await grantPractice(db, admin, { ...input, commandId: randomUUID(), revision: 1, documents: [{ versionId: receipt.versionId, download: true }] });
  const result = await readSharedPracticeDocument(db, f.techB.session, f.practice.id, receipt.versionId, true, readPrivateDocumentBounded);
  assert.deepEqual(result.bytes, officeBytes); assert.equal(result.contentType, 'application/octet-stream');
  await assert.rejects(readSharedPracticeDocument(db, f.techB.session, f.practice.id, receipt.versionId, false, readPrivateDocumentBounded));
  await assert.rejects(readSharedPracticeDocument(db, f.techA.session, f.practice.id, receipt.versionId, true, readPrivateDocumentBounded));
  await assert.rejects(readSharedPracticeDocument(db, f.techB.session, f.otherPractice.id, receipt.versionId, true, readPrivateDocumentBounded));
  await assert.rejects(readSharedClientDocument(db, f.techB.session, f.client.id, receipt.versionId, true, readPrivateDocumentBounded));
  await db.user.update({ where: { id: f.techB.user.id }, data: { active: false } });
  await assert.rejects(readSharedPracticeDocument(db, f.techB.session, f.practice.id, receipt.versionId, true, readPrivateDocumentBounded));
});

test('Office contract download retains the financial ceiling despite its generic stored media type', options, async () => {
  const f = await fixture('APPROVE_PRIVATE', { name: 'Relazione.docx', bytes: officeBytes }), { receipt } = await acquire(f, 'CONTRACT');
  for (const person of [f.techA, f.techB]) assert(!(await readTechnicalAssignmentManagement(db, admin.session, f.target, person.user.id)).documentOptions.some(d => d.fileId === receipt.versionId));
  const input = { version: 4, clientId: f.client.id, recipientId: f.salesA.user.id, commandId: randomUUID(), revision: 0,
    fields: [], companies: [], people: [], documents: [{ versionId: receipt.versionId, download: true }], expiresAt: null };
  await assert.rejects(previewClientSharing(db, admin.session, input));
  const accounting = await syntheticPerson(db, 'Amministrazione formato Office sintetico', 'amministrazione');
  await grantClient(db, admin, { ...input, commandId: randomUUID(), recipientId: accounting.user.id });
  assert.deepEqual((await readSharedClientDocument(db, accounting.session, f.client.id, receipt.versionId, true, readPrivateDocumentBounded)).bytes, officeBytes);
  await assert.rejects(readSharedClientDocument(db, accounting.session, f.client.id, receipt.versionId, false, readPrivateDocumentBounded));
});
