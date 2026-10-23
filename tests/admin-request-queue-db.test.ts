import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { syntheticUpdateMailbox } from './record-updates/email-fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { technicalFixture, revokeTechnical, technicalTarget } from './technical-assignments/fixtures';
import { requestFixture, requestInput, requestDraft } from './admin-requests/fixtures';
import { readAdminRequestEntry, submitAdminRequest, changeAdminRequest, readAdminRequest, readAdminRequestQueue,
  readAdminRequestDraftPrefill, readAdminRequestOutcome } from '../src/lib/admin-request-service';
import { saveApprovedMessageDraft, loadOrdinaryMessageCandidateContext, readPracticeCommunications,
  submitApprovedMessage, approveExactMessage } from '../src/lib/approved-communications';
import { revokeAllInternalSessions } from '../src/lib/internal-session-registry';
const enabled = process.env.ADMIN_REQUEST_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Awaited<ReturnType<typeof syntheticAuthority>>, box: Awaited<ReturnType<typeof syntheticUpdateMailbox>>;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db); box = await syntheticUpdateMailbox(db, admin.session);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(() => db.$disconnect());
const fixture = () => requestFixture(db, admin);
const lead = (f: Awaited<ReturnType<typeof fixture>>) => ({ kind: 'Lead' as const, targetId: f.lead.id });
const current = (id: string) => db.$transaction(tx => loadOrdinaryMessageCandidateContext(tx, admin.session, id));
const counts = async (id: string) => {
  const [r] = await db.$queryRaw<Array<{ events: number; audits: number }>>`SELECT
    (SELECT count(*)::int FROM "AdminRequestEvent" WHERE "requestId"=${id}::uuid) AS events,
    (SELECT count(*)::int FROM "AuditLog" a JOIN "AdminRequestEvent" e ON e.id::text=a."entityId" WHERE e."requestId"=${id}::uuid AND a.event='admin_request_changed') AS audits`;
  return r;
};
async function submit(f: Awaited<ReturnType<typeof fixture>>) {
  const input = await requestInput(db, f.salesA, lead(f));
  return { input, receipt: await submitAdminRequest(db, f.salesA.session, input) };
}
async function command(id: string, action: 'REQUEST_INFORMATION' | 'REJECT' | 'AMEND' | 'WITHDRAW') {
  const state = await readAdminRequest(db, admin.session, id);
  return { requestId: id, commandId: randomUUID(), expectedRevision: state.revision, expectedSubmissionSha256: state.submissionSha256,
    action, ...(['REQUEST_INFORMATION', 'REJECT'].includes(action) ? { requesterReply: 'Risposta interna esplicitamente visibile.' }
      : action === 'AMEND' ? { title: 'Integrazione aggiornata', details: 'Chiarimento tecnico aggiunto dall’autore.' } : {}) };
}
test('commercial owners have reciprocal isolation on lead and client; read entry and queue do not write', options, async () => {
  const f = await fixture(), before = await db.auditLog.count();
  await readAdminRequestEntry(db, f.salesA.session, lead(f));
  await readAdminRequestEntry(db, f.salesB.session, { kind: 'Client', targetId: f.otherClient.id });
  await assert.rejects(readAdminRequestEntry(db, f.salesB.session, lead(f)));
  await assert.rejects(readAdminRequestEntry(db, f.salesA.session, { kind: 'Client', targetId: f.otherClient.id }));
  await readAdminRequestQueue(db, f.salesA.session);
  assert.equal(await db.auditLog.count(), before);
});
test('submission creates one internal event and minimal audit, no email, notice or automatic recipient', options, async () => {
  const f = await fixture(), messages = await db.approvedCommunication.count(), { receipt } = await submit(f);
  assert.deepEqual(await counts(receipt.requestId), { events: 1, audits: 1 });
  assert.equal(await db.approvedCommunication.count(), messages);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.eventId } });
  assert.doesNotMatch(JSON.stringify(audit), /Servono|Documento tecnico|invalid.test/);
  assert.equal((await readAdminRequest(db, f.salesA.session, receipt.requestId)).status, 'OPEN');
  await assert.rejects(readAdminRequest(db, f.salesB.session, receipt.requestId));
  assert.equal((await readAdminRequestQueue(db, f.salesB.session, 1, 'Documento tecnico')).items.length, 0);
});
test('parallel duplicate submission and lost response retain one event, exact command/session and receipt', options, async () => {
  const f = await fixture(), input = await requestInput(db, f.salesA, lead(f));
  const results = await Promise.allSettled([submitAdminRequest(db, f.salesA.session, input), submitAdminRequest(db, f.salesA.session, input)]);
  assert(results.some(r => r.status === 'fulfilled'));
  const receipt = await submitAdminRequest(db, f.salesA.session, input);
  assert.deepEqual(await counts(receipt.requestId), { events: 1, audits: 1 });
  assert.equal((await readAdminRequestOutcome(db, f.salesA.session, input.commandId)).status, 'RECORDED');
  await assert.rejects(submitAdminRequest(db, f.salesA.session, { ...input, details: 'Changed replay text' }));
  const otherSession = await syntheticSession(db, f.salesA.user);
  await assert.rejects(readAdminRequestOutcome(db, otherSession.session, input.commandId));
  await assert.rejects(readAdminRequestOutcome(db, f.salesB.session, input.commandId));
});
test('personal email authority, not another Admin role, owns review and draft preparation', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Other synthetic Admin'), { receipt } = await submit(f);
  await assert.rejects(readAdminRequestQueue(db, other.session));
  await assert.rejects(readAdminRequestDraftPrefill(db, other.session, receipt.requestId));
  await assert.rejects(changeAdminRequest(db, f.salesA.session, await command(receipt.requestId, 'REJECT')));
});
test('clarification and author amendment preserve history, then rejection is final without sending', options, async () => {
  const f = await fixture(), { receipt } = await submit(f);
  await changeAdminRequest(db, admin.session, await command(receipt.requestId, 'REQUEST_INFORMATION'));
  let view = await readAdminRequest(db, f.salesA.session, receipt.requestId);
  assert.equal(view.status, 'NEEDS_INFORMATION'); assert.match(view.requesterReply!, /esplicitamente/);
  await changeAdminRequest(db, f.salesA.session, await command(receipt.requestId, 'AMEND'));
  await changeAdminRequest(db, admin.session, await command(receipt.requestId, 'REJECT'));
  view = await readAdminRequest(db, f.salesA.session, receipt.requestId);
  assert.equal(view.status, 'REJECTED'); assert.equal(view.history.length, 4);
  await assert.rejects(readAdminRequestDraftPrefill(db, admin.session, receipt.requestId));
});
test('withdrawal and replay cannot resurrect the request or produce a draft', options, async () => {
  const f = await fixture(), { receipt, input } = await submit(f);
  await changeAdminRequest(db, f.salesA.session, await command(receipt.requestId, 'WITHDRAW'));
  await submitAdminRequest(db, f.salesA.session, input);
  assert.equal((await readAdminRequest(db, f.salesA.session, receipt.requestId)).status, 'WITHDRAWN');
  await assert.rejects(readAdminRequestDraftPrefill(db, admin.session, receipt.requestId));
});
test('ownership A to B to A, archive and session revocation invalidate stale requests without transfers', options, async () => {
  const f = await fixture(), { receipt } = await submit(f);
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.salesB.user.id } });
  await assert.rejects(readAdminRequest(db, admin.session, receipt.requestId));
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.salesA.user.id } });
  await assert.rejects(readAdminRequest(db, f.salesA.session, receipt.requestId));
  const another = await requestInput(db, f.salesA, lead(f));
  await db.lead.update({ where: { id: f.lead.id }, data: { deletedAt: new Date() } });
  await assert.rejects(submitAdminRequest(db, f.salesA.session, another));
  await db.$transaction(tx => revokeAllInternalSessions(tx, f.salesA.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assert.rejects(readAdminRequestQueue(db, f.salesA.session));
});
test('two technicians require the explicit request action; ownership or read-sharing alone is insufficient', options, async () => {
  const f = await fixture();
  for (const person of [f.techA, f.techB]) {
    const input = await requestInput(db, person, technicalTarget(f));
    const receipt = await submitAdminRequest(db, person.session, input);
    assert.equal((await readAdminRequest(db, person.session, receipt.requestId)).authorId, person.user.id);
    await assert.rejects(readAdminRequest(db, person === f.techA ? f.techB.session : f.techA.session, receipt.requestId));
    await assert.rejects(readAdminRequestEntry(db, person.session, { kind: 'Client', targetId: f.client.id }));
  }
  const bare = await technicalFixture(db, admin);
  await assert.rejects(readAdminRequestEntry(db, bare.techA.session, technicalTarget(bare)));
  await assert.rejects(readAdminRequestEntry(db, f.techA.session, { kind: 'Project', targetId: f.otherProject.id }));
});
test('technical revocation suspends review and draft, and preserves separate commercial owner', options, async () => {
  const f = await fixture(), input = await requestInput(db, f.techA, technicalTarget(f));
  const receipt = await submitAdminRequest(db, f.techA.session, input);
  await revokeTechnical(db, admin, technicalTarget(f), f.techA);
  await assert.rejects(readAdminRequestDraftPrefill(db, admin.session, receipt.requestId));
  await assert.rejects(readAdminRequest(db, f.techA.session, receipt.requestId));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).salesOwnerId, f.salesA.user.id);
});
test('draft GET is pure; explicit save links an unapproved exact version with no inherited content or email', options, async () => {
  const f = await fixture(), { receipt } = await submit(f), before = await db.approvedCommunication.count();
  const p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
  assert.equal(await db.approvedCommunication.count(), before);
  assert.equal('body' in p, false); assert.equal('to' in p, false);
  const saved = await saveApprovedMessageDraft(db, admin.session, requestDraft(p, box.address));
  const message = await current(saved.id);
  assert.equal(message.row.state, 'DRAFT'); assert.equal(message.version.approval, null);
  assert.equal(message.requestSource?.requestId, receipt.requestId);
  assert.equal(await db.ordinaryEmailAttempt.count({ where: { messageId: saved.id } }), 0);
  assert.deepEqual(message.snapshot.attachments, []);
  const own = await readAdminRequest(db, f.salesA.session, receipt.requestId);
  assert.equal(own.status, 'DRAFT_PREPARED'); assert.equal(own.draftHref, null);
  assert.doesNotMatch(JSON.stringify(own), /synthetic-recipient|Testo composto|mailboxId|snapshotHash/);
  await assert.rejects(changeAdminRequest(db, f.salesA.session, await command(receipt.requestId, 'WITHDRAW')));
});
test('edits create a fresh exact version, invalidate approval and require the retained request origin', options, async () => {
  const f = await fixture(), { receipt } = await submit(f), p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
  const input = requestDraft(p, box.address), saved = await saveApprovedMessageDraft(db, admin.session, input);
  const bind = { messageId: saved.id, expectedRevision: saved.revision, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, admin.session, bind); await approveExactMessage(db, admin.session, bind);
  const changed = await saveApprovedMessageDraft(db, admin.session, { ...input, expectedRevision: 1, body: 'Testo personale rivisto esattamente.' });
  assert.equal(changed.revision, 2); assert.equal((await current(saved.id)).version.approval, null);
  const { requestSource: omitted, ...without } = input; assert(omitted);
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...without, expectedRevision: 2 }));
  await assert.rejects(approveExactMessage(db, admin.session, bind));
});
test('a stale prefill cannot save; a changed origin blocks decision/send context even after drafting', options, async () => {
  const f = await fixture(), { receipt } = await submit(f), p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
  await changeAdminRequest(db, f.salesA.session, await command(receipt.requestId, 'AMEND'));
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, requestDraft(p, box.address)));
  const fresh = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
  const saved = await saveApprovedMessageDraft(db, admin.session, requestDraft(fresh, box.address));
  await db.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.salesB.user.id } });
  await assert.rejects(current(saved.id));
  assert.equal((await readPracticeCommunications(db, admin.session, fresh.context)).messages.some(m => m.id === saved.id), false);
});
test('project origin uses its real client, practice its real context; unrelated context cannot replace either', options, async () => {
  const f = await fixture();
  for (const kind of ['Project', 'TechnicalPractice'] as const) {
    const input = await requestInput(db, f.techA, technicalTarget(f, kind)), receipt = await submitAdminRequest(db, f.techA.session, input);
    const p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
    assert.deepEqual(p.context, kind === 'Project' ? { kind: 'CLIENT', id: f.client.id } : { kind: 'TECHNICAL', id: f.practice.id });
    await assert.rejects(saveApprovedMessageDraft(db, admin.session, { ...requestDraft(p, box.address), context: { kind: 'CLIENT', id: f.otherClient.id } }));
    await saveApprovedMessageDraft(db, admin.session, requestDraft(p, box.address));
  }
});
test('request audit failure rolls back request, event and receipt together', options, async () => {
  const f = await fixture(), input = await requestInput(db, f.salesA, lead(f));
  await db.$executeRawUnsafe(`CREATE FUNCTION synthetic_request_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='admin_request_changed' THEN RAISE EXCEPTION 'SYNTHETIC_REQUEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_request_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_request_audit_fault()');
  try { await assert.rejects(submitAdminRequest(db, f.salesA.session, input)); assert.deepEqual(await counts(input.commandId), { events: 0, audits: 0 }); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER synthetic_request_audit_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION synthetic_request_audit_fault()'); }
  assert.equal((await readAdminRequestOutcome(db, f.salesA.session, input.commandId)).status, 'NOT_FOUND');
});
test('append-only history, atomic events and no hidden grant or email fields in submission', options, async () => {
  const f = await fixture(), { receipt, input } = await submit(f);
  await assert.rejects(db.$executeRaw`DELETE FROM "AdminRequestEvent" WHERE "requestId"=${receipt.requestId}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE "AdminRequest" SET revision=revision+1,state=jsonb_set(state,'{revision}',to_jsonb(revision+1)) WHERE id=${receipt.requestId}::uuid`);
  await assert.rejects(submitAdminRequest(db, f.salesA.session, { ...input, commandId: randomUUID(), to: ['hidden@invalid.test'] }));
  assert.deepEqual(await counts(receipt.requestId), { events: 1, audits: 1 });
});

test('Admin reviews current requester identity after the old requester session closes, without impersonation', options, async () => {
  const f = await fixture(), { receipt } = await submit(f);
  await db.internalSession.update({ where: { id: f.salesA.session.sessionId! }, data: {
    revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: admin.user.id } });
  await assert.rejects(readAdminRequest(db, f.salesA.session, receipt.requestId));
  const current = await readAdminRequest(db, admin.session, receipt.requestId);
  assert.equal(current.authorId, f.salesA.user.id); assert.equal(current.status, 'OPEN');
  await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
});

test('concurrent first draft save and a repeated save cannot create another version or approval', options, async () => {
  const f = await fixture(), { receipt } = await submit(f);
  const p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId), input = requestDraft(p, box.address);
  const result = await Promise.allSettled([saveApprovedMessageDraft(db, admin.session, input), saveApprovedMessageDraft(db, admin.session, input)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(saveApprovedMessageDraft(db, admin.session, input));
  assert.equal(await db.communicationVersion.count({ where: { messageId: receipt.requestId } }), 1);
  assert.equal(await db.communicationApproval.count({ where: { version: { messageId: receipt.requestId } } }), 0);
  assert.deepEqual(await counts(receipt.requestId), { events: 2, audits: 2 });
  assert.equal((await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId)).saved, true);
});

test('draft audit failure rolls back message, version, link and request transition together', options, async () => {
  const f = await fixture(), { receipt } = await submit(f);
  const p = await readAdminRequestDraftPrefill(db, admin.session, receipt.requestId);
  await db.$executeRawUnsafe("CREATE FUNCTION synthetic_request_draft_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='admin_request_changed' AND NEW.after->>'operation'='PREPARE_DRAFT' THEN RAISE EXCEPTION 'SYNTHETIC_DRAFT_FAULT'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_request_draft_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_request_draft_fault()');
  try {
    await assert.rejects(saveApprovedMessageDraft(db, admin.session, requestDraft(p, box.address)));
    assert.equal(await db.approvedCommunication.findUnique({ where: { id: receipt.requestId } }), null);
    assert.equal(await db.communicationVersion.count({ where: { messageId: receipt.requestId } }), 0);
    assert.deepEqual(await counts(receipt.requestId), { events: 1, audits: 1 });
    assert.equal((await readAdminRequest(db, admin.session, receipt.requestId)).status, 'OPEN');
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_request_draft_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_request_draft_fault()');
  }
});

test('a deferred audit mismatch is reported as failure before a submission receipt can escape', options, async () => {
  const f = await fixture(), input = await requestInput(db, f.salesA, lead(f));
  await db.$executeRawUnsafe(`CREATE FUNCTION synthetic_request_audit_mismatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='admin_request_changed' THEN NEW.after=jsonb_set(NEW.after,'{action}','"REJECT"'::jsonb); END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_request_audit_mismatch BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_request_audit_mismatch()');
  try {
    await assert.rejects(submitAdminRequest(db, f.salesA.session, input), /ADMIN_REQUEST_ATOMIC_EVENT_AUDIT_REQUIRED/);
    assert.deepEqual(await counts(input.commandId), { events: 0, audits: 0 });
    assert.equal((await readAdminRequestOutcome(db, f.salesA.session, input.commandId)).status, 'NOT_FOUND');
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_request_audit_mismatch ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_request_audit_mismatch()');
  }
});
