import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { previewRecordUpdate, confirmRecordUpdate, readRecordUpdateSetup, readRecordUpdateReceipt } from '../src/lib/record-updates';
import { listRecordUpdates, readRecordUpdate } from '../src/lib/record-update-delivery';
import { type UpdateCommand, type UpdatePatch } from '../src/lib/record-update-input';
import { lockLeadForMutation } from '../src/lib/lead-lifecycle-lock';
import { withSerializableTransaction } from '../src/lib/serializable';
import { changeClientReadGrant } from '../src/lib/client-read-perimeter';
import { previewSelectiveAccess, confirmSelectiveAccess } from '../src/lib/selective-project-access';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from './record-updates/communication-fixtures';
import { readPracticeCommunications } from '../src/lib/approved-communications';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.RECORD_UPDATES_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
function proof(person = admin, nowSeconds?: number) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id, sessionToken: person.token, nowSeconds }) };
}
async function fixture(kind: UpdateCommand['kind'] = 'LEAD', nonAdmin = false) {
  const reader = await syntheticPerson(db, 'Selected synthetic recipient', nonAdmin ? 'commerciale' : 'admin'), other = await syntheticPerson(db, 'Unselected synthetic recipient');
  if (nonAdmin) await db.userPermissionOverride.createMany({ data: [
    { userId: reader.user.id, permission: 'practice_communications.read', allowed: true },
    { userId: reader.user.id, permission: 'document.sensitive.read', allowed: false },
  ] });
  let id: string;
  if (kind === 'LEAD') id = (await db.lead.create({ data: { firstName: 'Synthetic', lastName: randomUUID(), assignedToId: reader.user.id,
    nextActionDate: new Date('2027-01-04T10:11:12.345Z'), notes: 'PRIVATE-NOTES-NEVER-IN-NOTICES' } })).id;
  else {
    const client = await db.client.create({ data: { displayName: 'Synthetic ' + randomUUID(), type: 'societa', salesOwnerId: reader.user.id } });
    if (kind === 'CLIENT') id = client.id;
    else if (kind === 'PROJECT') id = (await db.project.create({ data: { clientId: client.id, title: 'Synthetic project', scenarioA: 'PRIVATE-MARGIN' } })).id;
    else id = (await db.technicalPractice.create({ data: { clientId: client.id, title: 'Synthetic practice', practiceType: 'test',
      targetEntity: 'synthetic', technicalOwnerId: reader.user.id, createdById: admin.user.id } })).id;
  }
  return { kind, id, reader, other };
}
async function command(f: { kind: UpdateCommand['kind']; id: string; reader: Person }, operation: UpdateCommand['operation'] = 'UPDATE', actor = admin): Promise<UpdateCommand> {
  const setup = await readRecordUpdateSetup(db, actor.session, f.kind, f.id);
  let patch: UpdatePatch = setup.patch;
  switch (patch.kind) {
    case 'LEAD': patch = { ...patch, nextActionNote: 'PRIVATE-NEXT-ACTION-' + randomUUID() }; break;
    case 'CLIENT': patch = { ...patch, displayName: 'Synthetic changed ' + randomUUID() }; break;
    case 'PROJECT': patch = { ...patch, status: 'in_analisi' }; break;
    case 'PRACTICE': patch = { ...patch, status: 'in_progettazione' }; break;
  }
  return { commandId: randomUUID(), kind: f.kind, recordId: f.id, operation, expectedVersion: setup.expectedVersion,
    ruleVersion: setup.rule?.version ?? 0, selection: { people: [f.reader.user.id], groups: [] },
    events: ['STATE_CHANGED', 'RECORD_CHANGED', 'NEXT_ACTION', 'DEADLINE', 'COMMUNICATION'], persistent: false, expiresAt: null,
    patch: operation === 'UPDATE' ? patch : null };
}
async function commit(input: UpdateCommand, actor = admin) {
  const preview = await previewRecordUpdate(db, actor.session, input);
  return confirmRecordUpdate(db, actor.session, input, preview.digest, proof(actor));
}
async function works(id: string) {
  return db.recordUpdateDelivery.findMany({ where: { event: { recordId: id } }, include: { event: true } });
}
async function rule(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<UpdateCommand> = {}) {
  const input = { ...await command(f, 'RULE'), ...overrides };
  await commit(input); return input;
}
async function notifyLead(id: string) {
  await db.lead.update({ where: { id }, data: { nextActionNote: 'Private native change ' + randomUUID() } });
}

async function parameterFixture() {
  const f = await fixture('PROJECT');
  const expense = await db.projectExpense.create({ data: { projectId: f.id, category: 'software', description: 'Original expense', amount: '150.25', estimated: true,
    potentiallyEligible: true, eligibilityNotes: 'PRESERVE-ELIGIBILITY', priority: 'alta' } });
  const input = await command(f);
  assert(input.patch?.kind === 'PROJECT' && input.patch.parameters);
  input.patch.status = 'idea';
  input.patch.parameters.description = 'PRIVATE-PROJECT-DESCRIPTION';
  input.patch.parameters.totalInvestment = '2500.50'; input.patch.parameters.requestedAmount = '2000';
  input.patch.parameters.expenses[0].description = 'PRIVATE-EXPENSE';
  input.patch.parameters.expenses[0].amount = '300.75';
  input.patch.parameters.expenses.push({ id: null, category: 'formazione', description: 'PRIVATE-NEW-EXPENSE', amount: '199.99', estimated: false });
  return { f, input, expense };
}
test('project parameters, expense addition and current notices commit once and reopen with exact decimals', options, async () => {
  const { f, input, expense } = await parameterFixture(), preview = await previewRecordUpdate(db, admin.session, input);
  assert.equal(await db.projectExpense.count({ where: { projectId: f.id } }), 1, 'preview is read-only');
  await confirmRecordUpdate(db, admin.session, input, preview.digest, proof());
  await confirmRecordUpdate(db, admin.session, input, preview.digest, proof());
  const reopened = await readRecordUpdateSetup(db, admin.session, 'PROJECT', f.id);
  assert(reopened.patch.kind === 'PROJECT' && reopened.patch.parameters);
  assert.equal(reopened.patch.parameters.totalInvestment, '2500.5');
  assert.equal(reopened.patch.parameters.requestedAmount, '2000');
  assert.equal(reopened.patch.parameters.description, 'PRIVATE-PROJECT-DESCRIPTION');
  assert.equal(reopened.patch.parameters.expenses.length, 2);
  const saved = await db.projectExpense.findUniqueOrThrow({ where: { id: expense.id } });
  assert.equal(saved.amount.toString(), '300.75'); assert.equal(saved.eligibilityNotes, expense.eligibilityNotes);
  assert.equal(saved.potentiallyEligible, true); assert.equal(saved.priority, 'alta');
  const rows = await works(f.id); assert.equal(rows.length, 1); assert.deepEqual(rows[0].event.changed, ['profile']);
  assert.equal(rows[0].recipientId, f.reader.user.id); assert.equal((await listRecordUpdates(db, f.other.session)).length, 0);
  const audit = await db.auditLog.findMany({ where: { entityId: { in: [input.commandId, rows[0].eventId] } } });
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(row => ({ event: row.event, before: row.before, after: row.after })).sort((a, b) => a.event.localeCompare(b.event)), [
    { event: 'record_update_confirmed', before: null, after: { kind: 'PROJECT', changed: [{ changed: ['profile'] }] } },
    { event: 'record_update_event_recorded', before: {}, after: { kind: 'PROJECT', recipientCount: 1 } },
  ]);
  assert.deepEqual(Object.keys(rows[0].event).sort(), ['changed', 'event', 'id', 'kind', 'occurredAt', 'recordId', 'scope', 'sourceKey']);
  // Numeric substrings can occur in random record IDs; check values, not ID fragments.
  assert.doesNotMatch(JSON.stringify({ audit, rows }), /PRIVATE-|"(?:2500(?:\.50?)?|2000|300\.75|199\.99)"|PRESERVE-ELIGIBILITY/);
});
test('expense edits, additions and eligibility changes invalidate a project preview even without changing project updatedAt', options, async () => {
  for (const change of ['amount', 'new', 'eligibility']) {
    const { f, input, expense } = await parameterFixture(), before = await db.project.findUniqueOrThrow({ where: { id: f.id } });
    const preview = await previewRecordUpdate(db, admin.session, input);
    if (change === 'new') await db.projectExpense.create({ data: { projectId: f.id, category: 'altro', description: 'Concurrent new', amount: '1' } });
    else await db.projectExpense.update({ where: { id: expense.id }, data: change === 'amount' ? { amount: '151' } : { eligibilityNotes: 'Concurrent assessment' } });
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.id } })).updatedAt.toISOString(), before.updatedAt.toISOString());
    await assert.rejects(confirmRecordUpdate(db, admin.session, input, preview.digest, proof()));
    assert.equal((await readRecordUpdateReceipt(db, admin.session, input.commandId)).confirmed, false);
    assert.equal((await works(f.id)).length, 0);
  }
});
test('two project parameter confirmations serialize and cannot append the same new expense twice', options, async () => {
  const { f, input } = await parameterFixture(), second = { ...input, commandId: randomUUID() };
  const a = await previewRecordUpdate(db, admin.session, input), b = await previewRecordUpdate(db, admin.session, second);
  const result = await Promise.allSettled([confirmRecordUpdate(db, admin.session, input, a.digest, proof()), confirmRecordUpdate(db, admin.session, second, b.digest, proof())]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.projectExpense.count({ where: { projectId: f.id } }), 2);
  assert.equal((await works(f.id)).length, 1);
});
test('project parameters cannot be written by a non-Admin or after an open-preview permission revocation', options, async () => {
  const { f, input } = await parameterFixture(), technician = await syntheticPerson(db, 'No project parameter authority', 'consulente');
  await assert.rejects(readRecordUpdateSetup(db, technician.session, 'PROJECT', f.id));
  await assert.rejects(previewRecordUpdate(db, technician.session, input));
  const actor = await syntheticPerson(db, 'Synthetic project editor', 'admin');
  const preview = await previewRecordUpdate(db, actor.session, input);
  await db.userPermissionOverride.create({ data: { userId: actor.user.id, permission: 'project.write', allowed: false } });
  await assert.rejects(confirmRecordUpdate(db, actor.session, input, preview.digest, proof(actor)));
  assert.equal(await db.projectExpense.count({ where: { projectId: f.id } }), 1);
  assert.equal((await works(f.id)).length, 0);
});
test('audit failure rolls back all project parameters, expense writes, command and notification work', options, async () => {
  const { f, input, expense } = await parameterFixture(), before = await db.project.findUniqueOrThrow({ where: { id: f.id } });
  const preview = await previewRecordUpdate(db, admin.session, input);
  await db.$executeRawUnsafe("CREATE FUNCTION project_parameters_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='record_update_confirmed' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER project_parameters_test_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION project_parameters_test_fault()');
  try { await assert.rejects(confirmRecordUpdate(db, admin.session, input, preview.digest, proof()), /synthetic fault/); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER project_parameters_test_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION project_parameters_test_fault()'); }
  assert.deepEqual(await db.project.findUniqueOrThrow({ where: { id: f.id } }), before);
  assert.deepEqual(await db.projectExpense.findMany({ where: { projectId: f.id } }), [expense]);
  assert.equal((await readRecordUpdateReceipt(db, admin.session, input.commandId)).confirmed, false);
  assert.equal((await works(f.id)).length, 0);
});

for (const kind of ['LEAD', 'CLIENT', 'PROJECT', 'PRACTICE'] as const) {
  test(kind + ': preview is read-only; one save records only selected work and minimal native audit', options, async () => {
    const f = await fixture(kind), input = await command(f);
    const before = await db.recordUpdateCommand.count(), auditBefore = await db.auditLog.count();
    const preview = await previewRecordUpdate(db, admin.session, input);
    assert.equal(await db.recordUpdateCommand.count(), before); assert.equal(await db.auditLog.count(), auditBefore);
    await confirmRecordUpdate(db, admin.session, input, preview.digest, proof());
    const rows = await works(f.id); assert.equal(rows.length, 1); assert.equal(rows[0].recipientId, f.reader.user.id);
    assert.equal(await listRecordUpdates(db, f.other.session).then(a => a.length), 0);
    const visible = await listRecordUpdates(db, f.reader.session); assert.equal(visible.length, 1); assert.equal(visible[0].id, rows[0].id);
    assert.equal((await readRecordUpdate(db, f.reader.session, rows[0].id))?.readAt, null);
    assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: rows[0].id } })).readAt, null, 'GET must not mark read');
    const read = await readRecordUpdate(db, f.reader.session, rows[0].id, true); assert.ok(read?.readAt);
    assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
    assert.equal((await listRecordUpdates(db, f.reader.session, 100, false)).length, 1);
    const logs = await db.auditLog.findMany({ where: { OR: [{ entityId: input.commandId }, { entityId: rows[0].eventId }] } });
    assert.equal(logs.length, 2);
    assert.equal(logs.find(l => l.event === 'record_update_confirmed')?.actorId, admin.user.id);
    const dump = JSON.stringify({ rows, logs, visible });
    assert.doesNotMatch(dump, /PRIVATE-NOTES|PRIVATE-NEXT-ACTION|PRIVATE-MARGIN|Private native/);
    if (kind === 'LEAD') assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.id } })).nextActionDate!.toISOString(), '2027-01-04T10:11:12.345Z');
  });
}
test('actual role selectors are deduplicated and cannot grant an inaccessible person access', options, async () => {
  const f = await fixture(), denied = await syntheticPerson(db, 'No access', 'commerciale');
  const input = await command(f);
  input.selection.people.push(denied.user.id);
  const preview = await previewRecordUpdate(db, admin.session, input);
  assert.equal(preview.people.find(p => p.id === denied.user.id)?.available, false);
  await confirmRecordUpdate(db, admin.session, input, preview.digest, proof());
  assert.deepEqual((await works(f.id)).map(w => w.recipientId), [f.reader.user.id]);
  assert.equal((await listRecordUpdates(db, denied.session)).length, 0);
  assert.equal(await db.clientReadGrant.count({ where: { userId: denied.user.id } }), 0);
});
test('persistent rule captures native changes atomically; one-shot overlap has one work item per recipient', options, async () => {
  const f = await fixture(); await rule(f);
  await notifyLead(f.id); await notifyLead(f.id);
  assert.equal((await works(f.id)).length, 2);
  const next = await command(f); next.persistent = true; await commit(next);
  assert.equal((await works(f.id)).length, 3);
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 1, 'replacing rule version hides older rule work');
  assert.equal((await works(f.id)).filter(w => w.commandId === next.commandId).length, 1);
});
test('concurrent repeated confirmation and lost response produce one immutable receipt', options, async () => {
  const f = await fixture(), input = await command(f), preview = await previewRecordUpdate(db, admin.session, input);
  const outcomes = await Promise.allSettled([1, 2].map(() => confirmRecordUpdate(db, admin.session, input, preview.digest, proof())));
  assert.ok(outcomes.some(r => r.status === 'fulfilled'));
  assert.equal((await works(f.id)).length, 1);
  assert.equal((await readRecordUpdateReceipt(db, admin.session, input.commandId)).confirmed, true);
  assert.equal((await readRecordUpdateReceipt(db, f.other.session, input.commandId)).confirmed, false);
  const replay = await confirmRecordUpdate(db, admin.session, input, preview.digest, proof()); assert.equal(replay.replayed, true);
  assert.equal((await works(f.id)).length, 1);
  await assert.rejects(confirmRecordUpdate(db, admin.session, { ...input, selection: { people: [f.other.user.id], groups: [] } }, preview.digest, proof()));
});
test('changed content, directory, permissions or record version invalidate an open preview', options, async () => {
  for (const change of ['content', 'email', 'permission', 'record']) {
    const f = await fixture(), input = await command(f), preview = await previewRecordUpdate(db, admin.session, input);
    if (change === 'content') input.patch = { kind: 'LEAD', nextActionDate: '', nextActionNote: 'Different' };
    if (change === 'email') await db.user.update({ where: { id: f.reader.user.id }, data: { email: randomUUID() + '@invalid.test' } });
    if (change === 'permission') await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'lead.read', allowed: false } });
    if (change === 'record') await notifyLead(f.id);
    await assert.rejects(confirmRecordUpdate(db, admin.session, input, preview.digest, proof()), change);
    assert.equal((await works(f.id)).length, 0); assert.equal((await readRecordUpdateReceipt(db, admin.session, input.commandId)).confirmed, false);
  }
});
test('rule revocation and expiry hide list, detail and pending read receipt in existing sessions', options, async () => {
  const f = await fixture(); await rule(f); await notifyLead(f.id);
  const first = (await works(f.id))[0]; assert.ok(await readRecordUpdate(db, f.reader.session, first.id));
  await commit(await command(f, 'REVOKE'));
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  assert.equal(await readRecordUpdate(db, f.reader.session, first.id, true), null);
  await rule(f, { expiresAt: new Date(Date.now() + 1500).toISOString() }); await notifyLead(f.id);
  const current = (await works(f.id)).find(w => w.id !== first.id)!; assert.ok(await readRecordUpdate(db, f.reader.session, current.id));
  await new Promise(r => setTimeout(r, 1550));
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  assert.equal(await readRecordUpdate(db, f.reader.session, current.id, true), null);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: current.id } })).readAt, null);
});
test('permission revoke and regrant cannot resurrect old work or rule recipient authority', options, async () => {
  const f = await fixture(); await rule(f); await notifyLead(f.id);
  await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'lead.read', allowed: false } });
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  await db.userPermissionOverride.update({ where: { userId_permission: { userId: f.reader.user.id, permission: 'lead.read' } }, data: { allowed: true } });
  await notifyLead(f.id);
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  assert.equal((await works(f.id)).length, 1);
});
test('trash/restore and owner change/back permanently retire old context snapshots', options, async () => {
  for (const change of ['trash', 'owner']) {
    const f = await fixture(); await rule(f); await notifyLead(f.id);
    const before = await db.lead.findUniqueOrThrow({ where: { id: f.id } });
    if (change === 'trash') {
      await db.lead.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
      assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
      await db.lead.update({ where: { id: f.id }, data: { deletedAt: null } });
    } else {
      await db.lead.update({ where: { id: f.id }, data: { assignedToId: f.other.user.id } });
      await db.lead.update({ where: { id: f.id }, data: { assignedToId: before.assignedToId } });
    }
    await notifyLead(f.id);
    assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
    assert.equal((await works(f.id)).length, 1);
    assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.id } })).recordUpdateEpoch, before.recordUpdateEpoch + 2);
  }
});
test('temporary group membership invalidates earlier group decision after the person leaves', options, async () => {
  const f = await fixture(), direction = await syntheticPerson(db, 'Direzione selection', 'direzione');
  const visitor = await syntheticPerson(db, 'Temporary member', 'backoffice');
  await rule(f, { selection: { people: [direction.user.id], groups: ['direzione'] } });
  await notifyLead(f.id); assert.equal((await works(f.id)).length, 1);
  await db.user.update({ where: { id: visitor.user.id }, data: { role: 'direzione' } });
  await db.user.update({ where: { id: visitor.user.id }, data: { role: 'backoffice' } });
  assert.equal((await listRecordUpdates(db, direction.session)).length, 0);
});
test('audit failure or an aborted native transaction rolls back record, event, work and receipt together', options, async () => {
  const f = await fixture(), input = await command(f);
  const before = await db.lead.findUniqueOrThrow({ where: { id: f.id } });
  await db.$executeRawUnsafe("CREATE FUNCTION record_update_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='record_update_confirmed' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER record_update_test_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION record_update_test_fault()');
  try { await assert.rejects(commit(input)); } finally {
    await db.$executeRawUnsafe('DROP TRIGGER record_update_test_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION record_update_test_fault()');
  }
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: f.id } }), before);
  assert.equal((await works(f.id)).length, 0); assert.equal(await db.recordUpdateEvent.count({ where: { recordId: f.id } }), 0);
  assert.equal((await readRecordUpdateReceipt(db, admin.session, input.commandId)).confirmed, false);
  await rule(f);
  await assert.rejects(db.$transaction(async tx => { await tx.lead.update({ where: { id: f.id }, data: { nextActionNote: 'Not committed' } }); throw new Error('abort'); }));
  assert.equal((await works(f.id)).length, 0);
});
test('native conversion and a stale Salva e aggiorna cannot both win', options, async () => {
  const f = await fixture(), input = await command(f), preview = await previewRecordUpdate(db, admin.session, input);
  const outcomes = await Promise.allSettled([
    confirmRecordUpdate(db, admin.session, input, preview.digest, proof()),
    withSerializableTransaction(db, async tx => {
      const locked = await lockLeadForMutation(tx, admin.session, f.id, input.expectedVersion);
      const client = await tx.client.create({ data: { type: 'societa', displayName: 'Synthetic conversion', leadId: f.id } });
      await tx.lead.update({ where: { id: f.id }, data: { clientId: client.id, updatedAt: new Date(locked.lead.updatedAt.getTime() + 1) } });
    }),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const final = await db.lead.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal((await works(f.id)).length, final.clientId ? 0 : 1);
});
test('fresh Admin role, explicit denial, session revocation and expired step-up prevent mutation', options, async () => {
  for (const change of ['role', 'deny', 'session', 'proof', 'cookie']) {
    const actor = await syntheticPerson(db, 'Decision author'), f = await fixture(), input = await command(f, 'UPDATE', actor);
    const preview = await previewRecordUpdate(db, actor.session, input), p = proof(actor, change === 'proof' ? Math.floor(Date.now()/1000)-600 : undefined);
    if (change === 'role') await db.user.update({ where: { id: actor.user.id }, data: { role: 'direzione' } });
    if (change === 'deny') await db.userPermissionOverride.create({ data: { userId: actor.user.id, permission: 'lead.write', allowed: false } });
    if (change === 'session') await db.internalSession.update({ where: { id: actor.session.sessionId }, data: { revokedAt: new Date() } });
    if (change === 'cookie') p.sessionToken = admin.token;
    await assert.rejects(confirmRecordUpdate(db, actor.session, input, preview.digest, p), change);
    assert.equal((await works(f.id)).length, 0);
  }
});
test('completed internal note notifies only communication readers; private body and drafts do not leak', options, async () => {
  const f = await fixture('PRACTICE'); await rule(f);
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.id } });
  const note = await db.practiceCommunication.create({ data: { technicalPracticeId: f.id, clientId: practice.clientId,
    type: 'interna', channel: 'nota_interna', title: 'PRIVATE TITLE', content: 'PRIVATE BODY', createdById: admin.user.id } });
  assert.equal((await works(f.id)).length, 0);
  await db.practiceCommunication.update({ where: { id: note.id }, data: { status: 'usata_inviata' } });
  assert.equal((await works(f.id)).length, 1);
  const visible = await listRecordUpdates(db, f.reader.session); assert.equal(visible.length, 1); assert.doesNotMatch(JSON.stringify(visible), /PRIVATE TITLE|PRIVATE BODY/);
  await db.practiceCommunication.update({ where: { id: note.id }, data: { title: 'PRIVATE OTHER' } });
  assert.equal((await works(f.id)).length, 1);
  await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'practice_communications.read', allowed: false } });
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
});
test('parent suspension and restoration cannot resurrect indirect project notices', options, async () => {
  const f = await fixture('PROJECT'); await rule(f); await db.project.update({ where: { id: f.id }, data: { title: 'Changed synthetic title' } });
  const project = await db.project.findUniqueOrThrow({ where: { id: f.id } });
  await db.client.update({ where: { id: project.clientId }, data: { status: 'sospeso' } });
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  await db.client.update({ where: { id: project.clientId }, data: { status: 'attivo' } });
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
});
test('event, command and delivery history cannot be rewritten or deleted; read state is monotone', options, async () => {
  const f = await fixture(), input = await command(f); await commit(input);
  const work = (await works(f.id))[0];
  await assert.rejects(db.recordUpdateEvent.update({ where: { id: work.eventId }, data: { changed: ['email'] } }));
  await assert.rejects(db.recordUpdateCommand.delete({ where: { id: input.commandId } }));
  await assert.rejects(db.recordUpdateDelivery.delete({ where: { id: work.id } }));
  await readRecordUpdate(db, f.reader.session, work.id, true);
  await assert.rejects(db.recordUpdateDelivery.update({ where: { id: work.id }, data: { readAt: null } }));
  await assert.rejects(db.recordUpdateDelivery.update({ where: { id: work.id }, data: { recipientId: f.other.user.id } }));
});

test('client read grant revocation and regrant require a new notification decision', options, async () => {
  const f = await fixture('CLIENT'), limited = await syntheticPerson(db, 'Client perimeter recipient', 'commerciale');
  const selected = { ...f, reader: limited };
  const grant = (expectedVersion: number, active: boolean) => db.$transaction(tx => changeClientReadGrant(tx, admin.session,
    { userId: limited.user.id, clientId: f.id, expectedVersion, active }, true));
  await grant(0, true);
  await rule(selected);
  await db.client.update({ where: { id: f.id }, data: { displayName: 'Synthetic first change' } });
  const old = (await works(f.id))[0];
  assert.ok(await readRecordUpdate(db, limited.session, old.id));
  await grant(1, false);
  assert.equal(await readRecordUpdate(db, limited.session, old.id), null);
  await grant(2, true);
  await db.client.update({ where: { id: f.id }, data: { displayName: 'Synthetic second change' } });
  assert.equal((await listRecordUpdates(db, limited.session)).length, 0);
  assert.equal((await works(f.id)).length, 1);
  await rule(selected);
  await db.client.update({ where: { id: f.id }, data: { displayName: 'Synthetic newly authorized change' } });
  assert.equal((await listRecordUpdates(db, limited.session)).length, 1);
});

test('a selective project recipient never inherits the ordinary project update channel', options, async () => {
  const f = await fixture('PROJECT');
  await rule(f);
  await db.project.update({ where: { id: f.id }, data: { title: 'Synthetic project change' } });
  const selection = { projectId: f.id, recipientId: f.reader.user.id, revision: 0, fields: ['title'], documents: [], expiresAt: null };
  const preview = await previewSelectiveAccess(db, admin.session, selection);
  await confirmSelectiveAccess(db, admin.session, preview.token, true);
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  const input = await command(f, 'RULE');
  input.selection.people.push(f.other.user.id);
  const updatePreview = await previewRecordUpdate(db, admin.session, input);
  assert.equal(updatePreview.people.find(person => person.id === f.reader.user.id)?.available, false);
  assert.equal(updatePreview.people.find(person => person.id === f.other.user.id)?.available, true);
});

test('synthetic SENT and explicitly linked reply emit once; draft, uncertainty and unassociated reply emit nothing', options, async () => {
  const f = await fixture('LEAD', true); await rule(f);
  const { message, mailbox } = await storedNoticeMessage(db, { leadId: f.id, authorId: admin.user.id });
  assert.equal((await works(f.id)).length, 0);
  await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'UNCERTAIN' } });
  assert.equal((await works(f.id)).length, 0);
  await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'SENT' } });
  await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'SENT' } });
  assert.equal((await works(f.id)).length, 1);
  const reply = await db.communicationReply.create({ data: { canonicalMailboxId: mailbox.id,
    externalMessageId: randomUUID(), contentHash: 'b'.repeat(64), sender: 'synthetic@invalid.test',
    subject: 'PRIVATE SUBJECT', body: 'PRIVATE REPLY BODY', receivedAt: new Date(), evidenceReference: 'SYNTHETIC_ONLY',
    acquiredById: admin.user.id } });
  assert.equal((await works(f.id)).length, 1);
  await db.communicationReply.update({ where: { id: reply.id }, data: { messageId: message.id, linkedById: admin.user.id } });
  await db.communicationReply.update({ where: { id: reply.id }, data: { messageId: message.id, linkedById: admin.user.id } });
  assert.equal((await works(f.id)).length, 2);
  const visible = await listRecordUpdates(db, f.reader.session);
  assert.equal(visible.length, 2); assert.doesNotMatch(JSON.stringify(visible), /PRIVATE SUBJECT|PRIVATE REPLY BODY/);
  assert.equal((await readPracticeCommunications(db, f.reader.session, { kind: 'LEAD', id: f.id })).messages.length, 1);
});

for (const restriction of ['restricted', 'COMPLAINT', 'SENSITIVE', 'conflict'] as const) {
  test('non-Admin source admission blocks list/detail/read receipt: ' + restriction, options, async () => {
    const f = await fixture('LEAD', true); await rule(f);
    const { message, mailbox } = await storedNoticeMessage(db, { leadId: f.id, authorId: admin.user.id,
      mailboxAddress: restriction === 'restricted' ? 'info@finanzaagevolaimpresa.it' : undefined,
      classification: restriction === 'COMPLAINT' || restriction === 'SENSITIVE' ? restriction : 'ORDINARY' });
    const linked = restriction === 'conflict' ? await linkedOrdinaryNoticeReply(db, message.id, mailbox.id, admin.user.id) : null;
    if (!linked) await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'SENT' } });
    const [work] = await works(f.id); assert.ok(work);
    try {
      if (restriction === 'restricted' || linked) {
        assert.equal((await listRecordUpdates(db, f.reader.session)).length, 1);
        assert.ok(await readRecordUpdate(db, f.reader.session, work.id));
        if (linked) await linked.conflict();
        else await db.communicationMailbox.update({ where: { id: mailbox.id }, data: { restricted: true } });
      }
      const native = await readPracticeCommunications(db, f.reader.session, { kind: 'LEAD', id: f.id });
      assert.equal(linked ? native.messages.flatMap(m => m.replies).length : native.messages.length, 0);
      assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
      assert.equal((await listRecordUpdates(db, f.reader.session, 100, false)).length, 0);
      assert.equal(await readRecordUpdate(db, f.reader.session, work.id), null);
      assert.equal(await readRecordUpdate(db, f.reader.session, work.id, true), null);
      assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work.id } })).readAt, null);
    } finally {
      if (restriction === 'restricted') await db.communicationMailbox.update({ where: { id: mailbox.id }, data: { restricted: false } });
    }
  });
}

for (const fault of ['missing-version', 'snapshot-hash', 'revoked-attachment'] as const) {
  test('source version/hash and attachment admission cannot be bypassed by notifications: ' + fault, options, async () => {
    const f = await fixture('LEAD', true); await rule(f);
    const file = fault === 'revoked-attachment' ? await db.communicationContextFile.create({ data: {
      contextKind: 'LEAD', leadId: f.id, uploadedById: admin.user.id, fileName: 'synthetic.txt', mimeType: 'text/plain',
      sizeBytes: 1, sha256: 'a'.repeat(64), storagePath: 'synthetic-not-read/' + randomUUID(),
    } }) : null;
    const { message } = await storedNoticeMessage(db, { leadId: f.id, authorId: admin.user.id,
      omitVersion: fault === 'missing-version', invalidHash: fault === 'snapshot-hash',
      attachments: file ? [{ source: 'CONTEXT_FILE', documentId: file.id, versionId: file.id, filename: file.fileName,
        mimeType: file.mimeType, bytes: file.sizeBytes, sha256: file.sha256 }] : [] });
    await db.approvedCommunication.update({ where: { id: message.id }, data: { state: 'SENT' } });
    const [work] = await works(f.id); assert.ok(work);
    if (file) {
      assert.equal((await listRecordUpdates(db, f.reader.session)).length, 1);
      assert.ok(await readRecordUpdate(db, f.reader.session, work.id));
      await db.communicationContextFile.update({ where: { id: file.id }, data: { revokedAt: new Date() } });
      assert.equal((await readPracticeCommunications(db, f.reader.session, { kind: 'LEAD', id: f.id })).messages.length, 0);
    }
    assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
    assert.equal(await readRecordUpdate(db, f.reader.session, work.id, true), null);
    assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: work.id } })).readAt, null);
  });
}
