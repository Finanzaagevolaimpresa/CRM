import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { connect, ConnectionOptions } from 'node:tls';
import { db, fixture, claimed, reserve, runtime, key, person, sessionCookies } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { recordStoredOrdinaryEmailOutcome, previewStoredOrdinaryEmail } from '../../src/lib/ordinary-email-store-candidate';
import { previewStoredOrdinaryRecovery, confirmStoredOrdinaryRecovery } from '../../src/lib/ordinary-email-reconciliation';
import { writeOrdinaryObservation } from '../../src/lib/ordinary-email-observation';
import { confirmAndTransmitStoredOrdinaryEmail } from '../../src/lib/ordinary-email-service-candidate';
import { readPracticeCommunications } from '../../src/lib/approved-communications';
import { SyntheticSocket } from '../helpers/ordinary-smtp-socket';
import { createPrivilegedStepUpToken, privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { rotatePrivilegedStepUpKeyVersion } from '../../src/lib/application-key-registry';
import { verifyOrdinaryRecoveryPreview, signOrdinaryRecoveryPreview } from '../../src/lib/ordinary-email-reconciliation-contract';
import type { OrdinaryRecoveryResult } from '../../src/lib/ordinary-email-reconciliation-contract';

const enabled = process.env.ORDINARY_RECOVERY_DB_TESTS === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested:process.env.RUN_DB_TESTS==='1',destructiveConfirmed:process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED==='1',
  databaseUrl:process.env.DATABASE_URL,sentinel:process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment:process.env.APP_ENV,nodeEnvironment:process.env.NODE_ENV });
const options={skip:!enabled};
test.before(async()=>{
  if(!enabled)return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION recovery_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('fai.recovery_test_fault',true)=NEW."event" THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAULT'; END IF; RETURN NEW; END; $$`);
  await db.$executeRawUnsafe('CREATE OR REPLACE TRIGGER recovery_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION recovery_test_audit_fault()');
});
test.after(async()=>db.$disconnect());
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Claim=Awaited<ReturnType<typeof claimed>>;
const reference=(f:Fixture,c:Claim)=>({messageId:f.saved.id,attemptId:c.reserved.attemptId});
const preview=(f:Fixture,c:Claim)=>previewStoredOrdinaryRecovery(db,f.actor,reference(f,c),runtime);
async function ended(c:Claim){await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(c.lease.expiresAt)-Date.now()+100)));}
function ready(p:OrdinaryRecoveryResult){assert.equal(p.status,'READY');if(p.status!=='READY')throw new Error('NOT_READY');return p;}
const confirm=(f:Fixture,c:Claim,p:ReturnType<typeof ready>,store:Pick<PrismaClient,'$transaction'>=db)=>
  confirmStoredOrdinaryRecovery(store,f.actor,{...reference(f,c),token:p.token,reason:'Recupero sintetico della sola prova',confirmed:true},f.credentials,runtime);
async function counts(f:Fixture){
  const rows=await db.$queryRaw<Array<{state:string;outcome:string|null;recovery:string|null}>>`SELECT a."state",o."outcome",r."id" AS recovery
    FROM "OrdinaryEmailAttempt" a LEFT JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
    LEFT JOIN "OrdinaryEmailReconciliation" r ON r."attemptId"=a."id" WHERE a."messageId"=${f.saved.id}::uuid`;
  return {rows,events:await db.communicationEvent.count({where:{messageId:f.saved.id,event:'ORDINARY_OUTCOME_RECONCILED'}}),
    audits:await db.auditLog.count({where:{entityId:f.saved.id,event:'ordinary_email_reconciled'}})};
}
function fault(event:string):Pick<PrismaClient,'$transaction'>{
  return {$transaction:(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT set_config('fai.recovery_test_fault',${event},true)`;return work(tx);
  },opts)} as Pick<PrismaClient,'$transaction'>;
}
test('schema75 exposes the append-only recovery surface and binding guards',options,async()=>{
  const [r]=await db.$queryRaw<Array<{n:bigint}>>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(r.n,75n);
  const [guards]=await db.$queryRaw<Array<{n:bigint}>>`SELECT count(*) AS n FROM pg_trigger WHERE tgname IN
    ('OrdinaryEmailReconciliation_immutable','OrdinaryEmailReconciliation_no_truncate','OrdinaryEmailReconciliation_binding') AND tgenabled='O'`;
  assert.equal(guards.n,3n);
});
test('lost receipt persistence recovers a real synthetic wire observation once, without another transport',options,async()=>{
  const f=await fixture(), sockets:SyntheticSocket[]=[];
  const transport={readQualifiedTransport:async()=>({host:'smtp.synthetic.invalid',password:'SYNTHETIC_ONLY'}),
    connectTls:((config:ConnectionOptions)=>{assert.equal(config.rejectUnauthorized,true);const s=new SyntheticSocket({});sockets.push(s);queueMicrotask(()=>{s.emit('secureConnect');s.reply('220 synthetic ready\r\n');});return s;}) as unknown as typeof connect};
  const send=await confirmAndTransmitStoredOrdinaryEmail(fault('ordinary_email_outcome'),f.actor,
    {messageId:f.saved.id,requestId:randomUUID(),previewToken:(await previewStoredOrdinaryEmail(db,f.actor,f.saved.id,runtime)).token},
    f.credentials,runtime,transport,{deadline:performance.now()+14000,signal:AbortSignal.timeout(15000)});
  assert.equal(send.status,'RECONCILIATION_REQUIRED');assert.equal(sockets.length,1);
  const [claim]=await db.$queryRaw<Array<{expiresAt:Date}>>`SELECT "expiresAt" FROM "OrdinaryEmailClaim" WHERE "attemptId"=${send.attemptId}::uuid`;
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,claim.expiresAt.getTime()-Date.now()+100)));
  const ref={messageId:f.saved.id,attemptId:send.attemptId}, p=ready(await previewStoredOrdinaryRecovery(db,f.actor,ref,runtime));
  const input={...ref,token:p.token,reason:'Recupero dopo perdita della ricevuta sintetica',confirmed:true};
  const first=await confirmStoredOrdinaryRecovery(db,f.actor,input,f.credentials,runtime);
  const again=await confirmStoredOrdinaryRecovery(db,f.actor,input,f.credentials,runtime);
  assert.deepEqual(again,first);await assert.rejects(confirmStoredOrdinaryRecovery(db,f.actor,{...input,reason:'Motivo diverso per lo stesso comando'},f.credentials,runtime));assert.equal(first.status,'RECORDED');assert.equal(sockets.length,1);
  const current=await counts(f);assert.equal(current.rows.length,1);assert.equal(current.rows[0].state,'ACCEPTED');
  assert.equal(current.events,1);assert.equal(current.audits,1);
  const reopened=await previewStoredOrdinaryRecovery(db,f.actor,ref,runtime);assert.deepEqual(reopened,first);
});
test('uncertain immutable receipt is retained and the appended observation resolves effective readback',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  await recordStoredOrdinaryEmailOutcome(db,c.lease,{outcome:'UNCERTAIN',phase:'CONTENT',replyCode:250});
  const before=await db.ordinaryEmailOutcome.findUniqueOrThrow({where:{attemptId:c.reserved.attemptId}});
  await ended(c);const p=ready(await preview(f,c));await confirm(f,c,p);
  assert.deepEqual(await db.ordinaryEmailOutcome.findUniqueOrThrow({where:{attemptId:c.reserved.attemptId}}),before);
  const view=await readPracticeCommunications(db,f.actor,f.input.context);
  const receipt=view.messages.find(m=>m.id===f.saved.id)!.ordinaryReceipts[0];
  assert.equal(receipt.state,'ACCEPTED');assert.equal(receipt.outcome,'ACCEPTED');
  assert.equal(receipt.reconciliation?.originalOutcome,'UNCERTAIN');assert.equal(receipt.reconciliation?.sourceHash,p.sourceHash);
  await assert.rejects(db.$executeRaw`UPDATE "OrdinaryEmailOutcome" SET "outcome"='NOT_SENT' WHERE "attemptId"=${c.reserved.attemptId}::uuid`);
  await assert.rejects(db.$executeRaw`DELETE FROM "OrdinaryEmailReconciliation" WHERE "attemptId"=${c.reserved.attemptId}::uuid`);
});
test('missing proof, live claim, tampered file and another attempt cannot create a definitive outcome',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  assert.deepEqual(await preview(f,c),{status:'WAITING',reason:'IN_PROGRESS'});
  await recordStoredOrdinaryEmailOutcome(db,c.lease,{outcome:'UNCERTAIN',phase:'CONTENT'});
  await ended(c);assert.deepEqual(await preview(f,c),{status:'WAITING',reason:'NO_AUTHORITATIVE_OBSERVATION'});
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  const file=path.join(process.env.LOCAL_DOCUMENT_STORAGE_ROOT!,'ordinary-email-observations',c.reserved.attemptId+'.json');
  const good=await readFile(file), bad=JSON.parse(good.toString());bad.mac='0'.repeat(64);await writeFile(file,JSON.stringify(bad));
  assert.deepEqual(await preview(f,c),{status:'WAITING',reason:'NO_AUTHORITATIVE_OBSERVATION'});
  const before=await counts(f);assert.equal(before.rows[0].state,'UNCERTAIN');assert.equal(before.audits,0);
  await writeFile(file,good);
  await assert.rejects(previewStoredOrdinaryRecovery(db,f.actor,{messageId:randomUUID(),attemptId:c.reserved.attemptId},runtime));
  assert.deepEqual(await counts(f),before);
});
test('two concurrent confirmations create one recovery and authoritative NOT_SENT permits only a fresh personal send decision',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'NOT_SENT',phase:'CONTENT',replyCode:550},new Date());
  await ended(c);const p=ready(await preview(f,c));
  const [a,b]=await Promise.all([confirm(f,c,p),confirm(f,c,p)]);assert.deepEqual(a,b);
  const current=await counts(f);assert.equal(current.rows[0].state,'NOT_SENT');assert.equal(current.audits,1);assert.equal(current.events,1);
  const again=await reserve(f);assert.notEqual(again.attemptId,c.reserved.attemptId);
  assert.equal((await counts(f)).rows.length,2);
});
test('recovery rejects missing confirmation, absent step-up and revoked session without consuming the proof',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  await ended(c);const p=ready(await preview(f,c)), input={...reference(f,c),token:p.token,reason:'Recupero sintetico',confirmed:true};
  await assert.rejects(confirmStoredOrdinaryRecovery(db,f.actor,{...input,confirmed:false},f.credentials,runtime));
  await assert.rejects(confirmStoredOrdinaryRecovery(db,f.actor,input,{...f.credentials,stepUpToken:undefined},runtime));
  await db.internalSession.update({where:{id:f.actor.sessionId},data:{revokedAt:new Date()}});
  await assert.rejects(confirmStoredOrdinaryRecovery(db,f.actor,input,f.credentials,runtime));
  assert.equal((await counts(f)).audits,0);
  const admin=await person(), token=sessionCookies.get(admin.sessionId)!;
  const credentials={sessionToken:token,stepUpToken:createPrivilegedStepUpToken({key,userId:admin.userId,sessionToken:token,role:'admin'})};
  const fresh=ready(await previewStoredOrdinaryRecovery(db,admin,reference(f,c),runtime));
  assert.equal((await confirmStoredOrdinaryRecovery(db,admin,{...input,token:fresh.token},credentials,runtime)).status,'RECORDED');
});
test('current key rotation invalidates an open preview while preserving historical transport proof',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  await ended(c);const old=ready(await preview(f,c));
  key.version++;await db.$transaction(tx=>rotatePrivilegedStepUpKeyVersion(tx,{version:key.version,keyDigest:privilegedStepUpKeyDigest(key.secret),actorUserId:f.actor.userId}));
  f.credentials.stepUpToken=createPrivilegedStepUpToken({key,userId:f.actor.userId,sessionToken:f.credentials.sessionToken,role:'admin'});
  await assert.rejects(confirm(f,c,old));
  const fresh=ready(await preview(f,c));assert.equal(fresh.sourceHash,old.sourceHash);await confirm(f,c,fresh);
  assert.equal((await counts(f)).audits,1);
});
test('a failed recovery audit rolls back receipt and transition; same proof can be checked without another send',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  await ended(c);const p=ready(await preview(f,c)),before=await counts(f);
  await assert.rejects(confirm(f,c,p,fault('ordinary_email_reconciled')));
  assert.deepEqual(await counts(f),before);
  await confirm(f,c,p);assert.equal((await counts(f)).audits,1);
});
test('an unclaimed reservation remains blocked and is never presented as a proven SMTP failure',options,async()=>{
  const f=await fixture(),r=await reserve(f);
  assert.deepEqual(await previewStoredOrdinaryRecovery(db,f.actor,{messageId:f.saved.id,attemptId:r.attemptId},runtime),
    {status:'WAITING',reason:'RESERVED_WITHOUT_CLAIM'});
  assert.equal((await counts(f)).rows[0].state,'RESERVED');
});

test('expired recovery preview and current role withdrawal deny mutation; a fresh Admin decision retains the original proof',options,async()=>{
  const f=await fixture(),c=await claimed(f);
  await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
  await ended(c);const p=ready(await preview(f,c));
  const payload=verifyOrdinaryRecoveryPreview(p.token,key,new Date()), now=Date.now();
  const expired={...p,token:signOrdinaryRecoveryPreview({...payload,issuedAt:new Date(now-301000).toISOString(),expiresAt:new Date(now-1000).toISOString()},key)};
  await assert.rejects(confirm(f,c,expired));
  await db.user.update({where:{id:f.actor.userId},data:{role:'commerciale'}});
  await assert.rejects(confirm(f,c,p));
  assert.equal((await counts(f)).audits,0);
  await db.user.update({where:{id:f.actor.userId},data:{role:'admin'}});
  const fresh=ready(await preview(f,c));assert.equal(fresh.sourceHash,p.sourceHash);
  await confirm(f,c,fresh);assert.equal((await counts(f)).audits,1);
});
