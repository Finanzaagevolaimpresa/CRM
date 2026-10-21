import { withHistoricalEnrollment } from './selective-sharing/historical-enrollment';
// CI only: synthetic ephemeral PostgreSQL, never local or production data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test, { after, before } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { practiceProof, grantPractice, selectivePracticeFixture, type PracticePerson } from './selective-practices/fixtures';
import { practiceSharingManagement, confirmPracticeSharing, previewPracticeSharing, readPracticeSharing,
  readPracticeSharingReceipt, revokePracticeSharing, PracticeSharingError } from '../src/lib/selective-practice-access';
import { SerializableConflictError } from '../src/lib/serializable';
import { canEditTechnicalPractice, canViewTechnicalPractice, canViewClient, canViewProject } from '../src/lib/access-control';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { actualPracticeActions, practiceWriteActions, type PracticeWriteAction } from './selective-practices/action-harness';
import { previewRecordUpdate, confirmRecordUpdate, readRecordUpdateSetup } from '../src/lib/record-updates';
import { listRecordUpdates, readRecordUpdate } from '../src/lib/record-update-delivery';
import { savePracticeResponsibility, acceptResponsibility } from '../src/lib/responsibility';
import { loadAssignmentExceptions } from '../src/lib/assignment-exceptions';
import { selectiveAuditAllowed } from '../src/lib/selective-project-policy';
import { grantClient } from './selective-clients/fixtures';

const enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: PracticePerson;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
const fixture = () => selectivePracticeFixture(db, admin);
async function deniedOrdinary(f: Awaited<ReturnType<typeof fixture>>) {
  const actor = { ...f.reader.session, ...await loadSelectiveProjectScope(db, f.reader.user.id) };
  const context = { ...f.practice, client: f.client, project: { ...f.project, client: f.client } };
  assert.equal(canViewTechnicalPractice(actor, context), false);
  assert.equal(canEditTechnicalPractice(actor, context), false);
  assert.equal(canViewTechnicalPractice(actor, { ...f.other, client: f.client, project: context.project }), true);
  assert.equal(canViewClient(actor, f.client), true);
  assert.equal(canViewProject(actor, context.project), true);
}




test('project authority cannot bootstrap practice sharing from a management GET or preview', options, async () => {
  const f = await fixture();
  assert.equal(await db.selectivePracticeAuthority.count(), 0);
  await assert.rejects(practiceSharingManagement(db, admin.session, f.practice.id));
  await assert.rejects(previewPracticeSharing(db, admin.session, f.input));
  assert.equal(await db.selectivePracticeAuthority.count(), 0);
  await withHistoricalEnrollment(db, 'practice', async ({ db, admin, url }) => {
    const sql = readFileSync('ops/selective-practice-authority-enrollment.sql', 'utf8'), auditId = randomUUID();
    const target = new URL(url);
    assert.equal(target.searchParams.get('schema') ?? 'public', 'public'); target.searchParams.delete('schema');
    const binding = { database: target.pathname.slice(1), userId: admin.user.id, name: admin.user.name,
      email: admin.user.email, approvalSha256: 'a'.repeat(64), auditId };
    const enroll = (value: unknown, body = sql) => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', target.toString()], {
      input: "SELECT set_config('fai.selective_practice_binding','" + JSON.stringify(value).replaceAll("'", "''") + "',false);\n" + body,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000,
    });
    for (const value of [null, [], { ...binding, approvalSha256: null }, { ...binding, auditId: null }, { ...binding, name: '' }]) {
      assert.throws(() => enroll(value), /SELECTIVE_PRACTICE_ENROLLMENT_BINDING_INVALID/);
    }
    assert.throws(() => enroll({ ...binding, email: 'wrong@invalid.test' }), /SELECTIVE_PRACTICE_ENROLLMENT_PROFILE_DENIED/);
    assert.throws(() => enroll(binding, sql.replace('COMMIT;', () => "DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ROLLBACK'; END $$; COMMIT;")), /ERROR:\s+SYNTHETIC_ROLLBACK/);
    assert.equal(await db.selectivePracticeAuthority.count(), 0); assert.equal(await db.auditLog.count({ where: { id: auditId } }), 0);
    assert.match(enroll(binding).toString(), /SELECTIVE_PRACTICE_ENROLLMENT_COMMITTED/);
    assert.deepEqual(await db.selectivePracticeAuthority.findUnique({ where: { id: 'practice-sharing' } }),
      { id: 'practice-sharing', userId: admin.user.id, revision: 1, enabled: true });
    // Real canonical N04 trigger, including the complete persisted after value.
    const audit = await db.auditLog.findUniqueOrThrow({ where: { id: auditId } });
    assert.equal(audit.actorId, admin.user.id); assert.equal(audit.event, 'selective_practice_authority_enrolled');
    assert.deepEqual(audit.before, { version: 0 });
    assert.deepEqual(audit.after, { version: 1, enabled: true, approvalHash: binding.approvalSha256 });
    assert.throws(() => enroll(binding), /SELECTIVE_PRACTICE_ENROLLMENT_ALREADY_STARTED/);
    assert.equal(await db.selectivePracticeGrant.count(), 0);
  });
  // Explicit synthetic authority for the schema59 regression fixture only.
  await db.selectivePracticeAuthority.create({ data: { userId: admin.user.id, enabled: true } });
});

test('another Admin, self, substituted session and forged step-up cannot confirm', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Altro Admin sintetico');
  await assert.rejects(previewPracticeSharing(db, other.session, f.input));
  await assert.rejects(previewPracticeSharing(db, admin.session, { ...f.input, recipientId: admin.user.id }));
  const p = await previewPracticeSharing(db, admin.session, f.input);
  await assert.rejects(confirmPracticeSharing(db, admin.session, f.input, p.token, { ...practiceProof(admin), stepUpToken: 'forged' }));
  await assert.rejects(confirmPracticeSharing(db, admin.session, f.input, p.token, { ...practiceProof(admin), sessionToken: other.token }));
  await assert.rejects(confirmPracticeSharing(db, { ...admin.session, sessionId: other.session.sessionId }, f.input, p.token, practiceProof(admin)));
  assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 0);
});

test('changed fields, content or recipient invalidate the exact preview', options, async () => {
  const f = await fixture(), p = await previewPracticeSharing(db, admin.session, f.input);
  await assert.rejects(confirmPracticeSharing(db, admin.session, { ...f.input, fields: ['practiceType'] }, p.token, practiceProof(admin)));
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { internalNotes: 'Changed synthetic private note' } });
  await assert.rejects(confirmPracticeSharing(db, admin.session, f.input, p.token, practiceProof(admin)));
  const q = await previewPracticeSharing(db, admin.session, f.input);
  await db.user.update({ where: { id: f.reader.user.id }, data: { name: 'Changed synthetic recipient' } });
  await assert.rejects(confirmPracticeSharing(db, admin.session, f.input, q.token, practiceProof(admin)));
  assert.equal(await db.selectivePracticeCommand.count({ where: { practiceId: f.practice.id } }), 0);
});

test('lost response reconciles one receipt only for the exact command and practice', options, async () => {
  const f = await fixture(), { preview, receipt } = await grantPractice(db, admin, f.input);
  assert.deepEqual(await confirmPracticeSharing(db, admin.session, f.input, preview.token, practiceProof(admin)), receipt);
  assert.deepEqual(await readPracticeSharingReceipt(db, admin.session, f.input.commandId, f.practice.id), receipt);
  assert.equal(await readPracticeSharingReceipt(db, admin.session, f.input.commandId, f.other.id), null);
  await assert.rejects(confirmPracticeSharing(db, admin.session, { ...f.input, fields: ['status'] }, preview.token, practiceProof(admin)));
  assert.equal(await db.selectivePracticeRevision.count({ where: { grantId: receipt.grantId } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: receipt.revisionId } }), 1);
});

test('two concurrent decisions on one revision commit at most one command/history/audit', options, async () => {
  const f = await fixture(), other = { ...f.input, commandId: randomUUID(), fields: ['practiceType'] };
  const p = await previewPracticeSharing(db, admin.session, f.input), q = await previewPracticeSharing(db, admin.session, other);
  const results = await Promise.allSettled([
    confirmPracticeSharing(db, admin.session, f.input, p.token, practiceProof(admin)),
    confirmPracticeSharing(db, admin.session, other, q.token, practiceProof(admin)),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.selectivePracticeCommand.count({ where: { practiceId: f.practice.id } }), 1);
  const revisions = await db.selectivePracticeRevision.findMany({ where: { grant: { practiceId: f.practice.id } } });
  assert.equal(revisions.length, 1);
  assert.equal(await db.auditLog.count({ where: { id: revisions[0].id } }), 1);
});

test('audit failure rolls the grant, command, history and user generation back together', options, async () => {
  const f = await fixture(), p = await previewPracticeSharing(db, admin.session, f.input);
  const userBefore = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  await db.$executeRawUnsafe("CREATE FUNCTION synthetic_selective_practice_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='selective_practice_changed' THEN RAISE EXCEPTION 'synthetic client audit fault'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_selective_practice_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_selective_practice_fault()');
  try { await assert.rejects(confirmPracticeSharing(db, admin.session, f.input, p.token, practiceProof(admin))); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_selective_practice_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_selective_practice_fault()');
  }
  assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 0);
  assert.equal(await db.selectivePracticeCommand.count({ where: { practiceId: f.practice.id } }), 0);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } }), userBefore);
});

test('revocation retains immutable history and never restores ordinary ownership or Admin access', options, async () => {
  const f = await fixture(), { receipt } = await grantPractice(db, admin, f.input);
  const input = { grantId: receipt.grantId, revision: 1, commandId: randomUUID() };
  const revoked = await revokePracticeSharing(db, admin.session, input, practiceProof(admin));
  assert.equal(revoked.revision, 2);
  assert.deepEqual(await revokePracticeSharing(db, admin.session, input, practiceProof(admin)), revoked);
  await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
  await deniedOrdinary(f);
  assert.equal(await db.selectivePracticeRevision.count({ where: { grantId: receipt.grantId } }), 2);
  await assert.rejects(db.selectivePracticeGrant.delete({ where: { id: receipt.grantId } }));
  await assert.rejects(db.selectivePracticeRevision.delete({ where: { id: receipt.revisionId } }));
  await assert.rejects(db.selectivePracticeCommand.update({ where: { id: f.input.commandId }, data: { requestDigest: 'a'.repeat(64) } }));
});

test('expiry blocks an open session and does not reopen the full practice', options, async () => {
  const f = await fixture();
  await grantPractice(db, admin, { ...f.input, expiresAt: new Date(Date.now() + 4000).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 4100));
  await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
  await deniedOrdinary(f);
});

test('role and permission revocation remain invalid after their previous values are restored', options, async () => {
  const f = await fixture(); await grantPractice(db, admin, f.input);
  for (const role of ['commerciale', 'admin'] as const) await db.user.update({ where: { id: f.reader.user.id }, data: { role } });
  await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
  const g = await fixture(); await grantPractice(db, admin, g.input);
  const permission = await db.userPermissionOverride.create({ data: { userId: g.reader.user.id, permission: 'technical.read', allowed: false } });
  await assert.rejects(readPracticeSharing(db, g.reader.session, g.practice.id));
  await db.userPermissionOverride.delete({ where: { id: permission.id } });
  await assert.rejects(readPracticeSharing(db, g.reader.session, g.practice.id));
  await deniedOrdinary(f); await deniedOrdinary(g);
});

test('recipient session revocation blocks a previously open selected practice', options, async () => {
  const f = await fixture(); await grantPractice(db, admin, f.input);
  await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
});

test('a practice update committed while confirmation waits makes the old preview stale', options, async () => {
  const f = await fixture(), p = await previewPracticeSharing(db, admin.session, f.input);
  let release!: () => void, ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TechnicalPractice" WHERE id=${f.practice.id} FOR UPDATE`;
    ready(); await gate;
    await tx.technicalPractice.update({ where: { id: f.practice.id }, data: { title: 'Concurrent synthetic client update' } });
  });
  await started;
  const result = Promise.allSettled([confirmPracticeSharing(db, admin.session, f.input, p.token, practiceProof(admin))]);
  await new Promise(resolve => setTimeout(resolve, 100)); release(); await writer;
  assert.equal((await result)[0].status, 'rejected');
  assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 0);
});

test('chosen practice scalars, exact minimized audit and independent parent/sibling access', options, async () => {
  const f = await fixture(), counts = await Promise.all([db.selectivePracticeGrant.count(), db.auditLog.count()]);
  const p = await previewPracticeSharing(db, admin.session, f.input);
  assert.equal(p.replacesFullAccess, true);
  assert.deepEqual(p.fields.map(item => item.key), ['title','status']);
  assert.deepEqual(await Promise.all([db.selectivePracticeGrant.count(), db.auditLog.count()]), counts);
  const receipt = await confirmPracticeSharing(db, admin.session, f.input, p.token, practiceProof(admin));
  const view = await readPracticeSharing(db, f.reader.session, f.practice.id);
  assert.deepEqual(view.fields, p.fields);
  for (const excluded of [f.practice.internalNotes!, f.client.displayName, f.project.title, f.other.title]) {
    assert.ok(!JSON.stringify(view).includes(excluded));
  }
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } });
  assert.deepEqual(audit.before, { version: 0 });
  assert.deepEqual(audit.after, { version: 1, action: 'GRANT', fieldCount: 2 });
  assert.ok(!JSON.stringify(audit).includes(f.reader.user.email));
  await deniedOrdinary(f);
});

for (const change of ['practiceArchive','clientHold','projectArchive','ownerReassignment'] as const) {
  test(change + ': restoration never revives an earlier selected practice decision', options, async () => {
    const f = await fixture(); await grantPractice(db, admin, f.input);
    if (change === 'practiceArchive') for (const status of ['archiviata','da_progettare'] as const)
      await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status } });
    if (change === 'clientHold') for (const status of ['sospeso','attivo'])
      await db.client.update({ where: { id: f.client.id }, data: { status } });
    if (change === 'projectArchive') for (const status of ['archiviato', f.project.status] as const)
      await db.project.update({ where: { id: f.project.id }, data: { status } });
    if (change === 'ownerReassignment') for (const technicalOwnerId of [admin.user.id, f.reader.user.id])
      await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId } });
    await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
    await deniedOrdinary(f);
  });
}
test('revocation still records an exact immutable decision when the parent or practice is archived', options, async () => {
  const f = await fixture(), { receipt } = await grantPractice(db, admin, f.input);
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'archiviata', deletedAt: new Date() } });
  await db.client.update({ where: { id: f.client.id }, data: { status: 'archiviato' } });
  await db.project.update({ where: { id: f.project.id }, data: { status: 'archiviato' } });
  const management = await practiceSharingManagement(db, admin.session, f.practice.id);
  assert.equal(management.operational, false);
  assert.equal(management.grants.length, 1);
  await assert.rejects(previewPracticeSharing(db, admin.session, { ...f.input, revision: 1, commandId: randomUUID() }));
  const revoked = await revokePracticeSharing(db, admin.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, practiceProof(admin));
  assert.equal(revoked.revision, 2);
  await assert.rejects(readPracticeSharing(db, f.reader.session, f.practice.id));
});
test('a second practice selection preserves the first grant while excluding both full records', options, async () => {
  const f = await fixture(); await grantPractice(db, admin, f.input);
  await grantPractice(db, admin, { ...f.input, practiceId: f.other.id, commandId: randomUUID() });
  assert.equal((await readPracticeSharing(db, f.reader.session, f.practice.id)).fields.length, 2);
  assert.equal((await readPracticeSharing(db, f.reader.session, f.other.id)).fields.length, 2);
});
test('selected client restrictions cannot be bypassed by a narrower practice grant', options, async () => {
  const f = await fixture();
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  await grantClient(db, admin, { clientId: f.client.id, recipientId: f.reader.user.id,
    revision: 0, commandId: randomUUID(), fields: ['displayName'], expiresAt: null });
  await assert.rejects(previewPracticeSharing(db, admin.session, f.input));
  assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 0);
});
test('related audit identifiers and assignment exceptions respect a newly selected practice', options, async () => {
  const f = await fixture();
  const message = await db.practiceCommunication.create({ data: { technicalPracticeId: f.practice.id, clientId: f.client.id,
    projectId: f.project.id, type: 'interna', channel: 'nota_interna', title: 'SYNTHETIC_PRIVATE_TITLE',
    content: 'SYNTHETIC_PRIVATE_CONTENT', createdById: admin.user.id } });
  const inactive = await syntheticPerson(db, 'Responsabile inattivo sintetico');
  await db.user.update({ where: { id: inactive.user.id }, data: { active: false } });
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { technicalOwnerId: inactive.user.id } });
  await grantPractice(db, admin, f.input);
  const scope = await loadSelectiveProjectScope(db, f.reader.user.id);
  assert.equal(selectiveAuditAllowed(scope, { entityId: message.id }), false);
  assert.equal(selectiveAuditAllowed(scope, { entityId: 'unrelated', before: { technicalPracticeId: f.practice.id } }), false);
  assert.equal(selectiveAuditAllowed(scope, { entityId: f.other.id }), true);
  const exceptions = await db.$transaction(tx => loadAssignmentExceptions(tx, f.reader.session, 'practices'));
  assert.ok(!exceptions.rows.some(row => row.id === f.practice.id));
});
test('assignment and acceptance use current practice restrictions before any write', options, async () => {
  const f = await fixture(); await grantPractice(db, admin, f.input);
  const before = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } });
  await assert.rejects(db.$transaction(tx => savePracticeResponsibility(tx, f.reader.session, {
    id: f.practice.id, expectedEntryId: '', expectedUpdatedAt: before.updatedAt.toISOString(),
    commercialOwnerId: admin.user.id, technicalOwnerId: admin.user.id, departmentCode: 'SYNTHETIC',
    reason: 'Riassegnazione sintetica non ammessa',
  }, true)));
  await assert.rejects(db.$transaction(tx => acceptResponsibility(tx, f.reader.session,
    { kind: 'TechnicalPractice', id: f.practice.id, decisionId: randomUUID(), role: 'tecnico' })));
  assert.deepEqual(await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } }), before);
});
test('old notices and persistent rule work cannot disclose the newly selected practice', options, async () => {
  const f = await fixture(), setup = await readRecordUpdateSetup(db, admin.session, 'PRACTICE', f.practice.id);
  const input = { commandId: randomUUID(), kind: 'PRACTICE' as const, recordId: f.practice.id,
    operation: 'RULE' as const, expectedVersion: setup.expectedVersion, ruleVersion: 0,
    selection: { people: [f.reader.user.id], groups: [] }, events: ['STATE_CHANGED' as const], persistent: false, expiresAt: null, patch: null };
  const preview = await previewRecordUpdate(db, admin.session, input);
  await confirmRecordUpdate(db, admin.session, input, preview.digest, practiceProof(admin));
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'in_progettazione' } });
  const visible = await listRecordUpdates(db, f.reader.session);
  assert.equal(visible.length, 1);
  await grantPractice(db, admin, f.input);
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
  assert.equal(await readRecordUpdate(db, f.reader.session, visible[0].id), null);
  await db.technicalPractice.update({ where: { id: f.practice.id }, data: { status: 'documenti_richiesti' } });
  assert.equal((await listRecordUpdates(db, f.reader.session)).length, 0);
});

async function actionFixture(operation: PracticeWriteAction) {
  const f = await fixture(), form = new FormData();
  form.set('id', f.practice.id);
  form.set('technicalPracticeId', f.practice.id);
  if (operation === 'updateTechnicalPracticeStatus') form.set('status', 'in_progettazione');
  if (operation === 'createPracticeCommunicationDraft') {
    form.set('type', 'interna'); form.set('channel', 'nota_interna'); form.set('status', 'bozza');
    form.set('title', 'Nota sintetica'); form.set('content', 'Contenuto sintetico');
  }
  return { ...f, form };
}
async function actionState(f: Awaited<ReturnType<typeof actionFixture>>) {
  return { practice: await db.technicalPractice.findUniqueOrThrow({ where: { id: f.practice.id } }),
    messages: await db.practiceCommunication.findMany({ where: { technicalPracticeId: f.practice.id }, orderBy: { id: 'asc' } }),
    audits: await db.auditLog.findMany({ where: { actorId: f.reader.user.id }, orderBy: { id: 'asc' } }) };
}
async function waitForWriterLock(pid: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [row] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid<>pg_backend_pid() AND $1::integer=ANY(pg_blocking_pids(a.pid))) AS blocked', pid);
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Personal decision never waited on the actual practice write transaction');
}
for (const operation of practiceWriteActions) {
  test(operation + ': independent practice mutation and audit still commit', options, async () => {
    const f = await actionFixture(operation);
    await grantPractice(db, admin, { ...f.input, practiceId: f.other.id });
    await actualPracticeActions(db, f.reader.session)[operation](f.form);
    assert.equal((await actionState(f)).audits.length, 1);
  });
  test(operation + ': existing or revoked selection denies actual writes and audit', options, async () => {
    const f = await actionFixture(operation), { receipt } = await grantPractice(db, admin, f.input), before = await actionState(f);
    await assert.rejects(actualPracticeActions(db, f.reader.session)[operation](f.form));
    assert.deepEqual(await actionState(f), before);
    await revokePracticeSharing(db, admin.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, practiceProof(admin));
    await assert.rejects(actualPracticeActions(db, f.reader.session)[operation](f.form));
    assert.deepEqual(await actionState(f), before);
  });
  test(operation + ': a selection committed after the page precheck blocks the actual transaction', options, async () => {
    const f = await actionFixture(operation), before = await actionState(f);
    let scheduled = 0;
    const actions = actualPracticeActions(db, f.reader.session, async work => {
      scheduled++; await grantPractice(db, admin, f.input); return db.$transaction(work);
    });
    await assert.rejects(actions[operation](f.form));
    assert.equal(scheduled, 1); assert.deepEqual(await actionState(f), before);
  });
  test(operation + ': a session revoked after page precheck cannot mutate', options, async () => {
    const f = await actionFixture(operation), before = await actionState(f);
    const actions = actualPracticeActions(db, f.reader.session, async work => {
      await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
      return db.$transaction(work);
    });
    await assert.rejects(actions[operation](f.form)); assert.deepEqual(await actionState(f), before);
  });
  test(operation + ': actual in-progress writes serialize the personal decision', options, async () => {
    const f = await actionFixture(operation), preview = await previewPracticeSharing(db, admin.session, f.input);
    let decision: Promise<unknown> | undefined, decisionError: unknown, blocked = false;
    const actions = actualPracticeActions(db, f.reader.session, work => db.$transaction(async tx => {
      const result = await work(tx);
      const [row] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      decision = confirmPracticeSharing(db, admin.session, f.input, preview.token, practiceProof(admin)).catch(error => { decisionError = error; });
      await waitForWriterLock(row.pid); blocked = true;
      assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 0);
      return result;
    }, { timeout: 15_000 }));
    try { await actions[operation](f.form); } finally { await decision; }
    assert.equal(blocked, true); assert.equal((await actionState(f)).audits.length, 1);
    if (decisionError) assert.ok(decisionError instanceof PracticeSharingError || decisionError instanceof SerializableConflictError);
    else {
      assert.equal(operation, 'createPracticeCommunicationDraft');
      assert.equal(await db.selectivePracticeGrant.count({ where: { practiceId: f.practice.id } }), 1);
    }
  });
  test(operation + ': operation-specific permission revoked after precheck blocks the actual write', options, async () => {
    const f = await actionFixture(operation), before = await actionState(f);
    const permission = operation === 'createPracticeCommunicationDraft' ? 'practice_communications.write' : 'technical.status';
    const actions = actualPracticeActions(db, f.reader.session, async work => {
      await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission, allowed: false } });
      return db.$transaction(work);
    });
    await assert.rejects(actions[operation](f.form)); assert.deepEqual(await actionState(f), before);
  });
  test(operation + ': actual action audit failure rolls all business writes back', options, async () => {
    const f = await actionFixture(operation), before = await actionState(f);
    await db.$executeRawUnsafe("CREATE FUNCTION synthetic_practice_action_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event IN ('technical_practice_status_change','technical_practice_archive','practice_communication_draft_create') THEN RAISE EXCEPTION 'SYNTHETIC_PRACTICE_ACTION_AUDIT_FAULT'; END IF; RETURN NEW; END $$");
    await db.$executeRawUnsafe('CREATE TRIGGER synthetic_practice_action_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_practice_action_fault()');
    try { await assert.rejects(actualPracticeActions(db, f.reader.session)[operation](f.form)); }
    finally {
      await db.$executeRawUnsafe('DROP TRIGGER synthetic_practice_action_fault ON "AuditLog"');
      await db.$executeRawUnsafe('DROP FUNCTION synthetic_practice_action_fault()');
    }
    assert.deepEqual(await actionState(f), before);
  });
}
