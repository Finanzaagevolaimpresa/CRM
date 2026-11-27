import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { approvedMessageHash, approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';
import type { OrdinaryChannel } from '../../src/lib/ordinary-email-candidate';
import { checkPersistedOrdinaryDecision, confirmOrdinaryDecision, previewOrdinaryDecision, type OrdinaryDecisionCurrentState } from '../../src/lib/ordinary-email-decision';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

// This public, unusable test key only signs historical synthetic material in
// memory. It is never registered in the application or written to the evidence.
const syntheticKey = { version: 77, secret: 'SYNTHETIC-ONLY-schema77-personal-email-no-provider-0000000000000000' };
const historicalAt = new Date('2026-10-20T12:00:00.000Z'), historicalExpiry = new Date('2026-10-20T13:00:00.000Z');
const address = 'comunicazioni@finanzaagevolaimpresa.it';
type Ids = { actorId: string; sessionId: string; leadId: string; messageId: string; versionId: string; decisionId: string; mailboxId: string };
type Evidence = { protocol: string; synthetic: true; schema: number; ids: Ids; hashes: Record<string, string>; mailboxRevision: number;
  historicalAt: string; historicalSessionExpired: true; actorCurrentlyDisabled: true; noAttempts: true; historicalSignatureValid: true; currentAdmissionDenied: true };
type Tx = Prisma.TransactionClient;
let stage = 'guard';

function guard() {
  assert.equal(process.env.APP_ENV, 'test', 'APP_ENV=test required');
  assert.equal(process.env.RUN_DB_TESTS, '1', 'RUN_DB_TESTS=1 required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgresql:', 'postgres:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert(['15479', '15487'].includes(url.port), 'Only dedicated schema qualification ports are allowed');
  assert.equal(url.pathname, '/fai_crm_test'); assert.equal(url.searchParams.get('schema') ?? 'public', 'public');
  assert(process.env.FLOW_EVIDENCE, 'FLOW_EVIDENCE required');
  assert(historicalExpiry < new Date(), 'Historical session must already be expired');
  assert.deepEqual(process.argv.slice(2).filter(arg => !['--seed', '--verify'].includes(arg)), []);
  assert.equal(process.argv.slice(2).length, 1, 'Use exactly --seed or --verify');
}
async function schema(tx: Tx) {
  const rows = await tx.$queryRaw<{ count: number; unfinished: number }[]>`SELECT
    count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::integer AS count,
    count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::integer AS unfinished FROM "_prisma_migrations"`;
  assert.equal(rows[0]?.unfinished, 0); assert([77, 78].includes(rows[0]?.count));
  return rows[0].count;
}
function materialState(ids: Ids, mailboxRevision: number) {
  const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: ids.mailboxId, mailboxRevision, address,
    providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT', channelRevision: 1,
    qualificationReference: 'SYNTHETIC_SCHEMA77_HISTORICAL_ONLY_NO_TRANSPORT' };
  // Historical pure input, not a persisted or currently enabled authority/channel.
  const current: OrdinaryDecisionCurrentState = { actor: { userId: ids.actorId, sessionId: ids.sessionId, role: 'admin', active: true,
    expiresAt: historicalExpiry, registryExpiresAt: historicalExpiry }, authority: { id: 'ordinary-email', purpose: 'ORDINARY_EMAIL',
    userId: ids.actorId, mailboxId: ids.mailboxId, revision: 1, enabled: true }, contextHash: canonicalSha256({ synthetic: 'schema77-personal-email', leadId: ids.leadId, actorId: ids.actorId }) };
  return { channel, current };
}
async function readEvidence(tx: Tx, ids: Ids, mailboxRevision: number): Promise<Evidence> {
  stage = 'read-persisted-evidence';
  const rows = await tx.$queryRaw<{ decisionRow: Record<string, unknown>; versionRow: Record<string, unknown>; messageRow: Record<string, unknown>; serviceMessageId: unknown }[]>`
    SELECT to_jsonb(d)-'serviceMessageId' AS "decisionRow", to_jsonb(v) AS "versionRow", to_jsonb(m) AS "messageRow",
      to_jsonb(d)->'serviceMessageId' AS "serviceMessageId"
    FROM "OrdinaryEmailDecision" d JOIN "CommunicationVersion" v ON v.id=d."versionId"
    JOIN "ApprovedCommunication" m ON m.id=d."messageId"
    WHERE d.id=${ids.decisionId}::uuid AND v.id=${ids.versionId}::uuid AND m.id=${ids.messageId}::uuid`;
  assert.equal(rows.length, 1); const row = rows[0]; assert.equal(row.serviceMessageId, null);
  const snapshot = approvedMessageSnapshotSchema.parse(row.versionRow.snapshot);
  assert.equal(snapshot.schema, 'fai.approved-email.v2'); assert.deepEqual(snapshot.context, { kind: 'LEAD', id: ids.leadId });
  assert.equal(snapshot.clientId, null); assert.equal(snapshot.messageId, ids.messageId); assert.equal(snapshot.mailboxId, ids.mailboxId);
  assert.equal(row.versionRow.snapshotHash, approvedMessageHash(snapshot)); assert.equal(row.messageRow.state, 'DRAFT');
  const { channel, current } = materialState(ids, mailboxRevision), material = { snapshot, channel, materials: new Map<string, Buffer>() };
  assert.equal(typeof row.decisionRow.proof, 'string');
  const checked = checkPersistedOrdinaryDecision(row.decisionRow.decision, row.decisionRow.proof as string, material, current, syntheticKey, historicalAt);
  assert.equal(row.decisionRow.decisionHash, canonicalSha256(checked.decision));
  assert.equal(row.decisionRow.envelopeHash, canonicalSha256(checked.prepared.envelope));
  const actor = await tx.user.findUniqueOrThrow({ where: { id: ids.actorId }, select: { id: true, active: true } });
  const session = await tx.internalSession.findUniqueOrThrow({ where: { id: ids.sessionId }, select: { id: true, userId: true, expiresAt: true } });
  assert.equal(actor.active, false); assert.equal(session.userId, actor.id); assert.equal(session.expiresAt.toISOString(), historicalExpiry.toISOString());
  assert(session.expiresAt < new Date());
  assert.throws(() => checkPersistedOrdinaryDecision(row.decisionRow.decision, row.decisionRow.proof as string, material,
    { ...current, actor: { ...current.actor, active: actor.active } }, syntheticKey, new Date()));
  assert.equal(await tx.ordinaryEmailAttempt.count({ where: { messageId: ids.messageId } }), 0);
  assert.equal(await tx.communicationAttempt.count({ where: { messageId: ids.messageId } }), 0);
  const mailboxes = await tx.$queryRaw<{ row: unknown }[]>`SELECT to_jsonb(m) AS row FROM "CommunicationMailbox" m WHERE id=${ids.mailboxId}::uuid`;
  assert.equal(mailboxes.length, 1);
  const authorities = await tx.$queryRaw<{ row: unknown }[]>`SELECT to_jsonb(a) AS row FROM "OrdinaryEmailAuthority" a ORDER BY id`;
  const channels = await tx.$queryRaw<{ row: unknown }[]>`SELECT to_jsonb(c) AS row FROM "OrdinaryEmailChannel" c ORDER BY "mailboxId"`;
  return { protocol: 'FAI_SCHEMA77_PERSONAL_EMAIL_FIXTURE_V1', synthetic: true, schema: await schema(tx), ids, mailboxRevision,
    historicalAt: historicalAt.toISOString(), historicalSessionExpired: true, actorCurrentlyDisabled: true, noAttempts: true,
    historicalSignatureValid: true, currentAdmissionDenied: true, hashes: {
      decisionRow: canonicalSha256(row.decisionRow), versionRow: canonicalSha256(row.versionRow), messageRow: canonicalSha256(row.messageRow),
      snapshot: approvedMessageHash(snapshot), decision: canonicalSha256(checked.decision), proof: canonicalSha256(row.decisionRow.proof),
      mime: checked.prepared.mimeHash, envelope: canonicalSha256(checked.prepared.envelope), mailbox: canonicalSha256(mailboxes[0].row),
      authorities: canonicalSha256(authorities), channels: canonicalSha256(channels), actor: canonicalSha256(actor),
      session: canonicalSha256({ ...session, expiresAt: session.expiresAt.toISOString() }),
    } };
}
async function seed(tx: Tx) {
  stage = 'seed-schema77-mailbox';
  assert.equal(await schema(tx), 77, 'Seed is allowed only before migration78');
  const mailbox = await tx.communicationMailbox.findUniqueOrThrow({ where: { address }, select: { id: true, revision: true, enabled: true } });
  assert.equal(mailbox.enabled, false, 'Declared fixture mailbox must remain disabled');
  const ids: Ids = { actorId: 'flow_schema77_personal_actor', sessionId: randomUUID(), leadId: 'flow_schema77_personal_lead',
    messageId: randomUUID(), versionId: randomUUID(), decisionId: '', mailboxId: mailbox.id };
  const { channel, current } = materialState(ids, mailbox.revision);
  const snapshot = approvedMessageSnapshotSchema.parse({ schema: 'fai.approved-email.v2', messageId: ids.messageId, revision: 1,
    context: { kind: 'LEAD', id: ids.leadId }, clientId: null, channel: 'EMAIL_MANUAL', mailboxId: mailbox.id, mailboxRevision: mailbox.revision,
    from: address, replyTo: address, to: ['historical-recipient@invalid.test'], cc: [], bcc: [],
    subject: 'SYNTHETIC SCHEMA77 PERSONAL DECISION', body: 'Historical synthetic decision only. No provider, attempt or send.', attachments: [], classification: 'ORDINARY',
    recipientSelection: emptyCommunicationRecipientSelection(), externalRecipients: { to: ['historical-recipient@invalid.test'], cc: [], bcc: [] },
    recipientEvidenceHash: canonicalSha256({ synthetic: 'schema77-recipients' }), contextEvidenceHash: current.contextHash });
  const material = { snapshot, channel, materials: new Map<string, Buffer>() };
  const sessionToken = 'synthetic-schema77-historical-session-no-live-cookie';
  stage = 'pure-historical-signature';
  const preview = previewOrdinaryDecision(material, current, syntheticKey, historicalAt);
  const result = confirmOrdinaryDecision(preview.token, material, current, syntheticKey, { sessionToken,
    stepUpToken: createPrivilegedStepUpToken({ key: syntheticKey, userId: ids.actorId, role: 'admin', sessionToken, nowSeconds: historicalAt.getTime() / 1000 }) }, historicalAt);
  ids.decisionId = result.decision.decisionId;
  // Explicit selects avoid RETURNING columns added by the generated schema78 client.
  stage = 'seed-disabled-user';
  await tx.user.create({ data: { id: ids.actorId, email: 'schema77-personal-actor@invalid.test', name: 'SYNTHETIC HISTORICAL DISABLED ADMIN',
    passwordHash: 'UNUSABLE-SYNTHETIC-NO-LOGIN', role: 'admin', active: false, createdAt: historicalAt, updatedAt: historicalAt }, select: { id: true } });
  stage = 'seed-expired-session';
  await tx.internalSession.create({ data: { id: ids.sessionId, userId: ids.actorId, tokenDigest: createHash('sha256').update(sessionToken).digest(),
    createdAt: historicalAt, expiresAt: historicalExpiry }, select: { id: true } });
  stage = 'seed-lead';
  await tx.lead.create({ data: { id: ids.leadId, firstName: 'SYNTHETIC', lastName: 'Historical lead', email: snapshot.to[0],
    assignedToId: ids.actorId, createdAt: historicalAt, updatedAt: historicalAt }, select: { id: true } });
  stage = 'seed-message';
  await tx.approvedCommunication.create({ data: { id: ids.messageId, contextKind: 'LEAD', leadId: ids.leadId, mailboxId: mailbox.id,
    createdById: ids.actorId, currentRevision: 1, state: 'DRAFT', createdAt: historicalAt, updatedAt: historicalAt }, select: { id: true } });
  stage = 'seed-version';
  await tx.communicationVersion.create({ data: { id: ids.versionId, messageId: ids.messageId, revision: 1, snapshot: snapshot as Prisma.InputJsonValue,
    snapshotHash: approvedMessageHash(snapshot), createdById: ids.actorId, createdAt: historicalAt }, select: { id: true } });
  stage = 'seed-personal-decision';
  await tx.$executeRaw`INSERT INTO "OrdinaryEmailDecision" ("id","messageId","versionId","actorId","sessionId","decision","decisionHash","proof","envelopeHash","createdAt")
    VALUES (${ids.decisionId}::uuid,${ids.messageId}::uuid,${ids.versionId}::uuid,${ids.actorId},${ids.sessionId}::uuid,
      ${JSON.stringify(result.decision)}::jsonb,${result.decisionHash},${result.proof},${canonicalSha256(result.prepared.envelope)},${historicalAt})`;
  return readEvidence(tx, ids, mailbox.revision);
}
async function main() {
  guard();
  const directory = resolve(process.env.FLOW_EVIDENCE!), path = join(directory, 'schema77-personal-email.json'), mode = process.argv[2];
  if (mode === '--seed') assert(!existsSync(path), 'Preserve the existing seed evidence; use --verify');
  const db = new PrismaClient();
  try {
    stage = 'database-sentinel';
    await assertAiOrchestratorEphemeralDatabaseIdentity(db);
    const baseline = mode === '--verify' ? JSON.parse(readFileSync(path, 'utf8')) as Evidence : null;
    if (baseline) { assert.equal(baseline.protocol, 'FAI_SCHEMA77_PERSONAL_EMAIL_FIXTURE_V1'); assert.equal(baseline.synthetic, true); assert.equal(baseline.schema, 77); }
    const evidence = await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      return baseline ? readEvidence(tx, baseline.ids, baseline.mailboxRevision) : seed(tx);
    }, { timeout: 30_000 });
    stage = 'compare-evidence';
    if (baseline) assert.deepEqual({ ...evidence, schema: 77 }, baseline, 'Historical rows, snapshot, decision proof or native MIME changed');
    stage = 'write-evidence';
    mkdirSync(directory, { recursive: true });
    const output = baseline ? join(directory, 'schema77-personal-email.verify-schema' + evidence.schema + '.json') : path;
    writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: baseline ? 'w' : 'wx' });
    console.log(JSON.stringify({ mode, schema: evidence.schema, synthetic: true, historicalSignatureValid: true, currentAdmissionDenied: true,
      snapshotAndDecisionPreserved: Boolean(baseline), attempts: 0, providerWrites: 0, evidenceFile: output }));
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  console.error(JSON.stringify({ error: 'SCHEMA77_PERSONAL_EMAIL_FIXTURE_FAILED', stage,
    kind: error instanceof Error ? error.name : 'UNKNOWN', code: typeof error?.code === 'string' ? error.code : null }));
  process.exitCode = 1;
});
