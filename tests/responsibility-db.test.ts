import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createInternalSession, revokeAllInternalSessions } from '../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../src/lib/session';
import { withSerializableTransaction } from '../src/lib/serializable';
import { acceptResponsibility, appendResponsibilityDecision, confirmLeadResponsibility, readResponsibility, savePracticeResponsibility } from '../src/lib/responsibility';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
const users: string[] = [], clients: string[] = [], practices: string[] = [], leads: string[] = [];
const priorMode = process.env.INTERNAL_SESSION_MODE; let admitted = false;
before(async () => { if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db); admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry'; });
after(async () => {
  if (admitted) {
    await db.auditLog.deleteMany({ where: { OR: [{ entityType: 'TechnicalPractice', entityId: { in: practices } }, { entityType: 'Lead', entityId: { in: leads } }] } });
    await db.technicalPractice.deleteMany({ where: { id: { in: practices } } }); await db.lead.deleteMany({ where: { id: { in: leads } } });
    await db.client.deleteMany({ where: { id: { in: clients } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    if (priorMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = priorMode;
  }
  await db.$disconnect();
});
const tx = <T>(work: Parameters<typeof withSerializableTransaction<T>>[1]) => withSerializableTransaction(db, work);
async function actor(role: RoleCode) {
  const user = await db.user.create({ data: { name: 'Synthetic responsibility', email: `resp-${randomUUID()}@example.test`, role, passwordHash: 'synthetic-no-login' } }); users.push(user.id);
  const token = createRegistrySessionToken(), tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction(t => createInternalSession(t, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: session.id };
}
async function fixture() {
  const admin = await actor('admin'), sales = await actor('commerciale'), tech = await actor('consulente'), other = await actor('consulente');
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic responsibility client' } }); clients.push(client.id);
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, title: 'Synthetic work', practiceType: 'Consultazione', targetEntity: 'FAI', createdById: admin.userId } }); practices.push(practice.id);
  const input = { id: practice.id, expectedEntryId: '', expectedUpdatedAt: practice.updatedAt.toISOString(), commercialOwnerId: sales.userId,
    technicalOwnerId: tech.userId, departmentCode: 'Tecnico sintetico', reason: 'Decisione amministrativa esplicita per la prova' };
  return { admin, sales, tech, other, client, practice, input };
}
async function reassign(f: Awaited<ReturnType<typeof fixture>>, technicalOwnerId: string | null) {
  const current = await readResponsibility(db, 'TechnicalPractice', f.practice.id);
  return tx(t => savePracticeResponsibility(t, f.admin, { ...f.input, technicalOwnerId, expectedEntryId: current.current?.id ?? '', expectedUpdatedAt: current.context!.updatedAt.toISOString() }, true));
}
test('admin decision is distinct from two personal acceptances and repeated acceptance is idempotent', { skip: !enabled }, async () => {
  const f = await fixture(), decision = await tx(t => savePracticeResponsibility(t, f.admin, f.input, true));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).accepted.length, 0);
  const input = { kind: 'TechnicalPractice' as const, id: f.practice.id, decisionId: decision.id, role: 'tecnico' as const };
  await assert.rejects(tx(t => acceptResponsibility(t, f.admin, input)));
  await assert.rejects(tx(t => acceptResponsibility(t, f.other, input)));
  const first = await tx(t => acceptResponsibility(t, f.tech, input));
  assert.equal((await tx(t => acceptResponsibility(t, f.tech, input))).id, first.id);
  await tx(t => acceptResponsibility(t, f.sales, { ...input, role: 'commerciale' }));
  const state = await readResponsibility(db, 'TechnicalPractice', f.practice.id);
  assert.equal(state.accepted.length, 2); assert.equal(state.current?.decision.departmentCode, 'Tecnico sintetico');
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: f.client.id } }), f.client);
});
test('department-only assignment neither accepts work nor gives a member ownership', { skip: !enabled }, async () => {
  const f = await fixture(), decision = await tx(t => savePracticeResponsibility(t, f.admin, { ...f.input, commercialOwnerId: null, technicalOwnerId: null }, true));
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, { kind: 'TechnicalPractice', id: f.practice.id, decisionId: decision.id, role: 'tecnico' })));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).accepted.length, 0);
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert.equal(practice.technicalOwnerId, null); assert.equal(practice.commercialOwnerId, null);
  await assert.rejects(tx(t => savePracticeResponsibility(t, f.admin, { ...f.input, departmentCode: null, expectedEntryId: decision.id, expectedUpdatedAt: practice.updatedAt.toISOString() }, true)));
});
test('reassignment A to B to A never reuses a historical acceptance; stale decision and current-version conflict are rejected', { skip: !enabled }, async () => {
  const f = await fixture(), first = await tx(t => savePracticeResponsibility(t, f.admin, f.input, true));
  const input = { kind: 'TechnicalPractice' as const, id: f.practice.id, decisionId: first.id, role: 'tecnico' as const };
  const accepted = await tx(t => acceptResponsibility(t, f.tech, input));
  await reassign(f, f.other.userId); await reassign(f, f.tech.userId);
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, input)));
  await assert.rejects(tx(t => savePracticeResponsibility(t, f.admin, f.input, true)));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).accepted.length, 0);
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: accepted.id } }), accepted);
  const current = await readResponsibility(db, 'TechnicalPractice', f.practice.id);
  await tx(t => acceptResponsibility(t, f.tech, { ...input, decisionId: current.current!.id }));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).accepted.length, 1);
});
test('current registry actor, permission, live parent and admitted administrative session are authoritative', { skip: !enabled }, async () => {
  const f = await fixture();
  await assert.rejects(tx(t => savePracticeResponsibility(t, f.admin, f.input, false)));
  await assert.rejects(tx(t => savePracticeResponsibility(t, f.tech, f.input, true)));
  const decision = await tx(t => savePracticeResponsibility(t, f.admin, f.input, true));
  const input = { kind: 'TechnicalPractice' as const, id: f.practice.id, decisionId: decision.id, role: 'tecnico' as const };
  await db.userPermissionOverride.create({ data: { userId: f.tech.userId, permission: 'assignment.accept', allowed: false } });
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, input)));
  await db.userPermissionOverride.update({ where: { userId_permission: { userId: f.tech.userId, permission: 'assignment.accept' } }, data: { allowed: true } });
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, input)));
  await db.client.update({ where: { id: f.client.id }, data: { deletedAt: null } });
  await tx(t => revokeAllInternalSessions(t, f.tech.userId, 'INTERNAL_GLOBAL', f.admin.userId));
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, input)));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).accepted.length, 0);
});
test('concurrent decisions have one winner and an audit failure leaves canonical owners unchanged', { skip: !enabled }, async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([f.tech.userId, f.other.userId].map(technicalOwnerId => tx(t => savePracticeResponsibility(t, f.admin, { ...f.input, technicalOwnerId }, true))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const before = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  await db.$executeRawUnsafe(`CREATE FUNCTION responsibility_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event" = 'responsibility_assigned' THEN RAISE EXCEPTION 'synthetic responsibility fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER responsibility_test_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION responsibility_test_fault()');
  try { await assert.rejects(reassign(f, null)); assert.deepEqual(await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } }), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER responsibility_test_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION responsibility_test_fault()'); }
});
test('lead acceptance is personal and never records customer contact, conversion or a new assignment', { skip: !enabled }, async () => {
  const f = await fixture();
  const lead = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Responsibility', source: 'manuale', assignedToId: f.sales.userId } }); leads.push(lead.id);
  const decision = await tx(t => confirmLeadResponsibility(t, f.admin, { id: lead.id, expectedEntryId: '', expectedUpdatedAt: lead.updatedAt.toISOString(), reason: 'Conferma del referente già assegnato' }, true));
  await tx(t => acceptResponsibility(t, f.sales, { kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'commerciale' }));
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), lead);
  assert.equal(await db.commercialLeadInboxItem.count({ where: { leadId: lead.id } }), 0);
  await assert.rejects(tx(t => acceptResponsibility(t, f.tech, { kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'tecnico' })));
});
test('history remains pageable and context invalidation survives a change back to the original links', { skip: !enabled }, async () => {
  const f = await fixture(); await tx(t => savePracticeResponsibility(t, f.admin, f.input, true));
  for (let n = 0; n < 51; n++) await reassign(f, n % 2 ? f.tech.userId : f.other.userId);
  const first = await readResponsibility(db, 'TechnicalPractice', f.practice.id); assert.equal(first.history.length, 50); assert.ok(first.next);
  const second = await readResponsibility(db, 'TechnicalPractice', f.practice.id, first.next!); assert.equal(second.history.length, 2); assert.equal(second.next, null);
  const other = await fixture(); await assert.rejects(readResponsibility(db, 'TechnicalPractice', other.practice.id, first.next!));
  const invalidated = await tx(t => appendResponsibilityDecision(t, { kind: 'TechnicalPractice', id: f.practice.id, actorId: f.other.userId,
    state: first.context!.state, allowed: false, reason: 'Contesto modificato: verifica amministrativa necessaria' }));
  await assert.rejects(tx(t => acceptResponsibility(t, f.other, { kind: 'TechnicalPractice', id: f.practice.id, decisionId: invalidated.id, role: 'tecnico' })));
  assert.equal((await readResponsibility(db, 'TechnicalPractice', f.practice.id)).valid, false);
});
