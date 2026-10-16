import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft, submitApprovedMessage,
  approveExactMessage, prepareManualMessage } from '../../src/lib/approved-communications';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { previewStoredOrdinaryEmail, reserveStoredOrdinaryEmail, takeStoredOrdinaryEmailAttempt,
  checkStoredOrdinaryEmailLease, recordStoredOrdinaryEmailOutcome } from '../../src/lib/ordinary-email-store-candidate';
import { prepareOrdinaryEmail, type OrdinaryChannel } from '../../src/lib/ordinary-email-candidate';
import { approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { canonicalSha256 } from '../../src/lib/canonical-json';

const enabled = process.env.ORDINARY_EMAIL_STORE_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient(), options = { skip: !enabled };
const key = { version: 1, secret: 'synthetic-email-store-personal-key-0000000000000000' };
const bytes = Buffer.from('SYNTHETIC EMAIL STORE ATTACHMENT'), checksum = createHash('sha256').update(bytes).digest('hex');
const runtime = { key, readDocument: async () => bytes };
test.before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ordinary_store_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."event" LIKE 'ordinary_email_%' THEN
        IF current_setting('fai.ordinary_fault',true)='error' THEN RAISE EXCEPTION 'SYNTHETIC_ORDINARY_AUDIT_FAULT'; END IF;
        IF current_setting('fai.ordinary_fault',true)='delay' THEN PERFORM pg_sleep(0.6); END IF;
      END IF;
      RETURN NEW;
    END; $$`);
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS ordinary_store_test_audit_fault ON "AuditLog"');
  await db.$executeRawUnsafe('CREATE TRIGGER ordinary_store_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ordinary_store_test_audit_fault()');
});
test.after(async () => { await db.$disconnect(); });

async function person() {
  const user = await db.user.create({ data: { email: `ordinary-${randomUUID()}@invalid.test`, name: 'Synthetic ordinary authority',
    role: 'admin', passwordHash: 'synthetic-unusable-hash', active: true } });
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now()+3_600_000) } });
  return { userId: user.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime()/1000),
    role: 'admin', active: true, permissionOverrides: [] } satisfies AuthSession;
}
async function fixture() {
  const actor = await person();
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic ordinary client' } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Synthetic ordinary project' } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, title: 'Synthetic ordinary practice',
    practiceType: 'test', targetEntity: 'Synthetic', createdById: actor.userId, technicalOwnerId: actor.userId } });
  const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, title: 'Synthetic document', type: 'documento_operativo',
    fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: bytes.length, storagePath: 'synthetic/ordinary.txt', checksum,
    uploadedById: actor.userId, status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum, storagePath: doc.storagePath } });
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, actor, { mailboxId: before.id, expectedRevision: before.revision, kind: 'MAILBOX',
    canonicalMailboxId: null, providerReference: 'register_it', responsibleUserId: actor.userId, canSend: true, canReceive: true,
    restricted: false, configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_ONLY' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled") VALUES ('ordinary-email',${actor.userId},${box.id}::uuid,true)
    ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference","enabled")
    VALUES (${box.id}::uuid,${box.revision},'SYNTHETIC_ORDINARY_ONLY',true) ON CONFLICT ("mailboxId") DO UPDATE
    SET "mailboxRevision"=EXCLUDED."mailboxRevision","enabled"=true,"revision"="OrdinaryEmailChannel"."revision"+1`;
  const context = { kind: 'TECHNICAL' as const, id: practice.id };
  const input = { messageId: randomUUID(), expectedRevision: 0, context, mailboxId: box.id, replyTo: box.address,
    to: ['recipient@invalid.test'], cc: [], bcc: ['private@invalid.test'], subject: 'Synthetic stored decision', body: 'SYNTHETIC_PRIVATE_BODY',
    attachmentVersionIds: [version.id], classification: 'ORDINARY' };
  const saved = await saveApprovedMessageDraft(db, actor, input, runtime);
  const credentials = { sessionToken: 'synthetic-cookie-'+randomUUID(), stepUpToken: undefined as string | undefined };
  credentials.stepUpToken = createPrivilegedStepUpToken({ key, userId: actor.userId, sessionToken: credentials.sessionToken });
  return { actor, client, project, practice, box, doc, version, input, saved, credentials };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) => previewStoredOrdinaryEmail(db, f.actor, f.saved.id, runtime);
async function reserve(f: Fixture, token?: string, store = db) {
  return reserveStoredOrdinaryEmail(store, f.actor, { messageId: f.saved.id, requestId: randomUUID(), previewToken: token ?? (await preview(f)).token }, f.credentials, runtime);
}
async function request(f: Fixture, attemptId: string) {
  const [row] = await db.$queryRaw<Array<{ decision: { preparedAt: string }; channelRevision: number }>>`
    SELECT d."decision",c."revision" AS "channelRevision" FROM "OrdinaryEmailAttempt" a JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId"
    JOIN "OrdinaryEmailChannel" c ON c."mailboxId"=${f.box.id}::uuid WHERE a."id"=${attemptId}::uuid`;
  const version = await db.communicationVersion.findUniqueOrThrow({ where: { messageId_revision: { messageId: f.saved.id, revision: 1 } } });
  const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: f.box.id, mailboxRevision: f.box.revision,
    address: 'comunicazioni@finanzaagevolaimpresa.it', providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
    channelRevision: row.channelRevision, qualificationReference: 'SYNTHETIC_ORDINARY_ONLY' };
  const prepared = prepareOrdinaryEmail(approvedMessageSnapshotSchema.parse(version.snapshot), channel,
    new Map([[f.version.id,bytes]]), new Date(row.decision.preparedAt));
  return { attemptId, intentHash: prepared.intentHash, mimeHash: prepared.mimeHash, envelopeHash: canonicalSha256(prepared.envelope), channel };
}
async function claimed(f: Fixture) {
  const reserved = await reserve(f), input = await request(f, reserved.attemptId);
  return { reserved, input, lease: await takeStoredOrdinaryEmailAttempt(db, f.actor, input, runtime) };
}
async function footprint(f: Fixture) {
  return { message: await db.approvedCommunication.findUniqueOrThrow({ where: { id: f.saved.id } }),
    rows: await db.$queryRaw`SELECT 'decision' AS kind,count(*)::integer AS count FROM "OrdinaryEmailDecision" WHERE "messageId"=${f.saved.id}::uuid
      UNION ALL SELECT 'attempt',count(*)::integer FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid
      UNION ALL SELECT 'claim',count(*)::integer FROM "OrdinaryEmailClaim" WHERE "attemptId" IN (SELECT "id" FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid)
      UNION ALL SELECT 'outcome',count(*)::integer FROM "OrdinaryEmailOutcome" WHERE "attemptId" IN (SELECT "id" FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid)`,
    audits: await db.auditLog.findMany({ where: { entityId: f.saved.id }, orderBy: { id: 'asc' } }) };
}
function fault(mode: 'error' | 'delay'): PrismaClient {
  return { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>, opts: object) => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('fai.ordinary_fault',${mode},true)`;
    return work(tx);
  }, opts) } as unknown as PrismaClient;
}

test('ordinary store keeps schema50 and has a real native minimizer', options, async () => {
  const [count] = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(count.count,50);
  const [value] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='AuditLog_redaction_n04_v1' AND tgenabled='O') AS present`;
  assert.equal(value.present,true);
});
test('exact reservation and native audit commit together without bodies or addresses', options, async () => {
  const f = await fixture(), shown = await preview(f), reservation = await reserve(f,shown.token);
  assert.deepEqual(shown.summary.bcc,f.input.bcc);
  const row = await db.auditLog.findFirstOrThrow({ where: { entityId: f.saved.id, event: 'ordinary_email_reserved' } });
  const [decision] = await db.$queryRaw<Array<{ decisionHash: string }>>`SELECT "decisionHash" FROM "OrdinaryEmailDecision" WHERE "id"=${reservation.decisionId}::uuid`;
  assert.deepEqual(row.after,{ action:'reserved',decisionId:reservation.decisionId,attemptId:reservation.attemptId,evidenceHash:decision.decisionHash,status:'RESERVED' });
  for (const secret of [f.input.body,...f.input.to,...f.input.bcc,f.credentials.sessionToken,key.secret]) assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal((await footprint(f)).message.state,'SENDING');
});
test('audit fault rolls back the decision, reservation, state and audit', options, async () => {
  const f = await fixture(), shown = await preview(f), before = await footprint(f);
  await assert.rejects(reserve(f,shown.token,fault('error')),/SYNTHETIC_ORDINARY_AUDIT_FAULT/);
  assert.deepEqual(await footprint(f),before);
});
test('real concurrent reservations consume one preview once, including a new requestId', options, async () => {
  const f = await fixture(), shown = await preview(f);
  const results = await Promise.allSettled([reserve(f,shown.token),reserve(f,shown.token)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  await assert.rejects(reserve(f,shown.token));
  const state = await footprint(f); assert.equal(state.message.state,'SENDING');
  assert.equal(state.audits.filter(row=>row.event==='ordinary_email_reserved').length,1);
});
test('another Admin, forged preview and changed authority or channel cannot reserve', options, async () => {
  const f = await fixture(), shown = await preview(f), other = await person(), before = await footprint(f);
  await assert.rejects(reserveStoredOrdinaryEmail(db,other,{messageId:f.saved.id,requestId:randomUUID(),previewToken:shown.token},f.credentials,runtime));
  await assert.rejects(reserve(f,shown.token+'0'));
  await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
  await assert.rejects(reserve(f,shown.token));
  await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=true,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
  await assert.rejects(reserve(f,shown.token));
  const fresh = await preview(f);
  await db.$executeRaw`UPDATE "OrdinaryEmailChannel" SET "revision"="revision"+1 WHERE "mailboxId"=${f.box.id}::uuid`;
  await assert.rejects(reserve(f,fresh.token)); assert.deepEqual(await footprint(f),before);
});
test('changed draft and attachment bytes invalidate the decision before writes', options, async () => {
  const f = await fixture(), shown = await preview(f), before = await footprint(f);
  await assert.rejects(reserveStoredOrdinaryEmail(db,f.actor,{messageId:f.saved.id,requestId:randomUUID(),previewToken:shown.token},f.credentials,
    {...runtime,readDocument:async()=>Buffer.from('changed')}));
  assert.deepEqual(await footprint(f),before);
  await saveApprovedMessageDraft(db,f.actor,{...f.input,expectedRevision:1,body:'Changed synthetic version'},runtime);
  await assert.rejects(reserve(f,shown.token));
  await db.document.update({where:{id:f.doc.id},data:{fileName:'è'.repeat(195)+'.txt'}});
  await saveApprovedMessageDraft(db,f.actor,{...f.input,expectedRevision:2},runtime);
  const unsupported=await footprint(f);
  await assert.rejects(preview(f),/ORDINARY_SMTP_MIME_UNSUPPORTED/);
  assert.deepEqual(await footprint(f),unsupported); assert.equal(unsupported.message.state,'DRAFT');
});
test('expiry during a real audit wait rolls back all reservation writes', options, async () => {
  const f = await fixture(), shown = await preview(f);
  await db.internalSession.update({where:{id:f.actor.sessionId},data:{expiresAt:new Date(Date.now()+400)}});
  const before = await footprint(f);
  await assert.rejects(reserve(f,shown.token,fault('delay')));
  assert.deepEqual(await footprint(f),before);
});
test('document expiry during attachment IO prevents a reservation and expires the preview', options, async () => {
  const f=await fixture();
  await db.document.update({where:{id:f.doc.id},data:{validUntil:new Date(Date.now()+700)}});
  const shown=await preview(f), before=await footprint(f);
  assert.ok(Date.parse(shown.expiresAt)<Date.now()+700);
  await assert.rejects(reserveStoredOrdinaryEmail(db,f.actor,{messageId:f.saved.id,requestId:randomUUID(),previewToken:shown.token},f.credentials,
    {...runtime,readDocument:async()=>{ await new Promise(resolve=>setTimeout(resolve,750)); return bytes; }}));
  assert.deepEqual(await footprint(f),before);
});
test('archive, trash, revoked sessions and current permission denials prevent reservation', options, async () => {
  for (const change of ['archive','trash','session','permission'] as const) {
    const f = await fixture(), shown = await preview(f), before = await footprint(f);
    if(change==='archive') await db.project.update({where:{id:f.project.id},data:{status:'archiviato'}});
    if(change==='trash') await db.project.update({where:{id:f.project.id},data:{deletedAt:new Date()}});
    if(change==='session') await db.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
    if(change==='permission') await db.userPermissionOverride.create({data:{userId:f.actor.userId,permission:'practice_communications.mark_used',allowed:false}});
    await assert.rejects(reserve(f,shown.token)); assert.deepEqual(await footprint(f),before);
  }
});
test('manual and ordinary paths serialize on the native message; only one attempt wins', options, async () => {
  const f = await fixture(), binding={messageId:f.saved.id,expectedRevision:1,snapshotHash:f.saved.snapshotHash};
  await submitApprovedMessage(db,f.actor,binding); await approveExactMessage(db,f.actor,binding,runtime);
  const shown=await preview(f);
  const values=await Promise.allSettled([reserve(f,shown.token),prepareManualMessage(db,f.actor,{...binding,requestId:randomUUID()},runtime)]);
  assert.equal(values.filter(row=>row.status==='fulfilled').length,1);
  const [ordinary]=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::integer AS count FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid`;
  assert.equal(ordinary.count+await db.communicationAttempt.count({where:{messageId:f.saved.id}}),1);
});
test('exact claim is committed once across two PostgreSQL connections and rejects BCC/hash forgery', options, async () => {
  const f=await fixture(), reserved=await reserve(f), input=await request(f,reserved.attemptId);
  await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,{...input,envelopeHash:'0'.repeat(64)},runtime));
  const values=await Promise.allSettled([takeStoredOrdinaryEmailAttempt(db,f.actor,input,runtime),takeStoredOrdinaryEmailAttempt(db,f.actor,input,runtime)]);
  const successful=values.filter(row=>row.status==='fulfilled'); assert.equal(successful.length,1);
  if(successful[0].status==='fulfilled') await checkStoredOrdinaryEmailLease(db,f.actor,successful[0].value,runtime);
  await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,input,runtime));
});
test('claim audit failure leaves the committed reservation blocking; lost commit never permits reuse', options, async () => {
  const f=await fixture(), reserved=await reserve(f), input=await request(f,reserved.attemptId), before=await footprint(f);
  await assert.rejects(takeStoredOrdinaryEmailAttempt(fault('error'),f.actor,input,runtime)); assert.deepEqual(await footprint(f),before);
  const lost={ $transaction:async(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>{
    await db.$transaction(work,opts); throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST');
  }} as unknown as PrismaClient;
  await assert.rejects(takeStoredOrdinaryEmailAttempt(lost,f.actor,input,runtime),/SYNTHETIC_COMMIT_RESPONSE_LOST/);
  await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,input,runtime));
  await assert.rejects(reserve(f));
});
test('receipt audit failure preserves the blocking claim; accepted receipt is immutable and idempotent', options, async () => {
  const f=await fixture(), value=await claimed(f), before=await footprint(f), result={outcome:'ACCEPTED' as const,phase:'CONTENT' as const,replyCode:250};
  await assert.rejects(recordStoredOrdinaryEmailOutcome(fault('error'),value.lease,result)); assert.deepEqual(await footprint(f),before);
  await recordStoredOrdinaryEmailOutcome(db,value.lease,result);
  const after=await footprint(f); assert.equal(after.message.state,'SENT');
  await recordStoredOrdinaryEmailOutcome(db,value.lease,result); assert.deepEqual(await footprint(f),after);
  await assert.rejects(recordStoredOrdinaryEmailOutcome(db,value.lease,{outcome:'NOT_SENT',phase:'CONTENT',replyCode:550}));
  await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,value.input,runtime));
});
test('uncertain receipt blocks new decisions, leases and manual sends without retries', options, async () => {
  const f=await fixture(), value=await claimed(f);
  await recordStoredOrdinaryEmailOutcome(db,value.lease,{outcome:'UNCERTAIN',phase:'CONTENT'});
  assert.equal((await footprint(f)).message.state,'UNCERTAIN');
  await assert.rejects(reserve(f)); await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,value.input,runtime));
  await assert.rejects(prepareManualMessage(db,f.actor,{messageId:f.saved.id,expectedRevision:1,snapshotHash:f.saved.snapshotHash,requestId:randomUUID()},runtime));
});
test('definite no-send requires a new personal preview; an old decision cannot authorize another attempt', options, async () => {
  const f=await fixture(), shown=await preview(f), reservation=await reserve(f,shown.token), input=await request(f,reservation.attemptId);
  const lease=await takeStoredOrdinaryEmailAttempt(db,f.actor,input,runtime);
  await recordStoredOrdinaryEmailOutcome(db,lease,{outcome:'NOT_SENT',phase:'RCPT',replyCode:550});
  assert.equal((await footprint(f)).message.state,'ERROR');
  await assert.rejects(reserve(f,shown.token));
  const next=await reserve(f); assert.notEqual(next.decisionId,reservation.decisionId);
});
test('revocation denies new transport checks but does not discard a private definitive receipt', options, async () => {
  const f=await fixture(), value=await claimed(f);
  await db.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
  await assert.rejects(checkStoredOrdinaryEmailLease(db,f.actor,value.lease,runtime));
  await recordStoredOrdinaryEmailOutcome(db,value.lease,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250});
  assert.equal((await footprint(f)).message.state,'SENT');
});
test('database constraints forbid forged links, evidence edits, impossible receipts and state rollback', options, async () => {
  const f=await fixture(), value=await claimed(f);
  await assert.rejects(db.$executeRaw`UPDATE "OrdinaryEmailDecision" SET "proof"=${'0'.repeat(64)} WHERE "id"=${value.reserved.decisionId}::uuid`);
  await assert.rejects(db.$executeRaw`DELETE FROM "OrdinaryEmailClaim" WHERE "id"=${value.lease.leaseId}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE "OrdinaryEmailAttempt" SET "state"='RESERVED' WHERE "id"=${value.reserved.attemptId}::uuid`);
  await assert.rejects(recordStoredOrdinaryEmailOutcome(db,value.lease,{outcome:'ACCEPTED',phase:'RCPT',replyCode:250}));
  await assert.rejects(recordStoredOrdinaryEmailOutcome(db,value.lease,{outcome:'NOT_SENT',phase:'CONTENT'}));
  await assert.rejects(recordStoredOrdinaryEmailOutcome(db,{...value.lease,leaseId:randomUUID()},{outcome:'UNCERTAIN',phase:'CONTENT'}));
  assert.equal((await footprint(f)).message.state,'SENDING');
  await assert.rejects(db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false WHERE "id"='ordinary-email'`);
  await assert.rejects(db.$executeRaw`DELETE FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email'`);
});
