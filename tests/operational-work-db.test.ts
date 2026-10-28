import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, assignmentInput, revokeTechnical } from './technical-assignments/fixtures';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../src/lib/technical-assignment-service';
import { readOperationalWork, loadOperationalWorkCatalogue } from '../src/lib/operational-work';
import { selectOperationalWork } from '../src/lib/operational-work-projection';

const enabled = process.env.RUN_OPERATIONAL_WORK_DB_TESTS === '1', options = { skip: !enabled };
const db = new PrismaClient(); let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
async function ordinary(person: Person) {
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente ordinario sintetico', consultantId: person.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto ordinario sintetico', consultantId: person.user.id } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica ordinaria sintetica', practiceType: 'Sintetica', targetEntity: 'Ente sintetico', technicalOwnerId: person.user.id, createdById: admin.user.id } });
  return { client, project, practice };
}
test('ordinary and selective admission form one deduplicated set with separate routes and no other technician', options, async () => {
  const f = await technicalFixture(db, admin), o = await ordinary(f.techA);
  await assignTechnical(db, admin, technicalTarget(f), f.techA);
  const rows = await readOperationalWork(db, f.techA.session, 'TechnicalPractice');
  assert.equal(rows.total, 2); assert.equal(new Set(rows.records.map(row => row.id)).size, 2);
  assert.equal(rows.records.find(row => row.id === o.practice.id)?.href, '/technical-office/practices/' + o.practice.id);
  assert.equal(rows.records.find(row => row.id === f.practice.id)?.href, '/technical-work/practices/' + f.practice.id);
  assert.equal(rows.stateCounts.da_progettare, 2);
  assert(!JSON.stringify(rows).includes(f.otherPractice.id));
  assert(!JSON.stringify(await readOperationalWork(db, f.techB.session, 'TechnicalPractice')).includes(f.practice.id));
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } })).technicalOwnerId, f.techA.user.id);
});
test('omitted title and state never drive labels, search, counts or active filter', options, async () => {
  const f = await technicalFixture(db, admin), target = technicalTarget(f);
  const input = await assignmentInput(db, admin, target, f.techA);
  assert(input.selection.kind === 'TechnicalPractice');
  input.selection = { ...input.selection, readableFields: ['priority'], editableFields: [], actions: ['request_admin'] };
  const ref = { ...target, recipientId: f.techA.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
  const data = await readOperationalWork(db, f.techA.session, target.kind);
  assert.equal(data.total, 1); assert.equal(data.hiddenStatus, 1); assert.deepEqual(data.stateCounts, {});
  assert.equal(data.records[0].title, null); assert.equal(data.records[0].status, null);
  for (const query of [{ q: f.practice.title }, { status: 'da_progettare' }, { active: true }])
    assert.equal((await readOperationalWork(db, f.techA.session, target.kind, query)).total, 0);
  assert(!JSON.stringify(data).includes(f.client.displayName)); assert(!JSON.stringify(data).includes(f.practice.internalNotes!));
});
test('revocation removes every projection and never reopens ordinary ownership', options, async () => {
  const f = await technicalFixture(db, admin), target = technicalTarget(f);
  await assignTechnical(db, admin, target, f.techA);
  assert.equal((await readOperationalWork(db, f.techA.session, target.kind)).total, 1);
  await revokeTechnical(db, admin, target, f.techA);
  const rows = await readOperationalWork(db, f.techA.session, target.kind);
  assert.equal(rows.total, 0); assert.deepEqual(rows.stateCounts, {});
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: target.targetId } })).technicalOwnerId, f.techA.user.id);
});
test('closed parent and archived project cannot survive through the operational catalogue', options, async () => {
  const f = await technicalFixture(db, admin), o = await ordinary(f.techA);
  await assignTechnical(db, admin, technicalTarget(f), f.techA);
  await db.project.update({ where: { id: o.project.id }, data: { status: 'archiviato' } });
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { deletedAt: new Date() } });
  assert.equal((await readOperationalWork(db, f.techA.session, 'TechnicalPractice')).total, 0);
  assert.equal((await readOperationalWork(db, f.techA.session, 'Project')).total, 0);
});
test('pagination and totals are computed after current admission and filtering', options, async () => {
  const f = await technicalFixture(db, admin), o = await ordinary(f.techA);
  await db.technicalPractice.createMany({ data: Array.from({ length: 24 }, (_, i) => ({
    clientId: o.client.id, projectId: o.project.id, title: 'Catalogo autorizzato ' + i, practiceType: 'Sintetica',
    targetEntity: 'Ente sintetico', technicalOwnerId: f.techA.user.id, createdById: admin.user.id,
  })) });
  const catalogue = await loadOperationalWorkCatalogue(db, f.techA.session, 'TechnicalPractice');
  const first = selectOperationalWork(catalogue.records, { q: 'Catalogo autorizzato' });
  const second = selectOperationalWork(catalogue.records, { q: 'Catalogo autorizzato', page: 2 });
  assert.equal(first.total, 24); assert.equal(first.records.length, 20); assert(first.hasNext);
  assert.equal(second.total, 24); assert.equal(second.records.length, 4); assert(!second.hasNext);
  assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 24);
  assert.equal(selectOperationalWork(catalogue.records, { q: f.otherPractice.title }).total, 0);
});
test('disabled personal capability preserves ordinary work without disclosing a revoked selective fallback', options, async () => {
  const f = await technicalFixture(db, admin), o = await ordinary(f.techA);
  await assignTechnical(db, admin, technicalTarget(f), f.techA);
  await db.$executeRaw`UPDATE "TechnicalAssignmentAuthority" SET enabled=false WHERE id='technical-assignment'`;
  try {
    const data = await readOperationalWork(db, f.techA.session, 'TechnicalPractice');
    assert.equal(data.selectiveAvailable, false); assert.deepEqual(data.records.map(row => row.id), [o.practice.id]);
  } finally { await db.$executeRaw`UPDATE "TechnicalAssignmentAuthority" SET enabled=true WHERE id='technical-assignment'`; }
});
test('stale role, permission or revoked session denies both sources', options, async () => {
  const f = await technicalFixture(db, admin);
  await assignTechnical(db, admin, technicalTarget(f), f.techA);
  await ordinary(f.techA);
  await db.internalSession.update({ where: { id: f.techA.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readOperationalWork(db, f.techA.session, 'TechnicalPractice'));
  await assert.rejects(readOperationalWork(db, f.salesA.session, 'TechnicalPractice'));
});
