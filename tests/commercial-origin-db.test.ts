import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createInternalSession, revokeAllInternalSessions } from '../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../src/lib/session';
import { withSerializableTransaction } from '../src/lib/serializable';
import { readCommercialOrigin, readCommercialOriginHistory, recordCommercialOrigin } from '../src/lib/commercial-origin';
import { commercialOriginEvents } from '../src/lib/commercial-origin-contract';
import { removeInternalUserWithAudit } from '../src/lib/user-privilege-service';

const enabled = process.env.RUN_DB_TESTS === '1', db = new PrismaClient();
const users: string[] = [], clients: string[] = [];
const priorMode = process.env.INTERNAL_SESSION_MODE;
let admitted = false;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.auditLog.deleteMany({ where: { entityType: 'Client', entityId: { in: clients }, event: { in: [...commercialOriginEvents] } } });
    await db.client.deleteMany({ where: { id: { in: clients } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (priorMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = priorMode;
  }
  await db.$disconnect();
});
const tx = <T>(work: Parameters<typeof withSerializableTransaction<T>>[1]) => withSerializableTransaction(db, work);
async function actor(role: RoleCode = 'commerciale') {
  const user = await db.user.create({ data: { name: 'Synthetic origin', email: `origin-${randomUUID()}@example.test`, role, passwordHash: 'synthetic-not-a-login-hash' } });
  users.push(user.id);
  const token = createRegistrySessionToken(), tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction(t => createInternalSession(t, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: session.id };
}
async function fixture() {
  const admin = await actor('admin'), original = await actor(), current = await actor();
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic origin client', salesOwnerId: current.userId, consultantId: null } });
  clients.push(client.id);
  return { admin, original, current, client, input: { clientId: client.id, expectedEntryId: '', acquiredById: original.userId, contractedById: original.userId,
    sourceReference: 'Synthetic archive reference', reason: 'Original identity explicitly documented' } };
}

test('origin is never inferred; append-only correction preserves the original bytes and operational owners', { skip: !enabled }, async () => {
  const { admin, original, current, client, input } = await fixture();
  assert.equal(await readCommercialOrigin(db, client.id), null);
  const first = await tx(t => recordCommercialOrigin(t, admin, input, true));
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: client.id } }), client);
  const second = await tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: first.id, contractedById: current.userId, reason: 'Corrected against the separate contract record' }, true));
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } }), first);
  assert.deepEqual((await readCommercialOrigin(db, client.id))?.snapshot, { protocol: 'R05_COMMERCIAL_ORIGIN_V1', clientId: client.id, revision: 2, predecessorId: first.id,
    acquiredById: original.userId, contractedById: current.userId, sourceReference: input.sourceReference, reason: 'Corrected against the separate contract record' });
  assert.equal(second.createdAt > first.createdAt, true);
  const history = await readCommercialOriginHistory(db, client.id);
  assert.deepEqual(history.entries.map(entry => entry.snapshot.revision), [2, 1]);
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, input, true)));
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: client.id } }), client);
});

test('current admin, session, admission, live client and known identity are mandatory', { skip: !enabled }, async () => {
  const { admin, original, client, input } = await fixture();
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, input, false)));
  await assert.rejects(tx(t => recordCommercialOrigin(t, original, input, true)));
  await assert.rejects(tx(t => recordCommercialOrigin(t, { ...admin, sessionId: original.sessionId }, input, true)));
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, { ...input, acquiredById: 'missing' }, true)));
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, { ...input, acquiredById: '', contractedById: '' }, true)));
  await db.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, input, true)));
  await db.client.update({ where: { id: client.id }, data: { deletedAt: null } });
  await tx(t => revokeAllInternalSessions(t, admin.userId, 'INTERNAL_GLOBAL', admin.userId));
  await assert.rejects(tx(t => recordCommercialOrigin(t, admin, input, true)));
  assert.equal(await readCommercialOrigin(db, client.id), null);
});

test('database audit redaction preserves structured origin while removing sensitive free text', { skip: !enabled }, async () => {
  const { admin, client, input } = await fixture();
  const first = await tx(t => recordCommercialOrigin(t, admin, { ...input, sourceReference: 'Registro synthetic@example.test' }, true));
  const stored = await readCommercialOrigin(db, client.id);
  assert.equal(stored?.snapshot.sourceReference, 'Registro [REDACTED:PERSONAL]');
  assert.equal(stored?.snapshot.protocol, 'R05_COMMERCIAL_ORIGIN_V1');
  assert.equal(stored?.snapshot.revision, 1);
  assert.equal(JSON.stringify(first.after).includes('synthetic@example.test'), false);
  const second = await tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: first.id, reason: 'Confirmed against a separate synthetic register' }, true));
  assert.deepEqual(second.before, first.after);
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } }), first);
});

test('concurrent first registration and correction each have one winner', { skip: !enabled }, async () => {
  const { admin, client, input } = await fixture();
  const outcomes = await Promise.allSettled([1, 2].map(() => tx(t => recordCommercialOrigin(t, admin, input, true))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const first = await readCommercialOrigin(db, client.id);
  const corrections = await Promise.allSettled([1, 2].map(() => tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: first!.id, contractedById: '', reason: 'Contracting identity is not yet documented' }, true))));
  assert.equal(corrections.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await readCommercialOriginHistory(db, client.id)).entries.length, 2);
});

test('audit fault leaves no partial correction, and historical identities survive logical removal', { skip: !enabled }, async () => {
  const { admin, original, client, input } = await fixture();
  const first = await tx(t => recordCommercialOrigin(t, admin, input, true));
  await db.$executeRawUnsafe(`CREATE FUNCTION origin_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event" = 'client_commercial_origin_corrected' THEN RAISE EXCEPTION 'synthetic origin audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER origin_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION origin_test_audit_fault()');
  try {
    await assert.rejects(tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: first.id, contractedById: '', reason: 'Contracting identity is not yet documented' }, true)));
    assert.equal((await readCommercialOriginHistory(db, client.id)).entries.length, 1);
    assert.deepEqual(await db.auditLog.findUniqueOrThrow({ where: { id: first.id } }), first);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER origin_test_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION origin_test_audit_fault()');
  }
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, original.userId, true))).ok, true);
  assert.equal((await readCommercialOrigin(db, client.id))?.snapshot.acquiredById, original.userId);
  // A historical role or active-state change is not a reason to invent a replacement identity.
  await tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: first.id, reason: 'Archived identity confirmed against preserved evidence' }, true));
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: client.id } }), client);
});

test('history is fully pageable and foreign-client cursors or malformed snapshots fail closed', { skip: !enabled }, async () => {
  const { admin, client, input } = await fixture();
  let previous = '';
  for (let revision = 1; revision <= 27; revision++) previous = (await tx(t => recordCommercialOrigin(t, admin, { ...input, expectedEntryId: previous, reason: `Synthetic evidence clarification revision ${revision}` }, true))).id;
  const first = await readCommercialOriginHistory(db, client.id);
  assert.equal(first.entries.length, 25); assert.ok(first.next);
  const second = await readCommercialOriginHistory(db, client.id, first.next!);
  assert.deepEqual(second.entries.map(x => x.snapshot.revision), [2, 1]); assert.equal(second.next, null);
  const other = await fixture();
  await assert.rejects(readCommercialOriginHistory(db, other.client.id, first.next!));
  await db.auditLog.create({ data: { entityType: 'Client', entityId: other.client.id, actorId: admin.userId, event: commercialOriginEvents[0], after: { invalid: true } } });
  await assert.rejects(readCommercialOrigin(db, other.client.id));
  await assert.rejects(tx(t => recordCommercialOrigin(t, other.admin, other.input, true)));
});
