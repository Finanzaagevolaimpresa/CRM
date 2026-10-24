import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { PrismaClient, type Prisma } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { lockTechnicalAssignmentContext } from '../src/lib/technical-assignment-context';
import { lockTechnicalAssignmentRecord } from '../src/lib/technical-assignment-storage';
import { withTechnicalAssignmentDecision, withTechnicalAssignmentRecipient, technicalAssignmentClock,
  type TechnicalAssignmentTransaction } from '../src/lib/technical-assignment-transaction';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import { prepareTechnicalUploadRecord } from '../src/lib/technical-upload-record';
import { readTechnicalUploadQuota, loadTechnicalUploadRecord, persistTechnicalUploadRecord,
  withTechnicalUploadDecision } from '../src/lib/technical-upload-persistence';
import { technicalUploadAdmission } from '../src/lib/technical-upload-contract';
import { storeTechnicalUploadPrivateFile, readTechnicalUploadPrivateFile } from '../src/lib/technical-upload-storage';
import { previewTechnicalUpload, confirmTechnicalUpload, readTechnicalUploadOutcome, readOwnTechnicalUpload, readOwnTechnicalUploads } from '../src/lib/technical-upload-service';
import { readTechnicalUploadReviewQueue, readTechnicalUploadForAdmin, previewTechnicalUploadReview, confirmTechnicalUploadReview, readTechnicalUploadReviewOutcome } from '../src/lib/technical-upload-review-service';
import { prepareTechnicalUploadReview } from '../src/lib/technical-upload-review-contract';
import { persistTechnicalUploadReview } from '../src/lib/technical-upload-review-persistence';

// Real application services against an isolated database and private volume.
// Lower writers are used only for targeted atomicity/fault-injection tests.
const enabled = process.env.TECHNICAL_UPLOAD_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Person, root: string;
before(async () => { if (!enabled) return;
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal((await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count, 66n);
  // Storage configuration is captured by imported modules. The workflow must
  // provision this isolated root before Node starts, never after module import.
  assert.equal(process.env.STORAGE_PROVIDER, 'local');
  assert.equal(process.env.DOCUMENT_MAX_BYTES, '1024');
  root = await realpath(process.env.LOCAL_DOCUMENT_STORAGE_ROOT!);
  const runner = await realpath(process.env.RUNNER_TEMP!);
  assert(root.startsWith(runner + path.sep));
  assert(path.basename(root).startsWith('fai-upload-db-only-'));
  admin = await syntheticAuthority(db);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());

async function publicDeposit(f: Fixture) {
  const data = await readOwnTechnicalUploads(db, f.techA.session, f.target);
  const p = await previewTechnicalUpload(db, f.techA.session, f.target, { commandId: randomUUID(), assignmentId: data.assignmentId,
    assignmentRevision: data.assignmentRevision, expectedContextSha256: data.contextSha256, title: 'Elaborato da revisionare', action: 'deposit_private_document' }, 'Relazione.txt', bytes);
  await confirmTechnicalUpload(db, f.techA.session, f.target, p.command, p.token, bytes, true);
  return p;
}
async function reviewPreview(f: Fixture, verdict: 'APPROVE_PRIVATE' | 'REJECT_PRIVATE' = 'APPROVE_PRIVATE') {
  const ref = { ...f.target, recipientId: f.techA.user.id }, queue = await readTechnicalUploadReviewQueue(db, admin.session, ref);
  assert.equal(queue.deposits.length, 1);
  return previewTechnicalUploadReview(db, admin.session, ref, { commandId: randomUUID(), submissionCommandId: queue.deposits[0].commandId,
    sourceSha256: queue.deposits[0].sourceSha256, verdict, reason: 'Verifica sintetica del file esatto' });
}

test('personal Admin reads exact bytes and approves privately; no Document, notification or outgoing email is created', options, async () => {
  const f = await fixture(), p = await publicDeposit(f), ref = { ...f.target, recipientId: f.techA.user.id };
  const n = await counts(), notifications = await db.recordUpdateDelivery.count(), communications = await db.approvedCommunication.count();
  assert.deepEqual((await readTechnicalUploadForAdmin(db, admin.session, ref, p.command.commandId)).bytes, bytes);
  const review = await reviewPreview(f);
  const receipt = await confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true);
  assert.equal(receipt.verdict, 'APPROVE_PRIVATE');
  assert.deepEqual(await confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true), receipt);
  assert.deepEqual(await readTechnicalUploadReviewOutcome(db, admin.session, ref, review.command.commandId), { status: 'RECORDED', receipt });
  assert.equal((await readOwnTechnicalUploads(db, f.techA.session, f.target)).deposits[0].review?.verdict, 'APPROVE_PRIVATE');
  assert.deepEqual(await counts(), { ...n, audits: n.audits + 1n });
  assert.equal(await db.recordUpdateDelivery.count(), notifications); assert.equal(await db.approvedCommunication.count(), communications);
});

test('rejection retains exact bytes and quota; no second final review can overwrite the decision', options, async () => {
  const f = await fixture(1), p = await publicDeposit(f), ref = { ...f.target, recipientId: f.techA.user.id }, review = await reviewPreview(f, 'REJECT_PRIVATE');
  await confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true);
  const data = await readOwnTechnicalUploads(db, f.techA.session, f.target);
  assert.equal(data.consumedFiles, 1); assert.equal(data.deposits[0].review?.verdict, 'REJECT_PRIVATE');
  assert.deepEqual((await readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId)).bytes, bytes);
  await assert.rejects(previewTechnicalUploadReview(db, admin.session, ref, { ...review.command, commandId: randomUUID(), verdict: 'APPROVE_PRIVATE' }));
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalUploadReview" SET command=command WHERE "commandId"=${review.command.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`DELETE FROM "TechnicalUploadReview" WHERE "commandId"=${review.command.commandId}::uuid`);
});

test('two technicians, two sales and an unbound Admin cannot read another private upload, review queue or receipt', options, async () => {
  const f = await fixture(), p = await publicDeposit(f), ref = { ...f.target, recipientId: f.techA.user.id }, n = await counts();
  for (const person of [f.techB, f.salesA, f.salesB, admin]) await assert.rejects(readOwnTechnicalUpload(db, person.session, f.target, p.command.commandId));
  for (const person of [f.techA, f.techB, f.salesA, f.salesB]) {
    await assert.rejects(readTechnicalUploadReviewQueue(db, person.session, ref));
    await assert.rejects(readTechnicalUploadForAdmin(db, person.session, ref, p.command.commandId));
  }
  await db.user.update({ where: { id: f.salesA.user.id }, data: { role: 'admin' } });
  await assert.rejects(readTechnicalUploadReviewQueue(db, f.salesA.session, ref));
  await assert.rejects(readTechnicalUploadForAdmin(db, admin.session, { ...ref, targetId: f.otherPractice.id }, p.command.commandId));
  await assert.rejects(readTechnicalUploadForAdmin(db, admin.session, { ...ref, recipientId: f.techB.user.id }, p.command.commandId));
  assert.deepEqual(await counts(), n);
});

test('revocation with both pages open denies bytes, lists and pending review while preserving a minimal receipt', options, async () => {
  const f = await fixture(), p = await publicDeposit(f), ref = { ...f.target, recipientId: f.techA.user.id }, review = await reviewPreview(f), n = await counts();
  await revokeTechnical(db, admin, f.target, f.techA);
  await assert.rejects(confirmTechnicalUploadReview(db, admin.session, leadProof(admin), ref, review.command, review.token, true));
  await assert.rejects(readTechnicalUploadReviewQueue(db, admin.session, ref));
  await assert.rejects(readTechnicalUploadForAdmin(db, admin.session, ref, p.command.commandId));
  await assert.rejects(readOwnTechnicalUploads(db, f.techA.session, f.target));
  await assert.rejects(readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId));
  assert.equal((await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId)).status, 'RECORDED');
  assert.deepEqual(await counts(), n);
});

test('concurrent opposite reviews consume one submission once and retain one minimal audit', options, async () => {
  const f = await fixture(); await publicDeposit(f); const a = await reviewPreview(f), b = await reviewPreview(f, 'REJECT_PRIVATE'), n = await counts();
  const values = await Promise.allSettled([a, b].map(p => confirmTechnicalUploadReview(db, admin.session, leadProof(admin), p.reference, p.command, p.token, true)));
  assert.equal(values.filter(v => v.status === 'fulfilled').length, 1); assert.equal(values.filter(v => v.status === 'rejected').length, 1);
  assert.deepEqual(await counts(), { ...n, audits: n.audits + 1n });
});

test('changed review, session or current recipient epoch invalidates the exact preview', options, async () => {
  const f = await fixture(), p = await publicDeposit(f), review = await reviewPreview(f), n = await counts();
  await assert.rejects(confirmTechnicalUploadReview(db, admin.session, leadProof(admin), review.reference, { ...review.command, reason: 'Motivo sostituito' }, review.token, true));
  const otherSession = await syntheticSession(db, admin.user);
  await assert.rejects(confirmTechnicalUploadReview(db, otherSession.session, leadProof({ ...otherSession, user: admin.user }), review.reference, review.command, review.token, true));
  await db.user.update({ where: { id: f.techA.user.id }, data: { recordUpdateEpoch: { increment: 1 } } });
  await assert.rejects(confirmTechnicalUploadReview(db, admin.session, leadProof(admin), review.reference, review.command, review.token, true));
  await assert.rejects(readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId));
  assert.deepEqual(await counts(), n);
});

test('review audit stripping rolls the whole decision back before any success receipt escapes', options, async () => {
  const f = await fixture(); await publicDeposit(f); const p = await reviewPreview(f), n = await counts();
  // Fault injection uses the genuine service preview admission, not a fabricated authorization.
  const admission = JSON.parse(Buffer.from(p.token, 'base64url').toString('utf8')).payload.current;
  await assert.rejects(withTechnicalAssignmentDecision(db, admin.session, f.target.kind, f.techA.user.id, leadProof(admin), async (tx, state) => {
    await lockTechnicalAssignmentContext(tx, f.target);
    await lockTechnicalAssignmentRecord(tx, p.reference, 'decision');
    const record = prepareTechnicalUploadReview(state.key, p.command, admission, await technicalAssignmentClock(tx));
    await persistTechnicalUploadReview(tx, state, record);
    await tx.auditLog.delete({ where: { id: p.command.commandId } });
    await tx.$executeRaw`SET CONSTRAINTS technical_upload_review_atomic IMMEDIATE`;
  }), /TECHNICAL_UPLOAD_ATOMIC_REVIEW/);
  assert.deepEqual(await counts(), n);
  assert.deepEqual(await readTechnicalUploadReviewOutcome(db, admin.session, p.reference, p.command.commandId), { status: 'NOT_OBSERVED' });
});
const bytes = Buffer.from('Elaborato sintetico riservato');
const profile = { purpose: 'Elaborati da esaminare', formats: ['.txt'] as ['.txt'],
  maxFileBytes: 1024, maxFilesPerRevision: 2, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' as const };
async function fixture(maxFiles = 2) {
  const f = await technicalFixture(db, admin), target = technicalTarget(f);
  const setup = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
  const input = { commandId: randomUUID(), targetId: target.targetId, expectedRevision: 0,
    expectedContextSha256: setup.contextSha256, expectedRecipientEpoch: setup.recipient!.epoch,
    selection: { kind: target.kind, userId: f.techA.user.id, responsibility: 'supporto',
      actions: ['upload_document'], readableFields: ['title'], editableFields: [], documents: [],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      uploadProfile: { ...profile, maxFilesPerRevision: maxFiles, maxBytesPerRevision: maxFiles * 1024 } },
    reason: 'Incarico sintetico esplicito con profilo di deposito' };
  const ref = { ...target, recipientId: f.techA.user.id };
  const p = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  const receipt = await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, p.token, true);
  return { ...f, target, receipt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function current(tx: Prisma.TransactionClient, state: TechnicalAssignmentTransaction, f: Fixture) {
  const context = await lockTechnicalAssignmentContext(tx, f.target); assert(context);
  const record = await lockTechnicalAssignmentRecord(tx, { ...f.target, recipientId: f.techA.user.id }, 'decision'); assert(record);
  assert.equal(record.revokedAt, null);
  const quota = await readTechnicalUploadQuota(tx, state, record.id, record.revision);
  return technicalUploadAdmission.parse({ target: f.target, actorId: state.current.userId, sessionId: state.current.sessionId!,
    assignmentId: record.id, assignmentRevision: record.revision, assignmentStateSha256: record.stateSha256,
    authorityRevision: state.authority.revision, actorEpoch: state.actor.recordUpdateEpoch, authorEpoch: state.author.recordUpdateEpoch,
    keyVersion: state.key.version, contextSha256: context.contextSha256, scopeGeneration: context.rootEpoch,
    profile: record.payload.selection.uploadProfile, consumedFiles: quota.files, consumedBytes: quota.bytes,
    validUntil: Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime(), Date.parse(record.payload.selection.expiresAt)) });
}
async function preview(f: Fixture) {
  return withTechnicalAssignmentRecipient(db, f.techA.session, f.target.kind, async (tx, state) => {
    const admission = await current(tx, state, f);
    return previewTechnicalUploadDeposit(state.key, { commandId: randomUUID(), assignmentId: admission.assignmentId,
      assignmentRevision: admission.assignmentRevision, expectedContextSha256: admission.contextSha256,
      title: 'Elaborato isolato', action: 'deposit_private_document' }, 'Relazione.txt', bytes, admission,
    (await technicalAssignmentClock(tx)).getTime());
  });
}
async function proposed(tx: Prisma.TransactionClient, state: TechnicalAssignmentTransaction, f: Fixture,
  p: Awaited<ReturnType<typeof preview>>) {
  const admission = await current(tx, state, f), now = await technicalAssignmentClock(tx);
  const intent = confirmTechnicalUploadDeposit(state.key, p.command, p.token, bytes, true, admission, now.getTime()); assert(intent);
  const stored = await storeTechnicalUploadPrivateFile(intent.privateFile);
  return prepareTechnicalUploadRecord(state.key, intent, admission, stored, randomUUID(), now);
}
async function save(f: Fixture, p: Awaited<ReturnType<typeof preview>>, fail = false) {
  return withTechnicalUploadDecision(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    const receipt = await persistTechnicalUploadRecord(tx, state, value);
    if (fail) throw new Error('SYNTHETIC_AFTER_INSERT_ROLLBACK');
    return receipt;
  });
}
async function counts() {
  return (await db.$queryRaw<Array<{ submissions: bigint; audits: bigint; documents: bigint; versions: bigint }>>`SELECT
    (SELECT count(*) FROM "TechnicalUploadSubmission") AS submissions,
    (SELECT count(*) FROM "AuditLog" WHERE "entityType"='TechnicalUploadSubmission') AS audits,
    (SELECT count(*) FROM "Document") AS documents, (SELECT count(*) FROM "DocumentVersion") AS versions`)[0];
}
test('public upload consumes one exact command and returns the same original receipt after lost response', options, async () => {
  const f = await fixture(), n = await counts(), data = await readOwnTechnicalUploads(db, f.techA.session, f.target);
  const p = await previewTechnicalUpload(db, f.techA.session, f.target, { commandId: randomUUID(), assignmentId: data.assignmentId,
    assignmentRevision: data.assignmentRevision, expectedContextSha256: data.contextSha256, title: 'Documento tecnico', action: 'deposit_private_document' }, 'Relazione.txt', bytes);
  const receipt = await confirmTechnicalUpload(db, f.techA.session, f.target, p.command, p.token, bytes, true);
  assert.deepEqual(await confirmTechnicalUpload(db, f.techA.session, f.target, p.command, p.token, bytes, true), receipt);
  assert.deepEqual((await readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId)).bytes, bytes);
  assert.equal((await readOwnTechnicalUploads(db, f.techA.session, f.target)).deposits.length, 1);
  assert.deepEqual(await counts(), { ...n, submissions: n.submissions + 1n, audits: n.audits + 1n });
});
test('exact storage, immutable row, minimal audit and original decision agree after COMMIT', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts(), receipt = await save(f, p);
  const saved = await withTechnicalAssignmentRecipient(db, f.techA.session, f.target.kind, async (tx, state) =>
    loadTechnicalUploadRecord(tx, state, p.command.commandId)); assert(saved);
  assert.deepEqual(await readTechnicalUploadPrivateFile({ storageKey: saved.record.storageKey,
    sha256: saved.record.contentSha256, sizeBytes: saved.record.sizeBytes }), bytes);
  assert.deepEqual(saved.record.receipt, receipt);
  assert.deepEqual(saved.audit.after, { action: 'deposit_private_document', fileCount: 1 });
  assert(!JSON.stringify(saved.audit).includes('Relazione'));
  assert.deepEqual(await counts(), { ...n, submissions: n.submissions + 1n, audits: n.audits + 1n });
  assert.deepEqual((await readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId)).bytes, bytes);
});
test('lost-response recovery is read-only, original actor/session bound and contains no document metadata', options, async () => {
  const f = await fixture(), p = await preview(f), receipt = await save(f, p), n = await counts();
  assert.deepEqual(await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId), { status: 'RECORDED', receipt });
  assert(!JSON.stringify(receipt).includes('Relazione')); assert(!JSON.stringify(receipt).includes('Elaborato'));
  for (const person of [f.techB, f.salesA, f.salesB, admin])
    await assert.rejects(readTechnicalUploadOutcome(db, person.session, f.target, p.command.commandId));
  const another = await syntheticSession(db, f.techA.user);
  await assert.rejects(readTechnicalUploadOutcome(db, another.session, f.target, p.command.commandId));
  await assert.rejects(readTechnicalUploadOutcome(db, f.techA.session, { kind: 'TechnicalPractice', targetId: f.otherPractice.id }, p.command.commandId));
  assert.deepEqual(await counts(), n);
});
test('missing or changed canonical audit rejects before a receipt escapes and rolls back the whole submission', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts();
  await assert.rejects(withTechnicalUploadDecision(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    await persistTechnicalUploadRecord(tx, state, value);
    await tx.auditLog.delete({ where: { id: p.command.commandId } });
  }), /TECHNICAL_UPLOAD_ATOMIC_SUBMISSION/);
  assert.deepEqual(await counts(), n);
  await assert.rejects(withTechnicalUploadDecision(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    await persistTechnicalUploadRecord(tx, state, value);
    const changed = await tx.auditLog.update({ where: { id: p.command.commandId }, data: { after: { action: 'deposit_private_document', fileCount: 2 } } });
    assert.deepEqual(changed.after, { action: 'deposit_private_document', fileCount: 2 });
    const observed = await tx.$queryRaw<Array<{ after: unknown }>>`SELECT "after" FROM "AuditLog" WHERE id=${p.command.commandId}`;
    assert.deepEqual(observed, [{ after: { action: 'deposit_private_document', fileCount: 2 } }]);
  }), /TECHNICAL_UPLOAD_ATOMIC_SUBMISSION/);
  assert.deepEqual(await counts(), n);
});
test('immutable retained submissions refuse update, deletion, truncation and duplicate command consumption', options, async () => {
  const f = await fixture(), p = await preview(f); await save(f, p); const n = await counts();
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalUploadSubmission" SET "sizeBytes"="sizeBytes"+1 WHERE "commandId"=${p.command.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`DELETE FROM "TechnicalUploadSubmission" WHERE "commandId"=${p.command.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`TRUNCATE "TechnicalUploadSubmission"`);
  await assert.rejects(save(f, p)); assert.deepEqual(await counts(), n);
});
test('concurrent final quota slot has one committed command and no hidden extra audit', options, async () => {
  const f = await fixture(1), p = await preview(f), q = await preview(f), n = await counts();
  const outcomes = await Promise.allSettled([save(f, p), save(f, q)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
  assert.deepEqual(await counts(), { ...n, submissions: n.submissions + 1n, audits: n.audits + 1n });
  await assert.rejects(preview(f));
});
test('a rolled-back private file stays outside the journal and normal document indexes', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts();
  await assert.rejects(save(f, p, true), /SYNTHETIC_AFTER_INSERT_ROLLBACK/);
  assert.deepEqual(await counts(), n);
  assert.deepEqual(await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId), { status: 'NOT_OBSERVED' });
  // Retained orphan is not exposed by an application read and has no automatic cleanup.
  const { technicalUploadStorageKey } = await import('../src/lib/technical-upload-plan');
  const key = technicalUploadStorageKey({ actorId: f.techA.user.id, sessionId: f.techA.session.sessionId!, target: f.target,
    assignmentId: p.command.assignmentId, assignmentRevision: p.command.assignmentRevision }, p.command.commandId);
  assert.deepEqual(await readFile(path.join(root, ...key.split('/'))), bytes);
  await assert.rejects(readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId));
});
test('revocation preserves the original receipt but denies a pending new deposit', options, async () => {
  const f = await fixture(), p = await preview(f), receipt = await save(f, p), q = await preview(f);
  await revokeTechnical(db, admin, f.target, f.techA); const n = await counts();
  await assert.rejects(save(f, q));
  assert.deepEqual(await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId), { status: 'RECORDED', receipt });
  assert.deepEqual(await counts(), n);
});
test('a read-committed raw copy cannot bypass quota serialization even with a matching audit', options, async () => {
  const f = await fixture(), p = await preview(f); await save(f, p); const n = await counts(), id = randomUUID(), commandId = randomUUID();
  await assert.rejects(db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "TechnicalUploadSubmission"(id,"commandId","assignmentId","assignmentRevision",
      "actorId","sessionId","targetKind","targetId","requestDigest",command,"storageKey","contentSha256","sizeBytes",receipt,proof,"createdAt")
      SELECT ${id}::uuid,${commandId}::uuid,"assignmentId","assignmentRevision","actorId","sessionId","targetKind","targetId","requestDigest",
      jsonb_set(command,'{commandId}',to_jsonb(${commandId}::text)),
      regexp_replace("storageKey",'[a-f0-9]{64}$',repeat('f',64)),"contentSha256","sizeBytes",
      jsonb_set(jsonb_set(receipt,'{commandId}',to_jsonb(${commandId}::text)),'{submissionId}',to_jsonb(${id}::text)),proof,"createdAt"
      FROM "TechnicalUploadSubmission" WHERE "commandId"=${p.command.commandId}::uuid`;
    await tx.auditLog.create({ data: { id: commandId, actorId: f.techA.user.id, event: 'technical_upload_deposited',
      entityType: 'TechnicalUploadSubmission', entityId: id, before: {}, after: { action: 'deposit_private_document', fileCount: 1 } } });
    // Observe the SQL refusal inside the ORM callback as in the real writer.
    await tx.$executeRaw`SET CONSTRAINTS technical_upload_atomic IMMEDIATE`;
  }, { isolationLevel: 'ReadCommitted' }), /TECHNICAL_UPLOAD_ATOMIC_SUBMISSION/);
  assert.deepEqual(await counts(), n);
});

test('native COMMIT independently rejects missing or altered audit and leaves no submission', options, async () => {
  const f = await fixture(), p = await preview(f); await save(f, p);
  const n = await counts();
  const url = new URL(process.env.DATABASE_URL!); url.search = '';
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5432'); assert.equal(url.pathname, '/fai_crm_test');
  for (const altered of [false, true]) {
  const id = randomUUID(), commandId = randomUUID();
  // Only generated UUIDs enter this native SQL. The ephemeral DB guard and
  // sentinel above are mandatory; no production URL or data is accepted.
  for (const value of [id, commandId, p.command.commandId]) assert.match(value, /^[a-f0-9-]{36}$/);
  const result = spawnSync('psql', [url.toString(), '--no-psqlrc', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8', timeout: 10_000,
    input: `BEGIN ISOLATION LEVEL SERIALIZABLE;
INSERT INTO "TechnicalUploadSubmission"(id,"commandId","assignmentId","assignmentRevision",
 "actorId","sessionId","targetKind","targetId","requestDigest",command,"storageKey","contentSha256","sizeBytes",receipt,proof,"createdAt")
 SELECT '${id}'::uuid,'${commandId}'::uuid,"assignmentId","assignmentRevision","actorId","sessionId","targetKind","targetId","requestDigest",
 jsonb_set(command,'{commandId}',to_jsonb('${commandId}'::text)),
 regexp_replace("storageKey",'[a-f0-9]{64}$',repeat('e',64)),"contentSha256","sizeBytes",
 jsonb_set(jsonb_set(receipt,'{commandId}',to_jsonb('${commandId}'::text)),'{submissionId}',to_jsonb('${id}'::text)),proof,"createdAt"
 FROM "TechnicalUploadSubmission" WHERE "commandId"='${p.command.commandId}'::uuid;
${altered ? `INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after","createdAt")
 SELECT '${commandId}',"actorId",'technical_upload_deposited','TechnicalUploadSubmission','${id}',
 '{}'::jsonb,'{"action":"deposit_private_document","fileCount":1}'::jsonb,CURRENT_TIMESTAMP
 FROM "TechnicalUploadSubmission" WHERE id='${id}'::uuid;
UPDATE "AuditLog" SET "after"="after"||'{"fileCount":2}'::jsonb WHERE id='${commandId}';` : ''}
COMMIT;`,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 3);
  assert.match(result.stdout, /INSERT 0 1/);
  assert.match(result.stderr, /TECHNICAL_UPLOAD_ATOMIC_SUBMISSION/);
  assert.deepEqual(await counts(), n);
  }
});

test('rollback retains the physical quota slot across new command IDs, but permits exact recovery', options, async () => {
  const f = await fixture(1), p = await preview(f), q = await preview(f), n = await counts();
  await assert.rejects(save(f, p, true), /SYNTHETIC_AFTER_INSERT_ROLLBACK/);
  assert.deepEqual(await counts(), n);
  await assert.rejects(save(f, q), /TECHNICAL_UPLOAD_STORAGE_QUOTA/);
  assert.deepEqual(await counts(), n);
  const receipt = await save(f, p);
  assert.deepEqual(await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId), { status: 'RECORDED', receipt });
  assert.deepEqual(await counts(), { ...n, submissions: n.submissions + 1n, audits: n.audits + 1n });
});

test('existing audit minimization removes free text while preserving the exact private event', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts();
  const receipt = await withTechnicalUploadDecision(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    const saved = await persistTechnicalUploadRecord(tx, state, value);
    const updated = await tx.auditLog.update({ where: { id: p.command.commandId },
      data: { after: { action: 'deposit_private_document', fileCount: 1, title: 'Synthetic private title' } } });
    assert.deepEqual(updated.after, { action: 'deposit_private_document', fileCount: 1 });
    return saved;
  });
  assert.deepEqual(await readTechnicalUploadOutcome(db, f.techA.session, f.target, p.command.commandId), { status: 'RECORDED', receipt });
  assert.deepEqual(await counts(), { ...n, submissions: n.submissions + 1n, audits: n.audits + 1n });
});
