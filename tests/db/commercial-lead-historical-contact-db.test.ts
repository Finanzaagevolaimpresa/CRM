import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assignCommercialLeadInboxItem, initializeCommercialLeadInboxItem,
  recordCommercialLeadFirstResponse, convertCommercialLeadInboxItem, type CommercialLeadFaultPoint } from '../../src/lib/commercial-lead-inbox';
import { recordHistoricalLeadContact, readHistoricalLeadContactOutcome,
  readHistoricalLeadConversionOutcome, previewHistoricalLeadContact, confirmHistoricalLeadContact,
  previewHistoricalLeadConversion } from '../../src/lib/commercial-lead-historical-contact-storage';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { canonicalJson } from '../../src/lib/canonical-json';
import { redactTechnicalText } from '../../src/lib/data-classification';
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
const previewKey = { version: 1, secret: randomBytes(32).toString('hex') };
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
  execFileSync(process.execPath, [prisma, 'db', 'execute', '--file', 'ops/n14-historical-conversion-schema.draft.sql', '--schema', 'prisma/schema.prisma'], options);
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  process.env.INTERNAL_SESSION_MODE = 'registry';
  const admin = await actor('admin');
  await client().applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: previewKey.version,
    keyDigest: privilegedStepUpKeyDigest(previewKey.secret), status: 'ACTIVE', activatedAt: new Date(), createdById: admin.userId } });
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
    clients: await client().client.findMany({ where: { leadId: f.lead.id } }),
    conversions: await client().$queryRaw<unknown[]>`SELECT * FROM "CommercialLeadHistoricalConversion" WHERE "inboxItemId"=${f.item.id}::uuid`,
    conversionAudits: await client().auditLog.findMany({ where: { entityId: f.item.id, event: 'commercial_lead_historical_conversion_recorded' } }),
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
    type: 'N14_HISTORICAL_CONTACT_V1', recordId: redactTechnicalText(f.input.commandId),
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

async function conversionFixture() {
  const f = await fixture();
  const contact = await recordHistoricalLeadContact(client(), f.owner, f.input);
  const conversion = { leadId: f.lead.id, actor: f.owner, expectedInboxVersion: contact.receipt.inboxVersionAfter,
    clientType: 'persona_fisica' as const, historicalContact: {
      commandId: randomUUID(), contactId: contact.receipt.id, expectedAssignmentId: f.decision.id,
    } };
  return { ...f, contact, conversion };
}

async function conversionPreviewFixture() {
  const f = await conversionFixture(), raw = { ...f.conversion.historicalContact, leadId: f.lead.id,
    expectedInboxVersion: f.conversion.expectedInboxVersion, clientType: f.conversion.clientType };
  const preview = await previewHistoricalLeadConversion(client(), f.owner, raw, previewKey);
  return { ...f, preview, signed: { ...f.conversion, historicalPreview: { key: previewKey, token: preview.token } } };
}

test('signed conversion preview is read-only and confirms the exact source within N14', options, async () => {
  const f = await conversionFixture(), before = await state(f);
  const raw = { ...f.conversion.historicalContact, leadId: f.lead.id,
    expectedInboxVersion: f.conversion.expectedInboxVersion, clientType: f.conversion.clientType };
  const preview = await previewHistoricalLeadConversion(client(), f.owner, raw, previewKey);
  assert.deepEqual(await state(f), before);
  const result = await convertCommercialLeadInboxItem(client(), { ...f.conversion, historicalPreview: { key: previewKey, token: preview.token } });
  const after = await state(f); assert.equal(after.clients.length, 1); assert.equal(after.clients[0].id, result.id);
  assert.equal(after.conversions.length, 1); assert.equal(after.conversionAudits.length, 1);
  assert.equal(after.cycle.firstResponseAt, null); assert.equal(after.cycle.outcome, 'HISTORICAL_CONTACT_BEFORE_CRM');
});

test('a changed lead projection invalidates a signed conversion without changing its type or copying stale notes', options, async () => {
  const f = await conversionPreviewFixture();
  await client().lead.update({ where: { id: f.lead.id }, data: { notes: 'Changed synthetic notes' } });
  const before = await state(f);
  await assert.rejects(convertCommercialLeadInboxItem(client(), f.signed));
  assert.deepEqual(await state(f), before);
});

test('client authority revoked after signed preview blocks conversion and preserves the historical contact', options, async () => {
  const f = await conversionPreviewFixture();
  await client().userPermissionOverride.create({ data: { userId: f.owner.userId, permission: 'client.write', allowed: false } });
  const before = await state(f);
  await assert.rejects(convertCommercialLeadInboxItem(client(), f.signed));
  assert.deepEqual(await state(f), before);
});

test('another live session of the same owner cannot use the conversion preview', options, async () => {
  const f = await conversionPreviewFixture();
  const session = await client().internalSession.create({ data: { userId: f.owner.userId,
    tokenDigest: randomBytes(32), expiresAt: new Date('2099-01-01T00:00:00Z') } });
  const before = await state(f);
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.signed, actor: { ...f.owner, sessionId: session.id } }));
  assert.deepEqual(await state(f), before);
});

test('duplicate signed confirmations produce one client and an exact read-only reconciliation', options, async () => {
  const f = await conversionPreviewFixture();
  const results = await Promise.allSettled([1, 2].map(() => convertCommercialLeadInboxItem(client(), f.signed)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const after = await state(f); assert.equal(after.clients.length, 1); assert.equal(after.conversions.length, 1);
  const outcome = await readHistoricalLeadConversionOutcome(client(), f.owner, { leadId: f.lead.id, commandId: f.conversion.historicalContact.commandId });
  assert.equal(outcome.state, 'CONVERTED'); assert.deepEqual(await state(f), after);
});

test('retired preview key blocks historical conversion before all writes', options, async () => {
  const f = await conversionPreviewFixture(), before = await state(f);
  await client().applicationKeyVersion.updateMany({ where: { purpose: 'PRIVILEGED_STEP_UP', version: previewKey.version }, data: { status: 'RETIRED', retiredAt: new Date() } });
  try { await assert.rejects(convertCommercialLeadInboxItem(client(), f.signed)); assert.deepEqual(await state(f), before); }
  finally { await client().applicationKeyVersion.updateMany({ where: { purpose: 'PRIVILEGED_STEP_UP', version: previewKey.version }, data: { status: 'ACTIVE', retiredAt: null } }); }
});

test('historical conversion uses the existing N14 closure and records a distinct SLA basis without a fabricated response', options, async () => {
  const f = await conversionFixture(), before = await state(f);
  const result = await convertCommercialLeadInboxItem(client(), f.conversion), after = await state(f);
  assert.equal(after.clients.length, 1); assert.equal(result.id, after.clients[0].id);
  assert.equal(result.salesOwnerId, f.owner.userId); assert.equal(after.lead.clientId, result.id);
  assert.equal(after.lead.status, 'vinto'); assert.equal(after.item.state, 'CLOSED');
  assert.equal(after.item.version, before.item.version + 1);
  assert.equal(after.cycle.outcome, 'HISTORICAL_CONTACT_BEFORE_CRM'); assert.equal(after.cycle.firstResponseAt, null);
  assert.deepEqual(after.cycle.availableAt, before.cycle.availableAt); assert.deepEqual(after.cycle.dueAt, before.cycle.dueAt);
  assert.equal(after.cycle.policyVersionId, before.cycle.policyVersionId);
  assert.ok(after.cycle.closedAt);
  assert.ok(after.cycle.closedAt.getTime() >= Date.parse(f.contact.receipt.recordedAt));
  assert.deepEqual(after.records, before.records); assert.deepEqual(after.audits, before.audits);
  assert.equal(after.conversions.length, 1); assert.equal(after.conversionAudits.length, 1);
  assert.deepEqual(after.conversionAudits[0].after, { type: 'N14_HISTORICAL_CONVERSION_V1',
    recordId: redactTechnicalText(f.conversion.historicalContact.commandId), beforeVersion: before.item.version,
    afterVersion: after.item.version, outcome: 'HISTORICAL_CONTACT_BEFORE_CRM' });
  const activity = await client().commercialLeadActivity.findMany({ where: { inboxItemId: f.item.id, reasonCode: 'CONVERTED' } });
  assert.equal(activity.length, 1); assert.equal(activity[0].activityType, 'CLOSED');
  assert.equal(await client().technicalPractice.count({ where: { clientId: result.id } }), 0);
});

test('conversion receipt reconciles a lost response and exact replay without creating another client', options, async () => {
  const f = await conversionFixture();
  const result = await convertCommercialLeadInboxItem(client(), f.conversion);
  const lookup = { leadId: f.lead.id, commandId: f.conversion.historicalContact.commandId };
  const outcome = await readHistoricalLeadConversionOutcome(client(), f.owner, lookup);
  assert.equal(outcome.state, 'CONVERTED'); assert.equal(outcome.clientId, result.id); assert.equal(outcome.mayRepeat, false);
  const before = await state(f);
  assert.equal((await convertCommercialLeadInboxItem(client(), f.conversion)).id, result.id);
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion, clientType: 'societa' }));
  assert.deepEqual(await state(f), before);
  assert.deepEqual(await readHistoricalLeadConversionOutcome(client(), f.owner, { ...lookup, commandId: randomUUID() }), {
    state: 'NOT_OBSERVED', mayRepeat: false,
  });
});

test('concurrent identical historical conversion commands return the same single client', options, async () => {
  const f = await conversionFixture();
  const results = await Promise.all([1, 2].map(() => convertCommercialLeadInboxItem(client(), f.conversion)));
  assert.equal(results[0].id, results[1].id);
  const observed = await state(f);
  assert.equal(observed.clients.length, 1); assert.equal(observed.conversions.length, 1);
  assert.equal(observed.conversionAudits.length, 1);
});

test('distinct conversion commands racing on one receipt cannot create duplicate clients', options, async () => {
  const f = await conversionFixture();
  const other = { ...f.conversion, historicalContact: { ...f.conversion.historicalContact, commandId: randomUUID() } };
  const results = await Promise.allSettled([f.conversion, other].map(input => convertCommercialLeadInboxItem(client(), input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await state(f)).clients.length, 1); assert.equal((await state(f)).conversions.length, 1);
});

test('contact evidence alone does not remove the ordinary first-response gate; a current response keeps its normal SLA', options, async () => {
  const f = await conversionFixture();
  const ordinary = { leadId: f.lead.id, actor: f.owner, expectedInboxVersion: f.conversion.expectedInboxVersion, clientType: 'persona_fisica' as const };
  await assert.rejects(convertCommercialLeadInboxItem(client(), ordinary), /N14_FIRST_RESPONSE_REQUIRED/u);
  const updated = await recordCommercialLeadFirstResponse(client(), { leadId: f.lead.id, actor: f.owner,
    expectedInboxVersion: f.conversion.expectedInboxVersion });
  const before = await state(f);
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion, expectedInboxVersion: updated.item.version }));
  assert.deepEqual(await state(f), before);
  const result = await convertCommercialLeadInboxItem(client(), { ...ordinary, expectedInboxVersion: updated.item.version });
  const after = await state(f);
  assert.equal(after.lead.clientId, result.id); assert.deepEqual(after.cycle.firstResponseAt, before.cycle.firstResponseAt);
  assert.equal(after.cycle.outcome, before.cycle.outcome); assert.equal(after.conversions.length, 0);
});

test('current response and historical conversion racing cannot classify the same cycle both ways', options, async () => {
  const f = await conversionFixture();
  const results = await Promise.allSettled([
    convertCommercialLeadInboxItem(client(), f.conversion),
    recordCommercialLeadFirstResponse(client(), { leadId: f.lead.id, actor: f.owner, expectedInboxVersion: f.conversion.expectedInboxVersion }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const after = await state(f);
  if (after.cycle.firstResponseAt) {
    assert.ok(['MET', 'BREACHED'].includes(after.cycle.outcome!)); assert.equal(after.clients.length, 0); assert.equal(after.conversions.length, 0);
  } else {
    assert.equal(after.cycle.outcome, 'HISTORICAL_CONTACT_BEFORE_CRM'); assert.equal(after.clients.length, 1); assert.equal(after.conversions.length, 1);
  }
});

for (const faultAt of ['AFTER_CLIENT', 'AFTER_LEAD', 'AFTER_CYCLE', 'AFTER_ITEM', 'AFTER_ACTIVITY', 'AFTER_AUDIT'] satisfies CommercialLeadFaultPoint[]) {
  test(`conversion failure ${faultAt} rolls back client, closure, contact consumption and audit`, options, async () => {
    const f = await conversionFixture(), before = await state(f);
    await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion, faultAt }), new RegExp(`N14_SYNTHETIC_FAULT_${faultAt}`, 'u'));
    assert.deepEqual(await state(f), before);
  });
}

for (const permission of ['lead.read', 'lead.write', 'client.read', 'client.write'] as const) {
  test(`revoked ${permission} blocks historical conversion and disclosure of an existing conversion`, options, async () => {
    const first = await conversionFixture(), second = await conversionFixture();
    await convertCommercialLeadInboxItem(client(), second.conversion);
    for (const f of [first, second]) {
      await client().userPermissionOverride.create({ data: { userId: f.owner.userId, permission, allowed: false } });
      const before = await state(f);
      await assert.rejects(convertCommercialLeadInboxItem(client(), f.conversion));
      await assert.rejects(readHistoricalLeadConversionOutcome(client(), f.owner, { leadId: f.lead.id, commandId: f.conversion.historicalContact.commandId }));
      assert.deepEqual(await state(f), before);
    }
  });
}

test('conversion cannot consume a different lead contact, a stale version or a previous assignment after A to B to A', options, async () => {
  const f = await conversionFixture(), other = await conversionFixture(), before = await state(f);
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion,
    historicalContact: { ...f.conversion.historicalContact, contactId: other.input.commandId } }));
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion, expectedInboxVersion: f.conversion.expectedInboxVersion + 1 }));
  assert.deepEqual(await state(f), before);
  for (const target of [f.other, f.owner]) {
    const item = await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item.id } });
    await assignCommercialLeadInboxItem(client(), { leadId: f.lead.id, actor: { ...f.admin, requireManualAdmin: true },
      targetUserId: target.userId, expectedInboxVersion: item.version });
  }
  const current = (await readResponsibility(client(), 'Lead', f.lead.id)).current!;
  await withSerializableTransaction(client(), tx => acceptResponsibility(tx, f.owner, {
    kind: 'Lead', id: f.lead.id, decisionId: current.id, role: 'commerciale',
  }));
  const item = await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: f.item.id } });
  await assert.rejects(convertCommercialLeadInboxItem(client(), { ...f.conversion, expectedInboxVersion: item.version,
    historicalContact: { ...f.conversion.historicalContact, expectedAssignmentId: current.id } }));
  assert.equal((await state(f)).clients.length, 0);
});

test('reconciliation denies another actor, a revoked session, deleted client or changed commercial owner', options, async () => {
  for (const change of ['actor', 'session', 'clientTrash', 'owner'] as const) {
    const f = await conversionFixture();
    const converted = await convertCommercialLeadInboxItem(client(), f.conversion);
    if (change === 'session') await client().internalSession.update({ where: { id: f.owner.sessionId }, data: { revokedAt: new Date() } });
    if (change === 'clientTrash') await client().client.update({ where: { id: converted.id }, data: { deletedAt: new Date() } });
    if (change === 'owner') await client().client.update({ where: { id: converted.id }, data: { salesOwnerId: f.other.userId } });
    await assert.rejects(readHistoricalLeadConversionOutcome(client(), change === 'actor' ? f.other : f.owner,
      { leadId: f.lead.id, commandId: f.conversion.historicalContact.commandId }));
    assert.equal((await state(f)).clients.length, 1);
  }
});

test('SQL rejects a historical SLA closure without its same-transaction conversion receipt', options, async () => {
  const f = await conversionFixture(), before = await state(f);
  await assert.rejects(client().$executeRaw`UPDATE "CommercialLeadSlaCycle" SET version=version+1,
    "closedAt"=clock_timestamp(),outcome='HISTORICAL_CONTACT_BEFORE_CRM' WHERE id=${f.cycle.id}::uuid`, /N14_HISTORICAL_CONVERSION_RECEIPT_REQUIRED/u);
  assert.deepEqual(await state(f), before);
});

test('conversion journal transaction fault is surfaced before success and rolls back every linked row', options, async () => {
  const f = await conversionFixture(), before = await state(f);
  await client().$executeRawUnsafe(`CREATE FUNCTION historical_conversion_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW."transactionId" := txid_current()+1; RETURN NEW; END $$`);
  await client().$executeRawUnsafe('CREATE TRIGGER historical_conversion_fault BEFORE INSERT ON "CommercialLeadHistoricalConversion" FOR EACH ROW EXECUTE FUNCTION historical_conversion_fault()');
  try { await assert.rejects(convertCommercialLeadInboxItem(client(), f.conversion), /N14_HISTORICAL_CONVERSION_CONTRACT_INVALID/u); }
  finally {
    await client().$executeRawUnsafe('DROP TRIGGER historical_conversion_fault ON "CommercialLeadHistoricalConversion"');
    await client().$executeRawUnsafe('DROP FUNCTION historical_conversion_fault()');
  }
  assert.deepEqual(await state(f), before);
});

test('signed preview is read-only and confirmation records the exact event without an SLA rewrite', options, async () => {
  const f = await fixture(), before = await state(f);
  const preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey);
  assert.deepEqual(await state(f), before);
  const saved = await confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, true);
  assert.equal(saved.state, 'RECORDED'); assert.equal(saved.receipt.input.evidenceReference, f.input.evidenceReference);
  assert.equal(saved.receipt.input.occurredAt, f.input.occurredAt);
  assert.ok(Date.parse(saved.receipt.recordedAt) >= Date.parse(preview.previewedAt));
  assert.deepEqual((await state(f)).cycle, before.cycle);
  assert.equal((await state(f)).records.length, 1);
});

test('missing personal confirmation and a modified preview cannot write or manufacture a receipt', options, async () => {
  const f = await fixture(), before = await state(f);
  const preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey);
  await assert.rejects(confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, false));
  const value = JSON.parse(Buffer.from(preview.token, 'base64url').toString('utf8'));
  value.payload.input.evidenceReference = 'Altered synthetic reference';
  await assert.rejects(confirmHistoricalLeadContact(client(), f.owner, previewKey, Buffer.from(canonicalJson(value)).toString('base64url'), true));
  assert.deepEqual(await state(f), before);
});

test('a current first response between preview and confirmation invalidates the historical preview', options, async () => {
  const f = await fixture();
  const preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey);
  await recordCommercialLeadFirstResponse(client(), { leadId: f.lead.id, actor: f.owner, expectedInboxVersion: f.item.version });
  const afterResponse = await state(f);
  await assert.rejects(confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, true));
  assert.deepEqual(await state(f), afterResponse);
});

test('an open preview does not survive permission revocation', options, async () => {
  const f = await fixture(), preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey);
  await client().userPermissionOverride.create({ data: { userId: f.owner.userId, permission: 'lead.write', allowed: false } });
  const before = await state(f);
  await assert.rejects(confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, true));
  assert.deepEqual(await state(f), before);
});

test('a preview is bound to the original live session even for the same owner', options, async () => {
  const f = await fixture(), preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey);
  const session = await client().internalSession.create({ data: { userId: f.owner.userId, tokenDigest: randomBytes(32),
    expiresAt: new Date('2099-01-01T00:00:00.000Z') } });
  const before = await state(f);
  await assert.rejects(confirmHistoricalLeadContact(client(), { ...f.owner, sessionId: session.id }, previewKey, preview.token, true));
  assert.deepEqual(await state(f), before);
});

test('the preview key must remain active in the registry at confirmation', options, async () => {
  const f = await fixture(), preview = await previewHistoricalLeadContact(client(), f.owner, f.input, previewKey), before = await state(f);
  const where = { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version: previewKey.version } };
  await client().applicationKeyVersion.update({ where, data: { status: 'RETIRED', retiredAt: new Date() } });
  try { await assert.rejects(confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, true)); }
  finally { await client().applicationKeyVersion.update({ where, data: { status: 'ACTIVE', retiredAt: null } }); }
  assert.deepEqual(await state(f), before);
});

test('numeric contact command fragments retain privacy redaction and an exact journal link', options, async () => {
  const f = await fixture();
  const commandId = '03123456-1234-4123-8123-123456789012';
  const preview = await previewHistoricalLeadContact(client(), f.owner, { ...f.input, commandId }, previewKey);
  const result = await confirmHistoricalLeadContact(client(), f.owner, previewKey, preview.token, true);
  const observed = await state(f);
  assert.equal(result.receipt.id, commandId);
  assert.equal((observed.audits[0].after as { recordId: string }).recordId, '[REDACTED:PERSONAL]-4123-8123-123456789012');
  assert.equal(JSON.stringify(observed.audits[0].after).includes(commandId), false);
  const linked = await client().$queryRaw<Array<{ auditId: string }>>`SELECT "auditId" FROM "CommercialLeadHistoricalContact" WHERE id=${commandId}::uuid`;
  assert.equal(linked[0].auditId, observed.audits[0].id);
  assert.deepEqual(observed.cycle, f.cycle);
  assert.equal((await readHistoricalLeadContactOutcome(client(), f.owner, { leadId: f.lead.id, commandId })).state, 'RECORDED');
});

test('numeric conversion command fragments reconcile without weakening privacy or creating a second client', options, async () => {
  const f = await conversionFixture();
  const commandId = '03123456-1234-4123-8123-123456789013';
  const conversion = { ...f.conversion, historicalContact: { ...f.conversion.historicalContact, commandId } };
  const result = await convertCommercialLeadInboxItem(client(), conversion);
  const observed = await state(f);
  assert.equal((observed.conversionAudits[0].after as { recordId: string }).recordId, '[REDACTED:PERSONAL]-4123-8123-123456789013');
  assert.equal(JSON.stringify(observed.conversionAudits[0].after).includes(commandId), false);
  const linked = await client().$queryRaw<Array<{ auditId: string }>>`SELECT "auditId" FROM "CommercialLeadHistoricalConversion" WHERE id=${commandId}::uuid`;
  assert.equal(linked[0].auditId, observed.conversionAudits[0].id);
  assert.equal(observed.cycle.firstResponseAt, null);
  assert.equal((await readHistoricalLeadConversionOutcome(client(), f.owner, { leadId: f.lead.id, commandId })).clientId, result.id);
  assert.equal((await convertCommercialLeadInboxItem(client(), conversion)).id, result.id);
  assert.deepEqual(await state(f), observed);
});
