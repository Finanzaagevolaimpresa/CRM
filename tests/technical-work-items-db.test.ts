import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignmentInput, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { technicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { readTechnicalWork } from '../src/lib/technical-assignment-access';
import { readTechnicalWorkItem, previewTechnicalWorkItem, confirmTechnicalWorkItem, readTechnicalWorkItemOutcome } from '../src/lib/technical-work-item-service';
import { technicalWorkItemCommand } from '../src/lib/technical-work-item-command';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { canViewTask, canViewChecklistItem } from '../src/lib/access-control';
import { readCommercialProgress } from '../src/lib/commercial-progress';
import type { TechnicalWorkItemGrant } from '../src/lib/technical-work-item-grant';

const enabled = process.env.TECHNICAL_WORK_ITEM_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => { if (!enabled) return;
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
async function fixture() {
  const f = await technicalFixture(db, admin);
  const task = await db.task.create({ data: { clientId: f.client.id, projectId: f.project.id,
    assignedToId: f.techA.user.id, title: 'Attività tecnica sintetica', description: 'DESCRIZIONE_NON_SCELTA', priority: 'alta', dueAt: new Date(Date.now() + 86400000) } });
  const check = await db.documentChecklistItem.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'Relazione tecnica sintetica', notes: 'NOTA_CHECKLIST_NON_SCELTA' } });
  const financial = await db.documentChecklistItem.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'Etichetta generica', documentId: f.documents[2].doc.id } });
  return { ...f, task, check, financial };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepare(f: Fixture, person = f.techA, kind: TechnicalWorkItemGrant['kind'] = 'Task') {
  const target = technicalTarget(f), setup = await readTechnicalAssignmentManagement(db, admin.session, target, person.user.id);
  const option = setup.workItemOptions.find(item => item.kind === kind && item.itemId === (kind === 'Task' ? f.task.id : f.check.id)); assert(option);
  const base = await assignmentInput(db, admin, target, person);
  const identity = { kind: option.kind, itemId: option.itemId, generation: option.generation,
    scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256 };
  const choice = kind === 'Task' ? { ...identity, kind, readableFields: ['title', 'dueAt', 'priority'], editableFields: ['dueAt', 'priority'] }
    : { ...identity, kind, readableFields: ['title', 'notes', 'status'], editableFields: ['notes'] };
  const input = { ...base, selection: technicalAssignmentSelection.parse({ ...base.selection,
    actions: [...base.selection.actions, kind === 'Task' ? 'manage_deadlines' : 'manage_checklist'], workItems: [choice] }) };
  const ref = { ...target, recipientId: person.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  return { target, input, ref, preview };
}
async function assign(f: Fixture, person = f.techA, kind: TechnicalWorkItemGrant['kind'] = 'Task') {
  const p = await prepare(f, person, kind);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), p.ref, 'ASSIGN', p.input, p.preview.token, true);
  return p;
}
async function command(f: Fixture, person = f.techA, patch: Record<string, string | null> = { priority: 'urgente' }) {
  const target = technicalTarget(f), view = await readTechnicalWorkItem(db, person.session, target, { kind: 'Task', itemId: f.task.id });
  const { fields: _fields, editableFields: _editable, ...identity } = view;
  void _fields; void _editable;
  return technicalWorkItemCommand.parse({ ...identity, commandId: randomUUID(), action: 'update_fields', patch });
}
async function counts() {
  const [row] = await db.$queryRaw<Array<{ commands: bigint; audits: bigint }>>`SELECT
    (SELECT count(*) FROM "TechnicalWorkItemCommand") AS commands,
    (SELECT count(*) FROM "AuditLog" WHERE "entityType"='TechnicalWorkItemCommand') AS audits`;
  return row;
}
test('explicit catalogue, preview and assignment are read-only for canonical tasks; financial links and unrelated targets excluded', options, async () => {
  const f = await fixture(), before = await db.task.findUniqueOrThrow({ where: { id: f.task.id } }), n = await counts();
  const setup = await readTechnicalAssignmentManagement(db, admin.session, technicalTarget(f), f.techA.user.id);
  assert(!setup.workItemOptions.some(item => item.itemId === f.financial.id));
  const p = await prepare(f); assert.equal(p.preview.workItems.length, 1);
  assert(!JSON.stringify(p.preview.workItems).includes('DESCRIZIONE_NON_SCELTA'));
  assert.deepEqual(await counts(), n); assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: f.task.id } }), before);
  const wrong = await readTechnicalAssignmentManagement(db, admin.session, { kind: 'Project', targetId: f.otherProject.id }, f.techA.user.id);
  assert(!wrong.workItemOptions.some(item => item.itemId === f.task.id));
});
test('two technicians work independently with only selected fields; both sales and generic Admin cannot consume the technical path', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f); await assign(f, f.techB, 'ChecklistItem');
  const a = await readTechnicalWork(db, f.techA.session, target), b = await readTechnicalWork(db, f.techB.session, target);
  assert.equal(a.workItems.length, 1); assert.equal(b.workItems.length, 1); assert.equal(a.workItems[0].kind, 'Task'); assert.equal(b.workItems[0].kind, 'ChecklistItem');
  assert(!JSON.stringify(a).includes('DESCRIZIONE_NON_SCELTA'));
  for (const person of [f.techB, f.salesA, f.salesB, admin]) await assert.rejects(readTechnicalWorkItem(db, person.session, target, { kind: 'Task', itemId: f.task.id }));
  assert((await readCommercialProgress(db, f.salesA.session, { client: f.client.id })).items.length > 0);
  assert.equal((await readCommercialProgress(db, f.salesB.session, { client: f.client.id })).items.length, 0);
});
test('selected deadline mutation commits once with minimized audit; exact retry and lost response reconcile the same receipt', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f); const input = await command(f), before = await counts();
  const p = await previewTechnicalWorkItem(db, f.techA.session, target, input);
  assert.deepEqual(p.before, { priority: 'alta' }); assert.deepEqual(p.after, { priority: 'urgente' }); assert.deepEqual(await counts(), before);
  const receipt = await confirmTechnicalWorkItem(db, f.techA.session, target, p.command, p.token, true);
  assert.equal(receipt.itemVersion, receipt.previousItemVersion + 1);
  assert.deepEqual(await confirmTechnicalWorkItem(db, f.techA.session, target, p.command, p.token, true), receipt);
  assert.deepEqual(await readTechnicalWorkItemOutcome(db, f.techA.session, target, input.commandId), { status: 'RECORDED', receipt });
  const row = await db.task.findUniqueOrThrow({ where: { id: f.task.id } }); assert.equal(row.priority, 'urgente'); assert.equal(row.description, f.task.description);
  assert.equal(row.assignedToId, f.techA.user.id);
  assert.deepEqual(await counts(), { commands: before.commands + 1n, audits: before.audits + 1n });
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: input.commandId } });
  assert.deepEqual(audit.before, {}); assert.deepEqual(audit.after, { action: 'update_fields', fieldCount: 1 });
  assert(!JSON.stringify(receipt).includes(f.task.title));
  assert.equal((await readTechnicalWorkItem(db, f.techA.session, target, { kind: 'Task', itemId: f.task.id })).fields.priority, 'urgente');
});
test('checklist notes can be edited without changing status, linking a document or exposing unselected tasks', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f, f.techB, 'ChecklistItem');
  const view = await readTechnicalWorkItem(db, f.techB.session, target, { kind: 'ChecklistItem', itemId: f.check.id });
  const { fields: _f, editableFields: _e, ...identity } = view;
  void _f; void _e;
  const input = { ...identity, commandId: randomUUID(), action: 'update_fields', patch: { notes: 'Integrazione tecnica completata' } };
  const p = await previewTechnicalWorkItem(db, f.techB.session, target, input);
  await confirmTechnicalWorkItem(db, f.techB.session, target, p.command, p.token, true);
  const row = await db.documentChecklistItem.findUniqueOrThrow({ where: { id: f.check.id } });
  assert.equal(row.notes, input.patch.notes); assert.equal(row.status, f.check.status); assert.equal(row.documentId, null);
  await assert.rejects(previewTechnicalWorkItem(db, f.techB.session, target, { ...input, commandId: randomUUID(), patch: { status: 'validato' } }));
});
test('content changed after Admin preview or technician preview is rejected instead of overwriting', options, async () => {
  const f = await fixture(), p = await prepare(f);
  await db.task.update({ where: { id: f.task.id }, data: { priority: 'bassa' } });
  await assert.rejects(confirmTechnicalAssignment(db, admin.session, leadProof(admin), p.ref, 'ASSIGN', p.input, p.preview.token, true));
  await assign(f); const input = await command(f), work = await previewTechnicalWorkItem(db, f.techA.session, p.target, input);
  await db.task.update({ where: { id: f.task.id }, data: { description: 'Cambio concorrente' } });
  await assert.rejects(confirmTechnicalWorkItem(db, f.techA.session, p.target, work.command, work.token, true));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).priority, 'bassa');
});
test('scope restoration, finance restoration and lifecycle restoration do not resurrect item selections', options, async () => {
  for (const mode of ['scope', 'finance', 'lifecycle']) {
    const f = await fixture(), target = technicalTarget(f); await assign(f);
    if (mode === 'scope') { await db.task.update({ where: { id: f.task.id }, data: { projectId: f.otherProject.id } }); await db.task.update({ where: { id: f.task.id }, data: { projectId: f.project.id } }); }
    if (mode === 'finance') { await db.task.update({ where: { id: f.task.id }, data: { title: 'Pagamento riservato' } }); await db.task.update({ where: { id: f.task.id }, data: { title: f.task.title } }); }
    if (mode === 'lifecycle') { await db.task.update({ where: { id: f.task.id }, data: { deletedAt: new Date() } }); await db.task.update({ where: { id: f.task.id }, data: { deletedAt: null } }); }
    await assert.rejects(readTechnicalWorkItem(db, f.techA.session, target, { kind: 'Task', itemId: f.task.id }));
  }
});
test('ordinary routes stay denied after unassigning the item, revocation or replacing the selection', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f); await revokeTechnical(db, admin, target, f.techA);
  await db.task.update({ where: { id: f.task.id }, data: { projectId: null } });
  const current = { ...f.techA.session, ...await loadSelectiveProjectScope(db, f.techA.user.id) };
  assert(current.technicalTaskIds?.includes(f.task.id));
  assert.equal(canViewTask(current, { ...f.task, projectId: null, client: f.client }), false);
  assert.equal(canViewChecklistItem(current, { ...f.check, client: f.client }), false);
  await assert.rejects(readTechnicalWorkItem(db, f.techA.session, target, { kind: 'Task', itemId: f.task.id }));
});
test('revocation blocks an open preview but preserves receipt recovery without private field contents', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f);
  const p = await previewTechnicalWorkItem(db, f.techA.session, target, await command(f));
  const receipt = await confirmTechnicalWorkItem(db, f.techA.session, target, p.command, p.token, true);
  const next = await previewTechnicalWorkItem(db, f.techA.session, target, await command(f, f.techA, { priority: 'media' }));
  await revokeTechnical(db, admin, target, f.techA);
  await assert.rejects(confirmTechnicalWorkItem(db, f.techA.session, target, next.command, next.token, true));
  assert.deepEqual((await readTechnicalWorkItemOutcome(db, f.techA.session, target, p.command.commandId)).receipt, receipt);
  const session = await syntheticSession(db, f.techA.user);
  await assert.rejects(readTechnicalWorkItemOutcome(db, session.session, target, p.command.commandId));
});
test('concurrent two-technician changes to the same item accept at most one exact generation', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f); await assign(f, f.techB);
  const a = await previewTechnicalWorkItem(db, f.techA.session, target, await command(f));
  const b = await previewTechnicalWorkItem(db, f.techB.session, target, await command(f, f.techB, { priority: 'media' }));
  const results = await Promise.allSettled([confirmTechnicalWorkItem(db, f.techA.session, target, a.command, a.token, true),
    confirmTechnicalWorkItem(db, f.techB.session, target, b.command, b.token, true)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
});
test('audit failure rolls back the item, generation and command; direct generation edits are denied', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f);
  const before = await db.task.findUniqueOrThrow({ where: { id: f.task.id } }), n = await counts();
  const p = await previewTechnicalWorkItem(db, f.techA.session, target, await command(f));
  await db.auditLog.create({ data: { id: p.command.commandId, actorId: admin.user.id, event: 'synthetic_failure_injection', entityType: 'Synthetic', entityId: 'only' } });
  await assert.rejects(confirmTechnicalWorkItem(db, f.techA.session, target, p.command, p.token, true));
  assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: f.task.id } }), before); assert.deepEqual(await counts(), n);
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalWorkItemGeneration" SET generation=generation+1 WHERE kind='Task' AND "itemId"=${f.task.id}`);
});
