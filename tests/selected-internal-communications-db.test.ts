import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { contextFixture, contextThread, contextDraft, contextPerson } from './admin-email/fixture';
import { saveApprovedMessageDraft, submitApprovedMessage, approveExactMessage, loadOrdinaryMessageCandidateContext, readPracticeCommunications } from '../src/lib/approved-communications';
import { readSelectedInternalCommunications } from '../src/lib/selected-internal-communications';
import { previewInternalCommunication, confirmInternalCommunication } from '../src/lib/internal-communications';
const enabled = process.env.CI === 'true' && process.env.RUN_DB_TESTS === '1' && process.env.SELECTED_INTERNAL_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
after(async () => db.$disconnect());
async function fixture() {
  const f = await contextFixture(db), thread = await contextThread(db, f), context = { kind: 'INTERNAL' as const, id: thread.id };
  return { ...f, thread, context };
}
async function publish(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  const input = { ...contextDraft(f, f.context), shareInternalText: true, internalReadingExpiresAt: null, ...extra };
  const saved = await saveApprovedMessageDraft(db, f.owner.actor, input);
  const transition = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, f.owner.actor, transition); await approveExactMessage(db, f.owner.actor, transition);
  return { input, saved, transition };
}
test('private drafts persist but selected readers see neither private body nor the thread title', options, async () => {
  const f = await fixture(), saved = await saveApprovedMessageDraft(db, f.owner.actor, contextDraft(f, f.context));
  assert.equal((await readPracticeCommunications(db, f.owner.actor, f.context)).messages[0].id, saved.id);
  await assert.rejects(readPracticeCommunications(db, f.member.actor, f.context));
  const result = await readSelectedInternalCommunications(db, f.member.actor, f.thread.id);
  assert.equal(result[0].messages.length, 0); assert.notEqual(result[0].title, f.thread.title);
});
test('text becomes readable only after exact approval, with no mailbox, recipients, files or CRM record grants', options, async () => {
  const f = await fixture();
  const saved = await saveApprovedMessageDraft(db, f.owner.actor, { ...contextDraft(f, f.context), shareInternalText: true });
  assert.equal((await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages.length, 0);
  await assert.rejects(db.$transaction(tx => loadOrdinaryMessageCandidateContext(tx, f.owner.actor, saved.id)), /CONTENT_APPROVAL_REQUIRED/);
  const transition = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, f.owner.actor, transition); await approveExactMessage(db, f.owner.actor, transition);
  const text = (await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages[0];
  assert.equal(text.body, 'SYNTHETIC_CONTEXT_BODY');
  assert.deepEqual(Object.keys(text).sort(), ['id', 'revision', 'subject', 'body', 'publishedAt', 'expiresAt'].sort());
  await assert.rejects(readSelectedInternalCommunications(db, f.outsider.actor, f.thread.id));
});
test('the original set shape persists six participants and four distinct email destinations including technical Direzione', options, async () => {
  const f = await fixture();
  const extra = await Promise.all(['direzione', 'commerciale', 'consulente', 'backoffice'].map(role => contextPerson(db, role as 'direzione' | 'commerciale' | 'consulente' | 'backoffice')));
  const participants = [f.member, ...extra];
  await db.userPermissionOverride.create({ data: { userId: extra[0].user.id, permission: 'technical.write', allowed: true } });
  for (const p of participants) await db.userPermissionOverride.create({ data: { userId: p.user.id, permission: 'communications.internal.read', allowed: true } });
  const threadInput = { ...f.thread, expectedVersion: 1, selection: { userIds: participants.map(p => p.user.id), groups: [] } };
  const preview = await previewInternalCommunication(db, f.owner.actor, threadInput, f.credentials);
  await confirmInternalCommunication(db, f.owner.actor, threadInput, preview.evidenceHash, f.credentials);
  const input = contextDraft(f, f.context);
  input.recipientSelection.to.userIds = [f.owner.user.id, f.member.user.id, extra[0].user.id, extra[1].user.id];
  const published = await publish(f, { recipientSelection: input.recipientSelection });
  const row = (await readPracticeCommunications(db, f.owner.actor, f.context)).messages.find(m => m.id === published.saved.id)!;
  assert.equal(row.snapshot.to.length, 4);
  assert.equal(await db.internalCommunicationParticipant.count({ where: { threadId: f.thread.id, active: true } }), 6);
  for (const person of participants) assert.equal((await readSelectedInternalCommunications(db, person.actor, f.thread.id))[0].messages[0].id, published.saved.id);
  await db.$transaction(tx => loadOrdinaryMessageCandidateContext(tx, f.owner.actor, published.saved.id));
});
test('technical private draft can be saved before permission resolution; publication fails with a concrete permission error', options, async () => {
  const f = await fixture(), tech = await contextPerson(db, 'consulente');
  const threadInput = { ...f.thread, expectedVersion: 1, selection: { userIds: [tech.user.id, f.member.user.id], groups: [] } };
  const p = await previewInternalCommunication(db, f.owner.actor, threadInput, f.credentials);
  await confirmInternalCommunication(db, f.owner.actor, threadInput, p.evidenceHash, f.credentials);
  const input = contextDraft(f, f.context); input.recipientSelection.to.userIds = [tech.user.id];
  const saved = await saveApprovedMessageDraft(db, f.owner.actor, { ...input, shareInternalText: true });
  await submitApprovedMessage(db, f.owner.actor, { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash });
  await assert.rejects(approveExactMessage(db, f.owner.actor, { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash }), /RECIPIENT_PERMISSION_REQUIRED/);
});
test('editing the exact body removes publication until a new approval and never reuses the old approval', options, async () => {
  const f = await fixture(), published = await publish(f);
  await saveApprovedMessageDraft(db, f.owner.actor, { ...published.input, expectedRevision: 1, body: 'SYNTHETIC_NEW_BODY' });
  assert.equal((await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages.length, 0);
});
test('permission denial and participant removal revoke current text even from an open session', options, async () => {
  const f = await fixture(); await publish(f);
  await db.userPermissionOverride.create({ data: { userId: f.member.user.id, permission: 'communications.internal.read', allowed: false } });
  await assert.rejects(readSelectedInternalCommunications(db, f.member.actor, f.thread.id));
  const threadInput = { ...f.thread, expectedVersion: 1, selection: { userIds: [], groups: [] } };
  const p = await previewInternalCommunication(db, f.owner.actor, threadInput, f.credentials);
  await confirmInternalCommunication(db, f.owner.actor, threadInput, p.evidenceHash, f.credentials);
  await assert.rejects(readSelectedInternalCommunications(db, f.member.actor, f.thread.id));
});
test('expired publication is hidden while immutable approved source remains with Admin', options, async () => {
  const f = await fixture(); await publish(f, { internalReadingExpiresAt: new Date(Date.now() + 2200).toISOString() });
  assert.equal((await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages.length, 1);
  await new Promise(resolve => setTimeout(resolve, 2250));
  assert.equal((await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages.length, 0);
  assert.equal((await readPracticeCommunications(db, f.owner.actor, f.context)).messages.length, 1);
});
test('selected disclosure cannot be attached to restricted content, files or another context', options, async () => {
  const f = await fixture();
  await assert.rejects(saveApprovedMessageDraft(db, f.owner.actor, { ...contextDraft(f, { kind: 'CLIENT', id: f.client.id }), shareInternalText: true }));
  await assert.rejects(saveApprovedMessageDraft(db, f.owner.actor, { ...contextDraft(f, f.context), shareInternalText: true, contextFileIds: [randomUUID()] }));
});

test('changed participant permissions require an explicit fresh version before approval, preserving the original', options, async () => {
  const f = await fixture();
  const input = { ...contextDraft(f, f.context), shareInternalText: true };
  const first = await saveApprovedMessageDraft(db, f.owner.actor, input);
  await db.userPermissionOverride.create({ data: {
    userId: f.member.user.id, permission: 'video.read', allowed: false,
  } });
  const stale = { messageId: first.id, expectedRevision: first.revision, snapshotHash: first.snapshotHash };
  await submitApprovedMessage(db, f.owner.actor, stale);
  await assert.rejects(approveExactMessage(db, f.owner.actor, stale), /SHARING_CHANGED/);
  assert.equal(await db.communicationApproval.count({ where: { version: { messageId: first.id } } }), 0);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: first.id } }), 0);
  const refreshed = await saveApprovedMessageDraft(db, f.owner.actor, { ...input, expectedRevision: first.revision });
  assert.equal(refreshed.id, first.id); assert.equal(refreshed.revision, 2);
  const current = { messageId: refreshed.id, expectedRevision: refreshed.revision, snapshotHash: refreshed.snapshotHash };
  await submitApprovedMessage(db, f.owner.actor, current); await approveExactMessage(db, f.owner.actor, current);
  const versions = await db.communicationVersion.findMany({ where: { messageId: first.id }, orderBy: { revision: 'asc' } });
  assert.equal(versions.length, 2);
  assert.equal(versions[0].snapshotHash, first.snapshotHash);
  const view = (await readSelectedInternalCommunications(db, f.member.actor, f.thread.id))[0].messages;
  assert.equal(view.length, 1); assert.equal(view[0].revision, 2);
  assert.equal(view[0].body, input.body);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: first.id } }), 0);
});
