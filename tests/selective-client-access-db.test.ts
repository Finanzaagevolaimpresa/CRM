// CI-only integration qualification. Do not execute against a local or real database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { actualClientWriteActions, clientWriteActions, type ClientWriteAction } from './selective-clients/action-harness';
import { SerializableConflictError, withSerializableTransaction } from '../src/lib/serializable';
import test, { after, before } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { clientProof, grantClient, selectiveClientFixture, type ClientPerson } from './selective-clients/fixtures';
import { clientSharingManagement, confirmClientSharing, previewClientSharing, readClientSharing,
  readClientSharingReceipt, revokeClientSharing } from '../src/lib/selective-client-access';
import { canEditClient, canViewClient, canViewLead, canViewProject } from '../src/lib/access-control';
import { clientVisibilityWhere, leadVisibilityWhere } from '../src/lib/core-query-policy';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { withProjectResources } from '../src/lib/project-resource-guard';
import { changeClientReadGrant, loadClientReadScope } from '../src/lib/client-read-perimeter';

const enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: ClientPerson;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
const fixture = () => selectiveClientFixture(db, admin);
async function deniedOrdinary(f: Awaited<ReturnType<typeof fixture>>) {
  const actor = { ...f.reader.session, ...await loadSelectiveProjectScope(db, f.reader.user.id) };
  assert.equal(canViewClient(actor, f.client), false);
  assert.equal(canEditClient(actor, f.client), false);
  assert.equal(canViewLead(actor, f.lead), false);
  assert.equal(canViewProject(actor, { ...f.project, client: f.client }), false);
  assert.equal(canViewClient(actor, f.other), true);
  const staleSession = { ...f.reader.session, clientReadScope: [f.client.id] };
  assert.equal(await db.client.count({ where: { AND: [{ id: f.client.id }, clientVisibilityWhere(staleSession)] } }), 0);
  let workStarted = false;
  await assert.rejects(withProjectResources(db, actor.userId, [{ companyId: f.company.id }], async () => { workStarted = true; }));
  assert.equal(workStarted, false, 'current linked company context denies before work');
}

test('project authority cannot bootstrap client sharing from a management GET or preview', options, async () => {
  const f = await fixture();
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  await assert.rejects(clientSharingManagement(db, admin.session, f.client.id));
  await assert.rejects(previewClientSharing(db, admin.session, f.input));
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  const sql = readFileSync('ops/selective-client-authority-enrollment.sql', 'utf8'), auditId = randomUUID();
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.searchParams.get('schema') ?? 'public', 'public'); target.searchParams.delete('schema');
  const binding = { database: target.pathname.slice(1), userId: admin.user.id, name: admin.user.name,
    email: admin.user.email, approvalSha256: 'a'.repeat(64), auditId };
  const enroll = (value: unknown, body = sql) => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', target.toString()], {
    input: "SELECT set_config('fai.selective_client_binding','" + JSON.stringify(value).replaceAll("'", "''") + "',false);\n" + body,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000,
  });
  for (const value of [null, [], { ...binding, approvalSha256: null }, { ...binding, auditId: null }, { ...binding, name: '' }]) {
    assert.throws(() => enroll(value), /SELECTIVE_CLIENT_ENROLLMENT_BINDING_INVALID/);
  }
  assert.throws(() => enroll({ ...binding, email: 'wrong@invalid.test' }), /SELECTIVE_CLIENT_ENROLLMENT_PROFILE_DENIED/);
  assert.throws(() => enroll(binding, sql.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ROLLBACK'; END $$; COMMIT;")), /SYNTHETIC_ROLLBACK/);
  assert.equal(await db.selectiveClientAuthority.count(), 0); assert.equal(await db.auditLog.count({ where: { id: auditId } }), 0);
  assert.match(enroll(binding).toString(), /SELECTIVE_CLIENT_ENROLLMENT_COMMITTED/);
  assert.deepEqual(await db.selectiveClientAuthority.findUnique({ where: { id: 'client-sharing' } }),
    { id: 'client-sharing', userId: admin.user.id, revision: 1, enabled: true });
  // Real canonical N04 trigger, including the complete persisted after value.
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: auditId } });
  assert.equal(audit.actorId, admin.user.id); assert.equal(audit.event, 'selective_client_authority_enrolled');
  assert.deepEqual(audit.before, { version: 0 });
  assert.deepEqual(audit.after, { version: 1, enabled: true, approvalHash: binding.approvalSha256 });
  assert.throws(() => enroll(binding), /SELECTIVE_CLIENT_ENROLLMENT_ALREADY_STARTED/);
  assert.equal(await db.selectiveClientGrant.count(), 0);
});

test('preview and selected read expose only chosen scalars; broad roles and child records stay excluded', options, async () => {
  const f = await fixture();
  const before = await Promise.all([db.selectiveClientGrant.count(), db.auditLog.count()]);
  const preview = await previewClientSharing(db, admin.session, f.input);
  assert.equal(preview.replacesFullAccess, true);
  assert.deepEqual(preview.fields.map(row => row.key), ['displayName', 'status']);
  assert.deepEqual(await Promise.all([db.selectiveClientGrant.count(), db.auditLog.count()]), before);
  const receipt = await confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin));
  const view = await readClientSharing(db, f.reader.session, f.client.id);
  assert.deepEqual(view.fields, preview.fields);
  for (const excluded of [f.client.notes!, f.company.name, f.company.vatNumber!, f.project.title]) {
    assert.ok(!JSON.stringify(view).includes(excluded));
  }
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } });
  assert.deepEqual(audit.before, { version: 0 });
  assert.deepEqual(audit.after, { version: 1, action: 'GRANT', fieldCount: 2 });
  assert.ok(!JSON.stringify(audit).includes(f.reader.user.email));
  await deniedOrdinary(f);
});

test('a lead linked after scope loading cannot expose the selected client through a stale identifier graph', options, async () => {
  const f = await fixture(); await grantClient(db, admin, f.input);
  const actor = { ...f.reader.session, ...await loadSelectiveProjectScope(db, f.reader.user.id) };
  const linked = await db.lead.create({ data: { firstName: 'Synthetic late relation', lastName: randomUUID(),
    clientId: f.client.id, assignedToId: actor.userId } });
  const independent = await db.lead.create({ data: { firstName: 'Synthetic independent lead', lastName: randomUUID(),
    clientId: f.other.id, assignedToId: actor.userId } });
  assert.ok(!actor.selectiveLeadIds?.includes(linked.id));
  assert.equal(canViewLead(actor, linked), false);
  assert.equal(canViewLead(actor, independent), true);
  assert.equal(await db.lead.count({ where: { id: linked.id, AND: [leadVisibilityWhere(actor)] } }), 0);
  assert.equal(await db.lead.count({ where: { id: independent.id, AND: [leadVisibilityWhere(actor)] } }), 1);
});

test('a historical full-client grant stays subordinate and cannot be reactivated after selected access or revocation', options, async () => {
  const f = await selectiveClientFixture(db, admin, 'revisore');
  const input = { userId: f.reader.user.id, clientId: f.client.id, expectedVersion: 0, active: true };
  const full = await withSerializableTransaction(db, tx => changeClientReadGrant(tx, admin.session, input, true));
  assert.equal(canViewClient({ ...f.reader.session, clientReadScope: await loadClientReadScope(db, f.reader.user.id) }, f.client), true);
  const { receipt } = await grantClient(db, admin, f.input);
  const actor = { ...f.reader.session, clientReadScope: await loadClientReadScope(db, f.reader.user.id),
    ...await loadSelectiveProjectScope(db, f.reader.user.id) };
  assert.equal(canViewClient(actor, f.client), false);
  assert.equal((await readClientSharing(db, f.reader.session, f.client.id)).fields.length, 2);
  // Revoking a legacy full grant remains possible; activating it is not.
  await withSerializableTransaction(db, tx => changeClientReadGrant(tx, admin.session, { ...input, expectedVersion: 1, active: false }, true));
  await assert.rejects(withSerializableTransaction(db, tx => changeClientReadGrant(tx, admin.session, { ...input, expectedVersion: 2 }, true)), /SELECTIVE_CLIENT_READ_ONLY/);
  await revokeClientSharing(db, admin.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(admin));
  await assert.rejects(withSerializableTransaction(db, tx => changeClientReadGrant(tx, admin.session, { ...input, expectedVersion: 2 }, true)), /SELECTIVE_CLIENT_READ_ONLY/);
  assert.equal((await db.clientReadGrant.findUniqueOrThrow({ where: { id: full.id } })).active, false);
  assert.equal(await db.auditLog.count({ where: { entityId: full.id } }), 2);
  assert.equal(canViewClient({ ...actor, ...await loadSelectiveProjectScope(db, f.reader.user.id) }, f.client), false);
});

test('another Admin, self, substituted session and forged step-up cannot confirm', options, async () => {
  const f = await fixture(), other = await syntheticPerson(db, 'Altro Admin sintetico');
  await assert.rejects(previewClientSharing(db, other.session, f.input));
  await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, recipientId: admin.user.id }));
  const p = await previewClientSharing(db, admin.session, f.input);
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, p.token, { ...clientProof(admin), stepUpToken: 'forged' }));
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, p.token, { ...clientProof(admin), sessionToken: other.token }));
  await assert.rejects(confirmClientSharing(db, { ...admin.session, sessionId: other.session.sessionId }, f.input, p.token, clientProof(admin)));
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
});

test('changed fields, content or recipient invalidate the exact preview', options, async () => {
  const f = await fixture(), p = await previewClientSharing(db, admin.session, f.input);
  await assert.rejects(confirmClientSharing(db, admin.session, { ...f.input, fields: ['type'] }, p.token, clientProof(admin)));
  await db.client.update({ where: { id: f.client.id }, data: { notes: 'Changed synthetic private note' } });
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)));
  const q = await previewClientSharing(db, admin.session, f.input);
  await db.user.update({ where: { id: f.reader.user.id }, data: { name: 'Changed synthetic recipient' } });
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, q.token, clientProof(admin)));
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
});

test('lost response reconciles one receipt only for the exact command and client', options, async () => {
  const f = await fixture(), { preview, receipt } = await grantClient(db, admin, f.input);
  assert.deepEqual(await confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)), receipt);
  assert.deepEqual(await readClientSharingReceipt(db, admin.session, f.input.commandId, f.client.id), receipt);
  assert.equal(await readClientSharingReceipt(db, admin.session, f.input.commandId, f.other.id), null);
  await assert.rejects(confirmClientSharing(db, admin.session, { ...f.input, fields: ['status'] }, preview.token, clientProof(admin)));
  assert.equal(await db.selectiveClientRevision.count({ where: { grantId: receipt.grantId } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: receipt.revisionId } }), 1);
});

test('two concurrent decisions on one revision commit at most one command/history/audit', options, async () => {
  const f = await fixture(), other = { ...f.input, commandId: randomUUID(), fields: ['type'] };
  const p = await previewClientSharing(db, admin.session, f.input), q = await previewClientSharing(db, admin.session, other);
  const results = await Promise.allSettled([
    confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)),
    confirmClientSharing(db, admin.session, other, q.token, clientProof(admin)),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 1);
  const revisions = await db.selectiveClientRevision.findMany({ where: { grant: { clientId: f.client.id } } });
  assert.equal(revisions.length, 1);
  assert.equal(await db.auditLog.count({ where: { id: revisions[0].id } }), 1);
});

test('audit failure rolls the grant, command, history and user generation back together', options, async () => {
  const f = await fixture(), p = await previewClientSharing(db, admin.session, f.input);
  const userBefore = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  await db.$executeRawUnsafe("CREATE FUNCTION synthetic_selective_client_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='selective_client_changed' THEN RAISE EXCEPTION 'synthetic client audit fault'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_selective_client_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_selective_client_fault()');
  try { await assert.rejects(confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin))); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_selective_client_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_selective_client_fault()');
  }
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } }), userBefore);
});

test('revocation retains immutable history and never restores ordinary ownership or Admin access', options, async () => {
  const f = await fixture(), { receipt } = await grantClient(db, admin, f.input);
  const input = { grantId: receipt.grantId, revision: 1, commandId: randomUUID() };
  const revoked = await revokeClientSharing(db, admin.session, input, clientProof(admin));
  assert.equal(revoked.revision, 2);
  assert.deepEqual(await revokeClientSharing(db, admin.session, input, clientProof(admin)), revoked);
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await deniedOrdinary(f);
  assert.equal(await db.selectiveClientRevision.count({ where: { grantId: receipt.grantId } }), 2);
  await assert.rejects(db.selectiveClientGrant.delete({ where: { id: receipt.grantId } }));
  await assert.rejects(db.selectiveClientRevision.delete({ where: { id: receipt.revisionId } }));
  await assert.rejects(db.selectiveClientCommand.update({ where: { id: f.input.commandId }, data: { requestDigest: 'a'.repeat(64) } }));
});

test('expiry blocks an open session and does not reopen the full client', options, async () => {
  const f = await fixture();
  await grantClient(db, admin, { ...f.input, expiresAt: new Date(Date.now() + 4000).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 4100));
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await deniedOrdinary(f);
});

test('role and permission revocation remain invalid after their previous values are restored', options, async () => {
  const f = await fixture(); await grantClient(db, admin, f.input);
  for (const role of ['commerciale', 'admin'] as const) await db.user.update({ where: { id: f.reader.user.id }, data: { role } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  const g = await fixture(); await grantClient(db, admin, g.input);
  const permission = await db.userPermissionOverride.create({ data: { userId: g.reader.user.id, permission: 'client.read', allowed: false } });
  await assert.rejects(readClientSharing(db, g.reader.session, g.client.id));
  await db.userPermissionOverride.delete({ where: { id: permission.id } });
  await assert.rejects(readClientSharing(db, g.reader.session, g.client.id));
  await deniedOrdinary(f); await deniedOrdinary(g);
});

test('archive/restore and owner reassignment invalidate previous client decisions', options, async () => {
  const f = await fixture(); await grantClient(db, admin, f.input);
  for (const status of ['archiviato', 'attivo']) await db.client.update({ where: { id: f.client.id }, data: { status } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  const g = await fixture(); await grantClient(db, admin, g.input);
  for (const salesOwnerId of [admin.user.id, g.reader.user.id]) await db.client.update({ where: { id: g.client.id }, data: { salesOwnerId } });
  await assert.rejects(readClientSharing(db, g.reader.session, g.client.id));
  await deniedOrdinary(f); await deniedOrdinary(g);
});

test('recipient session revocation blocks a previously open selected client', options, async () => {
  const f = await fixture(); await grantClient(db, admin, f.input);
  await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});

test('a client update committed while confirmation waits makes the old preview stale', options, async () => {
  const f = await fixture(), p = await previewClientSharing(db, admin.session, f.input);
  let release!: () => void, ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${f.client.id} FOR UPDATE`;
    ready(); await gate;
    await tx.client.update({ where: { id: f.client.id }, data: { displayName: 'Concurrent synthetic client update' } });
  });
  await started;
  const result = Promise.allSettled([confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin))]);
  await new Promise(resolve => setTimeout(resolve, 100)); release(); await writer;
  assert.equal((await result)[0].status, 'rejected');
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
});

test('an ordinary resource write uses current exclusions rather than its precheck session', options, async () => {
  const f = await fixture();
  assert.equal(canEditClient(f.reader.session, f.client), true);
  await grantClient(db, admin, f.input);
  const before = await db.client.findUniqueOrThrow({ where: { id: f.client.id } });
  await assert.rejects(withProjectResources(db, f.reader.user.id, [{ clientId: f.client.id }], tx =>
    tx.client.update({ where: { id: f.client.id }, data: { notes: 'MUST_NOT_COMMIT' } })));
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: f.client.id } }), before);
  await withProjectResources(db, f.reader.user.id, [{ clientId: f.other.id }], tx =>
    tx.client.update({ where: { id: f.other.id }, data: { notes: 'Independent synthetic update' } }));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: f.other.id } })).notes, 'Independent synthetic update');
});

async function writeFixture(operation: ClientWriteAction) {
  const f = await fixture(), form = new FormData();
  form.set('clientId', f.client.id);
  form.set(operation === 'createCompany' ? 'name' : 'title', 'SYNTHETIC_CLIENT_ACTION_' + randomUUID());
  if (operation === 'createProject') form.set('companyId', f.company.id);
  return { ...f, form };
}
async function businessState(f: Awaited<ReturnType<typeof writeFixture>>) {
  return {
    companies: await db.company.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } }),
    projects: await db.project.findMany({ where: { clientId: f.client.id }, orderBy: { id: 'asc' } }),
    audits: await db.auditLog.findMany({ where: { actorId: f.reader.user.id, event: { in: ['company_create', 'project_create'] } }, orderBy: { id: 'asc' } }),
  };
}
async function waitForWriterLock(pid: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [row] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid<>pg_backend_pid() AND $1::integer=ANY(pg_blocking_pids(a.pid))) AS blocked', pid);
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Personal decision never waited on the actual write transaction');
}
for (const operation of clientWriteActions) {
  test(operation + ': independent client still saves through the actual action and audit', options, async () => {
    const f = await writeFixture(operation);
    await grantClient(db, admin, { ...f.input, clientId: f.other.id });
    const before = await businessState(f);
    await actualClientWriteActions(db, f.reader.session)[operation](f.form);
    const after = await businessState(f);
    assert.equal(after.audits.length, before.audits.length + 1);
    if (operation === 'createCompany') assert.equal(after.companies.length, before.companies.length + 1);
    else assert.equal(after.projects.length, before.projects.length + 1);
  });
  test(operation + ': existing and revoked client selection deny without business writes', options, async () => {
    const f = await writeFixture(operation), { receipt } = await grantClient(db, admin, f.input);
    const before = await businessState(f);
    await assert.rejects(actualClientWriteActions(db, f.reader.session)[operation](f.form));
    assert.deepEqual(await businessState(f), before);
    await revokeClientSharing(db, admin.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(admin));
    await assert.rejects(actualClientWriteActions(db, f.reader.session)[operation](f.form));
    assert.deepEqual(await businessState(f), before);
  });
  test(operation + ': selection committed after precheck denies the actual action transaction', options, async () => {
    const f = await writeFixture(operation), before = await businessState(f);
    let called = 0;
    const schedule: typeof withProjectResources = async (database, userId, resources, work) => {
      called++; await grantClient(db, admin, f.input);
      return withProjectResources(database, userId, resources, work);
    };
    await assert.rejects(actualClientWriteActions(db, f.reader.session, schedule)[operation](f.form));
    assert.equal(called, 1); assert.deepEqual(await businessState(f), before);
  });
  test(operation + ': a real in-progress write serializes the later personal decision', options, async () => {
    const f = await writeFixture(operation), preview = await previewClientSharing(db, admin.session, f.input);
    let decision: Promise<unknown> | undefined, decisionError: unknown, blocked = false;
    const schedule: typeof withProjectResources = (database, userId, resources, work) => withProjectResources(database, userId, resources, async tx => {
      const [row] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      decision = confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)).catch(error => { decisionError = error; });
      await waitForWriterLock(row.pid); blocked = true;
      assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
      return work(tx);
    });
    try { await actualClientWriteActions(db, f.reader.session, schedule)[operation](f.form); }
    finally { await decision; }
    assert.equal(blocked, true); assert.equal((await businessState(f)).audits.length, 1);
    if (decisionError) assert.ok(decisionError instanceof SerializableConflictError);
    else assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 1);
  });
  test(operation + ': session revoked after precheck prevents actual write and audit', options, async () => {
    const f = await writeFixture(operation), before = await businessState(f);
    const schedule: typeof withProjectResources = async (database, userId, resources, work) => {
      await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
      return withProjectResources(database, userId, resources, work);
    };
    await assert.rejects(actualClientWriteActions(db, f.reader.session, schedule)[operation](f.form));
    assert.deepEqual(await businessState(f), before);
  });
  test(operation + ': injected business-audit failure rolls the actual action back', options, async () => {
    const f = await writeFixture(operation), before = await businessState(f);
    await db.$executeRawUnsafe("CREATE FUNCTION synthetic_client_action_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event IN ('company_create','project_create') THEN RAISE EXCEPTION 'SYNTHETIC_ACTION_AUDIT_FAULT'; END IF; RETURN NEW; END $$");
    await db.$executeRawUnsafe('CREATE TRIGGER synthetic_client_action_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_client_action_fault()');
    try { await assert.rejects(actualClientWriteActions(db, f.reader.session)[operation](f.form)); }
    finally {
      await db.$executeRawUnsafe('DROP TRIGGER synthetic_client_action_fault ON "AuditLog"');
      await db.$executeRawUnsafe('DROP FUNCTION synthetic_client_action_fault()');
    }
    assert.deepEqual(await businessState(f), before);
  });
}
