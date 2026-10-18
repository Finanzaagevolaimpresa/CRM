import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { syntheticUpdateMailbox } from './record-updates/email-fixtures';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from './record-updates/communication-fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewRecordUpdate, confirmRecordUpdate, readRecordUpdateSetup } from '../src/lib/record-updates';
import { listRecordUpdates } from '../src/lib/record-update-delivery';
import { readRecordUpdateEmailQueue, readRecordUpdateEmailPrefill } from '../src/lib/record-update-email-queue';
import { saveApprovedMessageDraft, readPracticeCommunications, loadOrdinaryMessageCandidateContext, submitApprovedMessage, approveExactMessage } from '../src/lib/approved-communications';
import { emptyCommunicationRecipientSelection } from '../src/lib/communication-recipient-policy';
import type { UpdateCommand } from '../src/lib/record-update-input';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.RECORD_UPDATE_EMAIL_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, box: Awaited<ReturnType<typeof syntheticUpdateMailbox>>;
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); box = await syntheticUpdateMailbox(db, admin.session); } });
after(async () => db.$disconnect());
const proof = () => ({ key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: admin.user.id, sessionToken: admin.token }) });
async function fixture(kind: 'LEAD' | 'CLIENT' | 'PRACTICE' = 'LEAD', commercial = false) {
  const reader = await syntheticPerson(db, 'Selected email person', commercial ? 'commerciale' : 'admin');
  const other = await syntheticPerson(db, 'Not selected');
  if (commercial) await db.userPermissionOverride.createMany({ data: [
    { userId: reader.user.id, permission: 'practice_communications.read', allowed: true },
    { userId: reader.user.id, permission: 'document.sensitive.read', allowed: false },
  ] });
  let id: string;
  if (kind === 'LEAD') id = (await db.lead.create({ data: { firstName: 'Synthetic', lastName: randomUUID(), assignedToId: reader.user.id, notes: 'PRIVATE-NOTE-EXCLUDED' } })).id;
  else {
    const client = await db.client.create({ data: { displayName: 'Synthetic ' + randomUUID(), type: 'societa', salesOwnerId: reader.user.id } });
    id = kind === 'CLIENT' ? client.id : (await db.technicalPractice.create({ data: { clientId: client.id, title: 'Synthetic practice',
      practiceType: 'test', targetEntity: 'synthetic', technicalOwnerId: reader.user.id, createdById: admin.user.id } })).id;
  }
  return { kind, id, reader, other };
}
async function command(f: Awaited<ReturnType<typeof fixture>>, mode: UpdateCommand['mode'] = 'EMAIL_DRAFT', operation: UpdateCommand['operation'] = 'UPDATE'): Promise<UpdateCommand> {
  const setup = await readRecordUpdateSetup(db, admin.session, f.kind, f.id);
  let patch = setup.patch;
  if (patch.kind === 'LEAD') patch = { ...patch, nextActionNote: 'PRIVATE-NEXT-ACTION-' + randomUUID() };
  if (patch.kind === 'CLIENT') patch = { ...patch, displayName: 'Synthetic changed ' + randomUUID() };
  if (patch.kind === 'PRACTICE') patch = { ...patch, status: 'in_progettazione' };
  return { commandId: randomUUID(), kind: f.kind, recordId: f.id, mode, operation, expectedVersion: setup.expectedVersion,
    ruleVersion: setup.rule?.version ?? 0, selection: { people: [f.reader.user.id], groups: [] },
    events: ['STATE_CHANGED', 'RECORD_CHANGED', 'NEXT_ACTION', 'DEADLINE', 'COMMUNICATION'], persistent: false, expiresAt: null,
    patch: operation === 'UPDATE' ? patch : null };
}
async function commit(input: UpdateCommand) {
  const preview = await previewRecordUpdate(db, admin.session, input);
  return confirmRecordUpdate(db, admin.session, input, preview.digest, proof());
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, mode: UpdateCommand['mode'] = 'EMAIL_DRAFT', persistent = false) {
  await commit({ ...await command(f, mode), persistent });
  const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id } } });
  return { work, prefill: await readRecordUpdateEmailPrefill(db, admin.session, work.id) };
}
function draft(p: Awaited<ReturnType<typeof readRecordUpdateEmailPrefill>>) {
  const selection = emptyCommunicationRecipientSelection(); selection.to.userIds = [p.recipientId];
  return { messageId: p.deliveryId, expectedRevision: 0, context: p.context, mailboxId: box.id, replyTo: box.address,
    to: [] as string[], cc: [] as string[], bcc: [] as string[], recipientSelection: selection,
    subject: p.subject, body: p.body, attachmentVersionIds: [], contextFileIds: [] as string[], classification: 'ORDINARY',
    updateSource: { deliveryId: p.deliveryId, sourceHash: p.sourceHash } };
}
const currentMessage = (id: string) => db.$transaction(tx => loadOrdinaryMessageCandidateContext(tx, admin.session, id));
const versions = (id: string) => db.communicationVersion.count({ where: { messageId: id } });

for (const kind of ['LEAD', 'CLIENT', 'PRACTICE'] as const) test(kind + ': native selected event to read-only proposal to exact unapproved draft', options, async () => {
  const f = await fixture(kind), before = await db.approvedCommunication.count(), { work, prefill } = await prepare(f);
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  assert.equal((await readRecordUpdateEmailQueue(db, admin.session)).some(r => r.deliveryId === work.id), true);
  assert.equal(await db.approvedCommunication.count(), before, 'GET must not save a draft');
  const saved = await saveApprovedMessageDraft(db, admin.session, draft(prefill));
  const loaded = await currentMessage(saved.id);
  assert.equal(loaded.row.updateDeliveryId, work.id); assert.equal(loaded.row.state, 'DRAFT');
  assert.equal(loaded.version.approval, null); assert.equal(loaded.version.updateSourceHash, prefill.sourceHash);
  assert.deepEqual(loaded.snapshot.to, [f.reader.user.email]); assert.deepEqual(loaded.snapshot.cc, []); assert.deepEqual(loaded.snapshot.bcc, []);
  assert.equal(await db.ordinaryEmailDecision.count({ where: { messageId: saved.id } }), 0);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: saved.id } }), 0);
  assert.doesNotMatch(JSON.stringify(loaded.snapshot), /PRIVATE-NOTE|PRIVATE-NEXT-ACTION/);
  assert.equal((await readPracticeCommunications(db, f.other.session, prefill.context)).messages.some(m => m.id === saved.id), false);
});

test('invalid historical record labels deny only the affected email proposal', options, async () => {
  const f = await fixture(), { work } = await prepare(f);
  await db.lead.update({ where: { id: f.id }, data: { firstName: 'a'.repeat(250) } });
  assert.equal((await readRecordUpdateEmailQueue(db, admin.session)).some(r => r.deliveryId === work.id), false);
  await assert.rejects(readRecordUpdateEmailPrefill(db, admin.session, work.id));
  assert.equal(await db.approvedCommunication.count({ where: { updateDeliveryId: work.id } }), 0);
});

test('CRM remains the historical default and combined mode adds exactly one available CRM notice', options, async () => {
  const f = await fixture(); await commit(await command(f, 'CRM'));
  const crm = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id } } });
  await assert.rejects(readRecordUpdateEmailPrefill(db, admin.session, crm.id));
  const combined = await fixture(), { work } = await prepare(combined, 'CRM_AND_EMAIL_DRAFT');
  assert.equal((await listRecordUpdates(db, combined.reader.session)).length, 1);
  assert.equal((await readRecordUpdateEmailQueue(db, admin.session)).filter(r => r.deliveryId === work.id).length, 1);
});

test('Admin role alone does not acquire the personal email authority', options, async () => {
  const f = await fixture(), input = await command(f), { prefill } = await prepare(f);
  const fresh = await readRecordUpdateSetup(db, f.other.session, f.kind, f.id);
  assert.equal(fresh.emailDraftsAvailable, false);
  await assert.rejects(previewRecordUpdate(db, f.other.session, { ...input, expectedVersion: fresh.expectedVersion }));
  await assert.rejects(readRecordUpdateEmailQueue(db, f.other.session));
  await assert.rejects(readRecordUpdateEmailPrefill(db, f.other.session, prefill.deliveryId));
  await assert.rejects(saveApprovedMessageDraft(db, f.other.session, draft(prefill)));
});

test('forged origin, context, recipient, CC/BCC, source hash and ordinary-message conversion are rejected', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f), input = draft(prefill);
  const second = await fixture();
  for (const mutation of [
    { messageId: randomUUID() }, { context: { kind: 'LEAD', id: second.id } },
    { to: ['forged@invalid.test'] }, { cc: [f.other.user.email] }, { bcc: [f.other.user.email] },
    { updateSource: { ...input.updateSource, sourceHash: 'a'.repeat(64) } },
    { recipientSelection: { ...input.recipientSelection, to: { userIds: [f.other.user.id], groups: [] } } },
  ]) await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...input, ...mutation }));
  assert.equal(await versions(input.messageId), 0);
});

test('concurrent first saves and lost-response retry cannot duplicate the draft, version or audit', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f), input = draft(prefill);
  const outcomes = await Promise.allSettled([1, 2].map(() => saveApprovedMessageDraft(db, admin.session, input)));
  assert.ok(outcomes.some(r => r.status === 'fulfilled'));
  assert.equal(await versions(input.messageId), 1);
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, input));
  assert.equal((await readRecordUpdateEmailPrefill(db, admin.session, input.messageId)).saved, true);
  assert.equal(await versions(input.messageId), 1);
  assert.equal(await db.communicationEvent.count({ where: { messageId: input.messageId, event: 'DRAFT_SAVED' } }), 1);
});

test('native audit failure rolls back origin, version and draft together', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f), input = draft(prefill);
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, input, { failAudit: true }));
  assert.equal(await versions(input.messageId), 0);
  assert.equal(await db.approvedCommunication.count({ where: { updateDeliveryId: input.messageId } }), 0);
});

test('editing creates a new version without inheriting an earlier exact approval', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f), input = draft(prefill);
  const saved = await saveApprovedMessageDraft(db, admin.session, input);
  const transition = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, admin.session, transition); await approveExactMessage(db, admin.session, transition);
  const edited = await saveApprovedMessageDraft(db, admin.session, { ...input, expectedRevision: 1, body: 'Nuovo testo sintetico scelto personalmente.' });
  const loaded = await currentMessage(edited.id);
  assert.equal(loaded.version.revision, 2); assert.equal(loaded.version.approval, null); assert.equal(loaded.row.state, 'DRAFT');
  assert.equal(await db.communicationApproval.count({ where: { version: { messageId: saved.id } } }), 1);
});

test('record changes invalidate an open prefill and approval; a fresh explicit version is required', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f), input = draft(prefill);
  const saved = await saveApprovedMessageDraft(db, admin.session, input);
  await db.lead.update({ where: { id: f.id }, data: { firstName: 'Changed synthetic record', updatedAt: new Date(Date.now() + 1) } });
  await assert.rejects(currentMessage(saved.id));
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...input, expectedRevision: 1 }));
  const current = await readRecordUpdateEmailPrefill(db, admin.session, saved.id);
  assert.notEqual(current.sourceHash, prefill.sourceHash);
  const refreshed = await saveApprovedMessageDraft(db, admin.session, { ...draft(current), expectedRevision: 1, body: 'Riepilogo rivalutato.' });
  assert.equal(refreshed.revision, 2); assert.ok(await currentMessage(saved.id));
});

for (const change of ['revocation', 'expiry', 'permission', 'email', 'trash', 'owner', 'authority'] as const)
test(change + ': current admission blocks pending drafts and re-grant does not resurrect them', options, async () => {
  const f = await fixture();
  await commit(await command(f, 'EMAIL_DRAFT', 'RULE'));
  await db.lead.update({ where: { id: f.id }, data: { nextActionNote: randomUUID() } });
  const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id } } });
  const prefill = await readRecordUpdateEmailPrefill(db, admin.session, work.id);
  const saved = await saveApprovedMessageDraft(db, admin.session, draft(prefill));
  if (change === 'revocation') await commit(await command(f, 'CRM', 'REVOKE'));
  if (change === 'expiry') await db.recordUpdateRule.update({ where: { id: work.ruleId! }, data: { expiresAt: new Date(Date.now() - 1) } });
  if (change === 'permission') await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'lead.read', allowed: false } });
  if (change === 'email') await db.user.update({ where: { id: f.reader.user.id }, data: { email: randomUUID() + '@invalid.test' } });
  if (change === 'trash') await db.lead.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
  if (change === 'owner') await db.lead.update({ where: { id: f.id }, data: { assignedToId: f.other.user.id } });
  if (change === 'authority') await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: { enabled: false, revision: { increment: 1 } } });
  await assert.rejects(readRecordUpdateEmailPrefill(db, admin.session, work.id)); await assert.rejects(currentMessage(saved.id));
  if (change !== 'authority') assert.equal((await readRecordUpdateEmailQueue(db, admin.session)).some(r => r.deliveryId === work.id), false);
  if (change === 'permission') await db.userPermissionOverride.update({ where: { userId_permission: { userId: f.reader.user.id, permission: 'lead.read' } }, data: { allowed: true } });
  if (change === 'email') await db.user.update({ where: { id: f.reader.user.id }, data: { email: f.reader.user.email } });
  if (change === 'trash') await db.lead.update({ where: { id: f.id }, data: { deletedAt: null } });
  if (change === 'owner') await db.lead.update({ where: { id: f.id }, data: { assignedToId: f.reader.user.id } });
  if (change === 'authority') await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: { enabled: true, revision: { increment: 1 } } });
  await assert.rejects(currentMessage(saved.id));
  assert.equal(await versions(saved.id), 1); assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: saved.id } }), 0);
});

test('communication events keep native source privacy and inbound conflicts at draft save', options, async () => {
  for (const privacy of ['SENSITIVE', 'COMPLAINT', 'reply-conflict'] as const) {
    const f = await fixture('LEAD', true);
    await commit(await command(f, 'EMAIL_DRAFT', 'RULE'));
    const source = await storedNoticeMessage(db, { leadId: f.id, authorId: admin.user.id, classification: privacy === 'reply-conflict' ? 'ORDINARY' : privacy });
    if (privacy !== 'reply-conflict') {
      await db.approvedCommunication.update({ where: { id: source.message.id }, data: { state: 'SENT' } });
      const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id } } });
      await assert.rejects(readRecordUpdateEmailPrefill(db, admin.session, work.id));
    } else {
      const linked = await linkedOrdinaryNoticeReply(db, source.message.id, source.mailbox.id, admin.user.id);
      const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id } } });
      const prefill = await readRecordUpdateEmailPrefill(db, admin.session, work.id);
      await linked.conflict();
      await assert.rejects(saveApprovedMessageDraft(db, admin.session, draft(prefill)));
      assert.equal(await versions(work.id), 0);
    }
  }
});

test('derived messages and linked replies do not recursively create new update work', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f, 'EMAIL_DRAFT', true);
  const saved = await saveApprovedMessageDraft(db, admin.session, draft(prefill));
  const before = await db.recordUpdateDelivery.count({ where: { event: { recordId: f.id } } });
  // Synthetic history only; this does not invoke a send or claim SMTP acceptance.
  await db.approvedCommunication.update({ where: { id: saved.id }, data: { state: 'SENT' } });
  await linkedOrdinaryNoticeReply(db, saved.id, box.id, admin.user.id);
  assert.equal(await db.recordUpdateDelivery.count({ where: { event: { recordId: f.id } } }), before);
});

test('origin and immutable version provenance cannot be detached or rewritten', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f);
  const saved = await saveApprovedMessageDraft(db, admin.session, draft(prefill));
  await assert.rejects(db.approvedCommunication.update({ where: { id: saved.id }, data: { updateDeliveryId: null } }));
  await assert.rejects(db.communicationVersion.updateMany({ where: { messageId: saved.id }, data: { updateSourceHash: 'f'.repeat(64) } }));
  await assert.rejects(db.recordUpdateDelivery.update({ where: { id: saved.id }, data: { mode: 'CRM' } }));
});

test('revoked actual session cannot consult or save a stale email proposal', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f);
  const expired = { ...admin.session, expiresAt: Math.floor(Date.now() / 1000) - 1 };
  await assert.rejects(readRecordUpdateEmailPrefill(db, expired, prefill.deliveryId));
  await assert.rejects(saveApprovedMessageDraft(db, expired, draft(prefill)));
  assert.equal(await versions(prefill.deliveryId), 0);
});

test('selected recipient attachment admission and revocation remain live through exact candidate loading', options, async () => {
  const f = await fixture('LEAD', true), { prefill } = await prepare(f);
  const bytes = Buffer.from('SYNTHETIC UPDATE ATTACHMENT'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await db.communicationContextFile.create({ data: { contextKind: 'LEAD', leadId: f.id, uploadedById: admin.user.id,
    fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256, storagePath: 'synthetic/' + randomUUID() } });
  const input = { ...draft(prefill), contextFileIds: [file.id] }, runtime = { readDocument: async () => bytes };
  const saved = await saveApprovedMessageDraft(db, admin.session, input, runtime);
  const load = () => db.$transaction(tx => loadOrdinaryMessageCandidateContext(tx, admin.session, saved.id, runtime));
  assert.equal((await load()).snapshot.attachments.length, 1);
  await db.communicationContextFile.update({ where: { id: file.id }, data: { revokedAt: new Date() } });
  await assert.rejects(load());
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...input, expectedRevision: 1 }, runtime));
  assert.equal(await versions(saved.id), 1);
});

test('a temporary change in a selected group cannot resurrect an earlier draft', options, async () => {
  const f = await fixture('LEAD', true), input = await command(f, 'EMAIL_DRAFT', 'RULE');
  input.selection = { people: [], groups: ['commerciali'] };
  await commit(input);
  await db.lead.update({ where: { id: f.id }, data: { nextActionNote: randomUUID() } });
  const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: f.id }, recipientId: f.reader.user.id } });
  const prefill = await readRecordUpdateEmailPrefill(db, admin.session, work.id);
  const person = await syntheticPerson(db, 'Temporary group member', 'consulente');
  await db.user.update({ where: { id: person.user.id }, data: { role: 'commerciale' } });
  await db.user.update({ where: { id: person.user.id }, data: { role: 'consulente' } });
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, draft(prefill)));
  assert.equal(await versions(work.id), 0);
});

test('concurrent trash wins before draft admission and leaves no partial origin or audit', options, async () => {
  const f = await fixture(), { prefill } = await prepare(f);
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>(resolve => { locked = resolve; });
  const go = new Promise<void>(resolve => { release = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${f.id} FOR UPDATE`;
    locked(); await go;
    await tx.lead.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
  });
  await held;
  const saving = saveApprovedMessageDraft(db, admin.session, draft(prefill));
  const rejected = assert.rejects(saving);
  release(); await writer; await rejected;
  assert.equal(await versions(prefill.deliveryId), 0);
  assert.equal(await db.communicationEvent.count({ where: { messageId: prefill.deliveryId } }), 0);
});

test('recipient classification permissions are enforced when saving a selected email draft', options, async () => {
  const f = await fixture('LEAD', true), { prefill } = await prepare(f);
  for (const classification of ['SENSITIVE', 'COMPLAINT'])
    await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...draft(prefill), classification }));
  assert.equal(await versions(prefill.deliveryId), 0);
});
