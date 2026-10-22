import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { grantLead, leadProof, type Person } from './selective-leads/fixtures';
import { previewLeadEditingSelection, confirmLeadEditingSelection, revokeLeadEditing } from '../src/lib/selective-lead-edit-management';
import { readLeadEditing } from '../src/lib/selective-lead-edit-access';
import { previewLeadEdit, confirmLeadEdit, readLeadEditOutcome } from '../src/lib/selective-lead-edit-service';
import { revokeLeadSharing } from '../src/lib/selective-lead-access';
import { transitionLeadLifecycle } from '../src/lib/lead-lifecycle';
import { lockLeadForMutation } from '../src/lib/lead-lifecycle-lock';
import { withSerializableTransaction } from '../src/lib/serializable';

// A separate, explicit CI entry point applies the SQL draft to an ephemeral
// schema62 database. Ordinary test discovery cannot execute this preparation.
const enabled = process.env.RUN_SELECTIVE_LEAD_EDIT_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true', 'New PostgreSQL qualification runs only in authorized CI.');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
  await db.selectiveLeadAuthority.create({ data: { userId: admin.user.id, enabled: true } });
});
after(async () => db.$disconnect());

async function fixture() {
  const reader = await syntheticPerson(db, 'Destinatario modifica sintetico');
  const lead = await db.lead.create({ data: { firstName: 'Sintetico', lastName: 'Modifica',
    companyName: 'NOME_NON_MODIFICABILE', email: `${randomUUID()}@invalid.test`, phone: '+393331234567',
    notes: 'NOTA_PRIVATA_NON_AMMESSA', assignedToId: reader.user.id, interest: 'Interesse iniziale', priority: 'media' } });
  const availableAt = new Date(Date.now() - 86_400_000);
  const item = await db.commercialLeadInboxItem.create({ data: { leadId: lead.id, originKind: 'MANUAL_CRM',
    sourceSystem: 'CRM_SYNTHETIC', formCode: 'LEAD_EDIT', formVersion: '1', sourceOccurredAt: availableAt, initializedAt: availableAt } });
  const policy = await db.commercialLeadSlaPolicyVersion.findFirst({ orderBy: { version: 'asc' } })
    ?? await db.commercialLeadSlaPolicyVersion.create({ data: { version: 1, responseTargetSeconds: 86_400 } });
  const cycle = await db.commercialLeadSlaCycle.create({ data: { inboxItemId: item.id, policyVersionId: policy.id,
    sequence: 1, availableAt, dueAt: new Date(availableAt.getTime() + 86_400_000) } });
  await grantLead(db, admin, { leadId: lead.id, recipientId: reader.user.id, revision: 0,
    commandId: randomUUID(), fields: ['interest', 'priority', 'companyName'], expiresAt: null });
  const read = await db.selectiveLeadGrant.findUniqueOrThrow({ where: { leadId_recipientId: { leadId: lead.id, recipientId: reader.user.id } } });
  const selection = { protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1' as const, leadId: lead.id, recipientId: reader.user.id,
    readGrantId: read.id, readGrantRevision: read.revision, readGrantProof: read.proof,
    revision: 0, commandId: randomUUID(), fields: ['priority' as const], expiresAt: null as string | null };
  return { reader, lead, read, item, cycle, selection };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function grant(f: Fixture) {
  const p = await previewLeadEditingSelection(db, admin.session, f.selection);
  return confirmLeadEditingSelection(db, admin.session, f.selection, p.token, leadProof(admin));
}
async function command(f: Fixture) {
  const view = await readLeadEditing(db, f.reader.session, f.lead.id);
  return { protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1' as const, commandId: randomUUID(), leadId: f.lead.id,
    capabilityId: view.capabilityId, capabilityRevision: view.capabilityRevision,
    readGrantId: view.readGrantId, readGrantRevision: view.readGrantRevision, readGrantProof: view.readGrantProof,
    expectedVersion: view.expectedVersion, changes: { priority: 'alta' as const } };
}
async function counts(id: string) {
  const [row] = await db.$queryRaw<Array<{ commands: bigint; decisions: bigint; revisions: bigint; audits: bigint }>>`
    SELECT (SELECT count(*) FROM "SelectiveLeadEditCommand" WHERE "leadId"=${id}) AS commands,
      (SELECT count(*) FROM "SelectiveLeadEditDecision" WHERE "leadId"=${id}) AS decisions,
      (SELECT count(*) FROM "SelectiveLeadEditRevision" r JOIN "SelectiveLeadEditGrant" g ON g.id=r."grantId" WHERE g."leadId"=${id}) AS revisions,
      (SELECT count(*) FROM "AuditLog" WHERE event='selective_lead_edit_applied' AND "entityId" IN
        (SELECT id::text FROM "SelectiveLeadEditCommand" WHERE "leadId"=${id})) AS audits`;
  return row;
}

test('read authority cannot enroll editing; preview leaves all empty edit structures unchanged', options, async () => {
  const f = await fixture();
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "SelectiveLeadEditAuthority"`, []);
  const prior = await counts(f.lead.id);
  await assert.rejects(previewLeadEditingSelection(db, admin.session, f.selection));
  assert.deepEqual(await counts(f.lead.id), prior);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "SelectiveLeadEditAuthority"`, []);
  // Explicit synthetic enrollment after the counterproof; never a production identity.
  await db.$executeRaw`INSERT INTO "SelectiveLeadEditAuthority" ("userId",enabled) VALUES (${admin.user.id},true)`;
});

test('preview writes nothing and the recipient gets only explicitly editable readable values', options, async () => {
  const f = await fixture(), prior = await counts(f.lead.id);
  await assert.rejects(readLeadEditing(db, f.reader.session, f.lead.id));
  const p = await previewLeadEditingSelection(db, admin.session, f.selection);
  assert.deepEqual(p.fields.map(x => x.key), ['priority']);
  assert.deepEqual(await counts(f.lead.id), prior);
  await confirmLeadEditingSelection(db, admin.session, f.selection, p.token, leadProof(admin));
  const view = await readLeadEditing(db, f.reader.session, f.lead.id);
  assert.deepEqual(view.fields, [{ key: 'priority', label: 'Priorità', value: 'media' }]);
  for (const secret of [f.lead.notes!, f.lead.email!, f.lead.phone!, f.lead.companyName!, f.lead.interest!]) {
    assert.equal(JSON.stringify(view).includes(secret), false);
  }
});

test('another Admin, a forged step-up, extra fields and a changed selection cannot grant', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Admin senza autorità modifica');
  await assert.rejects(previewLeadEditingSelection(db, other.session, f.selection));
  await assert.rejects(previewLeadEditingSelection(db, admin.session, { ...f.selection, fields: ['notes'] }));
  const p = await previewLeadEditingSelection(db, admin.session, f.selection);
  await assert.rejects(confirmLeadEditingSelection(db, admin.session, f.selection, p.token, { ...leadProof(admin), stepUpToken: 'forged' }));
  await assert.rejects(confirmLeadEditingSelection(db, admin.session, { ...f.selection, fields: ['interest'] }, p.token, leadProof(admin)));
  assert.equal((await counts(f.lead.id)).decisions, 0n);
});

test('one exact mutation preserves unselected lead fields, Inbox, SLA and minimized audit', options, async () => {
  const f = await fixture(); await grant(f);
  const input = await command(f), beforeLead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  const p = await previewLeadEdit(db, f.reader.session, input), prior = await counts(f.lead.id);
  assert.equal(await readLeadEditOutcome(db, f.reader.session, input), null);
  assert.deepEqual(await counts(f.lead.id), prior);
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, false));
  const receipt = await confirmLeadEdit(db, f.reader.session, input, p.token, true);
  const afterLead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  assert.deepEqual({ ...afterLead, priority: beforeLead.priority, updatedAt: beforeLead.updatedAt }, beforeLead);
  assert.equal(afterLead.priority, 'alta'); assert.ok(afterLead.updatedAt > beforeLead.updatedAt);
  assert.deepEqual(await db.commercialLeadInboxItem.findUnique({ where: { id: f.item.id } }), f.item);
  assert.deepEqual(await db.commercialLeadSlaCycle.findUnique({ where: { id: f.cycle.id } }), f.cycle);
  assert.deepEqual(receipt.changedFields, ['priority']);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: input.commandId } });
  assert.deepEqual(audit.before, { version: input.expectedVersion });
  assert.deepEqual(audit.after, { version: receipt.afterVersion, changedPaths: ['priority'] });
  assert.equal((await counts(f.lead.id)).commands, 1n); assert.equal((await counts(f.lead.id)).audits, 1n);
  for (const excluded of [f.lead.notes!, f.lead.email!, f.lead.interest!, 'alta']) assert.equal(JSON.stringify(audit).includes(excluded), false);
});

test('lost response and double click leave one mutation, one audit and the same current-authorized receipt', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  const results = await Promise.allSettled([confirmLeadEdit(db, f.reader.session, input, p.token, true), confirmLeadEdit(db, f.reader.session, input, p.token, true)]);
  assert.ok(results.some(x => x.status === 'fulfilled'));
  const receipt = await readLeadEditOutcome(db, f.reader.session, input); assert.ok(receipt);
  assert.deepEqual(await confirmLeadEdit(db, f.reader.session, input, p.token, true), receipt);
  assert.equal((await counts(f.lead.id)).commands, 1n); assert.equal((await counts(f.lead.id)).audits, 1n);
  await assert.rejects(confirmLeadEdit(db, f.reader.session, { ...input, changes: { priority: 'urgente' } }, p.token, true));
  assert.equal((await counts(f.lead.id)).commands, 1n);
});

test('changed fields, another actor/session and an obsolete version reject the whole command', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  for (const changes of [{ notes: 'hidden' }, { interest: 'not granted' }, { priority: 'urgente' }, { assignedToId: admin.user.id }]) {
    await assert.rejects(confirmLeadEdit(db, f.reader.session, { ...input, changes }, p.token, true));
  }
  await assert.rejects(confirmLeadEdit(db, admin.session, input, p.token, true));
  await assert.rejects(confirmLeadEdit(db, { ...f.reader.session, sessionId: admin.session.sessionId }, input, p.token, true));
  await db.lead.update({ where: { id: f.lead.id }, data: { updatedAt: new Date(Date.now() + 10) } });
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true));
  assert.equal((await counts(f.lead.id)).commands, 0n);
});

test('revocation with a form already open prevents mutation and does not recreate a capability', options, async () => {
  const f = await fixture(), selection = await grant(f), input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  const revoke = { grantId: selection.grantId, revision: 1, commandId: randomUUID() };
  const receipt = await revokeLeadEditing(db, admin.session, revoke, leadProof(admin));
  assert.deepEqual(await revokeLeadEditing(db, admin.session, revoke, leadProof(admin)), receipt);
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true));
  await assert.rejects(readLeadEditing(db, f.reader.session, f.lead.id));
  assert.equal((await counts(f.lead.id)).commands, 0n);
});

test('revoked read grant blocks edits and receipt disclosure after a previously committed command', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  await confirmLeadEdit(db, f.reader.session, input, p.token, true);
  await revokeLeadSharing(db, admin.session, { grantId: f.read.id, revision: f.read.revision, commandId: randomUUID() }, leadProof(admin));
  await assert.rejects(readLeadEditOutcome(db, f.reader.session, input));
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true));
  assert.equal((await counts(f.lead.id)).commands, 1n);
});

test('inactive recipients may be revoked by the personal manager but cannot reopen their capability', options, async () => {
  const f = await fixture(), selection = await grant(f);
  await db.user.update({ where: { id: f.reader.user.id }, data: { active: false } });
  const receipt = await revokeLeadEditing(db, admin.session, { grantId: selection.grantId, revision: 1, commandId: randomUUID() }, leadProof(admin));
  assert.equal(receipt.operation, 'REVOKE');
  await db.user.update({ where: { id: f.reader.user.id }, data: { active: true } });
  await assert.rejects(readLeadEditing(db, f.reader.session, f.lead.id));
});

test('trash and restore do not renew read or edit approvals', options, async () => {
  const f = await fixture(); await grant(f);
  const beforeLead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  await transitionLeadLifecycle(db, admin.session, { id: f.lead.id, updatedAt: beforeLead.updatedAt.toISOString(), action: 'trash', confirmed: 'yes' }, leadProof(admin));
  await assert.rejects(readLeadEditing(db, f.reader.session, f.lead.id));
  const trashed = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  await transitionLeadLifecycle(db, admin.session, { id: f.lead.id, updatedAt: trashed.updatedAt.toISOString(), action: 'restore', confirmed: 'yes' }, leadProof(admin));
  await assert.rejects(readLeadEditing(db, f.reader.session, f.lead.id));
});

test('an existing client link blocks an already previewed edit regardless of the commercial status', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  const client = await db.client.create({ data: { type: 'persona_fisica', displayName: 'Cliente convertito sintetico' } });
  await withSerializableTransaction(db, async tx => {
    await lockLeadForMutation(tx, admin.session, f.lead.id, input.expectedVersion);
    await tx.lead.update({ where: { id: f.lead.id }, data: { clientId: client.id, updatedAt: new Date() } });
  });
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true));
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).clientId, client.id);
  assert.equal((await counts(f.lead.id)).commands, 0n);
});

test('an explicit write denial invalidates an open form even for an Admin recipient', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'lead.write', allowed: false } });
  await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true));
  await assert.rejects(previewLeadEditingSelection(db, admin.session, { ...f.selection, revision: 1, commandId: randomUUID() }));
  assert.equal((await counts(f.lead.id)).commands, 0n);
});

test('a concurrent ordinary writer wins its lock without losing data to a stale selective form', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
  const ordinary = withSerializableTransaction(db, async tx => {
    const row = await lockLeadForMutation(tx, admin.session, f.lead.id, input.expectedVersion);
    locked(); await gate;
    await tx.lead.update({ where: { id: f.lead.id }, data: { priority: 'urgente', updatedAt: new Date(Math.max(Date.now(), row.lead.updatedAt.getTime() + 1)) } });
  });
  await ready;
  const selective = confirmLeadEdit(db, f.reader.session, input, p.token, true);
  release(); await ordinary; await assert.rejects(selective);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).priority, 'urgente');
  assert.equal((await counts(f.lead.id)).commands, 0n);
});

test('a database audit fault rolls back the lead and command, then the same exact request can succeed', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  const beforeLead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  const name = `synthetic_edit_fault_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^[a-z0-9_]+$/); assert.match(input.commandId, /^[a-f0-9-]{36}$/);
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${input.commandId}' THEN RAISE EXCEPTION 'SYNTHETIC_EDIT_AUDIT_FAULT'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true), /SYNTHETIC_EDIT_AUDIT_FAULT/);
    assert.deepEqual(await db.lead.findUnique({ where: { id: f.lead.id } }), beforeLead);
    assert.equal((await counts(f.lead.id)).commands, 0n);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
  await confirmLeadEdit(db, f.reader.session, input, p.token, true);
  assert.equal((await counts(f.lead.id)).commands, 1n);
});

test('committed decisions, revisions and commands reject physical deletion or rewriting', options, async () => {
  const f = await fixture(), selection = await grant(f), input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  await confirmLeadEdit(db, f.reader.session, input, p.token, true);
  await assert.rejects(db.$executeRaw`DELETE FROM "SelectiveLeadEditCommand" WHERE id=${input.commandId}::uuid`, /SELECTIVE_LEAD_EDIT_HISTORY_RETAINED/);
  await assert.rejects(db.$executeRaw`UPDATE "SelectiveLeadEditCommand" SET "requestDigest"=${'a'.repeat(64)} WHERE id=${input.commandId}::uuid`, /SELECTIVE_LEAD_EDIT_IMMUTABLE/);
  await assert.rejects(db.$executeRaw`DELETE FROM "SelectiveLeadEditRevision" WHERE id=${selection.revisionId}::uuid`, /SELECTIVE_LEAD_EDIT_HISTORY_RETAINED/);
  await assert.rejects(db.$executeRaw`DELETE FROM "SelectiveLeadEditDecision" WHERE id=${f.selection.commandId}::uuid`, /SELECTIVE_LEAD_EDIT_HISTORY_RETAINED/);
  assert.equal((await counts(f.lead.id)).commands, 1n);
});

test('a deferred integrity failure rejects the call instead of returning an uncommitted receipt', options, async () => {
  const f = await fixture(); await grant(f); const input = await command(f), p = await previewLeadEdit(db, f.reader.session, input);
  const beforeLead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  const name = `zz_synthetic_edit_deferred_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^[a-z0-9_]+$/); assert.match(input.commandId, /^[a-f0-9-]{36}$/);
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${input.commandId}' THEN NEW."after" := NEW."after" - 'changedPaths'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    await assert.rejects(confirmLeadEdit(db, f.reader.session, input, p.token, true), /SELECTIVE_LEAD_EDIT_ATOMIC_COMMAND/);
    assert.deepEqual(await db.lead.findUnique({ where: { id: f.lead.id } }), beforeLead);
    assert.equal((await counts(f.lead.id)).commands, 0n);
    assert.equal((await counts(f.lead.id)).audits, 0n);
    assert.equal(await readLeadEditOutcome(db, f.reader.session, input), null);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
  const receipt = await confirmLeadEdit(db, f.reader.session, input, p.token, true);
  assert.equal((await counts(f.lead.id)).commands, 1n);
  assert.deepEqual(await readLeadEditOutcome(db, f.reader.session, input), receipt);
});
