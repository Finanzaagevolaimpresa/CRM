import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { syntheticAuthority, syntheticPerson, syntheticSharingCase } from './selective-sharing/fixtures';
import { transitionProjectLifecycle, listManagedProjectLifecycle } from '../src/lib/project-lifecycle';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { guardProjectResources, withProjectResources } from '../src/lib/project-resource-guard';
import { readOrdinaryDocument } from '../src/lib/ordinary-document-download';
import { confirmSelectiveAccess, previewSelectiveAccess, readSelectiveProject, readSelectiveDocument, revokeSelectiveAccess } from '../src/lib/selective-project-access';
import { canViewProject, canEditService, canEditTask, canViewCommercialOffer } from '../src/lib/access-control';
import { selectiveAuditAllowed } from '../src/lib/selective-project-policy';
import { selectiveProof } from '../src/lib/selective-project-proof';
import { canonicalSha256 } from '../src/lib/canonical-json';
import type { AuthSession } from '../src/lib/auth';
import type { ProjectLifecycleAction } from '../src/lib/project-lifecycle-policy';

const enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Awaited<ReturnType<typeof syntheticAuthority>>;
before(async () => { if (enabled) admin = await syntheticAuthority(db); });
after(async () => { await db.$disconnect(); });
async function fixture() { return syntheticSharingCase(db, admin); }
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function change(f: Fixture, action: ProjectLifecycleAction, session = admin.session) {
  const project = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  return transitionProjectLifecycle(db, session, { id: project.id, updatedAt: project.updatedAt.toISOString(), action, confirmed: 'yes' });
}
async function confirm(f: Fixture, revision = 0) {
  const preview = await previewSelectiveAccess(db, admin.session, { ...f.input, revision });
  return confirmSelectiveAccess(db, admin.session, preview.token, true);
}
const reader = (f: Fixture) => async (path: string) => {
  const file = [...f.documents, f.otherDocument].find(row => row.version.storagePath === path);
  assert.ok(file); return Buffer.from(file.bytes);
};
const ordinary = (f: Fixture, index = 0, session = admin.session) => readOrdinaryDocument(db, session, f.documents[index].doc.id,
  f.documents[index].version.id, { exists: async () => true, read: reader(f) });
async function snapshot(f: Fixture) {
  return Promise.all([
    db.document.findMany({ where: { projectId: f.project.id }, orderBy: { id: 'asc' } }),
    db.documentVersion.findMany({ where: { documentId: { in: f.documents.map(d => d.doc.id) } }, orderBy: { id: 'asc' } }),
    db.clientService.findMany({ where: { projectId: f.project.id }, orderBy: { id: 'asc' } }),
    db.technicalPractice.findMany({ where: { projectId: f.project.id }, orderBy: { id: 'asc' } }),
    db.task.findMany({ where: { projectId: f.project.id }, orderBy: { id: 'asc' } }),
    db.selectiveProjectGrant.findMany({ where: { projectId: f.project.id }, orderBy: { id: 'asc' } }),
    db.contract.findUniqueOrThrow({ where: { id: f.contract.id } }),
    db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }),
  ]);
}

test('archive, trash and restore preserve every linked row and version; restoration stays suspended', options, async () => {
  const f = await fixture();
  await db.project.update({ where: { id: f.project.id }, data: { status: 'in_analisi' } });
  await confirm(f);
  const before = await snapshot(f), original = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  await readSelectiveProject(db, f.reader.session, f.project.id);
  assert.equal((await change(f, 'archive')).state, 'archived');
  await assert.rejects(ordinary(f));
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  assert.equal((await change(f, 'trash')).state, 'trash');
  assert.equal((await change(f, 'restore')).state, 'archived');
  await assert.rejects(ordinary(f));
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[1].version.id, true, reader(f)));
  const restored = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  const stable = ({ status: _s, deletedAt: _d, updatedAt: _u, recordUpdateEpoch: _epoch, ...rest }: typeof original) => { void _s; void _d; void _u; void _epoch; return rest; };
  assert.deepEqual(stable(restored), stable(original));
  assert.equal(restored.recordUpdateEpoch, original.recordUpdateEpoch + 3);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await change(f, 'reactivate')).state, 'active');
  const reactivated = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  assert.equal(reactivated.status, 'idea');
  assert.equal(reactivated.recordUpdateEpoch, original.recordUpdateEpoch + 4);
  assert.deepEqual((await ordinary(f)).bytes, f.documents[0].bytes);
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  assert.deepEqual(await snapshot(f), before);
});

test('native audit stores the asserted state and concurrency version without project content', options, async () => {
  const f = await fixture();
  await change(f, 'trash');
  const project = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  const receipt = await db.auditLog.findFirstOrThrow({ where: { event: 'project_lifecycle_changed', entityId: project.id } });
  assert.equal(receipt.actorId, admin.user.id);
  assert.deepEqual(receipt.before, { status: 'idea', deletedAt: null });
  assert.deepEqual(receipt.after, { projectId: project.id, action: 'trash', status: 'idea', deletedAt: project.deletedAt!.toISOString(), stateVersion: project.updatedAt.toISOString() });
  assert.equal(JSON.stringify(receipt).includes(f.project.title), false);
  assert.equal(JSON.stringify(receipt).includes('NOTA_PRIVATA'), false);
});

test('audit failure rolls back state and leaves the former access usable', options, async () => {
  const f = await fixture(); await confirm(f);
  const before = await db.project.findUniqueOrThrow({ where: { id: f.project.id } }), related = await snapshot(f);
  await db.$executeRawUnsafe(`CREATE FUNCTION lifecycle_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event" = 'project_lifecycle_changed' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER lifecycle_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION lifecycle_test_audit_fault()');
  try { await assert.rejects(change(f, 'archive')); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER lifecycle_test_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION lifecycle_test_audit_fault()');
  }
  assert.deepEqual(await db.project.findUniqueOrThrow({ where: { id: f.project.id } }), before);
  assert.deepEqual(await snapshot(f), related);
  assert.equal(await db.auditLog.count({ where: { event: 'project_lifecycle_changed', entityId: f.project.id } }), 0);
  await readSelectiveProject(db, f.reader.session, f.project.id);
});

test('exact version and explicit consequence confirmation reject stale requests and replay; one concurrent winner', options, async () => {
  const f = await fixture(), input = { id: f.project.id, updatedAt: f.project.updatedAt.toISOString(), action: 'archive', confirmed: 'yes' };
  await assert.rejects(transitionProjectLifecycle(db, admin.session, { ...input, confirmed: 'no' }));
  await assert.rejects(transitionProjectLifecycle(db, admin.session, { ...input, permanent: true }));
  const results = await Promise.allSettled([admin.session, f.otherAdmin.session].map(s => transitionProjectLifecycle(db, s, input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(transitionProjectLifecycle(db, admin.session, input));
  assert.equal(await db.auditLog.count({ where: { event: 'project_lifecycle_changed', entityId: f.project.id } }), 1);
  await change(f, 'trash'); await change(f, 'restore'); await change(f, 'reactivate');
  await assert.rejects(transitionProjectLifecycle(db, admin.session, input));
});

test('management uses existing current rights; a selected recipient cannot exploit admin role or restore its own perimeter', options, async () => {
  const f = await fixture(); await confirm(f); await change(f, 'trash');
  const current = { ...admin.session, ...await loadSelectiveProjectScope(db, admin.user.id) };
  assert.ok(current.selectiveProjectIds?.includes(f.project.id));
  assert.ok((await listManagedProjectLifecycle(db, current, 'trash')).some(p => p.id === f.project.id));
  assert.equal((await listManagedProjectLifecycle(db, f.reader.session, 'trash')).some(p => p.id === f.project.id), false);
  await assert.rejects(change(f, 'restore', f.reader.session));
  const outsider = await syntheticPerson(db, 'Commerciale senza progetto', 'commerciale');
  await assert.rejects(change(f, 'restore', outsider.session));
  const consultant = await syntheticPerson(db, 'Consulente del progetto', 'consulente');
  await db.project.update({ where: { id: f.project.id }, data: { consultantId: consultant.user.id } });
  assert.ok((await listManagedProjectLifecycle(db, consultant.session, 'trash')).some(p => p.id === f.project.id));
  await db.userPermissionOverride.create({ data: { userId: consultant.user.id, permission: 'project.write', allowed: false } });
  await assert.rejects(change(f, 'restore', consultant.session));
  assert.equal((await change(f, 'restore', current)).state, 'archived');
});

test('indirect financial, service, task, offer, metadata and byte paths are excluded; other project remains operational', options, async () => {
  const f = await fixture(); await change(f, 'archive');
  const current = { ...admin.session, ...await loadSelectiveProjectScope(db, admin.user.id) };
  assert.equal(canViewProject(current, { ...f.project, client: f.client }), false);
  assert.equal(canEditService(current, { ...f.service, client: f.client, project: { ...f.project, client: f.client } }), false);
  assert.equal(canEditTask(current, { ...f.task, client: f.client, project: { ...f.project, client: f.client } }), false);
  assert.equal(canViewCommercialOffer(current, { ...f.offer, client: f.client, lead: f.lead }), false);
  for (const id of [f.project.id, f.service.id, f.contract.id, f.payment.id, f.offer.id, f.documents[0].version.id, f.messages[0].id, f.reply.id]) {
    assert.equal(selectiveAuditAllowed(current, { entityId: id }), false);
  }
  for (const resource of [{ projectId: f.project.id }, { clientServiceId: f.service.id }, { documentId: f.documents[2].doc.id }, { contractId: f.contract.id }, { commercialOfferId: f.offer.id }]) {
    let mutated = false;
    await assert.rejects(withProjectResources(db, admin.user.id, [resource], async () => { mutated = true; }));
    assert.equal(mutated, false);
  }
  assert.equal(canViewProject(current, { ...f.otherProject, client: f.client }), true);
  await db.$transaction(tx => guardProjectResources(tx, admin.user.id, [{ clientServiceId: f.otherService.id }]));
  const other = await readOrdinaryDocument(db, admin.session, f.otherDocument.doc.id, f.otherDocument.version.id, { exists: async () => true, read: reader(f) });
  assert.deepEqual(other.bytes, f.otherDocument.bytes);
});

test('restore preserves revoked and correctly signed expired grants byte for byte', options, async () => {
  for (const kind of ['revoked', 'expired']) {
    const f = await fixture(), grant = await confirm(f);
    if (kind === 'revoked') await revokeSelectiveAccess(db, admin.session, grant.id, grant.revision, true);
    else {
      const row = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } });
      const approvedAt = new Date(Date.now() - 120_000), expiresAt = new Date(Date.now() - 60_000);
      const selection = JSON.parse(JSON.stringify(row.selection)); selection.input.expiresAt = expiresAt.toISOString();
      const payload = JSON.parse(JSON.stringify({ id: row.id, projectId: row.projectId, recipientId: row.recipientId, revision: row.revision, selection,
        approvedById: row.approvedById, authorityRevision: row.authorityRevision, approvedAt, expiresAt, keyVersion: row.keyVersion }));
      const proof = selectiveProof({ version: row.keyVersion, secret: process.env.PRIVILEGED_STEP_UP_SECRET! }, 'grant', payload);
      await db.selectiveProjectGrant.update({ where: { id: row.id }, data: { approvedAt, expiresAt, selection, proof } });
      await db.auditLog.create({ data: { actorId: admin.user.id, entityType: 'SelectiveProjectGrant', entityId: row.id, event: 'selective_project_access_confirmed',
        after: { projectId: f.project.id, recipientId: f.reader.user.id, grantVersion: row.revision, grantHash: canonicalSha256(proof) } } });
    }
    const before = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } });
    await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
    for (const action of ['trash', 'restore', 'reactivate'] as const) await change(f, action);
    assert.deepEqual(await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } }), before);
    await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
    await assert.rejects(ordinary(f, 0, f.reader.session));
  }
});

test('old previews and old active grants do not survive a full cycle; new personal decision still excludes future versions', options, async () => {
  const f = await fixture(), oldPreview = await previewSelectiveAccess(db, admin.session, f.input);
  const grant = await confirmSelectiveAccess(db, admin.session, oldPreview.token, true);
  for (const action of ['archive', 'trash', 'restore', 'reactivate'] as const) await change(f, action);
  await assert.rejects(confirmSelectiveAccess(db, admin.session, oldPreview.token, true));
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  const bytes = Buffer.from('FUTURE_NOT_SELECTED'), future = await db.documentVersion.create({ data: { documentId: f.documents[0].doc.id, version: 2,
    storagePath: 'synthetic/lifecycle-future.txt', checksum: createHash('sha256').update(bytes).digest('hex') } });
  await confirm(f, grant.revision);
  const effective = await readSelectiveProject(db, f.reader.session, f.project.id);
  assert.deepEqual(effective.documents.map(d => d.versionId), f.documents.slice(0, 2).map(d => d.version.id));
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, future.id, false, async () => bytes));
});

test('an in-flight byte read finishes before archive; subsequent requests using the same session are denied', options, async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), resume = new Promise<void>(r => { release = r; });
  const read = readOrdinaryDocument(db, admin.session, f.documents[0].doc.id, f.documents[0].version.id, {
    exists: async () => true, read: async () => { entered(); await resume; return Buffer.from(f.documents[0].bytes); },
  });
  await ready;
  const outcome = Promise.allSettled([read, change(f, 'archive', f.otherAdmin.session)]);
  // Observe the actual database waiter; no fixed sleep is used as evidence.
  try {
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline && !blocked) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%Project%') AS blocked`;
      blocked = row.blocked;
      if (!blocked) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(blocked, true);
  } finally { release(); }
  const results = await outcome;
  assert.equal(results[0].status, 'fulfilled');
  if (results[1].status === 'rejected') {
    assert.match(String(results[1].reason), /concorrente|serialize|transaction|deadlock/i);
    await change(f, 'archive', f.otherAdmin.session);
  }
  await assert.rejects(ordinary(f));
  assert.equal(await db.auditLog.count({ where: { entityId: f.project.id, event: 'project_lifecycle_changed' } }), 1);
});

test('persisted session expiry while waiting for project lock cannot produce a lifecycle outcome', options, async () => {
  const f = await fixture(), person = f.otherAdmin;
  const expiry = new Date(Date.now() + 1500);
  await db.internalSession.update({ where: { id: person.session.sessionId! }, data: { expiresAt: expiry } });
  let release!: () => void, locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; }), resume = new Promise<void>(r => { release = r; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${f.project.id} FOR UPDATE`;
    locked(); await resume;
  }, { timeout: 10_000 });
  await ready;
  const operation = change(f, 'trash', person.session);
  const rejection = assert.rejects(operation);
  try {
    while (Date.now() <= expiry.getTime()) await new Promise(r => setTimeout(r, 20));
  } finally { release(); }
  await blocker; await rejection;
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).deletedAt, null);
  assert.equal(await db.auditLog.count({ where: { event: 'project_lifecycle_changed', entityId: f.project.id } }), 0);
  const forged: AuthSession = { ...person.session, sessionId: undefined };
  await assert.rejects(change(f, 'trash', forged));
});
