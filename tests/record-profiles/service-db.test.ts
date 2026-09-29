import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { acquireLeadIdentityWriteLock, hasStrongRawLeadIdentityDuplicate } from '../../src/lib/lead-identity';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { saveRecordProfile } from '../../src/lib/record-profiles';
import { RecordProfileError, personProfileVersion } from '../../src/lib/record-profile-contract';
const enabled = process.env.RECORD_PROFILES_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => { await db.$disconnect(); });
const failure = (code: string) => (error: unknown) => error instanceof RecordProfileError && error.code === code;
async function user(role: RoleCode) {
  const row = await db.user.create({ data: { name: 'Synthetic profile', email: `profile-${randomUUID()}@example.test`, role, active: true, passwordHash: 'synthetic-unusable' } });
  const session = await db.internalSession.create({ data: { userId: row.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { userId: row.id, role, active: true, permissionOverrides: [], sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime() / 1000) };
}
const companyData = { name: 'Synthetic full company', vatNumber: 'SYNTHETIC', taxCode: 'SYNTHETIC', rea: 'TEST', pec: 'company@example.test',
  legalAddress: 'Synthetic legal address', operatingAddress: 'Synthetic operating address', region: 'Synthetic', province: 'Test', city: 'Test', legalForm: 'Test',
  atecoCode: 'TEST', atecoDescription: 'Synthetic activity', incorporationDate: '2024-02-29', activityStartDate: '', activityStatus: 'Test', employees: '0',
  annualRevenue: '0.00', durcStatus: 'Non verificato', taxRegime: 'Test', notes: 'Synthetic notes' };
const personData = { firstName: 'Synthetic', lastName: 'Person', email: 'person@example.test', phone: '', taxCode: '', notes: '', role: 'Referente', ownershipPercent: '0' };
async function fixture() {
  const admin = await user('admin'), owner = await user('consulente'), outsider = await user('consulente');
  const client = await db.client.create({ data: { displayName: 'Synthetic client', type: 'societa', consultantId: owner.userId } });
  const createCompany = { kind: 'new-company', id: randomUUID(), clientId: client.id, data: companyData };
  return { admin, owner, outsider, client, createCompany };
}
test('full company profile saves, null clearing and zero work, and a duplicate create cannot create a second company', { skip: !enabled }, async () => {
  const f = await fixture();
  const first = await saveRecordProfile(db, f.owner, f.createCompany);
  assert.equal(await saveRecordProfile(db, f.owner, f.createCompany), first);
  const company = await db.company.findUniqueOrThrow({ where: { id: f.createCompany.id } });
  assert.equal(company.employees, 0); assert.equal(company.annualRevenue?.toString(), '0'); assert.equal(company.activityStartDate, null);
  await saveRecordProfile(db, f.owner, { kind: 'company', id: company.id, expectedVersion: company.updatedAt.toISOString(), data: { ...companyData, pec: '', annualRevenue: '' } });
  const cleared = await db.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(cleared.pec, null); assert.equal(cleared.annualRevenue, null);
  assert.equal(await db.company.count({ where: { clientId: f.client.id } }), 1);
  const audit = await db.auditLog.findMany({ where: { entityId: company.id, event: 'record_profile_saved' } });
  assert.equal(audit.length, 2); assert.ok(!JSON.stringify(audit).includes(companyData.legalAddress));
});
test('an outsider or read-only client grant cannot edit; revocation applies to an already-open form', { skip: !enabled }, async () => {
  const f = await fixture();
  await assert.rejects(saveRecordProfile(db, f.outsider, f.createCompany), failure('DENIED'));
  const readOnly = { ...f.outsider, clientReadScope: [f.client.id] };
  await assert.rejects(saveRecordProfile(db, readOnly, f.createCompany), failure('DENIED'));
  const override = await db.userPermissionOverride.create({ data: { userId: f.owner.userId, permission: 'company.write', allowed: false } });
  await assert.rejects(saveRecordProfile(db, f.owner, f.createCompany), failure('DENIED'));
  await db.userPermissionOverride.update({ where: { id: override.id }, data: { allowed: true } });
  await db.internalSession.update({ where: { id: f.owner.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(saveRecordProfile(db, f.owner, f.createCompany), failure('DENIED'));
  assert.equal(await db.company.count({ where: { clientId: f.client.id } }), 0);
});
test('reassignment, soft deletion and stale versions are denied without partial writes', { skip: !enabled }, async () => {
  const f = await fixture(); await saveRecordProfile(db, f.owner, f.createCompany);
  const company = await db.company.findUniqueOrThrow({ where: { id: f.createCompany.id } });
  const edit = { kind: 'company', id: company.id, expectedVersion: company.updatedAt.toISOString(), data: { ...companyData, name: 'Changed synthetic' } };
  await db.client.update({ where: { id: f.client.id }, data: { consultantId: f.outsider.userId } });
  await assert.rejects(saveRecordProfile(db, f.owner, edit), failure('DENIED'));
  await saveRecordProfile(db, f.outsider, edit);
  await assert.rejects(saveRecordProfile(db, f.outsider, edit), failure('STALE'));
  await db.company.update({ where: { id: company.id }, data: { deletedAt: new Date() } });
  await assert.rejects(saveRecordProfile(db, f.admin, edit), failure('DENIED'));
});
test('person update is bound to its company, rejects stale edits and cannot mutate a shared person through one company', { skip: !enabled }, async () => {
  const f = await fixture(); await saveRecordProfile(db, f.owner, f.createCompany);
  const command = { kind: 'new-person', id: randomUUID(), companyId: f.createCompany.id, data: personData };
  await saveRecordProfile(db, f.owner, command); await saveRecordProfile(db, f.owner, command);
  assert.equal(await db.companyPerson.count({ where: { companyId: command.companyId } }), 1);
  let link = await db.companyPerson.findUniqueOrThrow({ where: { id: command.id } });
  let person = await db.person.findUniqueOrThrow({ where: { id: link.personId } });
  const edit = { ...command, kind: 'person', expectedVersion: personProfileVersion(person, link), data: { ...personData, role: 'Socio' } };
  await assert.rejects(saveRecordProfile(db, f.outsider, edit), failure('DENIED'));
  await saveRecordProfile(db, f.owner, edit);
  await assert.rejects(saveRecordProfile(db, f.owner, edit), failure('STALE'));
  const other = await fixture(); await saveRecordProfile(db, other.owner, other.createCompany);
  await assert.rejects(saveRecordProfile(db, f.admin, { ...edit, companyId: other.createCompany.id }), failure('DENIED'));
  await db.companyPerson.create({ data: { companyId: other.createCompany.id, personId: person.id, role: 'Referente condiviso' } });
  link = await db.companyPerson.findUniqueOrThrow({ where: { id: link.id } });
  person = await db.person.findUniqueOrThrow({ where: { id: person.id } });
  await assert.rejects(saveRecordProfile(db, f.owner, { ...edit, expectedVersion: personProfileVersion(person, link) }), failure('SHARED_PERSON'));
});
test('lead contacts and client identity edit without changing conversion, ownership or commercial status', { skip: !enabled }, async () => {
  const f = await fixture(), sales = await user('commerciale');
  const lead = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Lead', status: 'vinto', assignedToId: sales.userId, clientId: f.client.id } });
  const data = { firstName: 'Updated', lastName: 'Synthetic', companyName: '', contactPerson: '', email: 'updated@example.test', phone: '', region: '', province: '', city: '' };
  await saveRecordProfile(db, sales, { kind: 'lead', id: lead.id, expectedVersion: lead.updatedAt.toISOString(), data });
  const saved = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(saved.status, 'vinto'); assert.equal(saved.assignedToId, sales.userId); assert.equal(saved.clientId, f.client.id);
  await saveRecordProfile(db, f.admin, { kind: 'client', id: f.client.id, expectedVersion: f.client.updatedAt.toISOString(), data: { displayName: 'Updated client', type: 'ditta_individuale', notes: '' } });
  const client = await db.client.findUniqueOrThrow({ where: { id: f.client.id } });
  assert.equal(client.consultantId, f.owner.userId); assert.equal(client.status, 'attivo');
});
test('an audit failure rolls back the profile mutation', { skip: !enabled }, async () => {
  const f = await fixture();
  const failing = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(saveRecordProfile(failing, f.owner, f.createCompany), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal(await db.company.count({ where: { clientId: f.client.id } }), 0);
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function namedConnection(name: string) {
  return { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('application_name', ${name}, true)`;
    return work(tx);
  }, options) } as unknown as PrismaClient;
}
async function waitForLock(name: string) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock') AS blocked`;
    if (row.blocked) return;
    await pause(20);
  }
  assert.fail('Expected actual PostgreSQL lock contention');
}
for (const expiry of ['database-session', 'claimed-session', 'legacy-session'] as const) {
  test(`profile ${expiry} expiry during a record lock wait leaves neither mutation nor audit`, { skip: !enabled }, async () => {
    const f = await fixture(), name = 'profile-expiry-' + randomUUID();
    if (expiry === 'database-session') await db.internalSession.update({ where: { id: f.owner.sessionId }, data: { expiresAt: new Date(Date.now() + 1800) } });
    else f.owner.expiresAt = Math.floor(Date.now() / 1000) + 2;
    const { sessionId, ...legacy } = f.owner; void sessionId;
    const session = expiry === 'legacy-session' ? legacy : f.owner;
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${f.client.id} FOR UPDATE`;
      locked(); await released;
    }, { timeout: 10_000 });
    await Promise.race([acquired, blocker]);
    const writer = Promise.allSettled([saveRecordProfile(namedConnection(name), session, f.createCompany)]);
    try { await waitForLock(name); await pause(2200); }
    finally { release(); await blocker; }
    const [result] = await writer;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.ok(failure('DENIED')(result.reason));
    assert.equal(await db.company.count({ where: { clientId: f.client.id } }), 0);
    assert.equal(await db.auditLog.count({ where: { entityId: f.createCompany.id } }), 0);
  });
}

const leadData = { firstName: '', lastName: '', companyName: '', contactPerson: '', email: '', phone: '', region: '', province: '', city: '' };
test('acquired lead contacts can be edited without inventing missing names', { skip: !enabled }, async () => {
  const admin = await user('admin');
  const lead = await db.lead.create({ data: { firstName: '', lastName: '', companyName: 'Synthetic unnamed lead' } });
  await saveRecordProfile(db, admin, { kind: 'lead', id: lead.id, expectedVersion: lead.updatedAt.toISOString(), data: { ...leadData,
    companyName: lead.companyName, email: `unnamed-${randomUUID()}@example.test` } });
  const saved = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(saved.firstName, ''); assert.equal(saved.lastName, ''); assert.ok(saved.email);
});

test('lead profile duplicate checks normalize strong contacts and exclude the current lead', { skip: !enabled }, async () => {
  const admin = await user('admin'), email = `shared-${randomUUID()}@example.test`;
  const other = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Contact', email, phone: '+12025550199' } });
  const lead = await db.lead.create({ data: { firstName: '', lastName: '', email: `own-${randomUUID()}@example.test` } });
  await saveRecordProfile(db, admin, { kind: 'lead', id: lead.id, expectedVersion: lead.updatedAt.toISOString(), data: { ...leadData, email: lead.email } });
  const current = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  for (const contacts of [{ email: email.toUpperCase() }, { phone: '+1 (202) 555-0199' }]) {
    await assert.rejects(saveRecordProfile(db, admin, { kind: 'lead', id: lead.id, expectedVersion: current.updatedAt.toISOString(), data: { ...leadData, ...contacts } }), failure('DUPLICATE_LEAD'));
  }
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), current);
  assert.equal(await db.auditLog.count({ where: { entityId: lead.id, event: 'record_profile_saved' } }), 1);
  await db.lead.update({ where: { id: other.id }, data: { deletedAt: new Date() } });
  await saveRecordProfile(db, admin, { kind: 'lead', id: lead.id, expectedVersion: current.updatedAt.toISOString(), data: { ...leadData, email } });
});

test('concurrent lead profile writers cannot claim the same strong contact', { skip: !enabled }, async () => {
  const admin = await user('admin'), email = `race-${randomUUID()}@example.test`;
  const leads = await Promise.all([1, 2].map(() => db.lead.create({ data: { firstName: '', lastName: '' } })));
  const results = await Promise.allSettled(leads.map(lead => saveRecordProfile(db, admin, { kind: 'lead', id: lead.id, expectedVersion: lead.updatedAt.toISOString(), data: { ...leadData, email } })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && failure('DUPLICATE_LEAD')(x.reason)).length, 1);
  assert.equal(await db.lead.count({ where: { email, deletedAt: null } }), 1);
});

test('historical duplicate contacts allow unrelated corrections and changes to one contact without bypassing new collisions', { skip: !enabled }, async () => {
  const admin = await user('admin'), email = `historical-${randomUUID()}@example.test`, phone = '+12025550187';
  const legacy = await Promise.all([1, 2].map(() => db.lead.create({ data: { firstName: '', lastName: '', email, phone, city: 'Old city' } })));
  const save = async (id: string, contacts: { email: string; phone: string }, city: string) => {
    const current = await db.lead.findUniqueOrThrow({ where: { id } });
    await saveRecordProfile(db, admin, { kind: 'lead', id, expectedVersion: current.updatedAt.toISOString(), data: { ...leadData, ...contacts, city } });
    return db.lead.findUniqueOrThrow({ where: { id } });
  };
  let current = await save(legacy[0].id, { email, phone }, 'Corrected city');
  assert.equal(current.city, 'Corrected city');
  current = await save(current.id, { email: email.toUpperCase(), phone: '+1 (202) 555-0187' }, 'Normalized city');
  assert.equal(current.city, 'Normalized city');
  const uniqueEmail = `corrected-${randomUUID()}@example.test`;
  current = await save(current.id, { email: uniqueEmail, phone }, 'Email corrected');
  assert.equal(current.email, uniqueEmail); assert.equal(current.phone, phone);
  const other = await save(legacy[1].id, { email, phone: '+12025550188' }, 'Phone corrected');
  assert.equal(other.email, email); assert.equal(other.phone, '+12025550188');
  await assert.rejects(save(current.id, { email, phone }, 'New email collision'), failure('DUPLICATE_LEAD'));
  await assert.rejects(save(current.id, { email: uniqueEmail, phone: other.phone! }, 'New phone collision'), failure('DUPLICATE_LEAD'));
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: current.id } }), current);
  assert.equal(await db.auditLog.count({ where: { entityId: current.id, event: 'record_profile_saved' } }), 3);
});

test('profile edits wait for the canonical creation identity lock and reject the newly committed contact', { skip: !enabled }, async () => {
  const admin = await user('admin'), email = `create-race-${randomUUID()}@example.test`, name = 'profile-identity-' + randomUUID();
  const lead = await db.lead.create({ data: { firstName: '', lastName: '' } });
  let checked!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { checked = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  // Same canonical creation boundary used by createLead, including a held gap
  // between the duplicate query and insert. The editor must actually block.
  const creation = db.$transaction(async tx => {
    await acquireLeadIdentityWriteLock(tx);
    assert.equal(await hasStrongRawLeadIdentityDuplicate(tx, { email }), false);
    checked(); await released;
    return tx.lead.create({ data: { firstName: 'Synthetic', lastName: 'Creation', email } });
  }, { timeout: 10_000 });
  await Promise.race([ready, creation]);
  const writer = Promise.allSettled([saveRecordProfile(namedConnection(name), admin, { kind: 'lead', id: lead.id, expectedVersion: lead.updatedAt.toISOString(), data: { ...leadData, email } })]);
  try { await waitForLock(name); } finally { release(); await creation; }
  const [result] = await writer;
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.ok(failure('DUPLICATE_LEAD')(result.reason));
  assert.equal(await db.lead.count({ where: { email, deletedAt: null } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: lead.id } }), 0);
});
