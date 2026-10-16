import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft, submitApprovedMessage,
  approveExactMessage, prepareManualMessage, readPracticeCommunications } from '../../src/lib/approved-communications';
import { createPrivilegedStepUpToken, privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { loadActivePrivilegedStepUpKey, rotatePrivilegedStepUpKeyVersion, PRIVILEGED_STEP_UP_KEY_PURPOSE } from '../../src/lib/application-key-registry';
import { previewStoredOrdinaryEmail, reserveStoredOrdinaryEmail, takeStoredOrdinaryEmailAttempt,
  checkStoredOrdinaryEmailLease, recordStoredOrdinaryEmailOutcome, loadStoredOrdinaryEmailMaterial, rejectStoredOrdinaryEmail } from '../../src/lib/ordinary-email-store-candidate';
import { prepareOrdinaryEmail, type OrdinaryChannel } from '../../src/lib/ordinary-email-candidate';
import { approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { canonicalJson, canonicalSha256 } from '../../src/lib/canonical-json';
import type { connect } from 'node:tls';
import { confirmAndTransmitStoredOrdinaryEmail } from '../../src/lib/ordinary-email-service-candidate';
import { SyntheticSocket, type WireOptions } from '../helpers/ordinary-smtp-socket';
import { confirmStoredOrdinaryEmailUsingExistingTransport } from '../../src/lib/ordinary-email-runtime-candidate';
import { createOrdinaryTransportResolver, ordinaryTransportQualificationReference } from '../../src/lib/ordinary-email-transport-binding';

const sourceEnvironment = (): Record<string, string | undefined> => ({ DIRECT_EMAIL_TEST_MODE: 'enforced',
  DIRECT_EMAIL_TEST_REFERENCE: 'R49_EMAIL_DIRECT_20260930_01', DIRECT_EMAIL_TEST_SMTP_HOST: 'authsmtp.securemail.pro',
  DIRECT_EMAIL_TEST_SMTP_PASSWORD: 'SYNTHETIC_EXISTING_SOURCE_PASSWORD' });

const enabled = process.env.ORDINARY_EMAIL_STORE_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient(), options = { skip: !enabled };
const key = { version: 1, secret: 'synthetic-email-store-personal-key-0000000000000000' };
const bytes = Buffer.from('SYNTHETIC EMAIL STORE ATTACHMENT'), checksum = createHash('sha256').update(bytes).digest('hex');
const runtime = { key, readDocument: async () => bytes };
const sessionCookies = new Map<string, string>();
test.before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ordinary_store_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."event" LIKE 'ordinary_email_%' THEN
        IF current_setting('fai.ordinary_fault',true)='error' THEN RAISE EXCEPTION 'SYNTHETIC_ORDINARY_AUDIT_FAULT'; END IF;
        IF current_setting('fai.ordinary_fault',true)='outcome-error' AND NEW."event"='ordinary_email_outcome' THEN RAISE EXCEPTION 'SYNTHETIC_ORDINARY_OUTCOME_FAULT'; END IF;
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
  const cookie = createRegistrySessionToken();
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: Buffer.from(await digestRegistrySessionToken(cookie.bytes)), expiresAt: new Date(Date.now()+3_600_000) } });
  sessionCookies.set(session.id, cookie.token);
  return { userId: user.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime()/1000),
    role: 'admin', active: true, permissionOverrides: [] } satisfies AuthSession;
}
async function fixture() {
  const actor = await person();
  const latest = await db.applicationKeyVersion.findFirst({ where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE }, orderBy: { version: 'desc' } });
  key.version = (latest?.version ?? 0) + 1;
  await db.$transaction(tx => rotatePrivilegedStepUpKeyVersion(tx, { version: key.version,
    keyDigest: privilegedStepUpKeyDigest(key.secret), actorUserId: actor.userId }));
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
    SET "mailboxRevision"=EXCLUDED."mailboxRevision","enabled"=true,"revision"="OrdinaryEmailChannel"."revision"+1,
      "qualificationReference"=EXCLUDED."qualificationReference"`;
  const context = { kind: 'TECHNICAL' as const, id: practice.id };
  const input = { messageId: randomUUID(), expectedRevision: 0, context, mailboxId: box.id, replyTo: box.address,
    to: ['recipient@invalid.test'], cc: [], bcc: ['private@invalid.test'], subject: 'Synthetic stored decision', body: 'SYNTHETIC_PRIVATE_BODY',
    attachmentVersionIds: [version.id], classification: 'ORDINARY' };
  const saved = await saveApprovedMessageDraft(db, actor, input, runtime);
  const credentials = { sessionToken: sessionCookies.get(actor.sessionId)!, stepUpToken: undefined as string | undefined };
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
    rows: await db.$queryRaw<Array<{kind:string;count:number}>>`SELECT 'decision' AS kind,count(*)::integer AS count FROM "OrdinaryEmailDecision" WHERE "messageId"=${f.saved.id}::uuid
      UNION ALL SELECT 'attempt',count(*)::integer FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid
      UNION ALL SELECT 'claim',count(*)::integer FROM "OrdinaryEmailClaim" WHERE "attemptId" IN (SELECT "id" FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid)
      UNION ALL SELECT 'outcome',count(*)::integer FROM "OrdinaryEmailOutcome" WHERE "attemptId" IN (SELECT "id" FROM "OrdinaryEmailAttempt" WHERE "messageId"=${f.saved.id}::uuid)`,
    audits: await db.auditLog.findMany({ where: { entityId: f.saved.id }, orderBy: { id: 'asc' } }) };
}
function fault(mode: 'error' | 'delay' | 'outcome-error'): PrismaClient {
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
  const f = await fixture(), shown = await preview(f);
  // Reissue this synthetic preview with the test-only key and the numeric UUID
  // that exposed a native phone-redaction collision. No production key is used.
  const payload=JSON.parse(Buffer.from(shown.token.split('.')[1],'base64url').toString('utf8'));
  payload.decisionId='06505798-e87d-4080-a15b-7cd84d47cdf7';
  const serialized=canonicalJson(payload);
  shown.token=`oe1.${Buffer.from(serialized).toString('base64url')}.${createHmac('sha256',key.secret).update(`fai.ordinary-email.preview.v1\n${serialized}`).digest('hex')}`;
  const reservation = await reserve(f,shown.token);
  assert.deepEqual(shown.summary.bcc,f.input.bcc);
  const row = await db.auditLog.findFirstOrThrow({ where: { entityId: f.saved.id, event: 'ordinary_email_reserved' } });
  const [decision] = await db.$queryRaw<Array<{ decisionHash: string }>>`SELECT "decisionHash" FROM "OrdinaryEmailDecision" WHERE "id"=${reservation.decisionId}::uuid`;
  assert.deepEqual(row.after,{ action:'reserved',decisionId:'ordinary_decision_uuid_06505798e87d4080a15b7cd84d47cdf7',
    attemptId:`ordinary_attempt_uuid_${reservation.attemptId.replaceAll('-','')}`,evidenceHash:decision.decisionHash,status:'RESERVED' });
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
  await db.document.update({where:{id:f.doc.id},data:{fileName:'\u00e8'.repeat(195)+'.txt'}});
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

function syntheticTransport(options: WireOptions = {}) {
  const sockets: SyntheticSocket[] = [];
  return { sockets, dependencies: {
    readQualifiedTransport: async () => ({host:'synthetic.invalid',password:'SYNTHETIC_PASSWORD_ONLY'}),
    connectTls: (() => {
      const socket=new SyntheticSocket(options); sockets.push(socket);
      queueMicrotask(()=>{socket.emit('secureConnect');socket.reply('220 synthetic ready\r\n');});
      return socket;
    }) as unknown as typeof connect,
  }};
}
async function send(f: Fixture, transport = syntheticTransport(), database = db, token?: string) {
  return confirmAndTransmitStoredOrdinaryEmail(database,f.actor,
    {messageId:f.saved.id,requestId:randomUUID(),previewToken:token ?? (await preview(f)).token},f.credentials,runtime,transport.dependencies,
    {deadline:performance.now()+14_000,signal:new AbortController().signal});
}

test('service composes exact personal decision, committed claim, SMTP and private audited receipt', options, async () => {
  const f=await fixture(), shown=await preview(f), transport=syntheticTransport(), result=await send(f,transport,db,shown.token);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'ACCEPTED');
  assert.deepEqual(Object.keys(result).sort(),['attemptId','outcome','status']);
  const state=await footprint(f); assert.equal(state.message.state,'SENT');
  assert.equal(transport.sockets.length,1);
  const wire=transport.sockets[0].writes;
  assert.ok(wire.includes('RCPT TO:<private@invalid.test>\r\n'));
  assert.ok(!wire.find(text=>text.startsWith('From: '))!.includes('private@invalid.test'));
  assert.equal(state.audits.filter(row=>row.event.startsWith('ordinary_email_')).length,3);
  assert.equal((await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::integer AS count FROM "OrdinaryEmailOutcome" WHERE "attemptId"=${result.attemptId}::uuid`)[0].count,1);
  await assert.rejects(send(f,transport,db,shown.token)); assert.equal(transport.sockets.length,1);
});

test('service records uncertain DATA once and blocks every later attempt', options, async () => {
  const f=await fixture(), transport=syntheticTransport({final:null}), result=await send(f,transport);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'UNCERTAIN');
  assert.equal((await footprint(f)).message.state,'UNCERTAIN');
  await assert.rejects(send(f,transport)); assert.equal(transport.sockets.length,1);
  assert.equal(transport.sockets[0].writes.filter(text=>text.startsWith('From: ')).length,1);
});

test('receipt audit fault after transport returns reconciliation and leaves the committed claim blocking', options, async () => {
  const f=await fixture(), transport=syntheticTransport(), result=await send(f,transport,fault('outcome-error'));
  assert.deepEqual(result,{attemptId:result.attemptId,status:'RECONCILIATION_REQUIRED'});
  const state=await footprint(f); assert.equal(state.message.state,'SENDING');
  assert.equal(state.audits.filter(row=>row.event==='ordinary_email_claimed').length,1);
  assert.equal(state.audits.filter(row=>row.event==='ordinary_email_outcome').length,0);
  await assert.rejects(send(f,transport)); assert.equal(transport.sockets.length,1);
});

test('two full service calls with one exact preview can submit at most one MIME body', options, async () => {
  const f=await fixture(), shown=await preview(f), transport=syntheticTransport();
  const results=await Promise.allSettled([send(f,transport,db,shown.token),send(f,transport,db,shown.token)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  const result=results.find(row=>row.status==='fulfilled'); assert.ok(result?.status==='fulfilled');
  assert.equal(result.value.outcome,'ACCEPTED');
  assert.equal(transport.sockets.length,1);
  assert.equal(transport.sockets[0].writes.filter(text=>text.startsWith('From: ')).length,1);
});

test('native DATA locks serialize session, authority, channel, project, document and permission revocations', options, async () => {
  for(const kind of ['session','authority','channel','project','document','permission'] as const) {
    const f=await fixture(); let revocation:Promise<unknown>|undefined, pid=0, blocked=false, completed=false;
    const transport=syntheticTransport({beforeDataReply:async()=>{
      revocation=db.$transaction(async tx=>{
        pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        if(kind==='session') await tx.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
        if(kind==='authority') await tx.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
        if(kind==='channel') await tx.$executeRaw`UPDATE "OrdinaryEmailChannel" SET "enabled"=false,"revision"="revision"+1 WHERE "mailboxId"=${f.box.id}::uuid`;
        if(kind==='project') await tx.project.update({where:{id:f.project.id},data:{status:'archiviato'}});
        if(kind==='document') await tx.document.update({where:{id:f.doc.id},data:{status:'archiviato'}});
        if(kind==='permission') await tx.userPermissionOverride.create({data:{userId:f.actor.userId,permission:'practice_communications.mark_used',allowed:false}});
      },{timeout:10_000}).then(()=>{completed=true;});
      // Observe a real PostgreSQL lock wait, not an arbitrary timer assumption.
      for(let i=0;i<100&&!blocked;i++) {
        if(pid) blocked=(await db.$queryRaw<Array<{blocked:boolean}>>`SELECT cardinality(pg_blocking_pids(${pid}::integer))>0 AS blocked`)[0].blocked;
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,kind); assert.equal(completed,false,kind);
    }});
    const result=await send(f,transport);
    await revocation;
    assert.equal(blocked,true,kind); assert.equal(completed,true,kind);
    assert.equal(result.outcome,'ACCEPTED',kind);
    assert.equal((await footprint(f)).message.state,'SENT');
    await assert.rejects(preview(f));
  }
});

test('session expiry during DATA challenge prevents bytes and records a definite no-send', options, async () => {
  const f=await fixture();
  await db.internalSession.update({where:{id:f.actor.sessionId},data:{expiresAt:new Date(Date.now()+2_000)}});
  const transport=syntheticTransport({beforeDataReply:()=>new Promise(resolve=>setTimeout(resolve,2_100))});
  const result=await send(f,transport);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'NOT_SENT');
  assert.ok(transport.sockets[0].writes.includes('DATA\r\n'));
  assert.ok(!transport.sockets[0].writes.some(text=>text.startsWith('From: ')));
  assert.equal((await footprint(f)).message.state,'ERROR');
});

test('lost DATA guard commit response is uncertain and never retries a submitted message', options, async () => {
  const f=await fixture(), transport=syntheticTransport();
  const lost={$transaction:async(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>{
    const result=await db.$transaction(work,opts);
    if(result&&typeof result==='object'&&'phase' in result&&result.phase==='CONTENT') throw new Error('SYNTHETIC_GUARD_COMMIT_LOST');
    return result;
  }} as unknown as PrismaClient;
  const result=await send(f,transport,lost);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'UNCERTAIN');
  assert.equal((await footprint(f)).message.state,'UNCERTAIN');
  assert.equal(transport.sockets[0].writes.filter(text=>text.startsWith('From: ')).length,1);
  await assert.rejects(send(f,transport)); assert.equal(transport.sockets.length,1);
});

async function rotate(f: Fixture) {
  return db.$transaction(tx => rotatePrivilegedStepUpKeyVersion(tx, { version: key.version+1,
    keyDigest: privilegedStepUpKeyDigest('synthetic-rotated-email-key-000000000000000000'), actorUserId: f.actor.userId }));
}

test('preview and reservation require the registered active key with the exact digest', options, async () => {
  for (const mode of ['unregistered','digest','retired','revoked'] as const) {
    const f=await fixture(), shown=await preview(f), before=await footprint(f);
    const changed={...runtime,key:{...key}};
    if(mode==='unregistered') changed.key.version+=1000;
    if(mode==='digest') changed.key.secret='wrong-synthetic-key-000000000000000000000000000';
    if(mode==='retired') await rotate(f);
    if(mode==='revoked') await db.applicationKeyVersion.update({where:{purpose_version:{purpose:PRIVILEGED_STEP_UP_KEY_PURPOSE,version:key.version}},
      data:{status:'REVOKED',retiredAt:new Date()}});
    await assert.rejects(previewStoredOrdinaryEmail(db,f.actor,f.saved.id,changed),/ORDINARY_EMAIL_STORE_DENIED/);
    await assert.rejects(reserveStoredOrdinaryEmail(db,f.actor,{messageId:f.saved.id,requestId:randomUUID(),previewToken:shown.token},f.credentials,changed),/ORDINARY_EMAIL_STORE_DENIED/);
    assert.deepEqual(await footprint(f),before);
  }
});

test('native rotation invalidates stale preview, reservation material, consumption and claim', options, async () => {
  for(const phase of ['preview','material','consume','claim'] as const) {
    const f=await fixture(), shown=await preview(f);
    const reserved=phase==='preview' ? undefined : await reserve(f,shown.token);
    const input=reserved ? await request(f,reserved.attemptId) : undefined;
    const lease=phase==='claim' ? await takeStoredOrdinaryEmailAttempt(db,f.actor,input!,runtime) : undefined;
    const before=await footprint(f);
    await rotate(f);
    if(phase==='preview') await assert.rejects(reserve(f,shown.token),/ORDINARY_EMAIL_STORE_DENIED/);
    if(phase==='material') await assert.rejects(loadStoredOrdinaryEmailMaterial(db,f.actor,reserved!.attemptId,runtime),/ORDINARY_EMAIL_STORE_DENIED/);
    if(phase==='consume') await assert.rejects(takeStoredOrdinaryEmailAttempt(db,f.actor,input!,runtime),/ORDINARY_EMAIL_STORE_DENIED/);
    if(phase==='claim') await assert.rejects(checkStoredOrdinaryEmailLease(db,f.actor,lease!,runtime),/ORDINARY_EMAIL_STORE_DENIED/);
    assert.deepEqual(await footprint(f),before);
  }
});

test('valid step-up for a different cookie cannot be paired with the claimed native session', options, async () => {
  const f=await fixture(), shown=await preview(f), before=await footprint(f);
  const otherCookie=createRegistrySessionToken();
  await db.internalSession.create({data:{userId:f.actor.userId,tokenDigest:Buffer.from(await digestRegistrySessionToken(otherCookie.bytes)),expiresAt:new Date(Date.now()+3_600_000)}});
  for(const sessionToken of [otherCookie.token,'synthetic-legacy-cookie']) {
    const credentials={sessionToken,stepUpToken:createPrivilegedStepUpToken({key,userId:f.actor.userId,sessionToken})};
    await assert.rejects(reserveStoredOrdinaryEmail(db,f.actor,{messageId:f.saved.id,requestId:randomUUID(),previewToken:shown.token},credentials,runtime),/ORDINARY_EMAIL_STORE_DENIED/);
  }
  assert.deepEqual(await footprint(f),before);
  await reserve(f,shown.token);
});

test('key rotation committed during transport qualification prevents every socket', options, async () => {
  const f=await fixture(), transport=syntheticTransport();
  transport.dependencies.readQualifiedTransport=async()=>{await rotate(f);return {host:'synthetic.invalid',password:'SYNTHETIC_PASSWORD_ONLY'};};
  const result=await send(f,transport);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'NOT_SENT');
  assert.equal(transport.sockets.length,0); assert.equal((await footprint(f)).message.state,'ERROR');
});

test('native key rotation waits for DATA without a lock cycle and its outcome remains recordable', options, async () => {
  const f=await fixture(); let rotation:Promise<unknown>|undefined, pid=0, blocked=false, completed=false;
  const transport=syntheticTransport({beforeDataReply:async()=>{
    rotation=db.$transaction(async tx=>{
      pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      return rotatePrivilegedStepUpKeyVersion(tx,{version:key.version+1,keyDigest:privilegedStepUpKeyDigest('synthetic-rotated-data-key-000000000000000000'),actorUserId:f.actor.userId});
    },{timeout:10_000}).then(()=>{completed=true;});
    for(let i=0;i<100&&!blocked;i++) {
      if(pid) blocked=(await db.$queryRaw<Array<{blocked:boolean}>>`SELECT cardinality(pg_blocking_pids(${pid}::integer))>0 AS blocked`)[0].blocked;
      if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true); assert.equal(completed,false);
  }});
  const result=await send(f,transport); await rotation;
  assert.equal(blocked,true); assert.equal(completed,true); assert.equal(result.outcome,'ACCEPTED');
  assert.equal(transport.sockets[0].writes.filter(text=>text.startsWith('From: ')).length,1);
  await assert.rejects(preview(f),/ORDINARY_EMAIL_STORE_DENIED/);
});

test('native environment key loader agrees with stored rotation and never returns retired material', options, async () => {
  const f=await fixture(), environment={PRIVILEGED_STEP_UP_KEY_VERSION:String(key.version),PRIVILEGED_STEP_UP_SECRET:key.secret};
  assert.deepEqual(await loadActivePrivilegedStepUpKey(db,environment),key);
  assert.equal(await loadActivePrivilegedStepUpKey(db,{...environment,PRIVILEGED_STEP_UP_SECRET:'different-synthetic-key-000000000000000'}),null);
  await rotate(f);
  assert.equal(await loadActivePrivilegedStepUpKey(db,environment),null);
});

const rejection = (f: Fixture) => ({ messageId: f.saved.id, expectedRevision: f.saved.revision,
  snapshotHash: f.saved.snapshotHash, personalConfirmation: 'RIFIUTO_QUESTA_VERSIONE' as const });
const reject = (f: Fixture, store = db) => rejectStoredOrdinaryEmail(store,f.actor,rejection(f),f.credentials,runtime);
async function refusalFootprint(f: Fixture) {
  return { ...await footprint(f), versions: await db.communicationVersion.findMany({where:{messageId:f.saved.id},orderBy:{revision:'asc'}}),
    events: await db.communicationEvent.findMany({where:{messageId:f.saved.id},orderBy:{id:'asc'}}) };
}

test('personal refusal preserves approved material, creates a fresh draft and retains exact minimized audit values', options, async () => {
  const f=await fixture(), shown=await preview(f), binding={messageId:f.saved.id,expectedRevision:1,snapshotHash:f.saved.snapshotHash};
  await submitApprovedMessage(db,f.actor,binding); await approveExactMessage(db,f.actor,binding,runtime);
  const before=await refusalFootprint(f), result=await reject(f), after=await refusalFootprint(f);
  assert.equal(result.revision,2); assert.equal(after.message.state,'DRAFT');
  assert.deepEqual(after.versions[0],before.versions[0]); assert.equal(after.versions.length,2);
  assert.deepEqual(after.versions[1].snapshot,{...before.versions[0].snapshot as object,revision:2});
  assert.equal(await db.communicationApproval.count({where:{versionId:after.versions[0].id}}),1);
  assert.equal(await db.communicationApproval.count({where:{versionId:after.versions[1].id}}),0);
  assert.notEqual(result.snapshotHash,f.saved.snapshotHash);
  const event=after.events.find(row=>row.event==='ORDINARY_REJECTED')!;
  const evidence={rejectedVersion:1,rejectedHash:f.saved.snapshotHash,newVersion:2,newHash:result.snapshotHash,
    versionId:`communication_version_uuid_${after.versions[1].id.replaceAll('-','')}`};
  assert.deepEqual(event.evidence,evidence);
  const audit=after.audits.find(row=>row.event==='ordinary_email_rejected')!;
  assert.deepEqual(audit.after,{action:'rejected',...evidence,evidenceHash:canonicalSha256(evidence),status:'DRAFT'});
  for(const secret of [f.input.body,...f.input.to,...f.input.bcc,f.credentials.sessionToken,key.secret]) assert.ok(!JSON.stringify(audit).includes(secret));
  assert.ok(after.rows.every(row=>row.count===0));
  await assert.rejects(reserve(f,shown.token)); await assert.rejects(reject(f));
  assert.deepEqual(await refusalFootprint(f),after);
});

test('refusal denies changed hashes, versions, actors, cookies and missing step-up without writes', options, async () => {
  const f=await fixture(), before=await refusalFootprint(f), other=await person();
  for(const changed of [{expectedRevision:2},{snapshotHash:'0'.repeat(64)},{personalConfirmation:'on'}]) {
    await assert.rejects(rejectStoredOrdinaryEmail(db,f.actor,{...rejection(f),...changed},f.credentials,runtime));
  }
  await assert.rejects(rejectStoredOrdinaryEmail(db,other,rejection(f),f.credentials,runtime));
  await assert.rejects(rejectStoredOrdinaryEmail(db,f.actor,rejection(f),{...f.credentials,stepUpToken:undefined},runtime));
  const cookie=createRegistrySessionToken().token;
  await assert.rejects(rejectStoredOrdinaryEmail(db,f.actor,rejection(f),{sessionToken:cookie,
    stepUpToken:createPrivilegedStepUpToken({key,userId:f.actor.userId,sessionToken:cookie})},runtime));
  await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
  await assert.rejects(reject(f)); assert.deepEqual(await refusalFootprint(f),before);
});

test('audit failure or expiry during refusal rolls back its draft, event and audit together', options, async () => {
  for(const mode of ['error','delay'] as const) {
    const f=await fixture();
    if(mode==='delay') await db.internalSession.update({where:{id:f.actor.sessionId},data:{expiresAt:new Date(Date.now()+400)}});
    const before=await refusalFootprint(f);
    await assert.rejects(reject(f,fault(mode)));
    assert.deepEqual(await refusalFootprint(f),before);
  }
});

test('concurrent refusal and reservation have one winner and neither path can replay the old version', options, async () => {
  const f=await fixture(), shown=await preview(f);
  const values=await Promise.allSettled([reject(f),reserve(f,shown.token)]);
  assert.equal(values.filter(value=>value.status==='fulfilled').length,1);
  const after=await refusalFootprint(f);
  assert.ok(['DRAFT','SENDING'].includes(after.message.state));
  await assert.rejects(reject(f)); await assert.rejects(reserve(f,shown.token));
  assert.deepEqual(await refusalFootprint(f),after);
});

test('refusal remains possible for a valid draft whose MIME is unsupported; a submitted attempt cannot be refused', options, async () => {
  const f=await fixture();
  await db.document.update({where:{id:f.doc.id},data:{fileName:'\u00e8'.repeat(195)+'.txt'}});
  f.saved=await saveApprovedMessageDraft(db,f.actor,{...f.input,expectedRevision:1},runtime);
  await assert.rejects(preview(f),/ORDINARY_SMTP_MIME_UNSUPPORTED/);
  assert.equal((await reject(f)).revision,3);
  for(const outcome of ['ACCEPTED','UNCERTAIN'] as const) {
    const sent=await fixture(), {lease}=await claimed(sent);
    await recordStoredOrdinaryEmailOutcome(db,lease,{outcome,phase:'CONTENT',...(outcome==='ACCEPTED'?{replyCode:250}:{})});
    const before=await refusalFootprint(sent);
    await assert.rejects(reject(sent)); assert.deepEqual(await refusalFootprint(sent),before);
  }
});

const read = (f: Fixture, actor=f.actor, store=db) => readPracticeCommunications(store,actor,f.input.context);
test('admitted receipt projection distinguishes pending, accepted and historical outcomes without fresh personal approval', options, async () => {
  const f=await fixture(), reserved=await reserve(f);
  let receipt=(await read(f)).messages[0].ordinaryReceipts[0];
  assert.equal(receipt.state,'RESERVED'); assert.equal(receipt.outcome,null);
  const lease=await takeStoredOrdinaryEmailAttempt(db,f.actor,await request(f,reserved.attemptId),runtime);
  assert.equal((await read(f)).messages[0].ordinaryReceipts[0].state,'CLAIMED');
  await recordStoredOrdinaryEmailOutcome(db,lease,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250});
  const delegate=await person();
  await db.user.update({where:{id:delegate.userId},data:{role:'direzione'}});
  await db.userPermissionOverride.create({data:{userId:delegate.userId,permission:'practice_communications.mark_used',allowed:false}});
  await db.$executeRaw`UPDATE "OrdinaryEmailAuthority" SET "enabled"=false,"revision"="revision"+1 WHERE "id"='ordinary-email'`;
  await rotate(f);
  const before=await footprint(f);
  receipt=(await read(f,delegate)).messages[0].ordinaryReceipts[0];
  assert.deepEqual(Object.keys(receipt).sort(),['createdAt','id','outcome','recordedAt','revision','snapshotHash','state']);
  assert.equal(receipt.state,'ACCEPTED'); assert.equal(receipt.outcome,'ACCEPTED'); assert.equal(receipt.revision,1);
  assert.equal(receipt.snapshotHash,f.saved.snapshotHash); assert.ok(receipt.recordedAt instanceof Date);
  assert.deepEqual(await footprint(f),before);
});

test('current context, session, permission and attachment filters precede receipt disclosure', options, async () => {
  for(const change of ['archive','trash','session','permission','document','expiry','classification'] as const) {
    const f=await fixture(); await reserve(f);
    // Native Admin bypasses per-user overrides. Use a current direction actor
    // with a positive read first to exercise effective individual denials.
    if(change==='permission'||change==='classification') {
      await db.user.update({where:{id:f.actor.userId},data:{role:'direzione'}});
      assert.equal((await read(f)).messages.length,1);
    }
    if(change==='archive') await db.project.update({where:{id:f.project.id},data:{status:'archiviato'}});
    if(change==='trash') await db.project.update({where:{id:f.project.id},data:{deletedAt:new Date()}});
    if(change==='session') await db.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
    if(change==='permission') await db.userPermissionOverride.create({data:{userId:f.actor.userId,permission:'practice_communications.read',allowed:false}});
    if(change==='document') await db.document.update({where:{id:f.doc.id},data:{status:'archiviato'}});
    if(change==='expiry') await db.document.update({where:{id:f.doc.id},data:{validUntil:new Date(Date.now()-1)}});
    if(change==='classification') {
      await db.document.update({where:{id:f.doc.id},data:{type:'contratto_fai'}});
      await db.userPermissionOverride.create({data:{userId:f.actor.userId,permission:'contract.read',allowed:false}});
    }
    if(['archive','trash','session','permission'].includes(change)) await assert.rejects(read(f),change);
    else assert.equal((await read(f)).messages.length,0,change);
  }
});

function observeReceiptRead(afterRead:()=>Promise<void>) {
  return {$transaction:(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>db.$transaction(tx=>work(new Proxy(tx,{
    get(target,property,receiver) {
      if(property!=='$queryRaw') return Reflect.get(target,property,receiver);
      return async(...args:unknown[])=>{
        const result=await Reflect.apply(target.$queryRaw,target,args);
        if(Array.isArray(args[0])&&args[0].join('').includes('FROM "OrdinaryEmailAttempt" a')) await afterRead();
        return result;
      };
    },})),opts)} as unknown as PrismaClient;
}

test('selective perimeters deny indirect communication receipts even for Admin and after revocation or expiry', options, async () => {
  for(const state of ['unverified','revoked','expired'] as const) {
    const f=await fixture(); await reserve(f);
    const approver=await person(), approvedAt=new Date(Date.now()-120_000);
    await db.selectiveProjectGrant.create({data:{projectId:f.project.id,recipientId:f.actor.userId,approvedById:approver.userId,
      revision:1,authorityRevision:1,keyVersion:key.version,selection:{},proof:'0'.repeat(64),approvedAt,
      revokedAt:state==='revoked'?new Date():null,expiresAt:state==='expired'?new Date(Date.now()-60_000):null}});
    await assert.rejects(read(f));
    assert.equal(await db.selectiveProjectGrant.count({where:{projectId:f.project.id,recipientId:f.actor.userId}}),1);
  }
});

test('receipt consultation holds current session/project/document locks against concurrent revocations', options, async () => {
  for(const change of ['session','project','document'] as const) {
    const f=await fixture(); await reserve(f);
    let mutation:Promise<unknown>|undefined, pid=0, blocked=false, completed=false;
    const observed=observeReceiptRead(async()=>{
      mutation=db.$transaction(async tx=>{
        pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        if(change==='session') return tx.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
        if(change==='project') return tx.project.update({where:{id:f.project.id},data:{status:'archiviato'}});
        return tx.document.update({where:{id:f.doc.id},data:{status:'archiviato'}});
      },{timeout:10_000}).then(()=>{completed=true;});
      for(let i=0;i<100&&!blocked;i++) {
        if(pid) blocked=(await db.$queryRaw<Array<{blocked:boolean}>>`SELECT cardinality(pg_blocking_pids(${pid}::integer))>0 AS blocked`)[0].blocked;
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true); assert.equal(completed,false);
    });
    assert.equal((await read(f,f.actor,observed)).messages[0].ordinaryReceipts.length,1);
    await mutation; assert.equal(completed,true);
    if(change==='document') assert.equal((await read(f)).messages.length,0);
    else await assert.rejects(read(f));
  }
});

test('DB-clock expiry at the end of receipt consultation denies the entire result without audit writes', options, async () => {
  for(const change of ['session','document'] as const) {
    const f=await fixture(); await reserve(f);
    const expiresAt=new Date(Date.now()+2_000);
    if(change==='session') await db.internalSession.update({where:{id:f.actor.sessionId},data:{expiresAt}});
    else await db.document.update({where:{id:f.doc.id},data:{validUntil:expiresAt}});
    const before=await footprint(f);
    const observed=observeReceiptRead(()=>new Promise(resolve=>setTimeout(resolve,2_100)));
    await assert.rejects(read(f,f.actor,observed));
    assert.deepEqual(await footprint(f),before);
  }
});

async function qualifyExistingSource(f: Fixture, env: Record<string,string|undefined>) {
  const [row] = await db.$queryRaw<Array<{ revision:number }>>`SELECT "revision" FROM "OrdinaryEmailChannel" WHERE "mailboxId"=${f.box.id}::uuid`;
  const channel: OrdinaryChannel = { purpose:'ORDINARY_SMTP', mailboxId:f.box.id, mailboxRevision:f.box.revision,
    address:'comunicazioni@finanzaagevolaimpresa.it', providerReference:'register_it', configurationReference:'M4_COMUNICAZIONI_REGISTER_IT',
    channelRevision:row.revision+1, qualificationReference:'SYNTHETIC_PREPARATION_ONLY' };
  const qualification = ordinaryTransportQualificationReference(channel,key,env);
  await db.$executeRaw`UPDATE "OrdinaryEmailChannel" SET "revision"=${channel.channelRevision},
    "qualificationReference"=${qualification} WHERE "mailboxId"=${f.box.id}::uuid`;
}

test('preview transport availability is current, read-only and does not disable an admitted refusal', options, async () => {
  const f = await fixture(), env = sourceEnvironment();
  const probe = () => {
    const resolver = createOrdinaryTransportResolver(key, { readEnvironment: () => env, connectTls: (() => { throw new Error('NO_SOCKET'); }) as typeof connect });
    return previewStoredOrdinaryEmail(db, f.actor, f.saved.id, { ...runtime, transportAvailable: channel => {
      try { resolver.assertChannel(channel); return true; } catch { return false; }
    } });
  };
  const before = await footprint(f);
  assert.equal((await probe()).sendAvailable, false);
  assert.deepEqual(await footprint(f), before);
  await qualifyExistingSource(f, env);
  const qualified = await footprint(f);
  assert.equal((await probe()).sendAvailable, true);
  assert.deepEqual(await footprint(f), qualified);
  env.DIRECT_EMAIL_TEST_SMTP_PASSWORD += '_CHANGED';
  const stale = await probe();
  assert.equal(stale.sendAvailable, false);
  assert.deepEqual(await footprint(f), qualified);
  const rejected = await rejectStoredOrdinaryEmail(db, f.actor, { messageId: f.saved.id, expectedRevision: stale.revision,
    snapshotHash: stale.snapshotHash, personalConfirmation: 'RIFIUTO_QUESTA_VERSIONE' }, f.credentials, runtime);
  assert.equal(rejected.revision, 2);
});
async function sendExistingSource(f:Fixture, env:Record<string,string|undefined>, transport=syntheticTransport(), database=db,
  token?:string, control={deadline:performance.now()+14_000,signal:new AbortController().signal}) {
  return confirmStoredOrdinaryEmailUsingExistingTransport(database,f.actor,
    {messageId:f.saved.id,requestId:randomUUID(),previewToken:token??(await preview(f)).token},
    f.credentials,runtime,{readEnvironment:()=>env,connectTls:transport.dependencies.connectTls},control);
}

test('existing-source service rejects manual or diagnostic qualification before reservation', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(), before=await footprint(f), transport=syntheticTransport();
  await assert.rejects(sendExistingSource(f,env,transport),/TRANSPORT_UNAVAILABLE/);
  assert.deepEqual(await footprint(f),before); assert.equal(transport.sockets.length,0);
});

test('existing-source exact qualification commits one personal decision and minimized SMTP receipt', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  for(const forbidden of ['DIRECT_EMAIL_TEST_RECIPIENT','DIRECT_EMAIL_TEST_APPROVAL_KEY'])
    Object.defineProperty(env,forbidden,{get(){throw new Error('DIAGNOSTIC_INPUT_NOT_ALLOWED');}});
  const shown=await preview(f), transport=syntheticTransport(), result=await sendExistingSource(f,env,transport,db,shown.token);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'ACCEPTED');
  assert.equal(transport.sockets.length,1); assert.equal((await footprint(f)).message.state,'SENT');
  const [decision]=await db.$queryRaw<Array<{decision:unknown;proof:string}>>`SELECT d."decision",d."proof" FROM "OrdinaryEmailDecision" d
    JOIN "OrdinaryEmailAttempt" a ON a."decisionId"=d."id" WHERE a."id"=${result.attemptId}::uuid`;
  const persisted=JSON.stringify({decision,state:await footprint(f),result});
  assert.ok(!persisted.includes(env.DIRECT_EMAIL_TEST_SMTP_PASSWORD!)); assert.ok(!persisted.includes(key.secret));
  await assert.rejects(sendExistingSource(f,env,transport,db,shown.token));
  assert.equal(transport.sockets[0].writes.filter(value=>value.startsWith('From: ')).length,1);
});

test('unavailable or changed runtime source leaves no reservation or audit', options, async()=>{
  for(const field of ['DIRECT_EMAIL_TEST_MODE','DIRECT_EMAIL_TEST_REFERENCE','DIRECT_EMAIL_TEST_SMTP_HOST','DIRECT_EMAIL_TEST_SMTP_PASSWORD']) {
    const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
    const shown=await preview(f), before=await footprint(f), transport=syntheticTransport();
    env[field]=field==='DIRECT_EMAIL_TEST_SMTP_PASSWORD'?undefined:'SYNTHETIC_CHANGED_SOURCE';
    await assert.rejects(sendExistingSource(f,env,transport,db,shown.token),/TRANSPORT_UNAVAILABLE/);
    assert.deepEqual(await footprint(f),before); assert.equal(transport.sockets.length,0);
  }
});

test('runtime drift after real reservation audit rolls back the entire transaction', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  const before=await footprint(f), transport=syntheticTransport(); let observed=false;
  const changed={ $transaction:(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>db.$transaction(tx=>{
    const wrapped=new Proxy(tx,{get(target,property,receiver){
      if(property!=='auditLog') return Reflect.get(target,property,receiver);
      return new Proxy(target.auditLog,{get(audit,member,auditReceiver){
        if(member!=='create') return Reflect.get(audit,member,auditReceiver);
        return async(args:Prisma.AuditLogCreateArgs)=>{
          const value=await audit.create(args);
          if(args.data.event==='ordinary_email_reserved') { observed=true; env.DIRECT_EMAIL_TEST_SMTP_PASSWORD='SYNTHETIC_ROTATED_DURING_AUDIT'; }
          return value;
        };
      }});
    }});
    return work(wrapped);
  },opts) } as unknown as PrismaClient;
  await assert.rejects(sendExistingSource(f,env,transport,changed),/TRANSPORT_UNAVAILABLE/);
  assert.ok(observed); assert.deepEqual(await footprint(f),before); assert.equal(transport.sockets.length,0);
});

test('runtime drift after opening the qualified socket prevents DATA and does not retry', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  const transport=syntheticTransport(), original=transport.dependencies.connectTls;
  transport.dependencies.connectTls=((...args:Parameters<typeof connect>)=>{
    const socket=Reflect.apply(original,undefined,args);
    env.DIRECT_EMAIL_TEST_SMTP_PASSWORD='SYNTHETIC_ROTATED_AFTER_CONNECT'; return socket;
  }) as typeof connect;
  const result=await sendExistingSource(f,env,transport);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'NOT_SENT');
  assert.equal(transport.sockets.length,1); assert.ok(!transport.sockets[0].writes.includes('DATA\r\n'));
  assert.equal((await footprint(f)).message.state,'ERROR');
});

test('runtime drift during 354 challenge prevents content under the native DATA locks', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  const transport=syntheticTransport({beforeDataReply:async()=>{env.DIRECT_EMAIL_TEST_SMTP_HOST='unqualified.invalid';}});
  const result=await sendExistingSource(f,env,transport);
  assert.equal(result.status,'RECORDED'); assert.equal(result.outcome,'NOT_SENT');
  assert.equal(transport.sockets.length,1); assert.ok(transport.sockets[0].writes.includes('DATA\r\n'));
  assert.ok(!transport.sockets[0].writes.some(value=>value.startsWith('From: ')));
  const [receipt]=await db.$queryRaw<Array<{phase:string;replyCode:number}>>`SELECT "phase","replyCode" FROM "OrdinaryEmailOutcome"
    WHERE "attemptId"=${result.attemptId}::uuid`;
  assert.deepEqual(receipt,{phase:'DATA',replyCode:354});
});

test('a newly qualified channel revision invalidates the previously displayed preview', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  const shown=await preview(f); await qualifyExistingSource(f,env);
  const before=await footprint(f), transport=syntheticTransport();
  await assert.rejects(sendExistingSource(f,env,transport,db,shown.token));
  assert.deepEqual(await footprint(f),before); assert.equal(transport.sockets.length,0);
});

test('cancelled or invalid deadline cannot reserve an existing-source attempt', options, async()=>{
  const f=await fixture(), env=sourceEnvironment(); await qualifyExistingSource(f,env);
  const shown=await preview(f), before=await footprint(f), transport=syntheticTransport(), cancelled=new AbortController(); cancelled.abort();
  for(const control of [{deadline:performance.now()+1_000,signal:cancelled.signal},
    {deadline:Number.NaN,signal:new AbortController().signal},{deadline:0,signal:new AbortController().signal}])
    await assert.rejects(sendExistingSource(f,env,transport,db,shown.token,control),/TRANSPORT_UNAVAILABLE/);
  assert.deepEqual(await footprint(f),before); assert.equal(transport.sockets.length,0);
});
