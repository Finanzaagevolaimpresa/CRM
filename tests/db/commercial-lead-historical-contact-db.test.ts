import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assignCommercialLeadInboxItem, initializeCommercialLeadInboxItem,
  recordCommercialLeadFirstResponse } from '../../src/lib/commercial-lead-inbox';
import { recordHistoricalLeadContact, readHistoricalLeadContactOutcome } from '../../src/lib/commercial-lead-historical-contact-storage';
import { acceptResponsibility, readResponsibility } from '../../src/lib/responsibility';
import { withSerializableTransaction } from '../../src/lib/serializable';
import { assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

// Preparation is qualified only by an isolated CI job. Never start a local DB
// or install this draft table into the production migration chain.
const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
if (enabled && process.env.CI !== 'true') throw new Error('HISTORICAL_CONTACT_CI_ONLY');
const root = enabled ? new PrismaClient() : null;
const schema = `n14_history_${randomUUID().replaceAll('-', '')}`;
let db: PrismaClient | null = null, schemaCreated = false;
const previous = { inbox: process.env.COMMERCIAL_LEAD_INBOX_MODE, session: process.env.INTERNAL_SESSION_MODE };
const client = () => { assert.ok(db); return db; };

test.before(async () => {
  if (!enabled) return;
  assert.ok(root);
  await assertAiOrchestratorEphemeralDatabaseIdentity(root);
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const options = { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' as const, timeout: 240_000 };
  const prisma = resolve('node_modules/prisma/build/index.js');
  execFileSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], options);
  execFileSync(process.execPath, [prisma, 'db', 'execute', '--file', 'ops/n14-historical-contact-schema.draft.sql', '--schema', 'prisma/schema.prisma'], options);
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  process.env.INTERNAL_SESSION_MODE = 'registry';
  const admin = await actor('admin');
  await client().commercialLeadSlaPolicyVersion.create({ data: {
    policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE',
    calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600,
    createdById: admin.userId,
  } });
});

test.after(async () => {
  await db?.$disconnect();
  if (schemaCreated) {
    assert.ok(root);
    await assertAiOrchestratorEphemeralDatabaseIdentity(root);
    assert.match(schema, /^n14_history_[0-9a-f]{32}$/u);
    await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await root?.$disconnect();
  if (previous.inbox === undefined) delete process.env.COMMERCIAL_LEAD_INBOX_MODE;
  else process.env.COMMERCIAL_LEAD_INBOX_MODE = previous.inbox;
  if (previous.session === undefined) delete process.env.INTERNAL_SESSION_MODE;
  else process.env.INTERNAL_SESSION_MODE = previous.session;
});

async function actor(role: RoleCode) {
  const user = await client().user.create({ data: {
    name: 'Synthetic historical contact', email: `history-${randomUUID()}@example.invalid`,
    passwordHash: 'synthetic-no-login', role, active: true,
  } });
  const session = await client().internalSession.create({ data: {
    userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  } });
  return { userId: user.id, sessionId: session.id };
}

async function fixture(accept = true) {
  const admin = await actor('admin'), owner = await actor('commerciale'), other = await actor('commerciale');
  const lead = await client().lead.create({ data: {
    firstName: 'Synthetic', lastName: 'Historical contact', source: 'CRM', leadSource: 'manuale', status: 'nuovo',
  } });
  const initial = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor: admin, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const item = await assignCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor: { ...admin, requireManualAdmin: true }, targetUserId: owner.userId,
    expectedInboxVersion: initial.version,
  });
  const decision = (await readResponsibility(client(), 'Lead', lead.id)).current;
  assert.ok(decision);
  if (accept) await withSerializableTransaction(client(), tx => acceptResponsibility(tx, owner, {
    kind: 'Lead', id: lead.id, decisionId: decision.id, role: 'commerciale',
  }));
  const cycle = await client().commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } });
  const input = {
    commandId: randomUUID(), leadId: lead.id, expectedInboxVersion: item.version,
    expectedAssignmentId: decision.id, occurredAt: new Date(item.initializedAt.getTime() - 86400_000).toISOString(),
    source: 'EXISTING_DOCUMENT', evidenceReference: 'Synthetic contact evidence before CRM', attested: true,
  };
  return { admin, owner, other, lead, item, cycle, decision, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function state(f: Fixture) {
  return {
    lead: await client().lead.findUniqueOrThrow({ where: { id: f.lead.id } }),
    item: await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item.id } }),
    cycle: await client().commercialLeadSlaCycle.findUniqueOrThrow({ where: { id: f.cycle.id } }),
    records: await client().$queryRaw<Array<{ id: string }>>`SELECT id FROM "CommercialLeadHistoricalContact" WHERE "inboxItemId"=${f.item.id}::uuid`,
    audits: await client().auditLog.findMany({ where: { entityId: f.item.id, event: 'commercial_lead_historical_contact_recorded' } }),
  };
}
const options = { skip: !enabled, timeout: 30_000 };

test('historical occurrence and DB registration are distinct; SLA, lead and N14 attribution are preserved', options, async () => {
  const f = await fixture(), before = await state(f);
  const result = await recordHistoricalLeadContact(client(), f.owner, f.input), after = await state(f);
  assert.equal(result.state, 'RECORDED'); assert.equal(result.replay, false);
  assert.equal(result.receipt.input.occurredAt, f.input.occurredAt);
  assert.ok(Date.parse(result.receipt.recordedAt) >= f.item.initializedAt.getTime());
  assert.deepEqual(after.cycle, before.cycle); assert.deepEqual(after.lead, before.lead);
  assert.equal(after.cycle.firstResponseAt, null); assert.equal(after.cycle.outcome, null);
  assert.deepEqual(after.item, { ...before.item, version: before.item.version + 1, updatedAt: new Date(result.receipt.recordedAt) });
  assert.equal(after.records.length, 1); assert.equal(after.audits.length, 1);
  assert.deepEqual(after.audits[0].after, {
    type: 'N14_HISTORICAL_CONTACT_V1', recordId: f.input.commandId,
    beforeVersion: f.item.version, afterVersion: f.item.version + 1, outcome: 'NO_REWRITE',
  });
  assert.equal(JSON.stringify(after.audits).includes(f.input.evidenceReference), false);
});

test('lost response is reconciled by command; exact replay returns one receipt and altered content is denied', options, async () => {
  const f = await fixture();
  const first = await recordHistoricalLeadContact(client(), f.owner, f.input);
  const lookup = { leadId: f.lead.id, commandId: f.input.commandId };
  assert.deepEqual(await readHistoricalLeadContactOutcome(client(), f.owner, lookup), {
    state: 'RECORDED', mayRepeat: false, receipt: first.receipt,
  });
  const replay = await recordHistoricalLeadContact(client(), f.owner, f.input);
  assert.equal(replay.replay, true); assert.deepEqual(replay.receipt, first.receipt);
  const before = await state(f);
  await assert.rejects(recordHistoricalLeadContact(client(), f.owner, { ...f.input, evidenceReference: 'Changed evidence' }));
  assert.deepEqual(await state(f), before);
  assert.deepEqual(await readHistoricalLeadContactOutcome(client(), f.owner, { ...lookup, commandId: randomUUID() }), {
    state: 'NOT_OBSERVED', mayRepeat: false,
  });
});

test('concurrent duplicate submissions have one journal row and one audit', options, async () => {
  const f = await fixture();
  const results = await Promise.all([1, 2].map(() => recordHistoricalLeadContact(client(), f.owner, f.input)));
  assert.equal(results.filter(r => !r.replay).length, 1);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  const observed = await state(f);
  assert.equal(observed.records.length, 1); assert.equal(observed.audits.length, 1);
  assert.equal(observed.item.version, f.item.version + 1);
});

test('concurrent distinct commands against one version cannot both record the contact', options, async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.input, { ...f.input, commandId: randomUUID() }]
    .map(input => recordHistoricalLeadContact(client(), f.owner, input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const observed = await state(f);
  assert.equal(observed.records.length, 1); assert.equal(observed.audits.length, 1);
  assert.deepEqual(observed.cycle, f.cycle);
});

test('concurrent reuse of one command with different evidence cannot reconcile as an exact replay', options, async () => {
  const f = await fixture();
  const inputs = [f.input, { ...f.input, evidenceReference: 'Different synthetic contact evidence' }];
  const results = await Promise.allSettled(inputs.map(input => recordHistoricalLeadContact(client(), f.owner, input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.findIndex(r => r.status === 'fulfilled');
  const outcome = await readHistoricalLeadContactOutcome(client(), f.owner, { leadId: f.lead.id, commandId: f.input.commandId });
  assert.equal(outcome.state, 'RECORDED');
  assert.equal(outcome.receipt?.input.evidenceReference, inputs[winner].evidenceReference);
  const observed = await state(f);
  assert.equal(observed.records.length, 1); assert.equal(observed.audits.length, 1);
  assert.equal(observed.item.version, f.item.version + 1);
  assert.deepEqual(observed.cycle, f.cycle);
});

test('failure while writing the audit rolls back the inbox version and entire command', options, async () => {
  const f = await fixture(), before = await state(f);
  await client().$executeRawUnsafe(`CREATE FUNCTION historical_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event='commercial_lead_historical_contact_recorded' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAULT'; END IF; RETURN NEW; END $$`);
  await client().$executeRawUnsafe('CREATE TRIGGER historical_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION historical_audit_fault()');
  try { await assert.rejects(recordHistoricalLeadContact(client(), f.owner, f.input), /SYNTHETIC_AUDIT_FAULT/u); }
  finally {
    await client().$executeRawUnsafe('DROP TRIGGER historical_audit_fault ON "AuditLog"');
    await client().$executeRawUnsafe('DROP FUNCTION historical_audit_fault()');
  }
  assert.deepEqual(await state(f), before);
});

test('admin, another commercial and an owner without personal acceptance cannot attest for the owner', options, async () => {
  const f = await fixture(false), before = await state(f);
  for (const who of [f.admin, f.other, f.owner]) await assert.rejects(recordHistoricalLeadContact(client(), who, f.input));
  assert.deepEqual(await state(f), before);
});

for (const revocation of ['permission', 'session', 'suspension'] as const) {
  test(`current ${revocation} revocation blocks both submission and receipt access in an open session`, options, async () => {
    const f = await fixture();
    await recordHistoricalLeadContact(client(), f.owner, f.input);
    if (revocation === 'permission') await client().userPermissionOverride.create({ data: {
      userId: f.owner.userId, permission: 'lead.read', allowed: false,
    } });
    if (revocation === 'session') await client().internalSession.update({ where: { id: f.owner.sessionId }, data: { revokedAt: new Date() } });
    if (revocation === 'suspension') await client().user.update({ where: { id: f.owner.userId }, data: { active: false } });
    const before = await state(f);
    await assert.rejects(recordHistoricalLeadContact(client(), f.owner, f.input));
    await assert.rejects(readHistoricalLeadContactOutcome(client(), f.owner, { leadId: f.lead.id, commandId: f.input.commandId }));
    assert.deepEqual(await state(f), before);
  });
}

test('A to B to A assignment never revives the old acceptance or historical receipt', options, async () => {
  const f = await fixture();
  await recordHistoricalLeadContact(client(), f.owner, f.input);
  for (const target of [f.other, f.owner]) {
    const item = await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item.id } });
    await assignCommercialLeadInboxItem(client(), {
      leadId: f.lead.id, actor: { ...f.admin, requireManualAdmin: true }, targetUserId: target.userId,
      expectedInboxVersion: item.version,
    });
  }
  const before = await state(f);
  await assert.rejects(recordHistoricalLeadContact(client(), f.owner, f.input));
  await assert.rejects(readHistoricalLeadContactOutcome(client(), f.owner, { leadId: f.lead.id, commandId: f.input.commandId }));
  assert.deepEqual(await state(f), before);
});

test('a current first response cannot be replaced by historical evidence', options, async () => {
  const f = await fixture();
  await recordCommercialLeadFirstResponse(client(), { leadId: f.lead.id, actor: f.owner, expectedInboxVersion: f.item.version });
  const before = await state(f);
  await assert.rejects(recordHistoricalLeadContact(client(), f.owner, f.input));
  assert.deepEqual(await state(f), before);
  assert.ok(before.cycle.firstResponseAt);
});

test('persisted evidence is append only and a duplicate command cannot create another row', options, async () => {
  const f = await fixture();
  await recordHistoricalLeadContact(client(), f.owner, f.input);
  const before = await state(f);
  await assert.rejects(client().$executeRaw`UPDATE "CommercialLeadHistoricalContact" SET "recordedAt"=clock_timestamp() WHERE id=${f.input.commandId}::uuid`);
  await assert.rejects(client().$executeRaw`DELETE FROM "CommercialLeadHistoricalContact" WHERE id=${f.input.commandId}::uuid`);
  await assert.rejects(client().$executeRaw`INSERT INTO "CommercialLeadHistoricalContact" SELECT * FROM "CommercialLeadHistoricalContact" WHERE id=${f.input.commandId}::uuid`);
  assert.deepEqual(await state(f), before);
});

test('deferred transaction linkage rejects a receipt even when its content and audit look valid', options, async () => {
  const f = await fixture(), before = await state(f);
  await client().$executeRawUnsafe(`CREATE FUNCTION historical_transaction_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW."transactionId" := txid_current()+1; RETURN NEW; END $$`);
  await client().$executeRawUnsafe('CREATE TRIGGER historical_transaction_fault BEFORE INSERT ON "CommercialLeadHistoricalContact" FOR EACH ROW EXECUTE FUNCTION historical_transaction_fault()');
  try { await assert.rejects(recordHistoricalLeadContact(client(), f.owner, f.input), /N14_HISTORICAL_CONTACT_CONTRACT_INVALID/u); }
  finally {
    await client().$executeRawUnsafe('DROP TRIGGER historical_transaction_fault ON "CommercialLeadHistoricalContact"');
    await client().$executeRawUnsafe('DROP FUNCTION historical_transaction_fault()');
  }
  assert.deepEqual(await state(f), before);
});
