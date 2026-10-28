import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { revokeInternalSession } from '../src/lib/internal-session-registry';
import { withSerializableTransaction } from '../src/lib/serializable';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { readProjectHandoff, previewProjectHandoff, confirmProjectHandoff, readProjectHandoffReceipt } from '../src/lib/project-handoff';
import { assertPracticeCreationSlot } from '../src/lib/practice-creation-slot';
import { handoffProof, type ProjectHandoffInput } from '../src/lib/project-handoff-contract';
const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1' && process.env.PROJECT_HANDOFF_DB_TESTS === '1';
const options = { skip: !enabled };
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admin = await syntheticAuthority(db); } });
after(async () => db.$disconnect());
function proof(person = admin, nowSeconds?: number) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id, sessionToken: person.token, nowSeconds }) };
}
async function fixture() {
  const commercial = await syntheticPerson(db, 'Commerciale sintetico A', 'commerciale');
  const otherCommercial = await syntheticPerson(db, 'Commerciale sintetico B', 'commerciale');
  const technical = await syntheticPerson(db, 'Tecnico sintetico A', 'consulente');
  const otherTechnical = await syntheticPerson(db, 'Tecnico sintetico B', 'consulente');
  const client = await db.client.create({ data: { displayName: 'Cliente sintetico ' + randomUUID(), type: 'societa', salesOwnerId: commercial.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto sintetico', consultantId: technical.user.id } });
  const setup = await readProjectHandoff(db, admin.session, project.id);
  const input: ProjectHandoffInput = { commandId: randomUUID(), projectId: project.id, expectedHash: setup.expectedHash,
    title: 'PRIVATE-TITLE', practiceType: 'PRIVATE-TYPE', targetEntity: 'Da definire', commercialOwnerId: commercial.user.id, technicalOwnerId: technical.user.id };
  return { commercial, otherCommercial, technical, otherTechnical, client, project, setup, input };
}
const projected = (p: Awaited<ReturnType<typeof previewProjectHandoff>>) => ({ digest: p.digest, expiresAt: p.expiresAt, proof: p.proof });
async function prepare(f: Awaited<ReturnType<typeof fixture>>) { return projected(await previewProjectHandoff(db, admin.session, f.input, key)); }
async function noPractice(id: string) { assert.equal(await db.technicalPractice.count({ where: { projectId: id } }), 0); }

test('canonical preview is read-only; preparation preserves owners and creates no grant, task, document or message', options, async () => {
  const f = await fixture(), before = await Promise.all([db.technicalAssignment.count(), db.task.count(), db.document.count(), db.approvedCommunication.count()]);
  assert.equal(f.setup.commercialOwnerId, f.commercial.user.id); assert.equal(f.setup.technicalOwnerId, f.technical.user.id);
  const preview = await prepare(f); await noPractice(f.project.id);
  const result = await confirmProjectHandoff(db, admin.session, f.input, preview, proof());
  const practice = await db.technicalPractice.findUniqueOrThrow({ where: { id: result.practiceId } });
  assert.equal(practice.clientId, f.client.id); assert.equal(practice.projectId, f.project.id); assert.equal(practice.status, 'da_progettare');
  assert.equal(practice.commercialOwnerId, f.commercial.user.id); assert.equal(practice.technicalOwnerId, f.technical.user.id);
  assert.equal(practice.clientServiceId, null); assert.equal(practice.submittedAt, null); assert.equal(practice.protocolNumber, null);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.client.id } })).salesOwnerId, f.commercial.user.id);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).consultantId, f.technical.user.id);
  assert.deepEqual(await Promise.all([db.technicalAssignment.count(), db.task.count(), db.document.count(), db.approvedCommunication.count()]), before);
  const audits = await db.auditLog.findMany({ where: { entityId: { in: [f.project.id, practice.id] } } });
  assert.equal(audits.length, 2); assert.doesNotMatch(JSON.stringify(audits), /PRIVATE-TITLE|PRIVATE-TYPE/);
  assert.equal(await db.auditLog.count({ where: { entityId: practice.id, event: 'responsibility_accepted' } }), 0);
});
test('lost-response replay and current receipt return one practice and one immutable command identity', options, async () => {
  const f = await fixture(), preview = await prepare(f);
  const first = await confirmProjectHandoff(db, admin.session, f.input, preview, proof());
  assert.deepEqual(await confirmProjectHandoff(db, admin.session, f.input, preview, proof()), first);
  assert.deepEqual(await readProjectHandoffReceipt(db, admin.session, f.project.id, f.input.commandId), first);
  assert.equal(await db.technicalPractice.count({ where: { projectId: f.project.id } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: f.input.commandId } }), 1);
});
test('two concurrent commands cannot prepare two practices', options, async () => {
  const f = await fixture(), a = await prepare(f), other = { ...f.input, commandId: randomUUID() };
  const b = projected(await previewProjectHandoff(db, admin.session, other, key));
  const results = await Promise.allSettled([confirmProjectHandoff(db, admin.session, f.input, a, proof()), confirmProjectHandoff(db, admin.session, other, b, proof())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await db.technicalPractice.count({ where: { projectId: f.project.id } }), 1);
});
test('project and canonical commercial changes invalidate a prepared summary', options, async () => {
  for (const change of ['project', 'commercial']) {
    const f = await fixture(), p = await prepare(f);
    if (change === 'project') await db.project.update({ where: { id: f.project.id }, data: { title: 'Concurrent title' } });
    else await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: f.otherCommercial.user.id } });
    await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, p, proof())); await noPractice(f.project.id);
  }
});
test('two commercial and two technical accounts cannot use the Admin preparation or receipt route', options, async () => {
  const f = await fixture(), p = await prepare(f);
  for (const person of [f.commercial, f.otherCommercial, f.technical, f.otherTechnical]) {
    await assert.rejects(readProjectHandoff(db, person.session, f.project.id));
    await assert.rejects(confirmProjectHandoff(db, person.session, f.input, p, proof(person)));
    await assert.rejects(readProjectHandoffReceipt(db, person.session, f.project.id, f.input.commandId));
  }
  await noPractice(f.project.id);
});
test('recipient suspension and explicit Admin permission revocation deny an open preview', options, async () => {
  const f = await fixture(), p = await prepare(f);
  await db.user.update({ where: { id: f.technical.user.id }, data: { active: false } });
  await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, p, proof())); await noPractice(f.project.id);
  const g = await fixture(), q = await prepare(g);
  const override = await db.userPermissionOverride.create({ data: { userId: admin.user.id, permission: 'technical.write', allowed: false } });
  try { await assert.rejects(confirmProjectHandoff(db, admin.session, g.input, q, proof())); await noPractice(g.project.id); }
  finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); }
});
test('archived or trashed project denies confirmation and does not create a practice', options, async () => {
  for (const trash of [false, true]) {
    const f = await fixture(), p = await prepare(f);
    await db.project.update({ where: { id: f.project.id }, data: trash ? { deletedAt: new Date() } : { status: 'archiviato' } });
    await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, p, proof())); await noPractice(f.project.id);
  }
});
test('expired step-up and expired or altered preview are rejected before writes', options, async () => {
  const f = await fixture(), p = await prepare(f);
  await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, p, proof(admin, Math.floor(Date.now()/1000)-601)));
  const expiresAt = new Date(Date.now()-1000).toISOString();
  await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, { ...p, expiresAt, proof: handoffProof(key, { digest:p.digest, expiresAt }) }, proof()));
  await assert.rejects(confirmProjectHandoff(db, admin.session, { ...f.input, technicalOwnerId:f.otherTechnical.user.id }, p, proof()));
  await noPractice(f.project.id);
});
test('audit insertion failure rolls back practice and initial responsibility', options, async () => {
  const f = await fixture(), p = await prepare(f);
  await db.$executeRawUnsafe("CREATE FUNCTION project_handoff_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='project_practice_prepared' THEN RAISE EXCEPTION 'synthetic handoff fault'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER project_handoff_test_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION project_handoff_test_fault()');
  try { await assert.rejects(confirmProjectHandoff(db, admin.session, f.input, p, proof()), /synthetic handoff fault/); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER project_handoff_test_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION project_handoff_test_fault()'); }
  await noPractice(f.project.id); assert.equal(await db.auditLog.count({ where: { id:f.input.commandId } }), 0);
});
test('existing archived and multiple practices remain visible and block silent replacement', options, async () => {
  const f = await fixture();
  for (const status of ['da_progettare','archiviata'] as const) await db.technicalPractice.create({ data: { projectId:f.project.id,clientId:f.client.id,
    title:status,practiceType:'test',targetEntity:'test',status,createdById:admin.user.id } });
  const s = await readProjectHandoff(db, admin.session, f.project.id);
  assert.equal(s.practices.length,2); assert.equal(s.practices.filter(x=>x.available).length,1);
  await assert.rejects(prepare(f),/EXISTS/);
  await assert.rejects(db.$transaction(tx=>assertPracticeCreationSlot(tx,f.project.id,null)));
});
test('receipt is bound to its original session and input; missing receipt never claims completion', options, async () => {
  const f = await fixture(), p = await prepare(f);
  assert.deepEqual(await readProjectHandoffReceipt(db,admin.session,f.project.id,f.input.commandId),{confirmed:false});
  await confirmProjectHandoff(db,admin.session,f.input,p,proof());
  await assert.rejects(confirmProjectHandoff(db,admin.session,{...f.input,title:'changed'},p,proof()));
  await assert.rejects(readProjectHandoffReceipt(db,{...admin.session,sessionId:f.commercial.session.sessionId},f.project.id,f.input.commandId));
});
test('practice attached indirectly through the purchased service blocks a second project preparation', options, async () => {
  const f=await fixture();
  const catalog=await db.serviceCatalog.create({data:{code:randomUUID(),name:'Synthetic service',category:'test'}});
  const service=await db.clientService.create({data:{clientId:f.client.id,projectId:f.project.id,serviceCatalogId:catalog.id}});
  const practice=await db.technicalPractice.create({data:{clientId:f.client.id,clientServiceId:service.id,title:'Indirect existing practice',practiceType:'test',targetEntity:'test',createdById:admin.user.id}});
  const setup=await readProjectHandoff(db,admin.session,f.project.id);
  assert.deepEqual(setup.practices.map(p=>p.id),[practice.id]);
  await assert.rejects(prepare(f),/EXISTS/);
  await assert.rejects(db.$transaction(tx=>assertPracticeCreationSlot(tx,f.project.id,null)));
  assert.equal(await db.technicalPractice.count({where:{clientId:f.client.id}}),1);
  assert.equal((await db.clientService.findUniqueOrThrow({where:{id:service.id}})).operationalStatus,'nuova');
});
test('generic initial creation and project confirmation share a serializable creation slot', options, async () => {
  const f=await fixture(), p=await prepare(f);
  const results=await Promise.allSettled([
    confirmProjectHandoff(db,admin.session,f.input,p,proof()),
    withSerializableTransaction(db,async tx=>{
      await assertPracticeCreationSlot(tx,f.project.id,null);
      return tx.technicalPractice.create({data:{clientId:f.client.id,projectId:f.project.id,title:'Generic synthetic preparation',practiceType:'test',targetEntity:'test',createdById:admin.user.id}});
    })
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.technicalPractice.count({where:{projectId:f.project.id}}),1);
});
test('revoked original session cannot confirm, inspect a receipt or be replaced by a fresh session', options, async () => {
  const person=await syntheticPerson(db,'Other synthetic Admin'), f=await fixture();
  const preview=projected(await previewProjectHandoff(db,person.session,f.input,key));
  await confirmProjectHandoff(db,person.session,f.input,preview,proof(person));
  await db.$transaction(tx=>revokeInternalSession(tx,person.session.sessionId!,'INTERNAL_SINGLE',admin.user.id));
  await assert.rejects(confirmProjectHandoff(db,person.session,f.input,preview,proof(person)));
  await assert.rejects(readProjectHandoffReceipt(db,person.session,f.project.id,f.input.commandId));
  const fresh=await syntheticSession(db,person.user);
  await assert.rejects(readProjectHandoffReceipt(db,fresh.session,f.project.id,f.input.commandId));
  assert.equal(await db.technicalPractice.count({where:{projectId:f.project.id}}),1);
});
