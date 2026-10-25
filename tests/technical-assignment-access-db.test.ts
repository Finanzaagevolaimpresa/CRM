import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, assignmentInput, revokeTechnical, workInput } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment, readTechnicalAssignmentOutcome } from '../src/lib/technical-assignment-service';
import { readTechnicalWork, listTechnicalWork, readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { previewTechnicalWork, confirmTechnicalWork, readTechnicalWorkOutcome } from '../src/lib/technical-work-service';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { canViewClient, canViewProject, canViewTechnicalPractice, canViewLead, canViewDocument } from '../src/lib/access-control';
import { readCommercialProgress } from '../src/lib/commercial-progress';

// New PostgreSQL execution is confined to the approved ephemeral CI job.
const enabled = process.env.RUN_TECHNICAL_ASSIGNMENT_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
const fixture = () => technicalFixture(db, admin);
async function workCount(targetId: string) {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalWorkCommand" WHERE "targetId"=${targetId}`;
  return row.n;
}

test('no sharing/email/Admin authority substitutes the distinct empty technical binding', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  await assert.rejects(readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id));
  assert.equal(await workCount(target.targetId), 0n);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const other = await syntheticPerson(db, 'Admin senza binding sintetico');
  await assert.rejects(readTechnicalAssignmentManagement(db, other.session, target));
  assert.equal((await readTechnicalAssignmentManagement(db, admin.session, target)).operational, true);
});

test('preview is read-only; two personal assignments coexist without changing sales or legacy technical owners', options, async () => {
  const f = await fixture(), target = technicalTarget(f), input = await assignmentInput(db, admin, target, f.techA);
  const ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  const [beforeRow] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalAssignment" WHERE "practiceId"=${f.practice.id}`;
  assert.equal(beforeRow.n, 0n);
  await assert.rejects(confirmTechnicalAssignment(db, admin.session, { ...leadProof(admin), stepUpToken: '' }, ref, 'ASSIGN', input, preview.token, true));
  const receipt = await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
  const second = await assignTechnical(db, admin, target, f.techB);
  assert.notEqual(receipt.assignmentId, second.receipt.assignmentId);
  for (const person of [f.techA, f.techB]) assert.equal((await readTechnicalWork(db, person.session, target)).assignmentRevision, 1);
  const current = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert.equal(current.technicalOwnerId, f.techA.user.id); assert.equal(current.commercialOwnerId, f.salesA.user.id);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).salesOwnerId, f.salesA.user.id);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } });
  assert.deepEqual(audit.before, { version: 0 });
  assert.deepEqual(audit.after, { version: 1, action: 'ASSIGN', fieldCount: input.selection.readableFields.length, actionCount: 2, documentCount: 0 });
  assert.equal(JSON.stringify(audit).includes('NOTA_INTERNA_NON_SELEZIONATA'), false);
});

test('exact assignment replay and lost-response lookup return one receipt; changed command, session or person cannot reuse it', options, async () => {
  const f = await fixture(), target = technicalTarget(f), a = await assignTechnical(db, admin, target, f.techA);
  assert.deepEqual(await confirmTechnicalAssignment(db, admin.session, leadProof(admin), a.ref, 'ASSIGN', a.input, a.preview.token, true), a.receipt);
  assert.deepEqual(await readTechnicalAssignmentOutcome(db, admin.session, a.ref, a.input.commandId), { status: 'RECORDED', receipt: a.receipt });
  await assert.rejects(confirmTechnicalAssignment(db, admin.session, leadProof(admin), a.ref, 'ASSIGN', { ...a.input, reason: 'Motivo differente' }, a.preview.token, true));
  await assert.rejects(readTechnicalAssignmentOutcome(db, admin.session, { ...a.ref, recipientId: f.techB.user.id }, a.input.commandId));
  const session = await syntheticSession(db, admin.user);
  await assert.rejects(readTechnicalAssignmentOutcome(db, session.session, a.ref, a.input.commandId));
  assert.equal((await readTechnicalAssignmentManagement(db, admin.session, target)).assignments.length, 1);
});

test('documents are usable only at the exact selected version, with download distinct from preview and financial links excluded', options, async () => {
  const f = await fixture(), target = technicalTarget(f), [one, two, financial] = f.documents;
  const setup = await readTechnicalAssignmentManagement(db, admin.session, target, f.techA.user.id);
  assert(setup.documentOptions.some(row => row.fileId === one.version.id));
  assert(!setup.documentOptions.some(row => row.fileId === financial.version.id));
  await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: one.version.id, allowDownload: false }, { fileId: two.version.id, allowDownload: true }] });
  const bytes = async (path: string) => {
    const doc = f.documents.find(row => row.doc.storagePath === path); assert(doc); return doc.bytes;
  };
  assert.deepEqual((await readTechnicalWorkDocument(db, f.techA.session, target, one.version.id, false, bytes)).bytes, one.bytes);
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, one.version.id, true, bytes));
  assert.deepEqual((await readTechnicalWorkDocument(db, f.techA.session, target, two.version.id, true, bytes)).bytes, two.bytes);
  await assert.rejects(readTechnicalWorkDocument(db, f.techB.session, target, one.version.id, false, bytes));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, financial.version.id, false, bytes));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, two.version.id, false, async () => Buffer.from('WRONG_BYTES')));
  const later = await db.documentVersion.create({ data: { documentId: one.doc.id, version: 2, storagePath: one.doc.storagePath, checksum: one.version.checksum } });
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, later.id, false, bytes));
});

test('selected fields and search exclude private fields and unselected titles; legacy dossier, lead and other project paths are denied', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  await assignTechnical(db, admin, target, f.techA, { statusOnly: true });
  const view = await readTechnicalWork(db, f.techA.session, target);
  assert.deepEqual(view.fields.map(row => row.key), ['status']);
  const search = await listTechnicalWork(db, f.techA.session, 'TechnicalPractice', 1, 'multipla');
  assert.equal(search.records.length, 0);
  assert.equal((await listTechnicalWork(db, f.techA.session, 'TechnicalPractice')).records[0].title, 'Incarico tecnico');
  const current = { ...f.techA.session, ...await loadSelectiveProjectScope(db, f.techA.user.id) };
  assert.equal(canViewClient(current, f.client), false);
  assert.equal(canViewLead(current, f.lead), false);
  assert.equal(canViewProject(current, { ...f.project, client: f.client }), false);
  assert.equal(canViewProject(current, { ...f.otherProject, client: f.client }), false);
  assert.equal(canViewTechnicalPractice(current, { ...f.practice, client: f.client, project: { ...f.project, client: f.client } }), false);
  assert.equal(canViewDocument(current, { ...f.documents[1].doc, client: f.client, project: { ...f.project, client: f.client } }), false);
  await assert.rejects(readTechnicalWork(db, f.techA.session, { kind: 'Project', targetId: f.otherProject.id }));
});

test('technical updates are exact, audited and visible only in the original commercial progress; other sales remains separate', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), preview = await previewTechnicalWork(db, f.techA.session, target, input);
  assert.equal(await workCount(target.targetId), 0n);
  const receipt = await confirmTechnicalWork(db, f.techA.session, target, preview.command, preview.token, true);
  assert.equal(receipt.fieldCount, 1);
  const row = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert.equal(row.clientVisibleStatus, input.patch.clientVisibleStatus); assert.equal(row.internalNotes, f.practice.internalNotes);
  assert.equal(row.commercialOwnerId, f.salesA.user.id); assert.equal(row.technicalOwnerId, f.techA.user.id);
  const a = await readCommercialProgress(db, f.salesA.session, { client: f.client.id });
  assert.equal(a.items.length, 1);
  // The commercial projection exposes canonical progress, never technical free text.
  assert.equal(JSON.stringify(a).includes(String(input.patch.clientVisibleStatus)), false);
  const statusInput = await workInput(db, f.techA, target, { status: 'in_progettazione' });
  const statusPreview = await previewTechnicalWork(db, f.techA.session, target, statusInput);
  const statusReceipt = await confirmTechnicalWork(db, f.techA.session, target, statusPreview.command, statusPreview.token, true);
  const progressed = await readCommercialProgress(db, f.salesA.session, { client: f.client.id });
  assert.equal(progressed.items[0].status, 'in_progettazione');
  assert.equal(progressed.items[0].statusLabel, 'In lavorazione');
  assert.equal(JSON.stringify(progressed).includes(String(input.patch.clientVisibleStatus)), false);
  assert.deepEqual((await db.auditLog.findUniqueOrThrow({ where: { id: statusReceipt.commandId } })).after,
    { action: 'update_status', fieldCount: 1 });
  assert.equal(await workCount(target.targetId), 2n);
  const b = await readCommercialProgress(db, f.salesB.session, { client: f.client.id });
  assert.equal(b.items.length, 0);
  const bOwn = await readCommercialProgress(db, f.salesB.session, {}); assert.equal(bOwn.items.length, 1);
  assert.equal(JSON.stringify(bOwn).includes(f.practice.id), false);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.commandId } });
  assert.deepEqual(audit.before, {}); assert.deepEqual(audit.after, { action: 'update_fields', fieldCount: 1 });
  assert.equal(JSON.stringify(audit).includes(String(input.patch.clientVisibleStatus)), false);
});

test('field allowlists and status operation cannot change owners, private notes, lifecycle or the exact preview', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), preview = await previewTechnicalWork(db, f.techA.session, target, input);
  for (const patch of [{ internalNotes: 'privato' }, { commercialOwnerId: f.salesB.user.id }, { clientId: f.otherClient.id }, { clientVisibleStatus: 'changed after preview' }]) {
    await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, { ...input, patch }, preview.token, true));
  }
  await assert.rejects(previewTechnicalWork(db, f.techA.session, target, { ...input, action: 'update_status', patch: { status: 'archiviata' } }));
  await assert.rejects(confirmTechnicalWork(db, f.techB.session, target, input, preview.token, true));
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, input, preview.token, false));
  assert.equal(await workCount(target.targetId), 0n);
  const status = await workInput(db, f.techA, target, { status: 'in_progettazione' });
  const p = await previewTechnicalWork(db, f.techA.session, target, status);
  await confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true);
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } })).status, 'in_progettazione');
});

test('concurrent exact double click commits once; retained outcome survives response loss without executing again', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  const results = await Promise.allSettled([1, 2].map(() => confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true)));
  assert(results.some(row => row.status === 'fulfilled')); assert.equal(await workCount(target.targetId), 1n);
  const recorded = await readTechnicalWorkOutcome(db, f.techA.session, target, input.commandId); assert.equal(recorded.status, 'RECORDED');
  const replay = await confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true);
  assert.deepEqual(recorded, { status: 'RECORDED', receipt: replay });
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, { ...p.command, patch: { clientVisibleStatus: 'another patch' } }, p.token, true));
  assert.equal(await workCount(target.targetId), 1n);
});

test('two technicians with previews of one version cannot overwrite each other; the second reload is explicit', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  await assignTechnical(db, admin, target, f.techA); await assignTechnical(db, admin, target, f.techB);
  const ia = await workInput(db, f.techA, target, { clientVisibleStatus: 'Lavoro tecnico A' });
  const ib = await workInput(db, f.techB, target, { clientVisibleStatus: 'Lavoro tecnico B' });
  const pa = await previewTechnicalWork(db, f.techA.session, target, ia), pb = await previewTechnicalWork(db, f.techB.session, target, ib);
  const settled = await Promise.allSettled([confirmTechnicalWork(db, f.techA.session, target, pa.command, pa.token, true),
    confirmTechnicalWork(db, f.techB.session, target, pb.command, pb.token, true)]);
  assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1); assert.equal(await workCount(target.targetId), 1n);
  const row = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  assert(['Lavoro tecnico A', 'Lavoro tecnico B'].includes(row.clientVisibleStatus!));
});

test('revocation blocks an already open mutation and exact document; retained minimal receipt does not restore access', options, async () => {
  const f = await fixture(), target = technicalTarget(f), doc = f.documents[0];
  await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: doc.version.id, allowDownload: true }] });
  const first = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, first);
  await confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true);
  const next = await workInput(db, f.techA, target, { clientVisibleStatus: 'Stale future update' });
  const pending = await previewTechnicalWork(db, f.techA.session, target, next);
  await revokeTechnical(db, admin, target, f.techA);
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, pending.command, pending.token, true));
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, doc.version.id, false, async () => doc.bytes));
  assert.equal((await readTechnicalWorkOutcome(db, f.techA.session, target, first.commandId)).status, 'RECORDED');
  assert.equal((await listTechnicalWork(db, f.techA.session, target.kind)).records.length, 0);
  assert.equal(canViewClient({ ...f.techA.session, ...await loadSelectiveProjectScope(db, f.techA.user.id) }, f.client), false);
  assert.equal(await workCount(target.targetId), 1n);
});

test('permission and registry-session revocation are reread despite a live old cookie', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  await db.userPermissionOverride.create({ data: { userId: f.techA.user.id, permission: 'technical.write', allowed: false } });
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true));
  // A second assigned person proves the session boundary independently.
  await assignTechnical(db, admin, target, f.techB);
  await db.internalSession.update({ where: { id: f.techB.session.sessionId! }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: admin.user.id } });
  await assert.rejects(readTechnicalWork(db, f.techB.session, target));
  assert.equal(await workCount(target.targetId), 0n);
});

test('parent ownership A to B to A and lifecycle changes never revive an old assignment', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId: f.techB.user.id } });
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId: f.techA.user.id } });
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true));
  await assignTechnical(db, admin, target, f.techA);
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'archiviata' } });
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'in_progettazione' } });
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
});

test('expired assignments deny work and ordinary fallback; no automatic renewal', options, async () => {
  const f = await fixture(), target = technicalTarget(f);
  await assignTechnical(db, admin, target, f.techA, { expiresAt: new Date(Date.now() + 5000).toISOString() });
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  await new Promise(resolve => setTimeout(resolve, 5100));
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true));
  assert.equal(await workCount(target.targetId), 0n);
  assert.equal(canViewClient({ ...f.techA.session, ...await loadSelectiveProjectScope(db, f.techA.user.id) }, f.client), false);
});

test('document metadata/privacy drift after preview blocks the complete command', options, async () => {
  const f = await fixture(), target = technicalTarget(f), doc = f.documents[0];
  await assignTechnical(db, admin, target, f.techA, { documents: [{ fileId: doc.version.id, allowDownload: false }] });
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  await db.document.update({ where: { id: doc.doc.id }, data: { title: 'Document metadata changed' } });
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true));
  await assert.rejects(readTechnicalWorkDocument(db, f.techA.session, target, doc.version.id, false, async () => doc.bytes));
  assert.equal(await workCount(target.targetId), 0n);
});

test('a required audit insert failure rolls back both target and command', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  const beforeRow = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  await db.auditLog.create({ data: { id: input.commandId, actorId: admin.user.id, event: 'synthetic_fault_sentinel', entityType: 'SyntheticTest', entityId: input.commandId } });
  await assert.rejects(confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true));
  assert.deepEqual(await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } }), beforeRow);
  assert.equal(await workCount(target.targetId), 0n);
});

test('immutable history rejects updates/deletes and a fabricated command without same-transaction target/audit', options, async () => {
  const f = await fixture(), target = technicalTarget(f), a = await assignTechnical(db, admin, target, f.techA);
  const input = await workInput(db, f.techA, target), p = await previewTechnicalWork(db, f.techA.session, target, input);
  const receipt = await confirmTechnicalWork(db, f.techA.session, target, p.command, p.token, true);
  await assert.rejects(db.$executeRaw`DELETE FROM "TechnicalAssignment" WHERE id=${a.receipt.assignmentId}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalAssignmentRevision" SET proof=${'a'.repeat(64)} WHERE id=${a.receipt.revisionId}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE "TechnicalWorkCommand" SET proof=${'b'.repeat(64)} WHERE id=${receipt.commandId}::uuid`);
  await assert.rejects(db.$executeRaw`INSERT INTO "TechnicalWorkCommand"(id,"assignmentId","assignmentRevision","actorId","sessionId",kind,"targetId",action,"requestDigest",receipt,proof)
    SELECT ${randomUUID()}::uuid,"assignmentId","assignmentRevision","actorId","sessionId",kind,"targetId",action,"requestDigest",receipt,proof
    FROM "TechnicalWorkCommand" WHERE id=${receipt.commandId}::uuid`);
  assert.equal(await workCount(target.targetId), 1n);
});

test('project assignments are independent of practice grants and cannot open financial or unrelated project fields', options, async () => {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), target = technicalTarget(f, 'Project');
  const backoffice = await syntheticPerson(db, 'Backoffice senza modifica progetti', 'backoffice');
  await assert.rejects(assignTechnical(db, admin, target, backoffice));
  await assignTechnical(db, admin, target, f.techA); await assignTechnical(db, admin, target, f.techB);
  const view = await readTechnicalWork(db, f.techB.session, target);
  assert.deepEqual(view.fields.map(row => row.key), ['title', 'description', 'status']);
  assert.equal(JSON.stringify(view).includes('SCENARIO_PRIVATO_NON_SELEZIONATO'), false);
  await assert.rejects(readTechnicalWork(db, f.techB.session, technicalTarget(f)));
  const input = await workInput(db, f.techB, target, { description: 'Relazione tecnica sintetica aggiornata' });
  const p = await previewTechnicalWork(db, f.techB.session, target, input);
  await confirmTechnicalWork(db, f.techB.session, target, p.command, p.token, true);
  const row = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  assert.equal(row.description, input.patch.description); assert.equal(row.scenarioA, f.project.scenarioA);
  assert.equal(row.consultantId, f.techA.user.id); assert.equal(row.clientId, f.client.id);
});

test('inactive recipient can be revoked, and reactivation does not restore assignment or general client access', options, async () => {
  const f = await fixture(), target = technicalTarget(f); await assignTechnical(db, admin, target, f.techA);
  await db.user.update({ where: { id: f.techA.user.id }, data: { active: false } });
  assert.equal((await revokeTechnical(db, admin, target, f.techA)).operation, 'REVOKE');
  await db.user.update({ where: { id: f.techA.user.id }, data: { active: true } });
  await assert.rejects(readTechnicalWork(db, f.techA.session, target));
  assert.equal(canViewClient({ ...f.techA.session, ...await loadSelectiveProjectScope(db, f.techA.user.id) }, f.client), false);
});

test('title search paginates only current personal assignments and performs no audit or work writes', options, async () => {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), term = 'Ricerca & controllo 100%_';
  const ids = [];
  for (let index = 0; index < 21; index++) {
    const project = await db.project.create({ data: { clientId: f.client.id, consultantId: f.techA.user.id,
      title: `${term} ${String(index).padStart(2, '0')}` } });
    ids.push(project.id);
    await assignTechnical(db, admin, { kind: 'Project', targetId: project.id }, f.techA);
  }
  const auditBefore = await db.auditLog.count(), commandsBefore = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalWorkCommand"`;
  const first = await listTechnicalWork(db, f.techA.session, 'Project', 1, '  RICERCA & CONTROLLO 100%_  ');
  const second = await listTechnicalWork(db, f.techA.session, 'Project', 2, term);
  assert.equal(first.records.length, 20); assert.equal(first.hasNext, true);
  assert.equal(second.records.length, 1); assert.equal(second.hasNext, false);
  assert.deepEqual([...first.records, ...second.records].map(row => row.target.targetId).sort(), ids.sort());
  assert.equal((await listTechnicalWork(db, f.techA.session, 'Project', 3, term)).records.length, 0);
  assert.equal((await listTechnicalWork(db, f.techA.session, 'Project', 1, '100x_')).records.length, 0);
  assert.equal((await listTechnicalWork(db, f.techB.session, 'Project', 1, term)).records.length, 0);
  assert.equal((await listTechnicalWork(db, f.techA.session, 'TechnicalPractice', 1, term)).records.length, 0);
  for (const person of [f.salesA, f.salesB]) await assert.rejects(listTechnicalWork(db, person.session, 'Project', 1, term));
  await assert.rejects(listTechnicalWork(db, f.techA.session, 'Project', 1, 'x'.repeat(201)));
  assert.equal(await db.auditLog.count(), auditBefore);
  assert.deepEqual(await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "TechnicalWorkCommand"`, commandsBefore);
  const revoked = first.records[0];
  await revokeTechnical(db, admin, revoked.target, f.techA);
  assert.equal((await listTechnicalWork(db, f.techA.session, 'Project', 1, revoked.title)).records.length, 0);
});

test('twenty-one revoked titles and later title changes cannot reveal search continuation', options, async () => {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), term = 'Titolo cambiato dopo revoca 100%_';
  for (let index = 0; index < 21; index++) {
    const project = await db.project.create({ data: { clientId: f.client.id, title: `Titolo precedente ${index}` } });
    const target = { kind: 'Project' as const, targetId: project.id };
    await assignTechnical(db, admin, target, f.techA); await revokeTechnical(db, admin, target, f.techA);
    await db.project.update({ where: { id: project.id }, data: { title: `${term} ${index}` } });
  }
  const auditBefore = await db.auditLog.count(), empty = { records: [], hasNext: false };
  for (const query of ['', term, 'NESSUNA_CORRISPONDENZA', '100%_', '100x_']) {
    assert.deepEqual(await listTechnicalWork(db, f.techA.session, 'Project', 1, query), empty);
    assert.deepEqual(await listTechnicalWork(db, f.techA.session, 'Project', 2, query), empty);
  }
  assert.deepEqual(await listTechnicalWork(db, f.techB.session, 'Project', 1, term), empty);
  assert.equal(await db.auditLog.count(), auditBefore);
});

test('admitted pagination crosses a full denied window without hiding valid rows or leaking revoked expired and stale titles', options, async () => {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), term = 'Pagina ammessa 100%_', ids: string[] = [];
  for (let index = 0; index < 21; index++) {
    const project = await db.project.create({ data: { clientId: f.client.id, title: `${term} valido ${index}` } });
    ids.push(project.id); await assignTechnical(db, admin, { kind: 'Project', targetId: project.id }, f.techA);
  }
  let lastExpiry = 0;
  // These later assignments sort before all the valid rows.
  for (let index = 0; index < 21; index++) {
    const project = await db.project.create({ data: { clientId: f.client.id, title: `${term} negato ${index}` } });
    const target = { kind: 'Project' as const, targetId: project.id };
    const expiresAt = index % 3 === 2 ? new Date(Date.now() + 10000).toISOString() : undefined;
    await assignTechnical(db, admin, target, f.techA, { expiresAt });
    if (index % 3 === 0) await revokeTechnical(db, admin, target, f.techA);
    else if (index % 3 === 1) await db.project.update({ where: { id: project.id }, data: { consultantId: f.techB.user.id } });
    else lastExpiry = Math.max(lastExpiry, new Date(expiresAt!).getTime());
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, lastExpiry - Date.now()) + 50));
  const auditBefore = await db.auditLog.count();
  for (const query of [term, '']) {
    const first = await listTechnicalWork(db, f.techA.session, 'Project', 1, query);
    const second = await listTechnicalWork(db, f.techA.session, 'Project', 2, query);
    assert.equal(first.records.length, 20); assert.equal(first.hasNext, true);
    assert.equal(second.records.length, 1); assert.equal(second.hasNext, false);
    assert.deepEqual([...first.records, ...second.records].map(row => row.target.targetId).sort(), [...ids].sort());
    assert.deepEqual(await listTechnicalWork(db, f.techA.session, 'Project', 3, query), { records: [], hasNext: false });
  }
  assert.deepEqual(await listTechnicalWork(db, f.techA.session, 'Project', 1, 'negato'), { records: [], hasNext: false });
  assert.deepEqual(await listTechnicalWork(db, f.techB.session, 'Project', 1, term), { records: [], hasNext: false });
  assert.equal(await db.auditLog.count(), auditBefore);
});
