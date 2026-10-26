import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticSession, syntheticPerson } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignmentInput, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { technicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { readTechnicalWork, readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { readTechnicalWorkItem, previewTechnicalWorkItem, confirmTechnicalWorkItem, readTechnicalWorkItemOutcome } from '../src/lib/technical-work-item-service';
import { technicalWorkItemCommand } from '../src/lib/technical-work-item-command';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { canViewTask, canViewChecklistItem } from '../src/lib/access-control';
import { readCommercialProgress } from '../src/lib/commercial-progress';
import type { TechnicalWorkItemGrant } from '../src/lib/technical-work-item-grant';
import { technicalWorkItemCatalogueQuery } from '../src/lib/technical-work-item-catalog';
import { documentCatalogueFixture } from './technical-work-items/document-catalog-fixture';
import { technicalDocumentCatalogueQuery } from '../src/lib/technical-document-catalog';
import { technicalDocumentPrivateVisibility } from '../src/lib/technical-document-visibility';
import { SerializableConflictError } from '../src/lib/serializable';

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

function documents(f: Fixture, query = '', page = 1, person = f.techA) {
  return readTechnicalAssignmentManagement(db, admin.session, technicalTarget(f), person.user.id,
    technicalWorkItemCatalogueQuery.parse({}), technicalDocumentCatalogueQuery.parse({ query, page }));
}
async function documentChoice(f: Fixture, query: string) {
  const catalogue = await documents(f, query), option = catalogue.documentOptions[0]; assert(option);
  const base = await assignmentInput(db, admin, technicalTarget(f), f.techA);
  return { ...base, selection: technicalAssignmentSelection.parse({ ...base.selection,
    documents: [{ documentId: option.documentId, fileId: option.fileId, version: option.version,
      contentSha256: option.contentSha256, contextSha256: option.contextSha256, allowDownload: false }] }) };
}

test('document catalogue reaches beyond 100 documents and 200 versions without writes or hidden financial metadata', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f, 101, 2);
  const audits = await db.auditLog.count(), decisions = await db.technicalAssignmentDecision.count();
  const first = await documents(f, 'Catalogo documentale sintetico'), last = await documents(f, 'Catalogo documentale sintetico', 11);
  assert(first.documentCatalogueAvailable); assert.equal(first.documentOptions.length, 20); assert(first.documentCatalogue.hasNext);
  assert.equal(last.documentOptions.length, 2); assert(!last.documentCatalogue.hasNext);
  assert.deepEqual(last.documentOptions.map(row => row.fileId), rows[100].versions.map(row => row.fileId));
  const searched = await documents(f, rows[100].fileName);
  assert.deepEqual(searched.documentOptions.map(row => row.fileId), rows[100].versions.map(row => row.fileId));
  assert(!JSON.stringify(searched.documentCatalogue).includes('storagePath'));
  assert.equal((await documents(f, f.documents[2].doc.fileName)).documentOptions.length, 0);
  assert.equal(await db.auditLog.count(), audits); assert.equal(await db.technicalAssignmentDecision.count(), decisions);
});

test('all 256 raw versions are supported; the next version closes new selection while revocation stays available', options, async () => {
  const f = await fixture(); await assign(f);
  await documentCatalogueFixture(db, f, 1, 253); // plus the three original versions
  const exact = await documents(f, 'Catalogo documentale sintetico', 13);
  assert(exact.documentCatalogueAvailable); assert.equal(exact.documentOptions.length, 13); assert(!exact.documentCatalogue.hasNext);
  await db.documentVersion.create({ data: { documentId: f.documents[0].doc.id, version: 2,
    storagePath: f.documents[0].doc.storagePath, checksum: f.documents[0].doc.checksum } });
  for (const query of ['', 'Catalogo documentale sintetico', 'absent']) {
    const limited = await documents(f, query);
    assert.equal(limited.documentCatalogueAvailable, false); assert.deepEqual(limited.documentOptions, []);
    assert.equal(limited.currentAssignmentId, limited.assignments.find(row => row.recipientId === f.techA.user.id)?.id);
    assert(limited.currentAssignmentId);
  }
  assert.equal((await revokeTechnical(db, admin, technicalTarget(f), f.techA)).operation, 'REVOKE');
  await assert.rejects(readTechnicalWork(db, f.techA.session, technicalTarget(f)));
});

test('document search omits another project, expired and nonordinary versions; invalid private relabelling stays forbidden', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f, 65);
  await db.document.update({ where: { id: rows[0].id }, data: { projectId: f.otherProject.id } });
  await db.document.update({ where: { id: rows[1].id }, data: { validUntil: new Date(0) } });
  // SQL68 deliberately prevents a private acquisition being forged by changing
  // visibility. Keep that invariant, then use a valid nonordinary source row.
  await assert.rejects(db.document.update({ where: { id: rows[2].id }, data: { visibilityLevel: technicalDocumentPrivateVisibility } }), /TECHNICAL_CANONICAL_RETAINED/);
  await db.document.update({ where: { id: rows[2].id }, data: { visibilityLevel: 'riservato' } });
  await db.document.update({ where: { id: rows[3].id }, data: { deletedAt: new Date() } });
  const first = await documents(f, 'Catalogo documentale sintetico'), last = await documents(f, 'Catalogo documentale sintetico', 4);
  assert.equal(first.documentOptions[0].fileId, rows[4].versions[0].fileId);
  assert.equal(last.documentOptions.length, 1); assert.equal(last.documentOptions[0].fileId, rows[64].versions[0].fileId);
  for (const row of rows.slice(0, 4)) assert.deepEqual((await documents(f, row.fileName)).documentOptions, []);
});

test('an off-page version grants only its bytes, never download or another version/person, then revocation closes it', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f, 65, 2), target = technicalTarget(f);
  const input = await documentChoice(f, rows[64].fileName), ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
  const file = rows[64].versions[0], bytes = async () => Buffer.from(file.text);
  assert.equal((await readTechnicalWorkDocument(db, f.techA.session, target, file.fileId, false, bytes)).bytes.toString(), file.text);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, file.fileId, true, bytes));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, rows[64].versions[1].fileId, false, bytes));
  for (const person of [f.techB, f.salesA, f.salesB]) await assert.rejects(readTechnicalWorkDocument(db, person.session, target, file.fileId, false, bytes));
  await revokeTechnical(db, admin, target, f.techA);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, file.fileId, false, bytes));
});

test('refresh does not renew a chosen document snapshot; concurrent source changes invalidate the exact preview', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f), target = technicalTarget(f);
  const input = await documentChoice(f, rows[64].fileName), ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await db.document.update({ where: { id: rows[64].id }, data: { title: 'Relazione aggiornata sintetica' } });
  const current = await documents(f, rows[64].fileName);
  assert.notEqual(current.documentOptions[0].contextSha256, input.selection.documents[0].contextSha256);
  await assert.rejects(previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input));
  await assert.rejects(confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true));
  assert.equal(await db.technicalAssignment.count({ where: { recipientId: f.techA.user.id, practiceId: target.targetId } }), 0);
});

test('catalogue source changes under a held SQL lock cannot return the old authorized title', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f, 1), target = rows[0];
  let locked!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { locked = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const update = db.$transaction(async tx => {
    await tx.document.update({ where: { id: target.id }, data: { projectId: f.otherProject.id } });
    locked(); await released;
  });
  await held;
  const read = documents(f, target.fileName).then(result => ({ result }), error => ({ error }));
  release(); await update;
  const observed = await read;
  if ('result' in observed) assert.deepEqual(observed.result.documentOptions, []);
  else assert(observed.error instanceof SerializableConflictError);
});

test('both technicians and both commercial actors cannot inspect the personal document catalogue', options, async () => {
  const f = await fixture();
  for (const person of [f.techA, f.techB, f.salesA, f.salesB])
    await assert.rejects(readTechnicalAssignmentManagement(db, person.session, technicalTarget(f), f.techA.user.id));
  await db.userPermissionOverride.create({ data: { userId: f.techA.user.id, permission: 'document.download', allowed: false } });
  assert.deepEqual((await documents(f)).documentOptions, []);
});

test('a linked checklist remains discoverable when its allowed document is on another catalogue page', options, async () => {
  const f = await fixture(), rows = await documentCatalogueFixture(db, f, 65);
  await db.documentChecklistItem.update({ where: { id: f.check.id }, data: { documentId: rows[64].id } });
  const result = await documents(f, rows[0].fileName);
  assert.equal(result.documentOptions.length, 1);
  assert(result.workItemOptions.some(row => row.itemId === f.check.id));
  const base = await assignmentInput(db, admin, technicalTarget(f), f.techA);
  const item = result.workItemOptions.find(row => row.itemId === f.check.id)!;
  const bad = { ...base, selection: technicalAssignmentSelection.parse({ ...base.selection, actions: ['manage_checklist'],
    readableFields: ['title'], editableFields: [],
    workItems: [{ kind: item.kind, itemId: item.itemId, generation: item.generation,
      scopeGeneration: item.scopeGeneration, scopeSha256: item.scopeSha256, readableFields: ['title'], editableFields: [] }] }) };
  await assert.rejects(previewTechnicalAssignment(db, admin.session, { ...technicalTarget(f), recipientId: f.techA.user.id }, 'ASSIGN', bad));
});

test('catalogue reaches admitted items beyond fifty and pages only after all current context exclusions', options, async () => {
  const f = await fixture(), target = technicalTarget(f), prefix = randomUUID();
  await db.task.createMany({ data: Array.from({ length: 61 }, (_, i) => ({ id: `${prefix}-visible-${String(i).padStart(3, '0')}`,
    clientId: f.client.id, projectId: f.project.id, title: `Catalogue literal %_[+] ${i}` })) });
  await db.task.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ id: `${prefix}-hidden-${String(i).padStart(3, '0')}`,
    clientId: f.client.id, projectId: f.otherProject.id, title: `Catalogue literal %_[+] DENIED ${i}` })) });
  const before = await counts(), audits = await db.auditLog.count(), seen: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const result = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id,
      technicalWorkItemCatalogueQuery.parse({ kind: 'Task', query: 'literal %_[+]', page }));
    assert(result.workItemCatalogueAvailable); assert.equal(result.workItemCatalogue.hasNext, page < 4);
    assert.equal(result.workItemOptions.length, page < 4 ? 20 : 1);
    seen.push(...result.workItemOptions.map(x => x.itemId));
    assert(!JSON.stringify(result.workItemOptions).includes('DENIED'));
  }
  assert.equal(new Set(seen).size, 61); assert(seen.some(id => id.endsWith('visible-060')));
  const hidden = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id,
    technicalWorkItemCatalogueQuery.parse({ kind: 'Task', query: 'DENIED' }));
  assert.deepEqual(hidden.workItemOptions, []); assert.equal(hidden.workItemCatalogue.hasNext, false);
  const later = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id,
    technicalWorkItemCatalogueQuery.parse({ kind: 'Task', query: 'literal %_[+]', page: 5 }));
  assert.deepEqual(later.workItemOptions, []); assert.equal(later.workItemCatalogue.hasNext, false);
  assert.deepEqual(await counts(), before); assert.equal(await db.auditLog.count(), audits);
});

test('an item selected from a later catalogue page is usable but a changed snapshot cannot be silently refreshed', options, async () => {
  const f = await fixture(), target = technicalTarget(f), prefix = randomUUID();
  await db.task.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, '0')}`,
    clientId: f.client.id, projectId: f.project.id, title: `Deep catalogue ${i}` })) });
  const view = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id,
    technicalWorkItemCatalogueQuery.parse({ query: 'Deep catalogue', page: 3 }));
  const selected = view.workItemOptions.at(-1)!; assert(selected.itemId.endsWith('-054'));
  const base = await assignmentInput(db, admin, target, f.techA);
  const { title: _title, ...identity } = selected; void _title;
  const input = { ...base, selection: technicalAssignmentSelection.parse({ ...base.selection, actions: ['manage_deadlines'],
    readableFields: ['title'], editableFields: [],
    workItems: [{ ...identity, readableFields: ['title', 'priority'], editableFields: ['priority'] }] }) };
  const ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await db.task.update({ where: { id: selected.itemId }, data: { priority: 'alta' } });
  await assert.rejects(confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true));
  await assert.rejects(previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input));
  const refreshed = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id,
    technicalWorkItemCatalogueQuery.parse({ query: 'Deep catalogue 54' }));
  const { title: _newTitle, ...current } = refreshed.workItemOptions[0]; void _newTitle;
  assert.equal(current.generation, selected.generation + 1);
  const next = { ...input, commandId: randomUUID(), selection: technicalAssignmentSelection.parse({ ...input.selection,
    workItems: [{ ...current, readableFields: ['title', 'priority'], editableFields: ['priority'] }] }) };
  const accepted = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', next);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', next, accepted.token, true);
  const admitted = await readTechnicalWorkItem(db, f.techA.session, target, { kind: 'Task', itemId: selected.itemId });
  assert.equal(admitted.fields.priority, 'alta');
  await assert.rejects(readTechnicalWorkItem(db, f.techB.session, target, { kind: 'Task', itemId: selected.itemId }));
});

test('catalogue requires the current personal manager and eligible recipient, not a technician or another Admin role', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  const otherAdmin = await syntheticPerson(db, 'Admin senza autorità personale', 'admin');
  for (const session of [f.techA.session, f.techB.session, f.salesA.session, f.salesB.session, otherAdmin.session])
    await assert.rejects(readTechnicalAssignmentManagement(db, session, target, f.techA.user.id, technicalWorkItemCatalogueQuery.parse({ query: '%' })));
  await db.user.update({ where: { id: f.techA.user.id }, data: { active: false } });
  const unavailable = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
  assert.equal(unavailable.recipientEligible, false); assert.deepEqual(unavailable.workItemOptions, []);
});

test('catalogue ceiling is query independent and leaves assignment history and revocation reachable', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assign(f);
  const before = await counts();
  await db.task.createMany({ data: Array.from({ length: 6001 }, (_, i) => ({ clientId: f.client.id,
    projectId: f.project.id, title: `Ceiling ${i}` })) });
  for (const query of ['', 'not present', 'Ceiling 6000']) {
    const view = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id, technicalWorkItemCatalogueQuery.parse({ query }));
    assert.equal(view.workItemCatalogueAvailable, false); assert.deepEqual(view.workItemOptions, []);
    assert.equal(view.workItemCatalogue.hasNext, false); assert(view.currentAssignmentId);
    assert(view.assignments.some(a => a.recipientId === f.techA.user.id));
  }
  assert.deepEqual(await counts(), before);
});
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
