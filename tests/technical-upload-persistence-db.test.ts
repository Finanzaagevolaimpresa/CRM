import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { PrismaClient, type Prisma } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { createTechnicalAssignmentPreview } from '../src/lib/technical-assignment-preview';
import { prepareTechnicalAssignmentDecision } from '../src/lib/technical-assignment-decision';
import { lockTechnicalAssignmentContext } from '../src/lib/technical-assignment-context';
import { lockTechnicalAssignmentRecord, persistTechnicalAssignmentDecision } from '../src/lib/technical-assignment-storage';
import { withTechnicalAssignmentDecision, withTechnicalAssignmentRecipient, technicalAssignmentClock,
  type TechnicalAssignmentTransaction } from '../src/lib/technical-assignment-transaction';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import { prepareTechnicalUploadRecord } from '../src/lib/technical-upload-record';
import { readTechnicalUploadQuota, loadTechnicalUploadRecord, persistTechnicalUploadRecord } from '../src/lib/technical-upload-persistence';
import { technicalUploadAdmission } from '../src/lib/technical-upload-contract';
import { storeTechnicalUploadPrivateFile, readTechnicalUploadPrivateFile } from '../src/lib/technical-upload-storage';
import { previewTechnicalUpload, readTechnicalUploadOutcome, readOwnTechnicalUpload } from '../src/lib/technical-upload-service';

// Qualification of the dormant persistence components, not a runtime upload
// acceptance test. The synthetic fixture installs a signed decision through the
// lower journal writer while the public management/service gate stays closed.
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
    reason: 'Fixture isolata del registro, non concessione runtime' };
  // This proves the production entry point cannot issue this dormant action.
  await assert.rejects(previewTechnicalAssignment(db, admin.session, { ...target, recipientId: f.techA.user.id }, 'ASSIGN', input));
  const receipt = await withTechnicalAssignmentDecision(db, admin.session, target.kind, f.techA.user.id, leadProof(admin), async (tx, state) => {
    const context = await lockTechnicalAssignmentContext(tx, target); assert(context);
    const admission = { actorId: admin.user.id, sessionId: admin.session.sessionId!, authorityRevision: state.authority.revision,
      actorEpoch: state.actor.recordUpdateEpoch, recipientEpoch: state.recipient!.recordUpdateEpoch,
      ...target, recipientId: f.techA.user.id, assignmentId: null, assignmentRevision: 0, assignmentStateSha256: null,
      contextSha256: context.contextSha256, validUntil: Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime()) };
    const now = await technicalAssignmentClock(tx);
    const token = createTechnicalAssignmentPreview('ASSIGN', state.key, input, admission, now.getTime());
    const change = prepareTechnicalAssignmentDecision({ operation: 'ASSIGN', key: state.key, raw: input, token, admission,
      previous: null, journal: null, assignmentId: randomUUID(), revisionId: randomUUID(), now });
    return persistTechnicalAssignmentDecision(tx, state, change, null);
  });
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
  return withTechnicalAssignmentRecipient(db, f.techA.session, f.target.kind, async (tx, state) => {
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
test('public runtime remains disabled even with a correctly signed isolated upload fixture', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts();
  await assert.rejects(previewTechnicalUpload(db, f.techA.session, f.target, p.command, 'Relazione.txt', bytes));
  assert.deepEqual(await counts(), n);
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
  await assert.rejects(readOwnTechnicalUpload(db, f.techA.session, f.target, p.command.commandId));
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
test('missing or enriched audit rolls back the whole submission transaction', options, async () => {
  const f = await fixture(), p = await preview(f), n = await counts();
  await assert.rejects(withTechnicalAssignmentRecipient(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    await persistTechnicalUploadRecord(tx, state, value);
    await tx.auditLog.delete({ where: { id: p.command.commandId } });
  }), /TECHNICAL_UPLOAD_ATOMIC_SUBMISSION/);
  assert.deepEqual(await counts(), n);
  await assert.rejects(withTechnicalAssignmentRecipient(db, f.techA.session, f.target.kind, async (tx, state) => {
    const value = await proposed(tx, state, f, p);
    await persistTechnicalUploadRecord(tx, state, value);
    await tx.auditLog.update({ where: { id: p.command.commandId }, data: { after: { action: 'deposit_private_document', fileCount: 1, title: 'Leak' } } });
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
  const key = technicalUploadStorageKey({ actorId: f.techA.user.id, sessionId: f.techA.session.sessionId!, target: f.target }, p.command.commandId);
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
      'technical-submissions/v1/'||repeat('f',64),"contentSha256","sizeBytes",
      jsonb_set(jsonb_set(receipt,'{commandId}',to_jsonb(${commandId}::text)),'{submissionId}',to_jsonb(${id}::text)),proof,"createdAt"
      FROM "TechnicalUploadSubmission" WHERE "commandId"=${p.command.commandId}::uuid`;
    await tx.auditLog.create({ data: { id: commandId, actorId: f.techA.user.id, event: 'technical_upload_deposited',
      entityType: 'TechnicalUploadSubmission', entityId: id, before: {}, after: { action: 'deposit_private_document', fileCount: 1 } } });
  }, { isolationLevel: 'ReadCommitted' }));
  assert.deepEqual(await counts(), n);
});
