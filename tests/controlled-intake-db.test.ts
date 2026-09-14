import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { admitBusinessInboxEvent, claimBusinessQueueEvent } from '../src/lib/business-event-backbone';
import {
  ControlledIntakeError,
  createControlledIntake,
  decideControlledIntakeDuplicate,
  linkAuthenticated1265Projection,
} from '../src/lib/controlled-intake';
import { createLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import { calculateLeadIdentityKeyDigest, LEAD_NORMALIZATION_VERSION } from '../src/lib/lead-identity';
import { projectClaimedLeadInboxEvent } from '../src/lib/lead-projection';
import { assignCommercialLeadInboxItem } from '../src/lib/commercial-lead-inbox';
import { prepareServiceCatalogV2 } from '../src/lib/service-catalog-v2-persistence';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';
import { N13_SYNTHETIC_KEY_SECRET, N13_SYNTHETIC_KEY_VERSION } from './fixtures/n13-lead-projection-v1';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './db/ai-orchestrator-db-test-guard';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const db = new PrismaClient();
const userId = 'controlled-intake-db-owner';
const otherUserId = 'controlled-intake-db-other';
const managerUserId = 'controlled-intake-db-manager';
const deniedUserId = 'controlled-intake-db-denied';
const sessionId = randomUUID();
const otherSessionId = randomUUID();
const deniedSessionId = randomUUID();
const managerSessionId = randomUUID();
const secretRoot = mkdtempSync(join(tmpdir(), 'controlled-intake-n13-'));
const secretPath = join(secretRoot, 'synthetic-lead-identity.json');
const actor = { userId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600, role: 'commerciale' as const, active: true, permissionOverrides: [] };
const otherActor = { ...actor, userId: otherUserId, sessionId: otherSessionId };
const managerActor = { userId: managerUserId, sessionId: managerSessionId };
const base = {
  sourceOccurredAt: '2026-09-14T09:00:00.000Z', firstName: 'Ada', lastName: 'Sintetica',
  subjectName: null, email: 'same@intake.invalid', phone: null, effectiveCategory: 'digitale',
  need: 'Richiesta inventata', objective: null, functions: null, indicativeBudget: null,
  timing: null, declaredMaterials: null, engagementReference: null, administrativeRequest: null,
  digitalProjectType: null,
};

function isCode(code: ControlledIntakeError['code']) {
  return (error: unknown) => error instanceof ControlledIntakeError && error.code === code;
}

test.before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await prepareServiceCatalogV2(db);
  await db.user.createMany({ data: [
    { id: userId, email: 'controlled-intake-db@invalid.test', name: 'Operatore sintetico', passwordHash: 'synthetic', role: 'commerciale' },
    { id: otherUserId, email: 'controlled-intake-other@invalid.test', name: 'Altro operatore', passwordHash: 'synthetic', role: 'commerciale' },
    { id: managerUserId, email: 'controlled-intake-manager@invalid.test', name: 'Responsabile sintetico', passwordHash: 'synthetic', role: 'direzione' },
    { id: deniedUserId, email: 'controlled-intake-denied@invalid.test', name: 'Lettore sintetico', passwordHash: 'synthetic', role: 'revisore' },
  ] });
  await db.internalSession.createMany({ data: [
    { id: sessionId, userId, tokenDigest: Buffer.alloc(32, 7), expiresAt: new Date(Date.now() + 3_600_000) },
    { id: otherSessionId, userId: otherUserId, tokenDigest: Buffer.alloc(32, 9), expiresAt: new Date(Date.now() + 3_600_000) },
    { id: managerSessionId, userId: managerUserId, tokenDigest: Buffer.alloc(32, 10), expiresAt: new Date(Date.now() + 3_600_000) },
    { id: deniedSessionId, userId: deniedUserId, tokenDigest: Buffer.alloc(32, 8), expiresAt: new Date(Date.now() + 3_600_000) },
  ] });
  writeFileSync(secretPath, JSON.stringify({ version: N13_SYNTHETIC_KEY_VERSION, secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64') }), { mode: 0o600 });
  await db.privacyNoticeVersion.createMany({ data: [
    { noticeCode: 'SYNTHETIC_PRIVACY_NOTICE', noticeVersion: 'v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', legalBasisCode: 'PRE_CONTRACTUAL_MEASURES', evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64) },
    { noticeCode: 'SYNTHETIC_MARKETING_NOTICE', noticeVersion: 'v1', purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', contentHash: '2'.repeat(64) },
  ] });
  await db.privacyNoticeVersion.updateMany({ where: { status: 'DRAFT' }, data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') } });
  const identityVersion = await db.leadIdentityKeyVersion.create({ data: { normalizationVersion: LEAD_NORMALIZATION_VERSION, version: N13_SYNTHETIC_KEY_VERSION, keyDigest: calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET), createdById: userId } });
  await db.leadIdentityKeyVersion.update({ where: { id: identityVersion.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
  await db.commercialLeadSlaPolicyVersion.create({ data: {
    policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 914, status: 'ACTIVE',
    responseTargetSeconds: 3600, createdById: userId,
  } });
});

test.after(async () => {
  if (enabled) await db.internalSession.updateMany({
    where: { id: { in: [sessionId, otherSessionId, managerSessionId, deniedSessionId] } },
    data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
  });
  await db.$disconnect();
  rmSync(secretRoot, { recursive: true, force: true });
});

test('four channels, N14, scoped replay, duplicate decision and rollback', { skip: !enabled }, async () => {
  const inputs = [
    { ...base, channel: 'WPFORMS_1265', sourceId: '1265-A', subjectType: 'IMPRESA', serviceCode: null },
    { ...base, channel: 'WPFORMS_1098', sourceId: '1098-A', subjectType: 'SOGGETTO_DA_COSTITUIRE', subjectName: 'Progetto da costituire', serviceCode: 'progetti_digitali', digitalProjectType: 'software_crm_workflow', objective: 'Organizzare il lavoro', functions: 'Workflow e ruoli', indicativeBudget: 12000, timing: 'Da concordare', declaredMaterials: 'Campione dichiarato' },
    { ...base, channel: 'EMAIL', sourceId: 'MSG-FISCAL-1', subjectType: 'PROFESSIONISTA', effectiveCategory: 'fiscale', serviceCode: 'consulenza_fiscale', need: 'Esigenza fiscale inventata' },
    { ...base, channel: 'WPFORMS_1485', sourceId: '1485-A', subjectType: 'ENTE', effectiveCategory: 'amministrativa', serviceCode: null, administrativeRequest: 'Bonifico da riconciliare', engagementReference: null },
  ] as const;
  const rows: Awaited<ReturnType<typeof createControlledIntake>>[] = [];
  for (const input of inputs) rows.push(await createControlledIntake(db, actor, input));
  assert.equal(new Set(rows.map(({ id }) => id)).size, 4);
  assert.equal(rows.every(({ status }) => status === 'ENROLLED'), true);
  const inbox = await db.commercialLeadInboxItem.findUniqueOrThrow({
    where: { leadId: rows[0]!.leadId }, include: { slaCycles: true, activities: true },
  });
  assert.equal(inbox.slaCycles.length, 1);
  assert.equal(inbox.activities.some(({ activityType }) => activityType === 'INITIALIZED'), true);

  const digital = rows[1]!;
  assert.equal(digital.subjectType, 'SOGGETTO_DA_COSTITUIRE');
  assert.ok(digital.serviceRevisionId);
  assert.equal(digital.duplicateCandidates.some(({ leadId }) => leadId === rows[0]!.leadId), true);
  await assignCommercialLeadInboxItem(db, { leadId: rows[0]!.leadId, actor: managerActor, targetUserId: otherUserId, expectedInboxVersion: 1 });
  const sanitizedReplay = await createControlledIntake(db, actor, inputs[1]);
  assert.equal(sanitizedReplay.duplicateCandidates.some(({ leadId }) => leadId === rows[0]!.leadId), false);
  await assignCommercialLeadInboxItem(db, { leadId: rows[0]!.leadId, actor: managerActor, targetUserId: userId, expectedInboxVersion: 2 });

  const decision = await decideControlledIntakeDuplicate(db, actor, {
    intakeId: digital.id, candidateLeadId: rows[0]!.leadId,
    outcome: 'KEEP_DISTINCT', expectedVersion: digital.version,
  });
  assert.equal(decision.outcome, 'KEEP_DISTINCT');
  await assert.rejects(decideControlledIntakeDuplicate(db, actor, {
    intakeId: digital.id, candidateLeadId: rows[0]!.leadId,
    outcome: 'LINK_RELATED', expectedVersion: digital.version,
  }), isCode('CONFLICT'));

  await db.lead.update({ where: { id: digital.leadId }, data: { notes: 'Nota libera modificata' } });
  assert.equal((await db.controlledIntake.findUniqueOrThrow({ where: { id: digital.id } })).need, 'Richiesta inventata');
  assert.equal((await createControlledIntake(db, actor, inputs[0])).id, rows[0]!.id);
  await assert.rejects(createControlledIntake(db, actor, { ...inputs[0], need: 'Contenuto diverso' }), isCode('CONFLICT'));

  await assignCommercialLeadInboxItem(db, { leadId: rows[0]!.leadId, actor: managerActor, targetUserId: otherUserId, expectedInboxVersion: 3 });
  await assert.rejects(createControlledIntake(db, actor, inputs[0]), isCode('DENIED'));
  assert.equal((await createControlledIntake(db, otherActor, inputs[0])).id, rows[0]!.id);

  const concurrent = await Promise.all(Array.from({ length: 4 }, () => createControlledIntake(db, actor, {
    ...inputs[0], sourceId: '1265-CONCURRENT', email: 'concurrent@intake.invalid',
  })));
  assert.equal(new Set(concurrent.map(({ id }) => id)).size, 1);
  assert.equal(await db.lead.count({ where: { source: 'INTAKE:WPFORMS_1265:1265-CONCURRENT' } }), 1);

  const before = {
    leads: await db.lead.count(), receipts: await db.websiteLeadReceipt.count(), intakes: await db.controlledIntake.count(),
    inbox: await db.commercialLeadInboxItem.count(), cycles: await db.commercialLeadSlaCycle.count(),
    activities: await db.commercialLeadActivity.count(), audits: await db.auditLog.count(),
  };
  await assert.rejects(createControlledIntake(db, actor, { ...inputs[0], sourceId: 'ROLLBACK' }, true), /SYNTHETIC_FAULT/u);
  assert.deepEqual({
    leads: await db.lead.count(), receipts: await db.websiteLeadReceipt.count(), intakes: await db.controlledIntake.count(),
    inbox: await db.commercialLeadInboxItem.count(), cycles: await db.commercialLeadSlaCycle.count(),
    activities: await db.commercialLeadActivity.count(), audits: await db.auditLog.count(),
  }, before);
});

test('administrative references require visibility and subject pertinence', { skip: !enabled }, async () => {
  const relatedLead = await db.lead.create({ data: {
    firstName: 'Rina', lastName: 'Riferimento', email: 'admin@intake.invalid',
    leadSource: 'manuale', status: 'nuovo', priority: 'media', assignedToId: userId,
  } });
  const unrelatedLead = await db.lead.create({ data: {
    firstName: 'Ugo', lastName: 'Estraneo', email: 'other@intake.invalid',
    leadSource: 'manuale', status: 'nuovo', priority: 'media', assignedToId: userId,
  } });
  const amounts = { taxableAmount: 100, vatAmount: 22, totalAmount: 122 };
  const relatedOffer = await db.commercialOffer.create({ data: { ...amounts, title: 'Preventivo pertinente', leadId: relatedLead.id, createdById: userId } });
  const unrelatedOffer = await db.commercialOffer.create({ data: { ...amounts, title: 'Preventivo estraneo', leadId: unrelatedLead.id, createdById: userId } });
  const input = {
    ...base, channel: 'WPFORMS_1485', sourceId: '1485-VERIFIED', subjectType: 'PERSONA',
    email: 'admin@intake.invalid', effectiveCategory: 'amministrativa', serviceCode: null,
    administrativeRequest: 'Richiesta amministrativa', engagementReference: 'PREV-DICHIARATO',
    commercialOfferId: relatedOffer.id,
  };
  const verified = await createControlledIntake(db, actor, input);
  assert.equal(verified.administrativeState, 'VERIFIED');
  assert.equal(verified.declaredEngagementReference, 'PREV-DICHIARATO');
  assert.equal(verified.commercialOfferId, relatedOffer.id);
  await assert.rejects(createControlledIntake(db, actor, { ...input, sourceId: '1485-UNRELATED', commercialOfferId: unrelatedOffer.id }), isCode('CATALOG_INVALID'));
  await assert.rejects(createControlledIntake(db, actor, { ...input, sourceId: '1485-MISSING', commercialOfferId: 'missing-offer' }), isCode('DENIED'));
});

test('disabled, denied and unavailable catalog writes have no effect', { skip: !enabled, concurrency: false }, async () => {
  const input = { ...base, channel: 'EMAIL', sourceId: 'DENIED', subjectType: 'PERSONA', serviceCode: null } as const;
  const before = await db.controlledIntake.count();
  await assert.rejects(createControlledIntake(db, { ...actor, userId: deniedUserId, sessionId: deniedSessionId, role: 'revisore' }, input), isCode('DENIED'));
  await db.serviceCatalog.update({ where: { code: 'consulenza_fiscale' }, data: { active: false } });
  try {
    await assert.rejects(createControlledIntake(db, actor, { ...input, sourceId: 'INACTIVE', serviceCode: 'consulenza_fiscale' }), isCode('CATALOG_INVALID'));
  } finally {
    await db.serviceCatalog.update({ where: { code: 'consulenza_fiscale' }, data: { active: true } });
  }
  const oldMode = process.env.CONTROLLED_INTAKE_MODE;
  delete process.env.CONTROLLED_INTAKE_MODE;
  try {
    await assert.rejects(createControlledIntake(db, actor, { ...input, sourceId: 'OFF' }), isCode('DISABLED'));
    await assert.rejects(decideControlledIntakeDuplicate(db, actor, {}), isCode('DISABLED'));
  } finally {
    if (oldMode === undefined) delete process.env.CONTROLLED_INTAKE_MODE;
    else process.env.CONTROLLED_INTAKE_MODE = oldMode;
  }
  assert.equal(await db.controlledIntake.count(), before);
});

test('an authenticated 1265 projection is produced by N13/N14, linked and replay-safe', { skip: !enabled }, async () => {
  const seed = syntheticLeadEventInputV1();
  const event = createLeadSubmittedEventV1({
    ...seed,
    eventId: randomUUID(),
    businessCorrelationId: randomUUID(),
    source: { ...seed.source, formCode: '1265', submissionId: 'INTAKE-1265-AUTH-1' },
    payload: { ...seed.payload, email: 'automatic-1265@intake.invalid' },
  });
  const admitted = await admitBusinessInboxEvent(db, event);
  const lease = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID() });
  assert.ok(lease);
  assert.equal(lease.eventRowId, admitted.inboxEventId);
  const projected = await projectClaimedLeadInboxEvent(db, lease, { keyFilePath: secretPath, allowedSecretRoot: secretRoot });
  assert.equal(projected.result.state, 'PROJECTED_NEW');
  const projection = await db.leadProjectionLedger.findUniqueOrThrow({ where: { id: projected.result.ledgerId }, include: { commercialInboxItem: true } });
  assert.equal(projection.commercialInboxItem?.originKind, 'BUSINESS_PROJECTION_N13');
  assert.equal(projection.commercialInboxItem?.formCode, '1265');

  const command = {
    projectionLedgerId: projection.id, effectiveCategory: 'digitale', need: 'Classificazione umana',
    subjectType: 'SOGGETTO_DA_COSTITUIRE', serviceCode: 'progetti_digitali', digitalProjectType: 'software_crm_workflow',
  };
  const linked = await linkAuthenticated1265Projection(db, actor, command);
  assert.equal(linked.acquisitionMode, 'AUTHENTICATED_AUTOMATIC');
  assert.equal(linked.sourceProjectionLedgerId, projection.id);
  assert.ok(linked.serviceRevisionId);
  assert.equal((await linkAuthenticated1265Projection(db, actor, command)).id, linked.id);
  await assert.rejects(linkAuthenticated1265Projection(db, actor, { ...command, need: 'Conflitto' }), isCode('CONFLICT'));
  await assert.rejects(linkAuthenticated1265Projection(db, actor, { ...command, projectionLedgerId: randomUUID() }), isCode('DENIED'));

  const browserEvent = createLeadSubmittedEventV1({
    ...seed,
    eventId: randomUUID(),
    businessCorrelationId: randomUUID(),
    source: { ...seed.source, formCode: '1265', submissionId: 'INTAKE-1265-BROWSER-UNLINKED' },
    payload: {
      ...seed.payload,
      firstName: 'Browser', lastName: 'Da classificare', companyName: 'Browser Distinct Synthetic',
      email: 'automatic-browser@intake.invalid', phone: '+39 333 999 8888',
    },
  });
  const browserAdmission = await admitBusinessInboxEvent(db, browserEvent);
  const browserLease = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID() });
  assert.ok(browserLease);
  assert.equal(browserLease.eventRowId, browserAdmission.inboxEventId);
  const browserProjection = await projectClaimedLeadInboxEvent(db, browserLease, { keyFilePath: secretPath, allowedSecretRoot: secretRoot });
  assert.equal(browserProjection.result.state, 'PROJECTED_NEW');
  assert.equal(await db.controlledIntake.count({ where: { sourceProjectionLedgerId: browserProjection.result.ledgerId } }), 0);
});
