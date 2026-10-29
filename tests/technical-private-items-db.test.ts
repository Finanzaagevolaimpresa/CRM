import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, revokeTechnical, type TechnicalFixture } from './technical-assignments/fixtures';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem,
  readPrivateTechnicalItemOutcome, closePrivateTechnicalItemAttempt } from '../src/lib/technical-private-item-service';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { readTechnicalWorkItem, previewTechnicalWorkItem, confirmTechnicalWorkItem } from '../src/lib/technical-work-item-service';
import { technicalWorkItemCommand } from '../src/lib/technical-work-item-command';
import type { TechnicalWorkItemGrant } from '../src/lib/technical-work-item-grant';
import type { TechnicalPrivateItemCommand } from '../src/lib/technical-private-item-contract';
import { listAccessibleTasks, filterAccessibleTasks, getAccessibleDashboardTaskCounts } from '../src/lib/read-access';
import { getInternalNotifications } from '../src/lib/internal-notifications';
import { buildOperationalReportMarkdown } from '../src/lib/operational-report';
import { canViewChecklistItem } from '../src/lib/access-control';
import type { TechnicalTargetReference } from '../src/lib/technical-assignment-display';

const enabled = process.env.TECHNICAL_PRIVATE_ITEM_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => { if (!enabled) return;
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
async function prepare(f: TechnicalFixture, kind: TechnicalPrivateItemCommand['kind'] = 'Task',
  target = technicalTarget(f), person = admin) {
  const context = await loadTechnicalPrivateItemCreationContext(db, person.session, target);
  const common = { target, commandId: randomUUID(), itemId: randomUUID(), expectedContextSha256: context.contextSha256 };
  const command: TechnicalPrivateItemCommand = kind === 'Task' ? { ...common, kind, values: {
    title: 'Attività privata ' + common.itemId, description: 'DESCRIZIONE_PRIVATA_' + common.itemId, priority: 'alta', dueAt: null } }
    : { ...common, kind, values: { title: 'Checklist privata ' + common.itemId, notes: 'NOTA_PRIVATA_' + common.itemId } };
  const proof = leadProof(person), preview = await previewPrivateTechnicalItem(db, person.session, proof, command);
  return { command, proof, preview, target, person };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
const confirm = (p: Prepared, client = db) => confirmPrivateTechnicalItem(client, p.person.session, p.proof, p.command, p.preview.token, true);
test('private creation reconciliation durably closes absent writes, serializes competing confirmation and reads a recorded receipt after a fresh login', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f);
  const close = () => closePrivateTechnicalItemAttempt(db, admin.session, p.proof, p.target, p.command.commandId, true);
  assert.equal((await readPrivateTechnicalItemOutcome(db, admin.session, p.target, p.command.commandId)).status, 'NOT_OBSERVED');
  assert.equal((await close()).status, 'CLOSED_WITHOUT_RECEIPT'); assert.equal((await close()).status, 'CLOSED_WITHOUT_RECEIPT');
  await assert.rejects(confirm(p)); assert.equal(await db.task.count({ where: { id: p.command.itemId } }), 0);
  assert.equal(await db.auditLog.count({ where: { id: 'technical-private-attempt:' + p.command.commandId } }), 1);
  const second = await prepare(f), fresh = { ...admin, ...await syntheticSession(db, admin.user) };
  await confirm(second);
  assert.equal((await readPrivateTechnicalItemOutcome(db, fresh.session, second.target, second.command.commandId)).status, 'RECORDED');
  assert.equal((await closePrivateTechnicalItemAttempt(db, fresh.session, leadProof(fresh), second.target, second.command.commandId, true)).status, 'RECORDED');
  assert.equal(await db.auditLog.count({ where: { id: 'technical-private-attempt:' + second.command.commandId } }), 0);
  const race = await prepare(f);
  await Promise.allSettled([confirm(race), closePrivateTechnicalItemAttempt(db, admin.session, race.proof, race.target, race.command.commandId, true)]);
  const final = await closePrivateTechnicalItemAttempt(db, admin.session, race.proof, race.target, race.command.commandId, true);
  assert(['RECORDED', 'CLOSED_WITHOUT_RECEIPT'].includes(final.status));
  assert.equal(await db.technicalPrivateItemOrigin.count({ where: { commandId: race.command.commandId } }), final.status === 'RECORDED' ? 1 : 0);
  if (final.status !== 'RECORDED') await assert.rejects(confirm(race));
});
async function count() { return { origins: await db.technicalPrivateItemOrigin.count(), tasks: await db.task.count(),
  checks: await db.documentChecklistItem.count(), audits: await db.auditLog.count(), assignments: await db.technicalAssignment.count(),
  notifications: await db.recordUpdateDelivery.count(), emails: await db.approvedCommunication.count() }; }
async function grant(p: Prepared, person: Person, target = p.target) {
  const view = await readTechnicalAssignmentManagement(db, admin.session, target, person.user.id);
  const option = view.workItemOptions.find(item => item.kind === p.command.kind && item.itemId === p.command.itemId); assert(option);
  const identity = { kind: option.kind, itemId: option.itemId, generation: option.generation,
    scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256 };
  const choice: TechnicalWorkItemGrant = option.kind === 'Task' ? { ...identity, kind: 'Task',
    readableFields: ['title', 'priority'], editableFields: ['priority'] } : { ...identity, kind: 'ChecklistItem',
    readableFields: ['title', 'notes'], editableFields: ['notes'] };
  return assignTechnical(db, admin, target, person, { workItems: [choice] });
}
test('GET and personal preview write no rows; task and checklist commit with one minimal atomic audit each', options, async () => {
  const f = await technicalFixture(db, admin), before = await count();
  for (const kind of ['Task', 'ChecklistItem'] as const) {
    const p = await prepare(f, kind); assert.deepEqual(await count(), before);
    const receipt = await confirm(p); assert.equal(receipt.grantCreated, false); assert.equal(receipt.notificationCreated, false);
    const row = await db.technicalPrivateItemOrigin.findUniqueOrThrow({ where: { commandId: p.command.commandId } });
    assert.equal(row.itemId, p.command.itemId); assert.equal(row.actorId, admin.user.id);
    const audit = await db.auditLog.findUniqueOrThrow({ where: { id: p.command.commandId } });
    assert.deepEqual(audit.before, {}); assert.deepEqual(audit.after, { action: 'create_private_item', type: kind });
    assert.equal(JSON.stringify(audit).includes(p.command.values.title), false);
    const after = await count(); assert.equal(after.origins, before.origins + 1); assert.equal(after.audits, before.audits + 1);
    assert.equal(after.assignments, before.assignments); assert.equal(after.notifications, before.notifications); assert.equal(after.emails, before.emails);
    Object.assign(before, after);
  }
});
test('another Admin, two technicians and both commercial owners cannot enter the private creation path', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f), other = await syntheticPerson(db, 'Altro Admin sintetico', 'admin');
  for (const person of [other, f.techA, f.techB, f.salesA, f.salesB]) {
    await assert.rejects(loadTechnicalPrivateItemCreationContext(db, person.session, p.target));
    await assert.rejects(previewPrivateTechnicalItem(db, person.session, leadProof(person), p.command));
    await assert.rejects(confirmPrivateTechnicalItem(db, person.session, leadProof(person), p.command, p.preview.token, true));
  }
  assert.equal(await db.technicalPrivateItemOrigin.count({ where: { itemId: p.command.itemId } }), 0);
});
test('private items stay out of ordinary lists, counters, notifications and reports even for the personal Admin', options, async () => {
  const f = await technicalFixture(db, admin), task = await prepare(f), check = await prepare(f, 'ChecklistItem');
  const now = new Date(), window = { now, startOfToday: new Date(now.getTime()-86400000), endOfToday: new Date(now.getTime()+86400000), next7: new Date(now.getTime()+604800000) };
  const counts = await getAccessibleDashboardTaskCounts(admin.session, window);
  await confirm(task); await confirm(check);
  assert.deepEqual(await getAccessibleDashboardTaskCounts(admin.session, window), counts);
  const savedTask = await db.task.findUniqueOrThrow({ where: { id: task.command.itemId } });
  const savedCheck = await db.documentChecklistItem.findUniqueOrThrow({ where: { id: check.command.itemId } });
  for (const person of [admin, f.techA, f.techB, f.salesA, f.salesB]) {
    assert.deepEqual(await listAccessibleTasks(person.session, { where: { id: savedTask.id }, take: 1 }), []);
    assert.deepEqual(await filterAccessibleTasks(person.session, [savedTask], db), []);
    assert.equal(canViewChecklistItem(person.session, { ...savedCheck, client: f.client, project: f.project }), false);
    assert.equal(JSON.stringify(await getInternalNotifications(person.session)).includes(savedTask.title), false);
    const report = await buildOperationalReportMarkdown(person.session, { clientId: f.client.id });
    assert.equal(JSON.stringify(report).includes(savedTask.title), false); assert.equal(JSON.stringify(report).includes(savedCheck.title), false);
  }
});
test('same-client and same-project sibling practices cannot adopt the private origin; explicit exact grant permits selected work', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f); await confirm(p);
  const sibling = await db.technicalPractice.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'Pratica sorella sintetica', practiceType: 'Sintetica', targetEntity: 'Ente sintetico', createdById: admin.user.id } });
  for (const target of [{ kind: 'TechnicalPractice', targetId: sibling.id }, technicalTarget(f, 'Project')] as TechnicalTargetReference[]) {
    const view = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
    assert(!view.workItemOptions.some(item => item.itemId === p.command.itemId));
  }
  await assert.rejects(readTechnicalWorkItem(db, f.techA.session, p.target, { kind: p.command.kind, itemId: p.command.itemId }));
  await grant(p, f.techA);
  const view = await readTechnicalWorkItem(db, f.techA.session, p.target, { kind: p.command.kind, itemId: p.command.itemId });
  assert.equal(view.fields.title, p.command.values.title); assert.equal('description' in view.fields, false);
  const command = technicalWorkItemCommand.parse({ commandId: randomUUID(), assignmentId: view.assignmentId,
    assignmentRevision: view.assignmentRevision, bindingId: view.bindingId, bindingRevision: view.bindingRevision,
    expectedContextSha256: view.expectedContextSha256, kind: view.kind, itemId: view.itemId,
    expectedItemVersion: view.expectedItemVersion, action: 'update_fields', patch: { priority: 'urgente' } });
  const preview = await previewTechnicalWorkItem(db, f.techA.session, p.target, command);
  await confirmTechnicalWorkItem(db, f.techA.session, p.target, command, preview.token, true);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: p.command.itemId } })).priority, 'urgente');
  for (const person of [f.techB, f.salesA, f.salesB])
    await assert.rejects(readTechnicalWorkItem(db, person.session, p.target, { kind: p.command.kind, itemId: p.command.itemId }));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).salesOwnerId, f.salesA.user.id);
});
test('project creation is private and cannot be inherited by a child practice sharing the same client', options, async () => {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), p = await prepare(f, 'ChecklistItem', technicalTarget(f, 'Project')); await confirm(p);
  await grant(p, f.techB);
  assert.equal((await readTechnicalWorkItem(db, f.techB.session, p.target, { kind: p.command.kind, itemId: p.command.itemId })).fields.title, p.command.values.title);
  const view = await readTechnicalAssignmentManagement(db, admin.session, technicalTarget(f), f.techB.user.id);
  assert(!view.workItemOptions.some(item => item.itemId === p.command.itemId));
  await revokeTechnical(db, admin, p.target, f.techB);
  await assert.rejects(readTechnicalWorkItem(db, f.techB.session, p.target, { kind: p.command.kind, itemId: p.command.itemId }));
  assert.equal(await db.technicalPrivateItemOrigin.count({ where: { commandId: p.command.commandId } }), 1);
  assert.equal((await readPrivateTechnicalItemOutcome(db, admin.session, p.target, p.command.commandId)).status, 'RECORDED');
});
test('lost response and concurrent duplicate confirmation record exactly one item and one command', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f);
  const results = await Promise.allSettled([confirm(p), confirm(p)]);
  assert(results.some(r => r.status === 'fulfilled'));
  const before = await count();
  assert.equal((await readPrivateTechnicalItemOutcome(db, admin.session, p.target, p.command.commandId)).status, 'RECORDED');
  const replay = await confirm(p); assert.equal(replay.commandId, p.command.commandId);
  assert.deepEqual(await count(), before);
  assert.equal(await db.technicalPrivateItemOrigin.count({ where: { commandId: p.command.commandId } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: p.command.commandId } }), 1);
  assert.equal(await db.task.count({ where: { id: p.command.itemId } }), 1);
  const other = { ...p, command: { ...p.command, values: { ...p.command.values, title: 'Contenuto sostituito' } } as TechnicalPrivateItemCommand };
  await assert.rejects(confirm(other)); assert.deepEqual(await count(), before);
});
test('revoked session, expired personal proof and explicit permission denial stop already open previews', options, async () => {
  const f = await technicalFixture(db, admin), fresh = { ...await syntheticSession(db, admin.user), user: admin.user }, p = await prepare(f, 'Task', technicalTarget(f), fresh);
  await db.internalSession.update({ where: { id: fresh.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(confirm(p));
  const valid = await prepare(f);
  await assert.rejects(confirm({ ...valid, proof: leadProof(admin, Math.floor(Date.now()/1000)-301) }));
  const permission = await db.userPermissionOverride.create({ data: { userId: admin.user.id, permission: 'service.write', allowed: false } });
  try { await assert.rejects(confirm(valid)); } finally { await db.userPermissionOverride.delete({ where: { id: permission.id } }); }
  assert.equal(await db.task.count({ where: { id: { in: [p.command.itemId, valid.command.itemId] } } }), 0);
});
test('a changed context or archived target invalidates preview even when restored before confirmation', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f);
  await db.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  await assert.rejects(confirm(p));
  await db.project.update({ where: { id: f.project.id }, data: { status: f.project.status } });
  await assert.rejects(confirm(p));
  const current = await prepare(f); await confirm(current);
  assert.equal(await db.task.count({ where: { id: p.command.itemId } }), 0);
});
test('a fresh active session of the same personal Admin can reconcile history but cannot replay another session command', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f); await confirm(p);
  const fresh = { ...await syntheticSession(db, admin.user), user: admin.user };
  const recorded = await readPrivateTechnicalItemOutcome(db, fresh.session, p.target, p.command.commandId);
  assert.equal(recorded.status, 'RECORDED');
  if (recorded.status === 'RECORDED') assert.equal(recorded.receipt.sessionId, admin.session.sessionId);
  await assert.rejects(confirm({ ...p, person: fresh, proof: leadProof(fresh) }));
  const outsider = await syntheticPerson(db, 'Altro Admin senza autorità personale', 'admin');
  await assert.rejects(readPrivateTechnicalItemOutcome(db, outsider.session, p.target, p.command.commandId));
  await db.internalSession.update({ where: { id: fresh.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readPrivateTechnicalItemOutcome(db, fresh.session, p.target, p.command.commandId));
  assert.deepEqual(await readPrivateTechnicalItemOutcome(db, admin.session, p.target, randomUUID()), { status: 'NOT_OBSERVED' });
});
test('database failure at the audit boundary rolls back canonical row, generation and origin together', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f), before = await count();
  const fault = new Proxy(db, { get(current, key, receiver) {
    if (key !== '$transaction') return Reflect.get(current, key, receiver);
    return <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, settings?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
      current.$transaction(tx => work(new Proxy(tx, { get(inner, property, rr) {
        if (property !== 'auditLog') return Reflect.get(inner, property, rr);
        return new Proxy(inner.auditLog, { get(log, operation, r) {
          if (operation !== 'create') return Reflect.get(log, operation, r);
          return async () => { throw new Error('SYNTHETIC_AUDIT_FAILURE'); };
        } });
      } })), settings);
  } });
  await assert.rejects(confirm(p, fault), /SYNTHETIC_AUDIT_FAILURE/); assert.deepEqual(await count(), before);
  assert.equal(await db.technicalWorkItemGeneration.count({ where: { kind: p.command.kind, itemId: p.command.itemId } }), 0);
});
test('DB constraints reject an orphan private row and forbid adding or removing the private marker', options, async () => {
  const f = await technicalFixture(db, admin), id = randomUUID();
  await assert.rejects(db.task.create({ data: { id, technicalPrivate: true, clientId: f.client.id, title: 'Orfana sintetica' } }));
  assert.equal(await db.task.count({ where: { id } }), 0);
  const old = await db.task.create({ data: { clientId: f.client.id, title: 'Attività ordinaria sintetica' } });
  await assert.rejects(db.task.update({ where: { id: old.id }, data: { technicalPrivate: true } }));
  const p = await prepare(f); await confirm(p);
  await assert.rejects(db.task.update({ where: { id: p.command.itemId }, data: { technicalPrivate: false } }));
  await assert.rejects(db.task.update({ where: { id: p.command.itemId }, data: { assignedToId: f.techA.user.id } }));
  await assert.rejects(db.task.update({ where: { id: p.command.itemId }, data: { projectId: f.otherProject.id } }));
  await assert.rejects(db.task.delete({ where: { id: p.command.itemId } }));
  await assert.rejects(db.technicalPrivateItemOrigin.delete({ where: { commandId: p.command.commandId } }));
  await assert.rejects(db.auditLog.update({ where: { id: p.command.commandId }, data: { after: { text: 'EXTRA' } } }));
  await assert.rejects(db.auditLog.delete({ where: { id: p.command.commandId } }));
});
test('an audit with extra content cannot commit a creation, despite a valid signed command', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f), before = await count();
  const altered = new Proxy(db, { get(current, key, receiver) {
    if (key !== '$transaction') return Reflect.get(current, key, receiver);
    return <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, settings?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
      current.$transaction(async tx => {
        const result = await work(tx);
        await tx.auditLog.update({ where: { id: p.command.commandId }, data: { after: { action: 'create_private_item', type: 'Task', text: 'EXTRA' } } });
        return result;
      }, settings);
  } });
  await assert.rejects(confirm(p, altered)); assert.deepEqual(await count(), before);
});
test('confirmation does not execute after a concurrent project scope change wins the parent lock', options, async () => {
  const f = await technicalFixture(db, admin), p = await prepare(f);
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const changing = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${f.project.id} FOR UPDATE`; locked(); await held;
    await tx.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  });
  await ready; const pending = confirm(p); release(); await changing; await assert.rejects(pending);
  assert.equal(await db.task.count({ where: { id: p.command.itemId } }), 0);
});
