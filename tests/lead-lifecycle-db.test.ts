import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { leadFixture } from './lead-lifecycle/fixtures';
import { transitionLeadLifecycle, listTrashedLeads } from '../src/lib/lead-lifecycle';
import { lockLeadForMutation, assertLeadOperational } from '../src/lib/lead-lifecycle-lock';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { withSerializableTransaction } from '../src/lib/serializable';
import { recordCommercialLeadFirstResponse } from '../src/lib/commercial-lead-inbox';
import { CommercialLeadInboxError } from '../src/lib/commercial-lead-inbox-contract';
import { canViewLead, canEditLead, canViewCommercialOffer, canViewClient } from '../src/lib/access-control';
import { canViewPracticeReadinessWork } from '../src/lib/practice-readiness-access';
import { guardProjectResources } from '../src/lib/project-resource-guard';
import { discoverLeadIdentityCandidates, digestLeadIdentitySignals, hasStrongRawLeadIdentityDuplicate } from '../src/lib/lead-identity';

const enabled = process.env.RUN_DB_TESTS === '1', options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
let admin: Awaited<ReturnType<typeof syntheticPerson>>;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
const fixture = () => leadFixture(db, admin.user.id);
function proof(person = admin, nowSeconds?: number) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id, sessionToken: person.token, nowSeconds }) };
}
async function input(id: string, action: 'trash' | 'restore') {
  const lead = await db.lead.findUniqueOrThrow({ where: { id } });
  return { id, updatedAt: lead.updatedAt.toISOString(), action, confirmed: 'yes', reasonCode: 'DUPLICATE' };
}
async function change(id: string, action: 'trash' | 'restore', person = admin) {
  return transitionLeadLifecycle(db, person.session, await input(id, action), proof(person));
}
test('trash and restore preserve linked client, offers, documents, versions, status, ownership and original SLA', options, async () => {
  const f = await fixture(), before = f.lead;
  await change(before.id, 'trash');
  assert.equal((await listTrashedLeads(db, admin.session, 1)).items.some(row => row.id === before.id), true);
  await change(before.id, 'restore');
  const after = await db.lead.findUniqueOrThrow({ where: { id: before.id } });
  const stable = ({ deletedAt: _d, updatedAt: _u, ...r }: typeof before) => { void _d; void _u; return r; };
  assert.deepEqual(stable(after), stable(before)); assert.equal(after.deletedAt, null);
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: f.client.id } }), f.client);
  assert.deepEqual(await db.commercialOffer.findUniqueOrThrow({ where: { id: f.offer.id } }), f.offer);
  assert.deepEqual(await db.document.findUniqueOrThrow({ where: { id: f.doc.id } }), f.doc);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({ where: { id: f.version.id } }), f.version);
  assert.deepEqual(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: f.cycle!.id } }), f.cycle);
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item!.id } });
  assert.deepEqual({ ...item, version: f.item!.version }, f.item);
  assert.equal(item.version, f.item!.version + 2);
  const previousMode = process.env.COMMERCIAL_LEAD_INBOX_MODE;
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  try {
    await assert.rejects(recordCommercialLeadFirstResponse(db, { leadId: before.id,
      actor: { userId: admin.user.id, sessionId: admin.session.sessionId! }, expectedInboxVersion: f.item!.version }),
    (error: unknown) => error instanceof CommercialLeadInboxError && error.code === 'N14_VERSION_CONFLICT');
  } finally {
    if (previousMode === undefined) delete process.env.COMMERCIAL_LEAD_INBOX_MODE;
    else process.env.COMMERCIAL_LEAD_INBOX_MODE = previousMode;
  }
  assert.deepEqual(await db.commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: f.cycle!.id } }), f.cycle);
});
test('native minimized audit keeps actor, exact state/version and reason, without lead content', options, async () => {
  const f = await fixture(); await change(f.lead.id, 'trash');
  const lead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  const audit = await db.auditLog.findFirstOrThrow({ where: { event: 'lead_lifecycle_changed', entityId: lead.id } });
  assert.equal(audit.actorId, admin.user.id);
  assert.deepEqual(audit.after, { leadId: lead.id, action: 'trash', status: lead.status, deletedAt: lead.deletedAt!.toISOString(),
    stateVersion: lead.updatedAt.toISOString(), reasonCode: 'DUPLICATE' });
  assert.ok(!JSON.stringify(audit).includes(f.lead.email!)); assert.ok(!JSON.stringify(audit).includes(f.lead.notes!));
});
test('audit failure rolls back both lifecycle and N14 invalidation', options, async () => {
  const f = await fixture();
  await db.$executeRawUnsafe(`CREATE FUNCTION lead_trash_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event"='lead_lifecycle_changed' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER lead_trash_test_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION lead_trash_test_fault()');
  try { await assert.rejects(change(f.lead.id, 'trash')); } finally {
    await db.$executeRawUnsafe('DROP TRIGGER lead_trash_test_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION lead_trash_test_fault()');
  }
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } }), f.lead);
  assert.deepEqual(await db.commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item!.id } }), f.item);
});
test('same version has one concurrent winner, replay and stale restore fail', options, async () => {
  const f = await fixture(), command = await input(f.lead.id, 'trash');
  const other = await syntheticPerson(db, 'Secondo admin sintetico');
  const outcomes = await Promise.allSettled([admin, other].map(p => transitionLeadLifecycle(db, p.session, command, proof(p))));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(transitionLeadLifecycle(db, admin.session, command, proof()));
  await assert.rejects(transitionLeadLifecycle(db, admin.session, { ...command, action: 'restore' }, proof()));
  await change(f.lead.id, 'restore');
  await assert.rejects(transitionLeadLifecycle(db, admin.session, command, proof()));
  assert.equal(await db.auditLog.count({ where: { entityId: f.lead.id, event: 'lead_lifecycle_changed' } }), 2);
});
test('commercial owner cannot trash, restore or list trash despite ordinary lead write access', options, async () => {
  const owner = await syntheticPerson(db, 'Owner sintetico', 'commerciale'), f = await leadFixture(db, owner.user.id);
  assert.equal(canEditLead(owner.session, f.lead), true);
  await assert.rejects(change(f.lead.id, 'trash', owner)); await change(f.lead.id, 'trash');
  await assert.rejects(listTrashedLeads(db, owner.session, 1)); await assert.rejects(change(f.lead.id, 'restore', owner));
});
test('fresh role, explicit permission deny, revoked session and expired confirmation fail closed', options, async () => {
  for (const mode of ['role', 'permission', 'session', 'proof', 'cookie', 'claimed-expiry'] as const) {
    const person = await syntheticPerson(db, 'Admin test'), f = await fixture(), command = await input(f.lead.id, 'trash');
    if (mode === 'role') await db.user.update({ where: { id: person.user.id }, data: { role: 'direzione' } });
    if (mode === 'permission') await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'lead.write', allowed: false } });
    if (mode === 'session') await db.internalSession.update({ where: { id: person.session.sessionId }, data: { revokedAt: new Date() } });
    const p = proof(person, mode === 'proof' ? Math.floor(Date.now() / 1000) - 600 : undefined);
    if (mode === 'cookie') p.sessionToken = admin.token;
    await assert.rejects(transitionLeadLifecycle(db, mode === 'claimed-expiry' ? { ...person.session, expiresAt: 1 } : person.session, command, p), mode);
    assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).deletedAt, null);
  }
});
test('old ordinary update cannot cross trash/restore; conversion and trash serialize on the lead row', options, async () => {
  const f = await fixture(); await change(f.lead.id, 'trash'); await change(f.lead.id, 'restore');
  await assert.rejects(withSerializableTransaction(db, tx => lockLeadForMutation(tx, admin.session, f.lead.id, f.lead.updatedAt.toISOString())));
  const lead = await db.lead.create({ data: { firstName: 'Concorrenza', lastName: 'Sintetica', assignedToId: admin.user.id } });
  const other = await syntheticPerson(db, 'Admin concorrente');
  const outcomes = await Promise.allSettled([
    transitionLeadLifecycle(db, other.session, { id: lead.id, updatedAt: lead.updatedAt.toISOString(), action: 'trash', confirmed: 'yes' }, proof(other)),
    withSerializableTransaction(db, async tx => {
      const locked = await lockLeadForMutation(tx, admin.session, lead.id, lead.updatedAt.toISOString());
      const client = await tx.client.create({ data: { type: 'societa', displayName: 'Conversione sintetica concorrente', leadId: lead.id } });
      await tx.lead.update({ where: { id: lead.id }, data: { clientId: client.id, updatedAt: new Date(locked.lead.updatedAt.getTime() + 1) } });
    }),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const final = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.notEqual(Boolean(final.clientId), Boolean(final.deletedAt));
  assert.equal(await db.client.count({ where: { leadId: lead.id } }), final.clientId ? 1 : 0);
});
test('indirect offer and readiness access fail in trash; independent converted client remains accessible', options, async () => {
  const f = await fixture(); await change(f.lead.id, 'trash');
  const lead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
  assert.equal(canViewLead(admin.session, lead), false); assert.equal(canEditLead(admin.session, lead), false);
  assert.equal(canViewCommercialOffer(admin.session, { ...f.offer, lead, client: f.client }), false);
  assert.equal(canViewPracticeReadinessWork(admin.session, { client: f.client, lead }), false);
  await assert.rejects(db.$transaction(tx => assertLeadOperational(tx, lead.id)));
  await assert.rejects(db.$transaction(tx => guardProjectResources(tx, admin.user.id, [{ commercialOfferId: f.offer.id }])));
  assert.equal(canViewClient(admin.session, f.client), true);
});
test('identity discovery retains trashed candidates and duplicate prevention cannot silently resurrect them', options, async () => {
  const f = await fixture(); await change(f.lead.id, 'trash');
  const signals = digestLeadIdentitySignals({ version: 1, secret: Buffer.alloc(32, 3) },
    [{ kind: 'EMAIL_EXACT_V1', strength: 'STRONG', canonicalValue: f.lead.email! }]);
  await db.$transaction(async tx => {
    const candidates = await discoverLeadIdentityCandidates(tx, { identityKeyVersionId: randomUUID(), signals });
    assert.ok(candidates.some(c => c.leadId === f.lead.id));
    assert.equal(await hasStrongRawLeadIdentityDuplicate(tx, { email: f.lead.email, trashedOnly: true }), true);
  });
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).deletedAt !== null, true);
});
test('restoration does not revive a revoked session or override a permission revocation', options, async () => {
  const f = await fixture(), opened = await syntheticSession(db, admin.user);
  await change(f.lead.id, 'trash'); await change(f.lead.id, 'restore');
  await db.internalSession.update({ where: { id: opened.session.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(listTrashedLeads(db, opened.session, 1));
  await assert.rejects(transitionLeadLifecycle(db, opened.session, await input(f.lead.id, 'trash'), { key, sessionToken: opened.token,
    stepUpToken: createPrivilegedStepUpToken({ key, userId: admin.user.id, sessionToken: opened.token }) }));
});
