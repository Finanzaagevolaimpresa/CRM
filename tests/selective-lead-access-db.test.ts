import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test, { before, after } from 'node:test';
import { PrismaClient, Prisma } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson } from './selective-sharing/fixtures';
import { selectiveLeadFixture, grantLead, leadProof, type Person } from './selective-leads/fixtures';
import { previewLeadSharing, confirmLeadSharing, revokeLeadSharing, readLeadSharing, readLeadSharingReceipt, leadSharingManagement } from '../src/lib/selective-lead-access';
import { loadSelectiveProjectScope } from '../src/lib/selective-project-scope';
import { leadVisibilityWhere } from '../src/lib/core-query-policy';
import { canViewLead, canEditLead, canViewCommercialOffer } from '../src/lib/access-control';
import { lockLeadForMutation } from '../src/lib/lead-lifecycle-lock';
import { transitionLeadLifecycle } from '../src/lib/lead-lifecycle';
import { recordCommercialLeadFirstResponse } from '../src/lib/commercial-lead-inbox';
import { confirmLeadResponsibility } from '../src/lib/responsibility';
import { saveApprovedMessageDraft } from '../src/lib/approved-communications';
import { currentRecordUpdateUser, recordUpdateContext } from '../src/lib/record-update-context';
import { withSerializableTransaction } from '../src/lib/serializable';
import { readinessLeadFixture } from './lead-lifecycle/fixtures';
import { canViewPracticeReadinessWork } from '../src/lib/practice-readiness-access';
import { hasStrongRawLeadIdentityDuplicate } from '../src/lib/lead-identity';
import { lockInternalUser, lockAuthoritativeInternalSession } from '../src/lib/internal-session-registry';
import { listRecordUpdates } from '../src/lib/record-update-delivery';
import { readLeadAcquisitions } from '../src/lib/lead-acquisition';

const enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
const fixture = () => selectiveLeadFixture(db, admin);
async function scope(person: Person) { return { ...person.session, ...await loadSelectiveProjectScope(db, person.user.id) }; }
async function deniedOrdinary(f: Awaited<ReturnType<typeof fixture>>) {
  const actor = await scope(f.reader);
  assert.equal(canViewLead(actor, f.lead), false); assert.equal(canEditLead(actor, f.lead), false);
  assert.equal(canViewCommercialOffer(actor, { ...f.offer, lead: f.lead }), false);
  assert.equal(await db.lead.count({ where: { AND: [{ id: f.lead.id }, leadVisibilityWhere(f.reader.session)] } }), 0, 'live relation denies even a stale page session');
  assert.equal(await db.lead.count({ where: { AND: [{ id: f.other.id }, leadVisibilityWhere(actor)] } }), 1);
  await assert.rejects(withSerializableTransaction(db, tx => lockLeadForMutation(tx, f.reader.session, f.lead.id, f.lead.updatedAt.toISOString())));
}
async function revoke(f: Awaited<ReturnType<typeof fixture>>, grantId: string, revision = 1) {
  return revokeLeadSharing(db, admin.session, { grantId, revision, commandId: randomUUID() }, leadProof(admin));
}

test('project authority does not enroll lead authority; read preview cannot bootstrap it', options, async () => {
  const f = await fixture();
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  await assert.rejects(previewLeadSharing(db, admin.session, f.input));
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  const sql = readFileSync('ops/selective-lead-authority-enrollment.sql', 'utf8');
  const auditId = randomUUID(), target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.searchParams.get('schema') ?? 'public', 'public');
  target.searchParams.delete('schema'); // Prisma-only parameter is not a libpq connection option.
  const binding = { database: target.pathname.slice(1), userId: admin.user.id, name: admin.user.name,
    email: admin.user.email, approvalSha256: 'a'.repeat(64), auditId };
  const enroll = (value: unknown, body = sql) => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', target.toString()], {
    input: `SELECT set_config('fai.selective_lead_binding','${JSON.stringify(value).replaceAll("'", "''")}',false);\n${body}`,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000,
  });
  for (const value of [null, [], { ...binding, approvalSha256: null }, { ...binding, auditId: null }, { ...binding, name: '' }, { ...binding, userId: 1 }]) {
    assert.throws(() => enroll(value), /SELECTIVE_LEAD_ENROLLMENT_BINDING_INVALID/);
  }
  assert.throws(() => enroll({ ...binding, email: 'wrong@invalid.test' }), /SELECTIVE_LEAD_ENROLLMENT_PROFILE_DENIED/);
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  // Fail after both insertions but before COMMIT: neither binding nor audit may persist.
  assert.throws(() => enroll(binding, sql.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ROLLBACK'; END $$; COMMIT;")), /SYNTHETIC_ROLLBACK/);
  assert.equal(await db.selectiveLeadAuthority.count(), 0);
  assert.equal(await db.auditLog.count({ where: { id: auditId } }), 0);
  assert.match(enroll(binding).toString(), /SELECTIVE_LEAD_ENROLLMENT_COMMITTED/);
  assert.deepEqual(await db.selectiveLeadAuthority.findUnique({ where: { id: 'lead-sharing' } }),
    { id: 'lead-sharing', userId: admin.user.id, revision: 1, enabled: true });
  assert.equal(await db.auditLog.count({ where: { id: auditId, event: 'selective_lead_authority_enrolled', actorId: admin.user.id } }), 1);
  assert.throws(() => enroll(binding), /SELECTIVE_LEAD_ENROLLMENT_ALREADY_STARTED/);
  assert.equal(await db.selectiveLeadGrant.count(), 0);
});
test('preview is read-only, actual recipient impact is explicit, persisted projection has only two fields', options, async () => {
  const f = await fixture(), counts = await Promise.all([db.selectiveLeadGrant.count(), db.auditLog.count()]);
  const preview = await previewLeadSharing(db, admin.session, f.input);
  assert.equal(preview.replacesFullAccess, true);
  assert.deepEqual(preview.fields.map(row => row.key), ['companyName', 'status']);
  assert.deepEqual(await Promise.all([db.selectiveLeadGrant.count(), db.auditLog.count()]), counts);
  await confirmLeadSharing(db, admin.session, f.input, preview.token, leadProof(admin));
  const view = await readLeadSharing(db, f.reader.session, f.lead.id);
  assert.deepEqual(view.fields, preview.fields);
  assert.ok(!JSON.stringify(view).includes(f.lead.notes!)); assert.ok(!JSON.stringify(view).includes(f.lead.email!));
  await deniedOrdinary(f);
  const a = await db.auditLog.findFirstOrThrow({ where: { event: 'selective_lead_changed', actorId: admin.user.id, entityId: (await db.selectiveLeadRevision.findFirstOrThrow({ where: { grant: { leadId: f.lead.id } } })).id } });
  assert.deepEqual(a.before, { version: 0 }); assert.deepEqual(a.after, { version: 1, action: 'GRANT', fieldCount: 2 });
  assert.ok(!JSON.stringify(a).includes(f.reader.user.email));
});
test('other Admin, self, forged session and missing personal step-up cannot grant', options, async () => {
  const f = await fixture(), otherAdmin = await syntheticPerson(db, 'Admin senza binding');
  await assert.rejects(previewLeadSharing(db, otherAdmin.session, f.input));
  await assert.rejects(previewLeadSharing(db, admin.session, { ...f.input, recipientId: admin.user.id }));
  const p = await previewLeadSharing(db, admin.session, f.input);
  await assert.rejects(confirmLeadSharing(db, admin.session, f.input, p.token, { ...leadProof(admin), stepUpToken: 'forged' }));
  await assert.rejects(confirmLeadSharing(db, admin.session, f.input, p.token, { ...leadProof(admin), sessionToken: otherAdmin.token }));
  await assert.rejects(confirmLeadSharing(db, { ...admin.session, sessionId: otherAdmin.session.sessionId }, f.input, p.token, leadProof(admin)));
  assert.equal(await db.selectiveLeadGrant.count({ where: { leadId: f.lead.id } }), 0);
});

test('project access does not reopen selected lead readiness, revision audit or identity matches', options, async () => {
  const f = await fixture();
  const project = await db.project.create({ data: { clientId: f.client.id, title: 'Synthetic independent project' } });
  const work = await readinessLeadFixture(db, f.reader.user.id, { clientId: f.client.id, projectId: project.id });
  await db.lead.update({ where: { id: work.lead.id }, data: { email: 'SELECTED_' + randomUUID() + '@invalid.test' } });
  const row = await db.lead.findUniqueOrThrow({ where: { id: work.lead.id } });
  const context = { lead: row, client: f.client, project: { ...project, client: f.client }, projectId: project.id };
  assert.equal(canViewPracticeReadinessWork(f.reader.session, context), true);
  await grantLead(db, admin, { ...f.input, leadId: row.id, commandId: randomUUID() });
  const current = await scope(f.reader);
  assert.equal(canViewPracticeReadinessWork(current, context), false);
  for (const id of [work.intake.id, work.revision.id, work.practice.id]) assert.ok(current.selectiveAuditEntityIds?.includes(id));
  assert.ok(current.selectiveLeadIntakeIds?.includes(work.intake.id));
  assert.ok(!current.selectiveLeadIntakeIds?.includes(row.id));
  assert.equal(await db.controlledIntake.count({ where: { id: { notIn: [...(current.selectiveLeadIntakeIds ?? [])] }, leadId: row.id } }), 0);
  await readLeadAcquisitions(db, f.reader.session, {});
  assert.equal(await hasStrongRawLeadIdentityDuplicate(db, { email: row.email, phone: null, selectedForRecipientId: f.reader.user.id }), true);
  assert.equal(await hasStrongRawLeadIdentityDuplicate(db, { email: row.email, phone: null, selectedForRecipientId: admin.user.id }), false);
});
test('unselected fields and stale content/recipient/expiry changes invalidate preview', options, async () => {
  const f = await fixture(), p = await previewLeadSharing(db, admin.session, f.input);
  await assert.rejects(confirmLeadSharing(db, admin.session, { ...f.input, fields: ['companyName', 'email'] }, p.token, leadProof(admin)));
  await assert.rejects(confirmLeadSharing(db, admin.session, { ...f.input, expiresAt: new Date(Date.now() + 10000).toISOString() }, p.token, leadProof(admin)));
  await db.lead.update({ where: { id: f.lead.id }, data: { notes: 'Changed after preview' } });
  await assert.rejects(confirmLeadSharing(db, admin.session, f.input, p.token, leadProof(admin)));
  const p2 = await previewLeadSharing(db, admin.session, f.input);
  await db.user.update({ where: { id: f.reader.user.id }, data: { name: 'Changed recipient' } });
  await assert.rejects(confirmLeadSharing(db, admin.session, f.input, p2.token, leadProof(admin)));
  assert.equal(await db.selectiveLeadCommand.count({ where: { id: f.input.commandId } }), 0);
});
test('lost response retry returns same receipt once; changed request cannot consume command again', options, async () => {
  const f = await fixture(), { preview, receipt } = await grantLead(db, admin, f.input);
  assert.deepEqual(await confirmLeadSharing(db, admin.session, f.input, preview.token, leadProof(admin)), receipt);
  assert.deepEqual(await readLeadSharingReceipt(db, admin.session, f.input.commandId), receipt);
  await assert.rejects(confirmLeadSharing(db, admin.session, { ...f.input, fields: ['email'] }, preview.token, leadProof(admin)));
  assert.equal(await db.selectiveLeadRevision.count({ where: { grantId: receipt.grantId } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: receipt.revisionId } }), 1);
});
test('two simultaneous commands for one version have one winner without automatic retry', options, async () => {
  const f = await fixture(), other = { ...f.input, commandId: randomUUID(), fields: ['status'] };
  const p = await previewLeadSharing(db, admin.session, f.input), q = await previewLeadSharing(db, admin.session, other);
  const results = await Promise.allSettled([confirmLeadSharing(db, admin.session, f.input, p.token, leadProof(admin)), confirmLeadSharing(db, admin.session, other, q.token, leadProof(admin))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.selectiveLeadCommand.count({ where: { leadId: f.lead.id } }), 1);
  assert.equal(await db.selectiveLeadRevision.count({ where: { grant: { leadId: f.lead.id } } }), 1);
});
test('native audit failure rolls back grant, command, history and notification generation', options, async () => {
  const f = await fixture(), p = await previewLeadSharing(db, admin.session, f.input);
  const before = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  await db.$executeRawUnsafe(`CREATE FUNCTION synthetic_selective_lead_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='selective_lead_changed' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER synthetic_selective_lead_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION synthetic_selective_lead_fault()');
  try { await assert.rejects(confirmLeadSharing(db, admin.session, f.input, p.token, leadProof(admin))); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER synthetic_selective_lead_fault ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION synthetic_selective_lead_fault()'); }
  assert.equal(await db.selectiveLeadGrant.count({ where: { leadId: f.lead.id } }), 0);
  assert.equal(await db.selectiveLeadCommand.count({ where: { id: f.input.commandId } }), 0);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } }), before);
});
test('revocation is atomic, history retained and ordinary Admin access never silently returns', options, async () => {
  const f = await fixture(), { receipt } = await grantLead(db, admin, f.input);
  const input = { grantId: receipt.grantId, revision: 1, commandId: randomUUID() };
  const r = await revokeLeadSharing(db, admin.session, input, leadProof(admin));
  assert.equal(r.revision, 2);
  assert.deepEqual(await revokeLeadSharing(db, admin.session, input, leadProof(admin)), r);
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id)); await deniedOrdinary(f);
  assert.equal(await db.selectiveLeadRevision.count({ where: { grantId: receipt.grantId } }), 2);
  await assert.rejects(db.selectiveLeadGrant.delete({ where: { id: receipt.grantId } }));
  await assert.rejects(db.selectiveLeadRevision.delete({ where: { id: receipt.revisionId } }));
  await assert.rejects(db.selectiveLeadCommand.update({ where: { id: f.input.commandId }, data: { requestDigest: 'a'.repeat(64) } }));
});
test('replacement requires exact current revision and does not restore revoked selection', options, async () => {
  const f = await fixture(), { receipt } = await grantLead(db, admin, f.input); await revoke(f, receipt.grantId);
  await assert.rejects(previewLeadSharing(db, admin.session, f.input));
  await grantLead(db, admin, { ...f.input, revision: 2, commandId: randomUUID(), fields: ['email'] });
  assert.deepEqual((await readLeadSharing(db, f.reader.session, f.lead.id)).fields.map(row => row.key), ['email']);
  await deniedOrdinary(f);
});
test('expiry denies current projection and never restores legacy access', options, async () => {
  const f = await fixture();
  await grantLead(db, admin, { ...f.input, expiresAt: new Date(Date.now() + 3000).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 3100));
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id)); await deniedOrdinary(f);
});
test('role change and reversal invalidate older grant permanently', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  for (const role of ['commerciale', 'admin'] as const) await db.user.update({ where: { id: f.reader.user.id }, data: { role } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id)); await deniedOrdinary(f);
});
test('permission revocation and removal do not renew old grant', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  const permission = await db.userPermissionOverride.create({ data: { userId: f.reader.user.id, permission: 'lead.read', allowed: false } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id));
  await db.userPermissionOverride.delete({ where: { id: permission.id } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id)); await deniedOrdinary(f);
});
test('trash/restore and ownership changes do not renew a selection or expose linked client documents', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  for (const action of ['trash', 'restore'] as const) {
    const row = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    await transitionLeadLifecycle(db, admin.session, { id: row.id, action, updatedAt: row.updatedAt.toISOString(), confirmed: 'yes', reasonCode: 'DUPLICATE' }, leadProof(admin));
    await assert.rejects(readLeadSharing(db, f.reader.session, row.id));
  }
  await deniedOrdinary(f);
  assert.deepEqual(await db.document.findUniqueOrThrow({ where: { id: f.doc.id } }), f.doc);
  const g = await fixture();
  // Use the ordinary lead without an N14 inbox: N14 correctly rejects direct
  // owner writes, and that protection is independent of this epoch test.
  await grantLead(db, admin, { ...g.input, leadId: g.other.id });
  await db.lead.update({ where: { id: g.other.id }, data: { assignedToId: admin.user.id } });
  await db.lead.update({ where: { id: g.other.id }, data: { assignedToId: g.reader.user.id } });
  await assert.rejects(readLeadSharing(db, g.reader.session, g.other.id));
});
test('a different selection invalidates notification admissions but preserves unrelated lead grants', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  const before = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  const second = await grantLead(db, admin, { ...f.input, leadId: f.other.id, commandId: randomUUID() });
  await revokeLeadSharing(db, admin.session, { grantId: second.receipt.grantId, revision: 1, commandId: randomUUID() }, leadProof(admin));
  const after = await db.user.findUniqueOrThrow({ where: { id: f.reader.user.id } });
  assert.ok(after.recordUpdateEpoch > before.recordUpdateEpoch); assert.equal(after.selectiveLeadEpoch, before.selectiveLeadEpoch);
  assert.equal((await readLeadSharing(db, f.reader.session, f.lead.id)).fields.length, 2);
});
test('direct N14, assignment, conversion/update lock and email draft are denied on old session', options, async () => {
  const f = await fixture();
  const box = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  // An independently enrolled synthetic email principal is needed for the
  // positive control; a generic Admin role cannot write a lead email draft.
  await db.ordinaryEmailAuthority.create({ data: { id: 'ordinary-email', userId: f.reader.user.id, mailboxId: box.id, enabled: true } });
  const draft = { messageId: randomUUID(), expectedRevision: 0, context: { kind: 'LEAD', id: f.lead.id }, mailboxId: box.id,
    replyTo: box.address, to: ['synthetic@invalid.test'], cc: [], bcc: [], subject: 'Synthetic draft', body: 'Synthetic only', attachmentVersionIds: [], classification: 'ORDINARY' };
  await saveApprovedMessageDraft(db, f.reader.session, draft);
  await grantLead(db, admin, f.input);
  const prior = process.env.COMMERCIAL_LEAD_INBOX_MODE; process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  try { await assert.rejects(recordCommercialLeadFirstResponse(db, { leadId: f.lead.id, actor: { userId: f.reader.user.id, sessionId: f.reader.session.sessionId! }, expectedInboxVersion: f.item!.version })); }
  finally { if (prior === undefined) delete process.env.COMMERCIAL_LEAD_INBOX_MODE; else process.env.COMMERCIAL_LEAD_INBOX_MODE = prior; }
  await assert.rejects(db.$transaction(tx => confirmLeadResponsibility(tx, { userId: f.reader.user.id, sessionId: f.reader.session.sessionId }, { id: f.lead.id, expectedUpdatedAt: f.lead.updatedAt.toISOString(), expectedEntryId: '', reason: 'synthetic' }, true)));
  await assert.rejects(saveApprovedMessageDraft(db, f.reader.session, { ...draft, messageId: randomUUID() }));
  await assert.rejects(saveApprovedMessageDraft(db, f.reader.session, { ...draft, expectedRevision: 1 }));
  await deniedOrdinary(f);
  assert.deepEqual(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: f.cycle!.id } }), f.cycle);
});
test('notification context re-reads current scope instead of trusting previous recipients', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  await db.$transaction(async tx => {
    const actor = await currentRecordUpdateUser(tx, f.reader.user.id), context = await recordUpdateContext(tx, 'LEAD', f.lead.id);
    assert.ok(actor); assert.equal(context.canRead(actor), false);
  });
});
test('recipient registry revocation blocks shared read and authority session revocation blocks pending confirmation', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id));
  const g = await fixture(), p = await previewLeadSharing(db, admin.session, g.input);
  // The revoked claimed session is a separate synthetic session for the bound person.
  const { syntheticSession } = await import('./selective-sharing/fixtures');
  const spare = { ...admin, ...await syntheticSession(db, admin.user) };
  const q = await previewLeadSharing(db, spare.session, g.input);
  await db.internalSession.update({ where: { id: spare.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(confirmLeadSharing(db, spare.session, g.input, q.token, leadProof(spare)));
  assert.ok(p.token.length > 0); assert.equal(await db.selectiveLeadGrant.count({ where: { leadId: g.lead.id } }), 0);
});
test('a committed concurrent lead change makes old preview stale', options, async () => {
  const f = await fixture(), p = await previewLeadSharing(db, admin.session, f.input);
  let release!: () => void, ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${f.lead.id} FOR UPDATE`; ready(); await gate;
    await tx.lead.update({ where: { id: f.lead.id }, data: { nextActionNote: 'Concurrent canonical update' } });
  });
  await readyPromise;
  const pending = confirmLeadSharing(db, admin.session, f.input, p.token, leadProof(admin));
  await new Promise(resolve => setTimeout(resolve, 100)); release(); await writer;
  await assert.rejects(pending); assert.equal(await db.selectiveLeadGrant.count({ where: { leadId: f.lead.id } }), 0);
});
test('step-up expiration while waiting on lead lock aborts the whole transaction', options, async () => {
  const f = await fixture(), p = await previewLeadSharing(db, admin.session, f.input);
  let release!: () => void, ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${f.lead.id} FOR UPDATE`; ready(); await gate; });
  await readyPromise;
  const pending = confirmLeadSharing(db, admin.session, f.input, p.token, leadProof(admin, Math.floor(Date.now() / 1000) - 299));
  const result = Promise.allSettled([pending]);
  await new Promise(resolve => setTimeout(resolve, 1600)); release(); await blocker;
  assert.equal((await result)[0].status, 'rejected'); assert.equal(await db.selectiveLeadGrant.count({ where: { leadId: f.lead.id } }), 0);
});
test('database rejects an otherwise signed-looking grant without atomic command/history/audit', options, async () => {
  const f = await fixture(), id = randomUUID();
  const payload = { id, revision: 1, selection: f.input };
  await assert.rejects(db.selectiveLeadGrant.create({ data: { id, leadId: f.lead.id, recipientId: f.reader.user.id, revision: 1, payload: payload as Prisma.InputJsonValue, proof: 'a'.repeat(64) } }));
  assert.equal(await db.selectiveLeadGrant.count({ where: { id } }), 0);
});
test('session admission and a caller holding User serialize without inverted row-lock deadlock', options, async () => {
  const person = await syntheticPerson(db, 'Synthetic concurrent session admission');
  let ready!: () => void, release!: () => void, backend!: (pid: number) => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pidReady = new Promise<number>(resolve => { backend = resolve; });
  const input = { userId: person.user.id, sessionId: person.session.sessionId! };
  const holder = db.$transaction(async tx => {
    await lockInternalUser(tx, person.user.id); ready(); await gate;
    assert.equal((await lockAuthoritativeInternalSession(tx, input))?.id, input.sessionId);
  }, { timeout: 15_000 });
  await held;
  const reader = db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    backend(row.pid);
    assert.equal((await lockAuthoritativeInternalSession(tx, input))?.id, input.sessionId);
  }, { timeout: 15_000 });
  const results = Promise.allSettled([holder, reader]);
  let waiting = false;
  try {
    const pid = await pidReady;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=${pid}`;
      if (row?.blocked) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  const completed = await results;
  assert.equal(waiting, true, 'second admission must be observed waiting on the first transaction');
  for (const result of completed) {
    if (result.status === 'rejected') throw result.reason;
  }
});
test('notification read after a confirmed rollback revalidates a newly revoked session', options, async () => {
  const f = await fixture(); let attempts = 0;
  const before = await db.recordUpdateDelivery.count();
  const intercepted = { $transaction: async (read: (tx: Prisma.TransactionClient) => Promise<unknown>, config: object) => {
    const attempt = ++attempts;
    try {
      return await db.$transaction(async tx => {
        const result = await read(tx);
        if (attempt === 1) await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40P01', MESSAGE='SYNTHETIC_NOTIFICATION_ABORT'; END $$`;
        return result;
      }, config);
    } catch (error) {
      if (attempt === 1) {
        assert.ok(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '40P01');
        await db.internalSession.update({ where: { id: f.reader.session.sessionId! }, data: { revokedAt: new Date() } });
      }
      throw error;
    }
  } } as unknown as PrismaClient;
  await assert.rejects(listRecordUpdates(intercepted, f.reader.session), error => (error as { code?: string }).code === 'DENIED');
  assert.equal(attempts, 2); assert.equal(await db.recordUpdateDelivery.count(), before);
});

test('personal authority suspension fails closed for management and open recipient sessions', options, async () => {
  const f = await fixture(); await grantLead(db, admin, f.input);
  const binding = await db.selectiveLeadAuthority.findUniqueOrThrow({ where: { id: 'lead-sharing' } });
  await db.selectiveLeadAuthority.update({ where: { id: binding.id }, data: { enabled: false, revision: binding.revision + 1 } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id));
  await assert.rejects(leadSharingManagement(db, admin.session, f.lead.id));
  await db.selectiveLeadAuthority.update({ where: { id: binding.id }, data: { enabled: true, revision: binding.revision + 2 } });
  await assert.rejects(readLeadSharing(db, f.reader.session, f.lead.id)); await deniedOrdinary(f);
});
