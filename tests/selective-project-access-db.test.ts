import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSharingCase, syntheticPerson } from './selective-sharing/fixtures';
import type { AuthSession } from '../src/lib/auth';
import { requireTechnicalPracticeEditAccess, requireTechnicalPracticeMutationAccess } from '../src/lib/write-access';
import { confirmSelectiveAccess, previewSelectiveAccess, readSelectiveDocument, readSelectiveProject, readPreviewSelectiveDocument, revokeSelectiveAccess } from '../src/lib/selective-project-access';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { canViewProject, canEditProject, canViewDocument, canEditService, canEditTask, canViewCommercialOffer, canEditCommercialOffer } from '../src/lib/access-control';
import { canViewPaymentListRecord } from '../src/lib/business-list-access';
import { declareContractSignature } from '../src/lib/contract-signature';
import { handoffPurchasedService } from '../src/lib/purchased-service-handoff';
import { acceptResponsibility, savePracticeResponsibility } from '../src/lib/responsibility';
import { selectiveProof } from '../src/lib/selective-project-proof';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { selectiveAuditAllowed } from '../src/lib/selective-project-policy';

const enabled = process.env.RUN_DB_TESTS === '1', db = new PrismaClient();
let admin: Awaited<ReturnType<typeof syntheticAuthority>>;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.INTERNAL_SESSION_MODE, 'registry');
  assert.ok((process.env.PRIVILEGED_STEP_UP_SECRET?.length ?? 0) >= 32);
  admin = await syntheticAuthority(db);
});
after(async () => { await db.$disconnect(); });
const options = { skip: !enabled };
async function fixture() { return syntheticSharingCase(db, admin); }
const readerFor = (f: Awaited<ReturnType<typeof fixture>>) => async (path: string) => {
  const item = f.documents.find(row => row.version.storagePath === path);
  assert.ok(item); return item.bytes;
};

test('real preview, effective projection and exact document bytes match; future data stays excluded', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  assert.equal(await db.selectiveProjectGrant.count({ where: { projectId: f.project.id } }), 0);
  assert.equal(preview.impact.previouslyFullProjectAccess, true);
  assert.deepEqual((await readPreviewSelectiveDocument(db, admin.session, preview.token, f.documents[0].version.id, readerFor(f))).bytes, f.documents[0].bytes);
  await assert.rejects(previewSelectiveAccess(db, admin.session, { ...f.input, documents: [{ versionId: f.documents[2].version.id, download: false }] }));
  await assert.rejects(readPreviewSelectiveDocument(db, admin.session, preview.token, f.documents[2].version.id, readerFor(f)));
  await confirmSelectiveAccess(db, admin.session, preview.token, true);
  const effective = await readSelectiveProject(db, f.reader.session, f.project.id);
  assert.deepEqual(effective, preview.projection);
  assert.deepEqual(effective.fields.map(row => row.key), ['title', 'totalInvestment']);
  assert.equal(JSON.stringify(effective).includes('ESCLUSA'), false);
  assert.deepEqual(effective.documents.map(row => row.versionId), f.documents.slice(0, 2).map(row => row.version.id));
  assert.deepEqual((await readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[0].version.id, false, readerFor(f))).bytes, f.documents[0].bytes);
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[0].version.id, true, readerFor(f)));
  assert.deepEqual((await readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[1].version.id, true, readerFor(f))).bytes, f.documents[1].bytes);
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[2].version.id, false, readerFor(f)));
  const futureBytes = Buffer.from('VERSIONE_FUTURA_ESCLUSA'), future = await db.documentVersion.create({ data: { documentId: f.documents[0].doc.id, version: 2, storagePath: 'synthetic/future.txt', checksum: createHash('sha256').update(futureBytes).digest('hex') } });
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, future.id, false, async () => futureBytes));
  assert.deepEqual(await readSelectiveProject(db, f.reader.session, f.project.id), effective);
  const financing = await db.corporateFinancingAssessment.create({ data: { clientId: f.client.id, clientServiceId: f.service.id, criticalIssues: 'PRIVATE_SYNTHETIC' } });
  const bankability = await db.bankabilityAssessment.create({ data: { clientId: f.client.id, projectId: f.project.id, riskRationale: 'PRIVATE_SYNTHETIC' } });
  const current = { ...f.reader.session, ...await loadSelectiveProjectScope(db, f.reader.user.id) };
  for (const entityId of [financing.id, bankability.id, future.id]) assert.equal(selectiveAuditAllowed(current, { entityId, after: { note: 'PRIVATE_SYNTHETIC' } }), false);
  assert.ok(current.selectiveContractIds?.includes(f.contract.id));
  assert.ok(current.selectiveOfferIds?.includes(f.offer.id));
  const boundOffer = { ...f.offer, lead: f.lead, client: f.client };
  assert.equal(canViewCommercialOffer(current, boundOffer), false);
  assert.equal(canEditCommercialOffer(current, boundOffer), false);
  assert.equal(selectiveAuditAllowed(current, { entityId: f.offer.id }), false);
  assert.equal(canViewPaymentListRecord(current, { payment: f.payment, contract: f.contract, client: f.client, project: null }), false);
  assert.equal(canEditService(current, { ...f.service, client: f.client, project: { ...f.project, client: f.client } }), false);
  assert.equal(canEditTask(current, { ...f.task, client: f.client, project: { ...f.project, client: f.client } }), false);
  await assert.rejects(declareContractSignature(db, f.reader.session, { contractId: f.contract.id, expectedVersion: f.contract.updatedAt.toISOString(),
    expectedDeclarationId: null, signedOn: '2026-10-01', source: 'Synthetic attempt', confirmed: true }));
  // The practice has no direct project binding: its service still puts it inside the perimeter.
  const indirect = await db.technicalPractice.create({ data: { clientId: f.client.id, projectId: null, clientServiceId: f.service.id,
    title: 'Pratica indiretta sintetica', practiceType: 'synthetic', targetEntity: 'synthetic', createdById: admin.user.id } });
  await assert.rejects(db.$transaction(tx => savePracticeResponsibility(tx, f.reader.session, { id: indirect.id,
    expectedEntryId: '', expectedUpdatedAt: indirect.updatedAt.toISOString(), commercialOwnerId: null, technicalOwnerId: null,
    departmentCode: null, reason: 'Synthetic attempt' }, true)), /SELECTIVE_PROJECT_READ_ONLY/);
  await assert.rejects(db.$transaction(tx => acceptResponsibility(tx, f.reader.session, { kind: 'TechnicalPractice', id: indirect.id,
    decisionId: 'synthetic', role: 'tecnico' })), /SELECTIVE_PROJECT_READ_ONLY/);
  assert.equal(canViewProject(current, { ...f.project, client: f.client }), false);
  assert.equal(canEditProject(current, { ...f.project, client: f.client }), false);
  assert.equal(canViewDocument(current, { ...f.documents[2].doc, client: f.client, project: { ...f.project, client: f.client } }), false);
  assert.equal(canViewProject(current, { ...f.otherProject, client: f.client }), true);
});
test('only personal authority, enforced admission and unchanged preview can confirm; replay has one winner', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  await assert.rejects(previewSelectiveAccess(db, f.otherAdmin.session, f.input));
  await assert.rejects(previewSelectiveAccess(db, admin.session, { ...f.input, recipientId: admin.user.id }));
  await assert.rejects(confirmSelectiveAccess(db, f.otherAdmin.session, preview.token, true));
  await assert.rejects(confirmSelectiveAccess(db, f.reader.session, preview.token, true));
  await assert.rejects(confirmSelectiveAccess(db, admin.session, preview.token, false));
  const envelope = JSON.parse(Buffer.from(preview.token, 'base64url').toString());
  envelope.payload.snapshot.input.fields.push('description');
  await assert.rejects(confirmSelectiveAccess(db, admin.session, Buffer.from(JSON.stringify(envelope)).toString('base64url'), true));
  await db.project.update({ where: { id: f.project.id }, data: { title: 'Changed after preview' } });
  await assert.rejects(confirmSelectiveAccess(db, admin.session, preview.token, true));
  const fresh = await previewSelectiveAccess(db, admin.session, f.input);
  const results = await Promise.allSettled([1, 2].map(() => confirmSelectiveAccess(db, admin.session, fresh.token, true)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.auditLog.count({ where: { event: 'selective_project_access_confirmed', after: { path: ['projectId'], equals: f.project.id } } }), 1);
});
test('atomic audit fault leaves no permission; forged stored grants are denied while the perimeter remains', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  await db.$executeRawUnsafe(`CREATE FUNCTION selective_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event" = 'selective_project_access_confirmed' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER selective_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION selective_test_audit_fault()');
  try { await assert.rejects(confirmSelectiveAccess(db, admin.session, preview.token, true)); }
  finally {
    await db.$executeRawUnsafe('DROP TRIGGER selective_test_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION selective_test_audit_fault()');
  }
  assert.equal(await db.selectiveProjectGrant.count({ where: { projectId: f.project.id } }), 0);
  const grant = await confirmSelectiveAccess(db, admin.session, preview.token, true);
  await db.selectiveProjectGrant.update({ where: { id: grant.id }, data: { proof: '0'.repeat(64) } });
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  assert.ok((await loadSelectiveProjectScope(db, f.reader.user.id)).selectiveProjectIds?.includes(f.project.id));
});
test('revocation and expiry deny old sessions and byte links, retaining the restrictive perimeter', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  const grant = await confirmSelectiveAccess(db, admin.session, preview.token, true);
  await revokeSelectiveAccess(db, admin.session, grant.id, grant.revision, true);
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  await assert.rejects(readSelectiveDocument(db, f.reader.session, f.project.id, f.documents[1].version.id, true, readerFor(f)));
  const renewed = await previewSelectiveAccess(db, admin.session, { ...f.input, revision: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await confirmSelectiveAccess(db, admin.session, renewed.token, true);
  await readSelectiveProject(db, f.reader.session, f.project.id);
  // A correctly signed expired receipt exercises the database-clock check without a timed sleep.
  const row = await db.selectiveProjectGrant.findUniqueOrThrow({ where: { id: grant.id } });
  const approvedAt = new Date(Date.now() - 120_000), expiresAt = new Date(Date.now() - 60_000);
  const selection = JSON.parse(JSON.stringify(row.selection)); selection.input.expiresAt = expiresAt.toISOString();
  const changed = { ...row, selection, approvedAt, expiresAt };
  const payload = JSON.parse(JSON.stringify({ id: changed.id, projectId: changed.projectId, recipientId: changed.recipientId, revision: changed.revision, selection,
    approvedById: changed.approvedById, authorityRevision: changed.authorityRevision, approvedAt, expiresAt, keyVersion: changed.keyVersion }));
  const proof = selectiveProof({ version: row.keyVersion, secret: process.env.PRIVILEGED_STEP_UP_SECRET! }, 'grant', payload);
  await db.selectiveProjectGrant.update({ where: { id: row.id }, data: { approvedAt, expiresAt, selection, proof } });
  await db.auditLog.create({ data: { actorId: admin.user.id, entityType: 'SelectiveProjectGrant', entityId: row.id, event: 'selective_project_access_confirmed',
    after: { projectId: f.project.id, recipientId: f.reader.user.id, grantVersion: row.revision, grantHash: canonicalSha256(proof) } } });
  await assert.rejects(readSelectiveProject(db, f.reader.session, f.project.id));
  assert.ok((await loadSelectiveProjectScope(db, f.reader.user.id)).selectiveProjectIds?.includes(f.project.id));
  await assert.rejects(db.selectiveProjectGrant.delete({ where: { id: row.id } }));
});

test('P1-01 fresh practice guards deny stale admin and assigned technician sessions, also after revocation', options, async () => {
  const f = await fixture(), technician = await syntheticPerson(db, 'Tecnico sintetico', 'consulente');
  await db.technicalPractice.update({ where: { id: f.technicalPractice.id }, data: { projectId: null, technicalOwnerId: technician.user.id } });
  for (const person of [f.reader, technician]) {
    await requireTechnicalPracticeEditAccess(person.session, f.technicalPractice.id, db);
    const preview = await previewSelectiveAccess(db, admin.session, { ...f.input, recipientId: person.user.id });
    const grant = await confirmSelectiveAccess(db, admin.session, preview.token, true);
    for (const revoked of [false, true]) {
      if (revoked) await revokeSelectiveAccess(db, admin.session, grant.id, grant.revision, true);
      const before = await db.technicalPractice.findUniqueOrThrow({ where: { id: f.technicalPractice.id } });
      const auditCount = await db.auditLog.count();
      await assert.rejects(requireTechnicalPracticeEditAccess(person.session, before.id, db), /Risorsa non disponibile/);
      await assert.rejects(db.$transaction(tx => requireTechnicalPracticeMutationAccess(person.session, before.id, tx)), /Risorsa non disponibile/);
      assert.deepEqual(await db.technicalPractice.findUniqueOrThrow({ where: { id: before.id } }), before);
      assert.equal(await db.auditLog.count(), auditCount);
    }
  }
});

test('P2-02 real PostgreSQL waits expire persisted and claimed sessions before any authorized outcome', options, async () => {
  const kinds = ['confirm', 'revoke', 'project', 'document', 'preview', 'preview-document'] as const;
  for (const source of ['persisted', 'claimed'] as const) for (const kind of kinds) {
    const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
    const needsGrant = ['revoke', 'project', 'document'].includes(kind);
    const grant = needsGrant ? await confirmSelectiveAccess(db, admin.session, preview.token, true) : null;
    const person = ['project', 'document'].includes(kind) ? f.reader : admin;
    const row = await db.internalSession.findUniqueOrThrow({ where: { id: person.session.sessionId! } });
    const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const expires = new Date(Math.ceil(clock.now.getTime() / 1000) * 1000 + 2000);
    if (source === 'persisted') await db.internalSession.update({ where: { id: row.id }, data: { expiresAt: expires } });
    const claimed: AuthSession = { ...person.session, expiresAt: source === 'claimed' ? expires.getTime() / 1000 : person.session.expiresAt };
    const before = await db.selectiveProjectGrant.findMany({ where: { projectId: f.project.id } }), audits = await db.auditLog.count();
    let release!: () => void, acquired!: (pid: number) => void;
    const lockReady = new Promise<number>(resolve => { acquired = resolve; });
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.$transaction(async tx => {
      const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (kind === 'revoke') await tx.$queryRaw`SELECT "id" FROM "SelectiveAccessAuthority" WHERE "id"='project-sharing' FOR UPDATE`;
      else await tx.$executeRaw`LOCK TABLE "Project" IN ACCESS EXCLUSIVE MODE`;
      acquired(pid.pid);
      await unlock;
    }, { timeout: 15_000 });
    try {
      const pid = await lockReady;
      const run = () => kind === 'confirm' ? confirmSelectiveAccess(db, claimed, preview.token, true)
        : kind === 'revoke' ? revokeSelectiveAccess(db, claimed, grant!.id, grant!.revision, true)
        : kind === 'project' ? readSelectiveProject(db, claimed, f.project.id)
        : kind === 'document' ? readSelectiveDocument(db, claimed, f.project.id, f.documents[1].version.id, true, readerFor(f))
        : kind === 'preview' ? previewSelectiveAccess(db, claimed, f.input)
        : readPreviewSelectiveDocument(db, claimed, preview.token, f.documents[0].version.id, readerFor(f));
      const result = run().then(value => ({ value, error: null }), error => ({ value: undefined, error }));
      let blocked = false;
      for (let attempt = 0; attempt < 80 && !blocked; attempt++) {
        const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = state.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.ok(blocked, `${source}/${kind}: real lock wait was not observed`);
      const [waiting] = await db.$queryRaw<Array<{ live: boolean }>>`SELECT clock_timestamp() < ${expires}::timestamptz AS live`;
      assert.ok(waiting.live, 'operation reached the lock with an unexpired session');
      await db.$executeRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${expires}::timestamptz - clock_timestamp()))) + 0.05)`;
      release(); await blocker;
      const outcome = await result;
      assert.equal(outcome.value, undefined, `${source}/${kind}: no projection or bytes may be returned`);
      assert.match(String(outcome.error), /SELECTIVE_ACCESS_DENIED/, `${source}/${kind}`);
      assert.deepEqual(await db.selectiveProjectGrant.findMany({ where: { projectId: f.project.id } }), before);
      assert.equal(await db.auditLog.count(), audits, 'expiry rolls back operational audit as well as permission changes');
    } finally {
      release(); await blocker;
      await db.internalSession.update({ where: { id: row.id }, data: { expiresAt: row.expiresAt } });
    }
  }
});

test('P2-03 canonical M4 message and reply audits are excluded while unrelated audits remain', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  const grant = await confirmSelectiveAccess(db, admin.session, preview.token, true);
  for (const revoked of [false, true]) {
    if (revoked) await revokeSelectiveAccess(db, admin.session, grant.id, grant.revision, true);
    const scope = await loadSelectiveProjectScope(db, f.reader.user.id);
    for (const id of [f.messages[0].id, f.reply.id]) {
      const events = await db.auditLog.findMany({ where: { entityId: id } });
      assert.ok(events.length);
      assert.ok(events.every(event => !JSON.stringify(event.after).includes(f.project.id)));
      assert.ok(events.every(event => !selectiveAuditAllowed(scope, event)));
    }
    const unrelated = await db.auditLog.findMany({ where: { entityId: f.messages[1].id } });
    assert.ok(unrelated.length); assert.ok(unrelated.every(event => selectiveAuditAllowed(scope, event)));
  }
});

test('P2-04 shared contract stays private without restricting another project service, document or task', options, async () => {
  const f = await fixture(), preview = await previewSelectiveAccess(db, admin.session, f.input);
  const grant = await confirmSelectiveAccess(db, admin.session, preview.token, true);
  for (const revoked of [false, true]) {
    if (revoked) await revokeSelectiveAccess(db, admin.session, grant.id, grant.revision, true);
    const current = { ...f.reader.session, ...await loadSelectiveProjectScope(db, f.reader.user.id) };
    assert.deepEqual(current.selectiveServiceIds, [f.service.id]);
    assert.ok(current.selectiveContractIds?.includes(f.contract.id));
    assert.equal(canViewPaymentListRecord(current, { payment: f.payment, contract: f.contract, client: f.client, project: null }), false);
    const project = { ...f.otherProject, client: f.client }, clientService = { ...f.otherService, client: f.client, project };
    assert.equal(canEditService(current, clientService), true);
    assert.equal(canEditTask(current, { ...f.otherTask, client: f.client, project, clientService }), true);
    assert.equal(canViewDocument(current, { ...f.otherDocument.doc, client: f.client, project, clientService }), true);
    assert.equal(canViewDocument(current, { ...f.documents[2].doc, client: f.client, project: { ...f.project, client: f.client } }), false);
    const audits = await db.auditLog.count();
    await assert.rejects(db.$transaction(tx => handoffPurchasedService(tx, f.reader.session, { serviceId: f.otherService.id,
      expectedHash: '0'.repeat(64), technicalOwnerId: f.otherAdmin.user.id, departmentCode: 'SYNTHETIC', variantCode: 'SYNTHETIC',
      dueDate: new Date().toISOString(), activities: ['Synthetic activity'], confirmed: true, reason: 'Synthetic stale handoff' }, true)),
    /Dati contrattuali non disponibili/);
    assert.equal(await db.auditLog.count(), audits);
  }
});
