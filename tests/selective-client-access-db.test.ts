import { withHistoricalEnrollment } from './selective-sharing/historical-enrollment';
// CI-only integration qualification. Do not execute against a local or real database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  readClientSharingReceipt, revokeClientSharing, readSharedClientDocument } from '../src/lib/selective-client-access';
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
async function documentFixture(role: 'admin' | 'direzione' | 'amministrazione' = 'direzione', financial = false) {
  const f = await selectiveClientFixture(db, admin, role);
  const bytes = Buffer.from('SYNTHETIC_SELECTED_DOCUMENT_' + randomUUID());
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const document = await db.document.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'Documento sintetico scelto', fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: bytes.length,
    storagePath: 'synthetic-no-real-file', checksum, uploadedById: admin.user.id, type: financial ? 'contratto' : 'altro',
    documentCategory: financial ? 'contratto' : 'altro', status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: document.storagePath, checksum } });
  const input = { ...f.input, version: 2 as const, fields: [], documents: [{ versionId: version.id, download: false }] };
  return { ...f, bytes, checksum, document, version, input };
}
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
  const historicalGrants = await db.selectiveClientGrant.findMany({ orderBy: { id: 'asc' } });
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  await assert.rejects(clientSharingManagement(db, admin.session, f.client.id));
  await assert.rejects(previewClientSharing(db, admin.session, f.input));
  assert.equal(await db.selectiveClientAuthority.count(), 0);
  await withHistoricalEnrollment(db, 'client', async ({ db, admin, url }) => {
    const sql = readFileSync('ops/selective-client-authority-enrollment.sql', 'utf8'), auditId = randomUUID();
    const target = new URL(url);
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
  // Explicit synthetic authority for the schema63 regression fixture only.
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  assert.deepEqual(await db.selectiveClientGrant.findMany({ orderBy: { id: 'asc' } }), historicalGrants);
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

test('V2 document-only grant preserves ordinary exclusions and separates view from download', options, async () => {
  const f = await documentFixture();
  const { receipt } = await grantClient(db, admin, f.input);
  assert.equal(receipt.protocol, 'SELECTIVE_CLIENT_RECEIPT_V2');
  assert.equal(receipt.fieldCount, 0);
  const selected = await readClientSharing(db, f.reader.session, f.client.id);
  assert.deepEqual(selected.fields, []); assert.equal(selected.documents.length, 1);
  assert.doesNotMatch(JSON.stringify(selected), /storagePath|NOTA_PRIVATA|AZIENDA_SINTETICA|PROGETTO_SINTETICO/);
  const view = await readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, false, async () => f.bytes);
  assert.deepEqual(view.bytes, f.bytes);
  let read = false;
  await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, true, async () => { read = true; return f.bytes; }));
  assert.equal(read, false);
  await deniedOrdinary(f);
  const audit = await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } });
  assert.deepEqual(audit.after, { version: 1, action: 'GRANT', fieldCount: 0, documentCount: 1 });
});

test('V2 download requires exact choice, valid bytes and current permission; denial leaves no audit', options, async () => {
  const f = await documentFixture(); f.input.documents[0].download = true;
  await grantClient(db, admin, f.input);
  const view = await readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, true, async () => f.bytes);
  assert.deepEqual(view.bytes, f.bytes);
  const before = await db.auditLog.count({ where: { entityId: f.document.id } });
  await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, true, async () => Buffer.from('ALTERED')));
  await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, 'unselected-version', false, async () => f.bytes));
  assert.equal(await db.auditLog.count({ where: { entityId: f.document.id } }), before);
  await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'document.download', allowed: false } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});

test('document changes restored to prior metadata never revive a previous selection or preview', options, async () => {
  const f = await documentFixture(); const preview = await previewClientSharing(db, admin.session, f.input);
  const before = await db.document.findUniqueOrThrow({ where: { id: f.document.id } });
  await db.document.update({ where: { id: f.document.id }, data: { containsSensitiveData: true } });
  await db.document.update({ where: { id: f.document.id }, data: { containsSensitiveData: false, updatedAt: before.updatedAt } });
  const after = await db.document.findUniqueOrThrow({ where: { id: f.document.id } });
  assert.ok(after.selectiveEpoch > before.selectiveEpoch);
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)));
  await grantClient(db, admin, f.input);
  await db.document.update({ where: { id: f.document.id }, data: { visibilityLevel: 'privato' } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await db.document.update({ where: { id: f.document.id }, data: { visibilityLevel: 'interno', updatedAt: after.updatedAt } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await assert.rejects(db.document.update({ where: { id: f.document.id }, data: { selectiveEpoch: 1 } }));
});

test('new version does not inherit selection and invalidates even the old bytes until a fresh personal choice', options, async () => {
  const f = await documentFixture(); await grantClient(db, admin, f.input);
  const next = await db.documentVersion.create({ data: { documentId: f.document.id, version: 2,
    storagePath: 'synthetic-second-version', checksum: 'c'.repeat(64) } });
  for (const versionId of [f.version.id, next.id]) await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, versionId, false, async () => f.bytes));
  await db.documentVersion.delete({ where: { id: next.id } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  const renewed = { ...f.input, commandId: randomUUID(), revision: 1 };
  await grantClient(db, admin, renewed);
  assert.equal((await readClientSharing(db, f.reader.session, f.client.id)).documents[0].versionId, f.version.id);
});

test('financial selection denies Direzione and forced allow; Admin and Amministrazione remain eligible', options, async () => {
  const denied = await documentFixture('direzione', true);
  await db.userPermissionOverride.create({ data: { userId: denied.reader.user.id, permission: 'contract.read', allowed: true } });
  await assert.rejects(previewClientSharing(db, admin.session, denied.input));
  for (const role of ['admin', 'amministrazione'] as const) {
    const f = await documentFixture(role, true); await grantClient(db, admin, f.input);
    assert.equal((await readClientSharing(db, f.reader.session, f.client.id)).documents.length, 1);
    await db.user.update({ where: { id: f.reader.user.id }, data: { role: 'direzione' } });
    await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, false, async () => f.bytes));
  }
});

test('document revocation is retained, receipt is reconcilable and duplicate confirmation cannot create another revision', options, async () => {
  const f = await documentFixture(); const { preview, receipt } = await grantClient(db, admin, f.input);
  assert.deepEqual(await confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)), receipt);
  assert.deepEqual(await readClientSharingReceipt(db, admin.session, f.input.commandId, f.client.id), receipt);
  const command = { grantId: receipt.grantId, revision: 1, commandId: randomUUID() };
  const revoked = await revokeClientSharing(db, admin.session, command, clientProof(admin));
  assert.equal(revoked.protocol, 'SELECTIVE_CLIENT_RECEIPT_V2');
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  assert.equal(await db.selectiveClientRevision.count({ where: { grantId: receipt.grantId } }), 2);
  await deniedOrdinary(f);
});

for (const reference of ['contract', 'payment'] as const) test(reference + ': canonical financial reassociation never revives an ordinary document selection', options, async () => {
  const f = await documentFixture(); await grantClient(db, admin, f.input);
  const contract = await db.contract.create({ data: { clientId: f.client.id, projectId: f.project.id,
    contractNumber: 'SYNTHETIC_' + randomUUID(), serviceName: 'Synthetic recovery association',
    taxableAmount: 1, vatAmount: 0, totalAmount: 1 } });
  const before = await db.document.findUniqueOrThrow({ where: { id: f.document.id } });
  if (reference === 'contract') {
    await db.contract.update({ where: { id: contract.id }, data: { signedDocumentId: f.document.id } });
  } else {
    await db.payment.create({ data: { contractId: contract.id, clientId: f.client.id,
      taxableAmount: 1, vatAmount: 0, totalAmount: 1, accountingDocumentId: f.document.id } });
  }
  await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, false, async () => f.bytes));
  const renewed = { ...f.input, commandId: randomUUID(), revision: 1 };
  await assert.rejects(previewClientSharing(db, admin.session, renewed));
  if (reference === 'contract') await db.contract.update({ where: { id: contract.id }, data: { signedDocumentId: null } });
  else await db.payment.updateMany({ where: { contractId: contract.id }, data: { accountingDocumentId: null } });
  assert.ok((await db.document.findUniqueOrThrow({ where: { id: f.document.id } })).selectiveEpoch >= before.selectiveEpoch + 2);
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await grantClient(db, admin, renewed);
  assert.deepEqual((await readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, false, async () => f.bytes)).bytes, f.bytes);
});

test('a document writer really blocks confirmation and makes its prior preview unusable', options, async () => {
  const f = await documentFixture(), preview = await previewClientSharing(db, admin.session, f.input);
  let release!: () => void, ready!: (pid: number) => void;
  const started = new Promise<number>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${f.document.id} FOR UPDATE`;
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(row.pid); await gate;
    await tx.document.update({ where: { id: f.document.id }, data: { title: 'Concurrent synthetic document mutation' } });
  });
  const pid = await started;
  const result = Promise.allSettled([confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin))]);
  try { await waitForWriterLock(pid); } finally { release(); await writer; }
  assert.equal((await result)[0].status, 'rejected');
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
});

test('financial parent history changes invalidate its accounting document even after timestamp restoration', options, async () => {
  const f = await documentFixture('amministrazione');
  const contract = await db.contract.create({ data: { clientId: f.client.id, contractNumber: 'SYNTHETIC_' + randomUUID(),
    serviceName: 'Synthetic accounting document parent', taxableAmount: 1, vatAmount: 0, totalAmount: 1 } });
  await db.payment.create({ data: { contractId: contract.id, clientId: f.client.id, taxableAmount: 1, vatAmount: 0,
    totalAmount: 1, accountingDocumentId: f.document.id } });
  await grantClient(db, admin, f.input);
  const before = await db.document.findUniqueOrThrow({ where: { id: f.document.id } });
  await db.contract.update({ where: { id: contract.id }, data: { status: 'firmato' } });
  await db.contract.update({ where: { id: contract.id }, data: { status: contract.status, updatedAt: contract.updatedAt } });
  assert.ok((await db.document.findUniqueOrThrow({ where: { id: f.document.id } })).selectiveEpoch >= before.selectiveEpoch + 2);
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});

test('company reassociation restored to its prior client and timestamp cannot revive document access', options, async () => {
  const f = await documentFixture();
  await db.document.update({ where: { id: f.document.id }, data: { companyId: f.company.id } });
  await grantClient(db, admin, f.input);
  const before = await db.document.findUniqueOrThrow({ where: { id: f.document.id } });
  await db.company.update({ where: { id: f.company.id }, data: { clientId: f.other.id } });
  await db.company.update({ where: { id: f.company.id }, data: { clientId: f.client.id, updatedAt: f.company.updatedAt } });
  assert.ok((await db.document.findUniqueOrThrow({ where: { id: f.document.id } })).selectiveEpoch >= before.selectiveEpoch + 2);
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});

test('V2 audit failure rolls back the decision and a failed access audit returns no bytes', options, async () => {
  const f = await documentFixture(), preview = await previewClientSharing(db, admin.session, f.input);
  const before = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  await db.$executeRawUnsafe("CREATE FUNCTION synthetic_selected_document_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event IN ('selective_client_changed','selective_client_document_view') THEN RAISE EXCEPTION 'SYNTHETIC_SELECTED_DOCUMENT_AUDIT_FAULT'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_selected_document_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_selected_document_audit_fault()');
  try { await assert.rejects(confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin))); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER synthetic_selected_document_audit_fault ON "AuditLog"'); }
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } }), before);
  await grantClient(db, admin, f.input);
  const count = await db.auditLog.count({ where: { entityId: f.document.id } });
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_selected_document_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_selected_document_audit_fault()');
  try { await assert.rejects(readSharedClientDocument(db, f.reader.session, f.client.id, f.version.id, false, async () => f.bytes)); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_selected_document_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_selected_document_audit_fault()');
  }
  assert.equal(await db.auditLog.count({ where: { entityId: f.document.id } }), count);
});


async function companyFixture() {
  const f = await fixture();
  return { ...f, input: { ...f.input, version: 3 as const, fields: [], documents: [],
    companies: [{ companyId: f.company.id, fields: ['vatNumber' as const] }] } };
}
test('company-only V3 projects only selected data, keeps ordinary paths denied and records counts atomically', options, async () => {
  const f = await companyFixture(), { preview, receipt } = await grantClient(db, admin, f.input);
  const view = await readClientSharing(db, f.reader.session, f.client.id);
  assert.deepEqual(view.companies, preview.companies);
  assert.deepEqual(view.companies[0].fields.map(row => row.key), ['vatNumber']);
  assert.doesNotMatch(JSON.stringify(view), /AZIENDA_SINTETICA_ESCLUSA|NOTA_PRIVATA_SINTETICA|PROGETTO_SINTETICO_ESCLUSO/);
  assert.equal(receipt.protocol, 'SELECTIVE_CLIENT_RECEIPT_V3');
  assert.deepEqual((await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } })).after,
    { version: 1, action: 'GRANT', fieldCount: 0, documentCount: 0, companyCount: 1, companyFieldCount: 1 });
  await deniedOrdinary(f);
  await db.company.create({ data: { clientId: f.client.id, name: 'NEW_COMPANY_MUST_NOT_INHERIT' } });
  assert.deepEqual((await readClientSharing(db, f.reader.session, f.client.id)).companies, view.companies);
});
test('company changes and restored content invalidate preview and grant without silent resurrection', options, async () => {
  const f = await companyFixture(), preview = await previewClientSharing(db, admin.session, f.input);
  await db.company.update({ where: { id: f.company.id }, data: { vatNumber: 'CHANGED' } });
  await db.company.update({ where: { id: f.company.id }, data: { vatNumber: f.company.vatNumber, updatedAt: f.company.updatedAt } });
  await assert.rejects(confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)));
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
  await grantClient(db, admin, f.input);
  await db.company.update({ where: { id: f.company.id }, data: { city: 'Synthetic city' } });
  await db.company.update({ where: { id: f.company.id }, data: { city: f.company.city, updatedAt: f.company.updatedAt } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});
test('company.read denial for authority or recipient cannot be bypassed by Admin role or old open session', options, async () => {
  const f = await companyFixture(); await grantClient(db, admin, f.input);
  for (const userId of [f.reader.user.id, admin.user.id]) {
    const override = await db.userPermissionOverride.create({ data: { userId, permission: 'company.read', allowed: false } });
    try {
      await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
      await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, revision: 1, commandId: randomUUID() }));
    } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); }
  }
});
test('company cross-client identity, trash and changed association are denied', options, async () => {
  const f = await companyFixture();
  await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, clientId: f.other.id }));
  await grantClient(db, admin, f.input);
  await db.company.update({ where: { id: f.company.id }, data: { clientId: f.other.id } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await db.company.update({ where: { id: f.company.id }, data: { clientId: f.client.id, deletedAt: new Date() } });
  await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, revision: 1, commandId: randomUUID() }));
});
test('generation survives company deletion and reinsertion and rejects direct reduction, deletion and truncate', options, async () => {
  const f = await companyFixture();
  const c = await db.company.create({ data: { clientId: f.client.id, name: 'Synthetic detachable company' } });
  const input = { ...f.input, companies: [{ companyId: c.id, fields: ['name'] }] };
  await grantClient(db, admin, input);
  const generation = async () => (await db.$queryRaw<Array<{ generation: number }>>`SELECT generation FROM "SelectiveCompanyGeneration" WHERE "companyId"=${c.id}`)[0].generation;
  const before = await generation();
  await db.company.delete({ where: { id: c.id } });
  await db.company.create({ data: { ...c } });
  assert.equal(await generation(), before + 2);
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await assert.rejects(db.$executeRaw`UPDATE "SelectiveCompanyGeneration" SET generation=1 WHERE "companyId"=${c.id}`);
  await assert.rejects(db.$executeRaw`DELETE FROM "SelectiveCompanyGeneration" WHERE "companyId"=${c.id}`);
  await assert.rejects(db.$executeRaw`TRUNCATE "SelectiveCompanyGeneration"`);
  assert.equal(await generation(), before + 2);
});
test('company and V2 document selections coexist without adding generation bytes to Company or modifying legacy grants', options, async () => {
  const f = await documentFixture();
  await db.document.update({ where: { id: f.document.id }, data: { companyId: f.company.id } });
  await grantClient(db, admin, f.input);
  const old = await db.selectiveClientGrant.findUniqueOrThrow({ where: { clientId_recipientId: { clientId: f.client.id, recipientId: f.reader.user.id } } });
  assert.equal(Object.hasOwn(await db.company.findUniqueOrThrow({ where: { id: f.company.id } }), 'companyEpoch'), false);
  assert.equal((await readClientSharing(db, f.reader.session, f.client.id)).documents.length, 1);
  const input = { ...f.input, version: 3, revision: 1, commandId: randomUUID(), companies: [{ companyId: f.company.id, fields: ['vatNumber'] }] };
  const { receipt } = await grantClient(db, admin, input);
  const view = await readClientSharing(db, f.reader.session, f.client.id);
  assert.equal(view.documents.length, 1); assert.equal(view.companies.length, 1);
  const legacy = await db.selectiveClientRevision.findUniqueOrThrow({ where: { grantId_revision: { grantId: old.id, revision: 1 } } });
  assert.deepEqual(legacy.payload, old.payload); assert.equal(legacy.proof, old.proof);
  await revokeClientSharing(db, admin.session, { grantId: receipt.grantId, revision: 2, commandId: randomUUID() }, clientProof(admin));
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});
test('V3 duplicate command and lost reply keep a single grant, revision and minimized audit', options, async () => {
  const f = await companyFixture(), p = await previewClientSharing(db, admin.session, f.input);
  const receipt = await confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin));
  assert.deepEqual(await confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)), receipt);
  assert.deepEqual(await readClientSharingReceipt(db, admin.session, f.input.commandId, f.client.id), receipt);
  assert.equal(await db.selectiveClientRevision.count({ where: { grantId: receipt.grantId } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: receipt.revisionId } }), 1);
});
test('pending V3 confirmation waits for actual company writer and denies after the change', options, async () => {
  const f = await companyFixture(), p = await previewClientSharing(db, admin.session, f.input);
  let confirm: Promise<unknown> | undefined, failure: unknown;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${f.company.id} FOR UPDATE`;
    const [owner] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    confirm = confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)).catch(error => { failure = error; });
    await waitForWriterLock(owner.pid);
    await tx.company.update({ where: { id: f.company.id }, data: { vatNumber: 'CONCURRENT_CHANGE' } });
  });
  await confirm; assert.ok(failure);
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
});

async function personFixture() {
  const f = await fixture();
  const person = await db.person.create({ data: { firstName: 'PRIVATE_SYNTHETIC_FIRST', lastName: 'PRIVATE_SYNTHETIC_LAST',
    email: 'selected@example.invalid', phone: 'PRIVATE_SYNTHETIC_PHONE', notes: 'PRIVATE_SYNTHETIC_PERSON_NOTE' } });
  const membership = await db.companyPerson.create({ data: { companyId: f.company.id, personId: person.id, role: 'Referente', ownershipPercent: '12.34567890123456789' } });
  const choice = { membershipId: membership.id, companyId: f.company.id, personId: person.id, fields: ['email'] };
  const input = { ...f.input, version: 4, fields: [], documents: [], companies: [], people: [choice] };
  return { ...f, person, membership, choice, input };
}
test('V4 person-only choice exposes no implicit names, company or other membership and keeps minimized atomic counts', options, async () => {
  const f = await personFixture();
  const otherCompany = await db.company.create({ data: { clientId: f.other.id, name: 'PRIVATE_OTHER_PERSON_COMPANY' } });
  await db.companyPerson.create({ data: { companyId: otherCompany.id, personId: f.person.id, role: 'PRIVATE_OTHER_MEMBERSHIP' } });
  const { preview, receipt } = await grantClient(db, admin, f.input);
  const view = await readClientSharing(db, f.reader.session, f.client.id);
  assert.deepEqual(view.people, preview.people); assert.deepEqual(view.people[0].fields.map(row => row.key), ['email']);
  assert.equal(view.people[0].fields[0].value, f.person.email);
  for (const privateValue of [f.person.firstName, f.person.lastName, f.person.notes!, f.company.name, otherCompany.name, 'PRIVATE_OTHER_MEMBERSHIP']) assert.ok(!JSON.stringify(view).includes(privateValue));
  assert.equal(receipt.protocol, 'SELECTIVE_CLIENT_RECEIPT_V4');
  assert.deepEqual((await db.auditLog.findUniqueOrThrow({ where: { id: receipt.revisionId } })).after,
    { version: 1, action: 'GRANT', fieldCount: 0, documentCount: 0, companyCount: 0, companyFieldCount: 0, personCount: 1, personFieldCount: 1 });
  await deniedOrdinary(f);
  const catalogue = await clientSharingManagement(db, admin.session, f.client.id);
  assert.deepEqual(catalogue.personOptions.map(row => row.membershipId), [f.membership.id]);
});
test('V4 modified and restored person or membership invalidates both preview and persisted approval', options, async () => {
  for (const kind of ['person', 'membership'] as const) {
    const f = await personFixture(), preview = await previewClientSharing(db, admin.session, f.input);
    const changeAndRestore = async () => {
      if (kind === 'person') {
        await db.person.update({ where: { id: f.person.id }, data: { phone: 'CHANGED' } });
        await db.person.update({ where: { id: f.person.id }, data: { phone: f.person.phone } });
      } else {
        await db.companyPerson.update({ where: { id: f.membership.id }, data: { role: 'CHANGED' } });
        await db.companyPerson.update({ where: { id: f.membership.id }, data: { role: f.membership.role } });
      }
    };
    await changeAndRestore();
    await assert.rejects(confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin)));
    assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
    await grantClient(db, admin, f.input); await changeAndRestore();
    await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  }
});
test('V4 rejects substituted membership identity, foreign client, reparenting and person trash without resurrection', options, async () => {
  const f = await personFixture();
  for (const patch of [{ personId: 'wrong' }, { companyId: 'wrong' }, { membershipId: 'wrong' }]) {
    await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, people: [{ ...f.choice, ...patch }] }));
  }
  await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, clientId: f.other.id }));
  await grantClient(db, admin, f.input);
  await db.person.update({ where: { id: f.person.id }, data: { deletedAt: new Date() } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await db.person.update({ where: { id: f.person.id }, data: { deletedAt: null } });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await db.company.update({ where: { id: f.company.id }, data: { clientId: f.other.id } });
  await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, revision: 1, commandId: randomUUID() }));
});
test('V4 tombstones survive deletion and reinsertion; source no-op is stable and direct ledger rewrites/truncates are denied', options, async () => {
  const f = await personFixture(); await grantClient(db, admin, f.input);
  const epochs = async () => (await db.$queryRaw<Array<{ person: number; membership: number }>>`SELECT
    (SELECT generation FROM "SelectivePersonGeneration" WHERE "personId"=${f.person.id}) AS person,
    (SELECT generation FROM "SelectiveMembershipGeneration" WHERE "membershipId"=${f.membership.id}) AS membership`)[0];
  const before = await epochs();
  await db.person.update({ where: { id: f.person.id }, data: { email: f.person.email } });
  await db.companyPerson.update({ where: { id: f.membership.id }, data: { role: f.membership.role } });
  assert.deepEqual(await epochs(), before);
  await db.companyPerson.delete({ where: { id: f.membership.id } });
  await db.person.delete({ where: { id: f.person.id } });
  await db.person.create({ data: f.person }); await db.companyPerson.create({ data: f.membership });
  assert.deepEqual(await epochs(), { person: before.person + 2, membership: before.membership + 2 });
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
  await assert.rejects(db.$executeRaw`UPDATE "SelectivePersonGeneration" SET generation=1 WHERE "personId"=${f.person.id}`);
  await assert.rejects(db.$executeRaw`DELETE FROM "SelectiveMembershipGeneration" WHERE "membershipId"=${f.membership.id}`);
  for (const table of ['SelectivePersonGeneration', 'SelectiveMembershipGeneration', 'Person', 'CompanyPerson']) {
    await assert.rejects(db.$executeRawUnsafe(`TRUNCATE "${table}"`));
  }
});
test('V4 permission revocation for authority or recipient denies open sessions without ordinary fallback', options, async () => {
  const f = await personFixture(); await grantClient(db, admin, f.input);
  for (const userId of [f.reader.user.id, admin.user.id]) {
    const override = await db.userPermissionOverride.create({ data: { userId, permission: 'company.read', allowed: false } });
    try {
      await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
      await assert.rejects(previewClientSharing(db, admin.session, { ...f.input, revision: 1, commandId: randomUUID() }));
    } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); }
  }
  await deniedOrdinary(f);
});
test('V4 repeated confirmation and lost reply produce one receipt; revocation denies current reads', options, async () => {
  const f = await personFixture(), p = await previewClientSharing(db, admin.session, f.input);
  const attempts = await Promise.allSettled([1, 2].map(() => confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin))));
  const committed = attempts.filter(row => row.status === 'fulfilled');
  assert.ok(committed.length >= 1, 'one concurrent request must commit');
  const receipt = committed[0].value;
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled') assert.deepEqual(attempt.value, receipt);
    else assert.ok(attempt.reason instanceof SerializableConflictError, 'only a serialization conflict may be retried');
    // Retry the same command after a conflict or a lost reply, without a new decision.
    assert.deepEqual(await confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)), receipt);
  }
  assert.deepEqual(await readClientSharingReceipt(db, admin.session, f.input.commandId, f.client.id), receipt);
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 1);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 1);
  assert.equal(await db.selectiveClientRevision.count({ where: { grantId: receipt.grantId } }), 1);
  assert.equal(await db.auditLog.count({ where: { id: receipt.revisionId } }), 1);
  await revokeClientSharing(db, admin.session, { grantId: receipt.grantId, revision: 1, commandId: randomUUID() }, clientProof(admin));
  await assert.rejects(readClientSharing(db, f.reader.session, f.client.id));
});
test('V4 pending confirmation waits for person/membership writers then rejects stale values', options, async () => {
  for (const kind of ['person', 'membership'] as const) {
    const f = await personFixture(), p = await previewClientSharing(db, admin.session, f.input);
    let confirm: Promise<unknown> | undefined, failure: unknown;
    await db.$transaction(async tx => {
      if (kind === 'person') await tx.$queryRaw`SELECT id FROM "Person" WHERE id=${f.person.id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "CompanyPerson" WHERE id=${f.membership.id} FOR UPDATE`;
      const [owner] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      confirm = confirmClientSharing(db, admin.session, f.input, p.token, clientProof(admin)).catch(error => { failure = error; });
      await waitForWriterLock(owner.pid);
      if (kind === 'person') await tx.person.update({ where: { id: f.person.id }, data: { email: 'changed@example.invalid' } });
      else await tx.companyPerson.update({ where: { id: f.membership.id }, data: { role: 'Changed' } });
    });
    await confirm; assert.ok(failure); assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
  }
});
test('V4 audit failure rolls back grant, command and history together', options, async () => {
  const f = await personFixture(), preview = await previewClientSharing(db, admin.session, f.input);
  await db.$executeRawUnsafe("CREATE FUNCTION synthetic_person_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='selective_client_changed' THEN RAISE EXCEPTION 'SYNTHETIC_PERSON_AUDIT_FAULT'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_person_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_person_audit_fault()');
  try { await assert.rejects(confirmClientSharing(db, admin.session, f.input, preview.token, clientProof(admin))); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_person_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION synthetic_person_audit_fault()');
  }
  assert.equal(await db.selectiveClientGrant.count({ where: { clientId: f.client.id } }), 0);
  assert.equal(await db.selectiveClientCommand.count({ where: { clientId: f.client.id } }), 0);
});
test('V4 database validator independently denies malformed identities, duplicate membership and inconsistent epochs', options, async () => {
  const f = await personFixture(), { receipt } = await grantClient(db, admin, f.input);
  const payload = (await db.selectiveClientGrant.findUniqueOrThrow({ where: { id: receipt.grantId } })).payload;
  const valid = async (value: unknown) => (await db.$queryRaw<Array<{ valid: boolean }>>`SELECT fai_selective_client_people_valid(${JSON.stringify(value)}::jsonb) AS valid`)[0].valid;
  assert.equal(await valid(payload), true);
  const p = JSON.parse(JSON.stringify(payload));
  for (const people of [[], [p.people[0], p.people[0]], [{ ...p.people[0], personEpoch: 0 }], [{ ...p.people[0], membershipEpoch: 2147483648 }], [{ ...p.people[0], personId: 'other' }]]) {
    assert.equal(await valid({ ...p, people }), false);
  }
  assert.equal(await valid({ ...p, selection: { ...p.selection, people: [{ ...f.choice, fields: ['notes'] }] } }), false);
  assert.equal(await valid({ ...p, selection: { ...p.selection, people: [f.choice, f.choice] } }), false);
});
test('V4 personal fields coexist with selected company fields and documents while preserving old V2 history', options, async () => {
  const f = await documentFixture(), { receipt: old } = await grantClient(db, admin, f.input);
  const legacy = await db.selectiveClientRevision.findUniqueOrThrow({ where: { id: old.revisionId } });
  const person = await db.person.create({ data: { firstName: 'Private', lastName: 'Synthetic', email: 'combined@example.invalid' } });
  const membership = await db.companyPerson.create({ data: { companyId: f.company.id, personId: person.id, role: 'Referente' } });
  const input = { ...f.input, version: 4, revision: 1, commandId: randomUUID(), companies: [{ companyId: f.company.id, fields: ['vatNumber'] }],
    people: [{ membershipId: membership.id, companyId: f.company.id, personId: person.id, fields: ['email'] }] };
  await grantClient(db, admin, input);
  const view = await readClientSharing(db, f.reader.session, f.client.id);
  assert.equal(view.companies.length, 1); assert.equal(view.people.length, 1); assert.equal(view.documents.length, 1);
  assert.deepEqual(await db.selectiveClientRevision.findUniqueOrThrow({ where: { id: old.revisionId } }), legacy);
});
