import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { saveApprovedMessageDraft, submitApprovedMessage, approveExactMessage, prepareManualMessage, recordManualMessageEvidence,
  configureCommunicationMailbox, qualifyCommunicationMailbox, acquireManualReply, linkAmbiguousReply,
  readPracticeCommunications, readCommunicationAdministration } from '../../src/lib/approved-communications';
import { ApprovedCommunicationError } from '../../src/lib/approved-communication-contract';

const enabled = process.env.M4_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
const bytes = Buffer.from('Synthetic M4 attachment; no real client data.'), checksum = createHash('sha256').update(bytes).digest('hex');
const runtime = { readDocument: async () => bytes };
const failure = (code: string) => (error: unknown) => error instanceof ApprovedCommunicationError && error.code === code;
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => { await db.$disconnect(); });

async function user(role: RoleCode) {
  const row = await db.user.create({ data: { email: `m4-${randomUUID()}@invalid.test`, name: 'Synthetic M4', role, passwordHash: 'synthetic-unusable-hash', active: true } });
  const session = await db.internalSession.create({ data: { userId: row.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { userId: row.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime() / 1000), role, active: true, permissionOverrides: [] };
}
async function fixture() {
  const admin = await user('admin'), operator = await user('consulente'), commercial = await user('commerciale');
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic M4 Client', consultantId: operator.userId, salesOwnerId: commercial.userId } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Synthetic M4', consultantId: operator.userId } });
  const catalog = await db.serviceCatalog.create({ data: { code: `M4-${randomUUID()}`, name: 'Synthetic M4', category: 'test' } });
  const service = await db.clientService.create({ data: { clientId: client.id, projectId: project.id, serviceCatalogId: catalog.id, assignedToId: operator.userId } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, clientServiceId: service.id,
    title: 'Synthetic M4', practiceType: 'test', targetEntity: 'Synthetic', createdById: admin.userId, technicalOwnerId: operator.userId, commercialOwnerId: commercial.userId } });
  const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, clientServiceId: service.id, type: 'documento_operativo', title: 'Synthetic M4 attachment',
    fileName: 'synthetic-m4.txt', mimeType: 'text/plain', sizeBytes: bytes.length, storagePath: 'synthetic/m4.txt', checksum, uploadedById: admin.userId, status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum, storagePath: doc.storagePath } });
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, admin, { mailboxId: before.id, expectedRevision: before.revision,
    kind: 'MAILBOX', canonicalMailboxId: null, providerReference: 'SYNTHETIC_PROVIDER', responsibleUserId: admin.userId,
    canSend: true, canReceive: true, restricted: false, configurationReference: 'SYNTHETIC_CONFIG' });
  await qualifyCommunicationMailbox(db, admin, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_SEND_RECEIVE_PROOF' });
  await qualifyCommunicationMailbox(db, admin, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  const context = { kind: 'TECHNICAL' as const, id: practice.id };
  const input = { messageId: randomUUID(), expectedRevision: 0, context, mailboxId: box.id, replyTo: box.address,
    to: ['client@invalid.test'], cc: [], bcc: ['archive@invalid.test'], subject: 'Synthetic M4 exact email', body: 'Approved synthetic content only.', attachmentVersionIds: [version.id], classification: 'ORDINARY' };
  return { admin, operator, commercial, client, project, service, practice, doc, version, box, context, input };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const saved = await saveApprovedMessageDraft(db, f.operator, f.input, runtime);
  const binding = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, f.operator, binding); await approveExactMessage(db, f.admin, binding, runtime);
  return binding;
}
async function footprint(messageId: string) {
  return { row: await db.approvedCommunication.findUnique({ where: { id: messageId } }),
    versions: await db.communicationVersion.count({ where: { messageId } }), attempts: await db.communicationAttempt.count({ where: { messageId } }),
    events: await db.communicationEvent.count({ where: { messageId } }), audits: await db.auditLog.count({ where: { entityId: messageId } }) };
}

test('M4 migration registers exactly seven disabled mailboxes and preserves dormant queues', { skip: !enabled }, async () => {
  const boxes = await db.communicationMailbox.findMany();
  assert.equal(boxes.length, 7); assert.ok(boxes.every(box => box.kind === 'UNATTESTED' && !box.enabled && !box.canSend && !box.testedAt));
  assert.equal(await db.communicationIntentRecord.count(), 0); assert.equal(await db.businessOutboxEvent.count(), 0);
  await assert.rejects(db.communicationMailbox.update({ where: { id: boxes[0].id }, data: { enabled: true } }));
  assert.equal(Number((await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count), 49);
});

test('M4 exact admin approval, commercial preparation and changed versions are enforced in storage', { skip: !enabled }, async () => {
  const f = await fixture();
  const commercialDraft = await saveApprovedMessageDraft(db, f.commercial, { ...f.input, messageId: randomUUID(), attachmentVersionIds: [] }, runtime);
  assert.equal(commercialDraft.revision, 1);
  const saved = await saveApprovedMessageDraft(db, f.operator, f.input, runtime), binding = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, f.operator, binding);
  const before = await footprint(saved.id);
  await assert.rejects(approveExactMessage(db, { ...f.operator, role: 'admin' }, binding, runtime), failure('DENIED'));
  assert.deepEqual(await footprint(saved.id), before);
  await approveExactMessage(db, f.admin, binding, runtime);
  const changed = await saveApprovedMessageDraft(db, f.operator, { ...f.input, expectedRevision: 1, bcc: [] }, runtime);
  assert.equal(changed.revision, 2); assert.notEqual(changed.snapshotHash, saved.snapshotHash);
  await assert.rejects(prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime), failure('CONFLICT'));
  assert.equal((await footprint(saved.id)).row?.state, 'DRAFT');
  assert.equal(await db.communicationApproval.count({ where: { version: { messageId: saved.id } } }), 1);
  await assert.rejects(db.communicationVersion.update({ where: { messageId_revision: { messageId: saved.id, revision: 1 } }, data: { snapshotHash: '0'.repeat(64) } }));
});

test('M4 double click has one attempt; uncertain results block retry until admin reconciliation', { skip: !enabled }, async () => {
  const f = await fixture(), binding = await approved(f), input = { ...binding, requestId: randomUUID() };
  const [first, replay] = await Promise.all([prepareManualMessage(db, f.operator, input, runtime), prepareManualMessage(db, f.operator, input, runtime)]);
  assert.equal(first.attemptId, replay.attemptId); assert.deepEqual(first.bytes, replay.bytes);
  assert.equal(first.artifactHash, createHash('sha256').update(first.bytes).digest('hex'));
  assert.equal(await db.communicationAttempt.count({ where: { messageId: binding.messageId } }), 1);
  await assert.rejects(prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime), failure('RECONCILIATION_REQUIRED'));
  const uncertain = { messageId: binding.messageId, attemptId: first.attemptId, reconciliation: false,
    evidence: { method: 'MANUAL_DECLARATION', outcome: 'UNCERTAIN', occurredAt: new Date().toISOString(), reference: 'SYNTHETIC_LOST_RESPONSE' } };
  await recordManualMessageEvidence(db, f.operator, uncertain);
  const before = await footprint(binding.messageId);
  await recordManualMessageEvidence(db, f.operator, uncertain); assert.deepEqual(await footprint(binding.messageId), before);
  await assert.rejects(prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime), failure('RECONCILIATION_REQUIRED'));
  const reconciled = { ...uncertain, reconciliation: true, evidence: { ...uncertain.evidence, outcome: 'NOT_SENT', reference: 'SYNTHETIC_VERIFIED_NOT_SENT' } };
  await assert.rejects(recordManualMessageEvidence(db, f.operator, reconciled), failure('DENIED'));
  await recordManualMessageEvidence(db, f.admin, reconciled);
  const next = await prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime);
  await recordManualMessageEvidence(db, f.operator, { ...uncertain, attemptId: next.attemptId, evidence: { ...uncertain.evidence, outcome: 'SENT', reference: 'SYNTHETIC_MANUAL_DECLARATION' } });
  assert.equal((await footprint(binding.messageId)).row?.state, 'SENT');
  await assert.rejects(prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime), failure('CONFLICT'));
  assert.equal(await db.communicationEvent.count({ where: { messageId: binding.messageId, event: 'MANUAL_OUTCOME_RECONCILED' } }), 1);
});

test('M4 fresh rights, suspension, approver revocation and mailbox disablement prevent package preparation', { skip: !enabled }, async () => {
  const f = await fixture(), binding = await approved(f), input = { ...binding, requestId: randomUUID() }, before = await footprint(binding.messageId);
  await db.user.update({ where: { id: f.operator.userId }, data: { active: false } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  await db.user.update({ where: { id: f.operator.userId }, data: { active: true } });
  const override = await db.userPermissionOverride.create({ data: { userId: f.operator.userId, permission: 'practice_communications.mark_used', allowed: false } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  await db.userPermissionOverride.update({ where: { id: override.id }, data: { allowed: true } });
  await db.clientService.update({ where: { id: f.service.id }, data: { status: 'sospeso' } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  await db.clientService.update({ where: { id: f.service.id }, data: { status: 'richiesto' } });
  await db.user.update({ where: { id: f.admin.userId }, data: { role: 'consulente' } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  await db.user.update({ where: { id: f.admin.userId }, data: { role: 'admin' } });
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: null } });
  await qualifyCommunicationMailbox(db, f.admin, { mailboxId: f.box.id, expectedRevision: f.box.revision, action: 'DISABLE' });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('SENDER_NOT_READY'));
  assert.deepEqual(await footprint(binding.messageId), before);
});

test('M4 attachment bytes, access and audit failure fail atomically without creating an attempt', { skip: !enabled }, async () => {
  const f = await fixture(), binding = await approved(f), input = { ...binding, requestId: randomUUID() }, before = await footprint(binding.messageId);
  await assert.rejects(prepareManualMessage(db, f.operator, input, { readDocument: async () => Buffer.from('changed') }), failure('DENIED'));
  await assert.rejects(prepareManualMessage(db, f.operator, input, { ...runtime, failAudit: true }), /SYNTHETIC_M4_AUDIT_FAILURE/);
  assert.deepEqual(await footprint(binding.messageId), before);
  await db.document.update({ where: { id: f.doc.id }, data: { containsSensitiveData: true } });
  await assert.rejects(prepareManualMessage(db, f.operator, input, runtime), failure('DENIED'));
  assert.equal((await readPracticeCommunications(db, f.operator, f.context)).messages.length, 0);
  assert.equal((await readPracticeCommunications(db, f.admin, f.context)).messages.length, 1);
});

test('M4 replies deduplicate aliases, retain ambiguous inputs, and require an explicit scoped link', { skip: !enabled }, async () => {
  const f = await fixture(), binding = await approved(f);
  await prepareManualMessage(db, f.operator, { ...binding, requestId: randomUUID() }, runtime);
  const beforeAlias = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'info@finanzaagevolaimpresa.it' } });
  const alias = await configureCommunicationMailbox(db, f.admin, { mailboxId: beforeAlias.id, expectedRevision: beforeAlias.revision, kind: 'ALIAS', canonicalMailboxId: f.box.id,
    providerReference: 'SYNTHETIC_ALIAS', responsibleUserId: f.admin.userId, canSend: true, canReceive: true, restricted: false, configurationReference: 'SYNTHETIC_ALIAS_CONFIG' });
  await qualifyCommunicationMailbox(db, f.admin, { mailboxId: alias.id, expectedRevision: alias.revision, action: 'TEST', testReference: 'SYNTHETIC_ALIAS_TEST' });
  const input = { mailboxId: f.box.id, externalMessageId: `<${randomUUID()}@invalid.test>`, inReplyTo: `<fai-${binding.messageId}-v1@crm.finanzaagevolaimpresa.it>`,
    sender: 'client@invalid.test', subject: 'Synthetic reply', body: 'Synthetic answer', receivedAt: new Date().toISOString(), evidenceReference: 'SYNTHETIC_RECEIVED' };
  const reply = await acquireManualReply(db, f.admin, input), replay = await acquireManualReply(db, f.admin, { ...input, mailboxId: alias.id });
  assert.equal(reply.id, replay.id); assert.equal(reply.messageId, binding.messageId);
  await assert.rejects(db.communicationReply.update({ where: { id: reply.id }, data: { body: 'Overwritten received evidence' } }));
  await assert.rejects(acquireManualReply(db, f.admin, { ...input, body: 'Different body for identical external ID' }), failure('CONFLICT'));
  const ambiguous = await acquireManualReply(db, f.admin, { ...input, externalMessageId: `<${randomUUID()}@invalid.test>`, inReplyTo: 'Ambiguous subject is not authority' });
  assert.equal(ambiguous.messageId, null);
  await assert.rejects(linkAmbiguousReply(db, f.operator, { replyId: ambiguous.id, messageId: binding.messageId, reason: 'Synthetic verified link' }), failure('DENIED'));
  await linkAmbiguousReply(db, f.admin, { replyId: ambiguous.id, messageId: binding.messageId, reason: 'Synthetic identity and content verified' });
  assert.equal((await readPracticeCommunications(db, f.operator, f.context)).messages[0].replies.length, 2);
  assert.equal((await readCommunicationAdministration(db, f.admin)).replies.some(item => item.id === ambiguous.id), false);
});

test('M4 complaint content cannot be disclosed by reclassifying a later revision', { skip: !enabled }, async () => {
  const f = await fixture();
  const saved = await saveApprovedMessageDraft(db, f.admin, { ...f.input, classification: 'COMPLAINT' }, runtime);
  assert.equal((await readPracticeCommunications(db, f.operator, f.context)).messages.length, 0);
  await assert.rejects(saveApprovedMessageDraft(db, f.admin, { ...f.input, expectedRevision: saved.revision, classification: 'ORDINARY' }, runtime), failure('DENIED'));
  const outsider = await user('consulente');
  await assert.rejects(readPracticeCommunications(db, outsider, f.context), failure('DENIED'));
  const otherBox = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'documenti@finanzaagevolaimpresa.it' } });
  const restricted = await configureCommunicationMailbox(db, f.admin, { mailboxId: otherBox.id, expectedRevision: otherBox.revision,
    kind: 'MAILBOX', canonicalMailboxId: null, providerReference: 'SYNTHETIC_PRIVATE', responsibleUserId: f.admin.userId,
    canSend: true, canReceive: true, restricted: true, configurationReference: 'SYNTHETIC_PRIVATE_CONFIG' });
  await assert.rejects(configureCommunicationMailbox(db, f.admin, { mailboxId: restricted.id, expectedRevision: restricted.revision,
    kind: 'MAILBOX', canonicalMailboxId: null, providerReference: 'SYNTHETIC_PUBLIC', responsibleUserId: f.admin.userId,
    canSend: true, canReceive: true, restricted: false, configurationReference: 'SYNTHETIC_DOWNGRADE' }), failure('DENIED'));
});


test('M4 an editor waiting for the row lock cannot overwrite a concurrent prepared message', { skip: !enabled, timeout: 30_000 }, async () => {
  const f = await fixture(), binding = await approved(f), preparer = await user('admin');
  let readReady = () => {}, releaseRead = () => {};
  const existingRead = new Promise<void>(resolve => { readReady = resolve; });
  const continueEdit = new Promise<void>(resolve => { releaseRead = resolve; });
  // Hold the real editor transaction after its initial read, before FOR UPDATE.
  // Preparation uses another authenticated user and a separate PostgreSQL transaction.
  const editorDb = db.$extends({ query: { approvedCommunication: {
    async findUnique({ args, query }) {
      const row = await query(args);
      if (args.where.id === binding.messageId && !args.include) {
        readReady(); await continueEdit;
      }
      return row;
    },
  } } }) as unknown as PrismaClient;
  const editing = saveApprovedMessageDraft(editorDb, f.operator,
    { ...f.input, expectedRevision: 1, body: 'Concurrent edit must not replace the prepared message.' }, runtime)
    .then(value => ({ value, error: null }), error => ({ value: null, error }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([existingRead, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('EDITOR_READ_BARRIER_TIMEOUT')), 10_000);
    })]);
    const prepared = await prepareManualMessage(db, preparer, { ...binding, requestId: randomUUID() }, runtime);
    releaseRead();
    const edited = await editing;
    assert.equal(edited.value, null);
    assert.ok(failure('CONFLICT')(edited.error));
    const state = await footprint(binding.messageId);
    assert.equal(state.row?.state, 'SENDING'); assert.equal(state.row?.currentRevision, 1);
    assert.equal(state.versions, 1); assert.equal(state.attempts, 1);
    await recordManualMessageEvidence(db, preparer, { messageId: binding.messageId, attemptId: prepared.attemptId,
      reconciliation: false, evidence: { method: 'MANUAL_DECLARATION', outcome: 'SENT',
        occurredAt: new Date().toISOString(), reference: 'SYNTHETIC_CONCURRENT_SEND_OUTCOME' } });
    assert.equal((await footprint(binding.messageId)).row?.state, 'SENT');
    assert.equal((await db.communicationAttempt.findUniqueOrThrow({ where: { id: prepared.attemptId } })).state, 'SENT');
  } finally {
    clearTimeout(timeout); releaseRead(); await editing;
  }
});
