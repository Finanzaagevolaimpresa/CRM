import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './db/ai-orchestrator-db-test-guard';
import { contextFixture, contextPerson, contextDraft, contextThread } from './admin-email/fixture';
import { saveApprovedMessageDraft, readPracticeCommunications, submitApprovedMessage, approveExactMessage, prepareManualMessage } from '../src/lib/approved-communications';
import { previewInternalCommunication, confirmInternalCommunication, listInternalCommunications } from '../src/lib/internal-communications';
import { previewStoredOrdinaryEmail, reserveStoredOrdinaryEmail, loadStoredOrdinaryEmailMaterial } from '../src/lib/ordinary-email-store-candidate';
import { storeCommunicationFile, readCommunicationFile, revokeCommunicationFile } from '../src/lib/communication-files';
import { updateAccountProfile } from '../src/lib/user-account-service';
import { updateInternalUserRoleWithAudit, createInternalUserWithAudit } from '../src/lib/user-privilege-service';
import { lockCommunicationDirectory } from '../src/lib/communication-directory-lock';

const enabled=process.env.CI==='true'&&process.env.ADMIN_EMAIL_CONTEXTS_TESTS==='1'&&assertAiOrchestratorEphemeralDbTestConfiguration({requested:process.env.RUN_DB_TESTS==='1',
  destructiveConfirmed:process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED==='1',databaseUrl:process.env.DATABASE_URL,sentinel:process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment:process.env.APP_ENV,nodeEnvironment:process.env.NODE_ENV});
const db=new PrismaClient(), options={skip:!enabled};
const denied=(e:unknown)=>e instanceof Error&&/DENIED|CONFLICT|RECONCILIATION|INVALID|VIOLATION|CHECK_CURRENT|P2002|Unique constraint/i.test(e.message);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test.before(async()=>{
  if(!enabled)return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.ok(process.env.LOCAL_DOCUMENT_STORAGE_ROOT && path.isAbsolute(process.env.LOCAL_DOCUMENT_STORAGE_ROOT));
  await db.$executeRawUnsafe(`CREATE FUNCTION context_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('fai.context_fault',true)='error' AND NEW."event" IN ('internal_communication_participants_confirmed','m4_draft_saved','communication_file_uploaded') THEN RAISE EXCEPTION 'SYNTHETIC_CONTEXT_AUDIT_FAILURE'; END IF;
    RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER context_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION context_test_audit_fault()');
});
test.after(async()=>db.$disconnect());
const fault={ $transaction: (work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT set_config('fai.context_fault','error',true)`;return work(tx);
},opts)} as unknown as PrismaClient;
function latch(){let done!:()=>void;const promise=new Promise<void>(r=>done=r);return {promise,done};}

test('schema64 is exact, historical v1 payload retained and all context FKs restrict deletion',options,async()=>{
  const [row]=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::integer AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(row.count,64);
  const columns=await db.$queryRaw<Array<{conname:string;confdeltype:string}>>`SELECT conname,confdeltype FROM pg_constraint WHERE contype='f' AND conrelid IN ('"InternalCommunicationThread"'::regclass,'"InternalCommunicationParticipant"'::regclass,'"CommunicationContextFile"'::regclass)`;
  assert.equal(columns.length,9);assert.ok(columns.every(c=>c.confdeltype==='r'));
  const old=await db.approvedCommunication.findUniqueOrThrow({where:{id:'22222222-5252-4252-8252-222222222222'},include:{versions:true}});
  assert.equal(old.contextKind,'LEGACY');assert.equal(old.clientId,'migration52-client');assert.equal((old.versions[0].snapshot as {schema:string}).schema,'fai.approved-email.v1');
});
test('lead and standalone client use real contexts without creating clients or practices',options,async()=>{
  const f=await contextFixture(db),before={clients:await db.client.count(),practices:await db.technicalPractice.count()};
  const lead=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,{kind:'LEAD',id:f.lead.id}));
  const client=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,{kind:'CLIENT',id:f.client.id}));
  assert.equal((await db.approvedCommunication.findUniqueOrThrow({where:{id:lead.id}})).clientId,null);
  assert.equal((await readPracticeCommunications(db,f.owner.actor,{kind:'CLIENT',id:f.client.id})).messages[0].id,client.id);
  assert.deepEqual({clients:await db.client.count(),practices:await db.technicalPractice.count()},before);
  await assert.rejects(saveApprovedMessageDraft(db,f.outsider.actor,contextDraft(f,{kind:'LEAD',id:f.lead.id})),denied);
});
test('internal context admits only current participants including against another Admin and keeps client tables unchanged',options,async()=>{
  const f=await contextFixture(db),before=await db.client.count(),thread=await contextThread(db,f);
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,{kind:'INTERNAL',id:thread.id}));
  const row=await db.approvedCommunication.findUniqueOrThrow({where:{id:saved.id}});assert.equal(row.clientId,null);assert.equal(row.technicalPracticeId,null);
  assert.equal((await readPracticeCommunications(db,f.member.actor,{kind:'INTERNAL',id:thread.id})).messages[0].id,saved.id);
  await assert.rejects(readPracticeCommunications(db,f.outsider.actor,{kind:'INTERNAL',id:thread.id}),denied);
  assert.equal((await listInternalCommunications(db,f.outsider.actor)).length,0);assert.equal(await db.client.count(),before);
});
test('internal preview is not confirmation: step-up and personal binding are mandatory at commit',options,async()=>{
  const f=await contextFixture(db),input={id:randomUUID(),expectedVersion:0,title:'Synthetic preview',selection:{userIds:[f.member.user.id],groups:[]}};
  const noStep={...f.credentials,stepUpToken:undefined},p=await previewInternalCommunication(db,f.owner.actor,input,noStep);
  assert.equal(await db.internalCommunicationThread.count({where:{id:input.id}}),0);
  await assert.rejects(confirmInternalCommunication(db,f.owner.actor,input,p.evidenceHash,noStep),denied);
  await assert.rejects(previewInternalCommunication(db,f.outsider.actor,input,f.credentials),denied);
  await confirmInternalCommunication(db,f.owner.actor,input,p.evidenceHash,f.credentials);
  assert.equal(await db.internalCommunicationParticipant.count({where:{threadId:input.id,active:true}}),2);
});
test('participant changes reject stale preview and double commit; audit is atomic',options,async()=>{
  const f=await contextFixture(db),input={id:randomUUID(),expectedVersion:0,title:'Synthetic CAS',selection:{userIds:[f.member.user.id],groups:[]}};
  const p=await previewInternalCommunication(db,f.owner.actor,input,f.credentials);
  await assert.rejects(confirmInternalCommunication(fault,f.owner.actor,input,p.evidenceHash,f.credentials),/SYNTHETIC_CONTEXT_AUDIT_FAILURE/);
  assert.equal(await db.internalCommunicationThread.count({where:{id:input.id}}),0);
  const results=await Promise.allSettled([confirmInternalCommunication(db,f.owner.actor,input,p.evidenceHash,f.credentials),confirmInternalCommunication(db,f.owner.actor,input,p.evidenceHash,f.credentials)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.auditLog.count({where:{entityId:input.id,event:'internal_communication_participants_confirmed'}}),1);
  const edit={...input,expectedVersion:1,title:'Changed'},preview=await previewInternalCommunication(db,f.owner.actor,edit,f.credentials);
  await db.$transaction(tx=>updateAccountProfile(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},f.member.user.id,{name:'Changed member',email:f.member.user.email},true));
  await assert.rejects(confirmInternalCommunication(db,f.owner.actor,edit,preview.evidenceHash,f.credentials),denied);
});
test('revoked participant loses an open session and prior version cannot be approved after membership changes',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),context={kind:'INTERNAL' as const,id:thread.id};
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,context));
  await previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key});
  const change={...thread,expectedVersion:1,selection:{userIds:[f.owner.user.id],groups:[]}},p=await previewInternalCommunication(db,f.owner.actor,change,f.credentials);
  await confirmInternalCommunication(db,f.owner.actor,change,p.evidenceHash,f.credentials);
  await assert.rejects(readPracticeCommunications(db,f.member.actor,context),denied);
  await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key}),denied);
  assert.equal(await db.internalSession.count({where:{id:f.member.actor.sessionId,revokedAt:null}}),1);
});
test('internal destinations cannot introduce nonparticipants or external addresses',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),input=contextDraft(f,{kind:'INTERNAL',id:thread.id});
  await assert.rejects(saveApprovedMessageDraft(db,f.owner.actor,{...input,to:['outside@invalid.test']}),denied);
  input.recipientSelection.to.userIds=[f.outsider.user.id];await assert.rejects(saveApprovedMessageDraft(db,f.owner.actor,input),denied);
  assert.equal(await db.approvedCommunication.count({where:{internalThreadId:thread.id}}),0);
});
test('native directory email and group membership changes invalidate the exact version',options,async()=>{
  const f=await contextFixture(db),input=contextDraft(f,{kind:'LEAD',id:f.lead.id});input.to=[];input.recipientSelection.to.userIds=[f.member.user.id];
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,input),p=await previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key});
  await db.$transaction(tx=>updateAccountProfile(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},f.member.user.id,{name:f.member.user.name,email:'changed-'+f.member.user.email},true));
  await assert.rejects(reserveStoredOrdinaryEmail(db,f.owner.actor,{messageId:saved.id,requestId:randomUUID(),previewToken:p.token},f.credentials,{key:f.key}),denied);
  const admin=await contextPerson(db,'amministrazione');input.recipientSelection.to={userIds:[],groups:['amministrazione']};input.messageId=randomUUID();
  const groupSaved=await saveApprovedMessageDraft(db,f.owner.actor,input);
  await db.$transaction(tx=>createInternalUserWithAudit(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},{name:'Synthetic new group member',email:`group-${randomUUID()}@invalid.test`,role:'amministrazione',active:true,passwordHash:'unusable'}));
  await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,groupSaved.id,{key:f.key}),denied);
  assert.ok(admin.user.active);
});
test('native role change invalidates selected person evidence; personal owner deactivation blocks conversation reads',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),input=contextDraft(f,{kind:'INTERNAL',id:thread.id}),saved=await saveApprovedMessageDraft(db,f.owner.actor,input);
  await db.$transaction(tx=>updateInternalUserRoleWithAudit(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},f.member.user.id,'consulente'));
  await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key}),denied);
  await db.user.update({where:{id:f.owner.user.id},data:{active:false}});
  await assert.rejects(readPracticeCommunications(db,f.member.actor,input.context),denied);
});
test('lead trash or standalone client deletion blocks stale drafts and never broadens to a practice',options,async()=>{
  const f=await contextFixture(db),context={kind:'LEAD' as const,id:f.lead.id},saved=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,context));
  await db.lead.update({where:{id:f.lead.id},data:{deletedAt:new Date()}});
  await assert.rejects(readPracticeCommunications(db,f.owner.actor,context),denied);await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key}),denied);
  const clientContext={kind:'CLIENT' as const,id:f.client.id};await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,clientContext));
  await db.client.update({where:{id:f.client.id},data:{deletedAt:new Date()}});await assert.rejects(readPracticeCommunications(db,f.owner.actor,clientContext),denied);
});
test('draft CAS and native audit commit exactly once; failed audit creates no message',options,async()=>{
  const f=await contextFixture(db),input=contextDraft(f,{kind:'CLIENT',id:f.client.id});
  await assert.rejects(saveApprovedMessageDraft(fault,f.owner.actor,input),/SYNTHETIC_CONTEXT_AUDIT_FAILURE/);
  assert.equal(await db.approvedCommunication.count({where:{id:input.messageId}}),0);
  const both=await Promise.allSettled([saveApprovedMessageDraft(db,f.owner.actor,input),saveApprovedMessageDraft(db,f.owner.actor,input)]);
  assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(await db.communicationVersion.count({where:{messageId:input.messageId}}),1);
  const audit=await db.auditLog.findFirstOrThrow({where:{entityId:input.messageId,event:'m4_draft_saved'}});
  assert.ok(!JSON.stringify(audit).includes(input.body));assert.ok(!JSON.stringify(audit).includes(input.to[0]));
});
test('internal reservation consumes one exact decision and lost-response replay cannot reserve or enter manual path',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),input=contextDraft(f,{kind:'INTERNAL',id:thread.id});
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,input),p=await previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key});
  const request={messageId:saved.id,requestId:randomUUID(),previewToken:p.token};
  const reserved=await reserveStoredOrdinaryEmail(db,f.owner.actor,request,f.credentials,{key:f.key});
  await assert.rejects(reserveStoredOrdinaryEmail(db,f.owner.actor,request,f.credentials,{key:f.key}),denied);
  await assert.rejects(prepareManualMessage(db,f.owner.actor,{messageId:saved.id,expectedRevision:1,snapshotHash:saved.snapshotHash,requestId:randomUUID()}),denied);
  const material=await loadStoredOrdinaryEmailMaterial(db,f.owner.actor,reserved.attemptId,{key:f.key});assert.equal(material.snapshot.clientId,null);
  assert.equal(await db.ordinaryEmailAttempt.count({where:{messageId:saved.id}}),1);
});
test('private context file upload is scoped, hash-bound, auditable and has no dossier document side effect',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),context={kind:'INTERNAL' as const,id:thread.id},id=randomUUID(),bytes=Buffer.from('SYNTHETIC_PRIVATE_CONTEXT_FILE');
  const before=await db.document.count();await storeCommunicationFile(db,f.owner.actor,{id,context,classification:'ORDINARY'},new File([bytes],'context.txt',{type:'text/plain'}));
  assert.deepEqual((await readCommunicationFile(db,f.member.actor,{id,context,sha256:hash(bytes)})).bytes,bytes);
  await assert.rejects(readCommunicationFile(db,f.outsider.actor,{id,context,sha256:hash(bytes)}),denied);
  await assert.rejects(readCommunicationFile(db,f.owner.actor,{id,context:{kind:'CLIENT',id:f.client.id},sha256:hash(bytes)}),denied);
  await assert.rejects(readCommunicationFile(db,f.member.actor,{id,context,sha256:'a'.repeat(64)}),denied);
  assert.equal(await db.document.count(),before);const row=await db.communicationContextFile.findUniqueOrThrow({where:{id}});
  assert.equal(row.sizeBytes,bytes.length);assert.ok(!path.isAbsolute(row.storagePath));
});
test('file revocation blocks open-reader download and previously prepared email while retaining immutable bytes',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),context={kind:'INTERNAL' as const,id:thread.id},id=randomUUID(),bytes=Buffer.from('SYNTHETIC_REVOKED_FILE');
  await storeCommunicationFile(db,f.owner.actor,{id,context,classification:'ORDINARY'},new File([bytes],'revoke.txt',{type:'text/plain'}));
  const input=contextDraft(f,context);input.contextFileIds=[id];const saved=await saveApprovedMessageDraft(db,f.owner.actor,input);
  await previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key});await revokeCommunicationFile(db,f.owner.actor,{id,context,sha256:hash(bytes)});
  await assert.rejects(readCommunicationFile(db,f.member.actor,{id,context,sha256:hash(bytes)}),denied);await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key}),denied);
  const row=await db.communicationContextFile.findUniqueOrThrow({where:{id}});assert.deepEqual(await readFile(path.join(process.env.LOCAL_DOCUMENT_STORAGE_ROOT!,row.storagePath)),bytes);
  await assert.rejects(db.communicationContextFile.update({where:{id},data:{revokedAt:null}}),/COMMUNICATION_FILE_IMMUTABLE/);
});
test('sensitive files cannot be downgraded, corrupt bytes never leave storage, and file audit failure leaves no accessible metadata',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),context={kind:'INTERNAL' as const,id:thread.id},id=randomUUID(),bytes=Buffer.from('SYNTHETIC_SENSITIVE_FILE');
  await storeCommunicationFile(db,f.owner.actor,{id,context,classification:'SENSITIVE'},new File([bytes],'sensitive.txt',{type:'text/plain'}));
  await assert.rejects(readCommunicationFile(db,f.member.actor,{id,context,sha256:hash(bytes)}),denied);
  const input=contextDraft(f,context);input.contextFileIds=[id];await assert.rejects(saveApprovedMessageDraft(db,f.owner.actor,input),denied);
  const file=await db.communicationContextFile.findUniqueOrThrow({where:{id}});await writeFile(path.join(process.env.LOCAL_DOCUMENT_STORAGE_ROOT!,file.storagePath),'CORRUPT');
  await assert.rejects(readCommunicationFile(db,f.owner.actor,{id,context,sha256:hash(bytes)}),denied);
  const failed=randomUUID();await assert.rejects(storeCommunicationFile(fault,f.owner.actor,{id:failed,context,classification:'ORDINARY'},new File([bytes],'fault.txt',{type:'text/plain'})),/SYNTHETIC_CONTEXT_AUDIT_FAILURE/);
  assert.equal(await db.communicationContextFile.count({where:{id:failed}}),0);
});
test('context identity cannot be rewritten and context rows cannot be deleted',options,async()=>{
  const f=await contextFixture(db),thread=await contextThread(db,f),saved=await saveApprovedMessageDraft(db,f.owner.actor,contextDraft(f,{kind:'INTERNAL',id:thread.id}));
  await assert.rejects(db.approvedCommunication.update({where:{id:saved.id},data:{contextKind:'CLIENT',clientId:f.client.id,internalThreadId:null}}),/COMMUNICATION_CONTEXT_IMMUTABLE/);
  await assert.rejects(db.internalCommunicationParticipant.deleteMany({where:{threadId:thread.id}}));await assert.rejects(db.internalCommunicationThread.delete({where:{id:thread.id}}));
});
test('manual approval revalidates context and current recipient evidence',options,async()=>{
  const f=await contextFixture(db),input=contextDraft(f,{kind:'CLIENT',id:f.client.id});input.recipientSelection.cc.userIds=[f.member.user.id];
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,input),transition={messageId:saved.id,expectedRevision:saved.revision,snapshotHash:saved.snapshotHash};
  await submitApprovedMessage(db,f.owner.actor,transition);await approveExactMessage(db,f.owner.actor,transition);
  await db.$transaction(tx=>updateAccountProfile(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},f.member.user.id,{name:'Recipient renamed',email:f.member.user.email},true));
  await assert.rejects(prepareManualMessage(db,f.owner.actor,{...transition,requestId:randomUUID()}),denied);
});

test('current session expiry during attachment validation rolls back the entire draft and audit',options,async()=>{
  const f=await contextFixture(db),context={kind:'LEAD' as const,id:f.lead.id},id=randomUUID(),bytes=Buffer.from('SYNTHETIC_EXPIRY_FILE');
  await storeCommunicationFile(db,f.owner.actor,{id,context,classification:'ORDINARY'},new File([bytes],'expiry.txt',{type:'text/plain'}));
  const input=contextDraft(f,context);input.contextFileIds=[id];let readStarted=false;
  await db.internalSession.update({where:{id:f.owner.actor.sessionId},data:{expiresAt:new Date(Date.now()+1000)}});
  await assert.rejects(saveApprovedMessageDraft(db,f.owner.actor,input,{readDocument:async()=>{
    readStarted=true;await new Promise(resolve=>setTimeout(resolve,1100));return bytes;
  }}),denied);
  assert.equal(readStarted,true);assert.equal(await db.approvedCommunication.count({where:{id:input.messageId}}),0);
  assert.equal(await db.auditLog.count({where:{entityId:input.messageId}}),0);
});
test('concurrent uploads enforce the context quota including revoked files',options,async()=>{
  const f=await contextFixture(db),context={kind:'LEAD' as const,id:f.lead.id};
  await db.communicationContextFile.createMany({data:Array.from({length:99},()=>({id:randomUUID(),contextKind:'LEAD',leadId:f.lead.id,
    uploadedById:f.owner.user.id,fileName:'synthetic-quota.txt',mimeType:'text/plain',sizeBytes:1,sha256:'a'.repeat(64),
    storagePath:'synthetic-quota/'+randomUUID(),revokedAt:new Date()}))});
  const results=await Promise.allSettled([0,1].map(()=>storeCommunicationFile(db,f.owner.actor,{id:randomUUID(),context,classification:'ORDINARY'},
    new File([Buffer.from('SYNTHETIC_QUOTA')],'quota.txt',{type:'text/plain'}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await db.communicationContextFile.count({where:{leadId:f.lead.id}}),100);
});
test('retired key and revoked native session cannot confirm an earlier participant preview',options,async()=>{
  const f=await contextFixture(db),input={id:randomUUID(),expectedVersion:0,title:'Synthetic stale authorization',selection:{userIds:[f.member.user.id],groups:[]}};
  const p=await previewInternalCommunication(db,f.owner.actor,input,f.credentials);
  await db.internalSession.update({where:{id:f.owner.actor.sessionId},data:{revokedAt:new Date()}});
  await assert.rejects(confirmInternalCommunication(db,f.owner.actor,input,p.evidenceHash,f.credentials),denied);
  const g=await contextFixture(db),other={...input,id:randomUUID(),selection:{userIds:[g.member.user.id],groups:[]}};
  const preview=await previewInternalCommunication(db,g.owner.actor,other,g.credentials);
  await db.applicationKeyVersion.updateMany({where:{purpose:'PRIVILEGED_STEP_UP',status:'ACTIVE'},data:{status:'RETIRED',retiredAt:new Date()}});
  await assert.rejects(confirmInternalCommunication(db,g.owner.actor,other,preview.evidenceHash,g.credentials),denied);
  assert.equal(await db.internalCommunicationThread.count({where:{id:{in:[input.id,other.id]}}}),0);
});
for(const order of ['reader-first','writer-first'] as const)test(`native same-Admin directory writer and preview serialize in ${order} order without deadlock`,options,async()=>{
  const f=await contextFixture(db),input=contextDraft(f,{kind:'LEAD',id:f.lead.id});input.recipientSelection.cc.userIds=[f.member.user.id];
  const saved=await saveApprovedMessageDraft(db,f.owner.actor,input),held=latch(),release=latch(),pending=latch();
  const writer=()=>db.$transaction(async tx=>{
    await lockCommunicationDirectory(tx,true);if(order==='writer-first'){held.done();await release.promise;}
    return updateAccountProfile(tx,{userId:f.owner.user.id,sessionId:f.owner.actor.sessionId},f.member.user.id,{name:'Serialized changed member',email:f.member.user.email},true);
  },{timeout:15_000});
  const readerDb={ $transaction:(work:(tx:Prisma.TransactionClient)=>Promise<unknown>,opts:object)=>db.$transaction(async tx=>{
    await lockCommunicationDirectory(tx);if(order==='reader-first'){held.done();await release.promise;}return work(tx);
  },opts)} as unknown as PrismaClient;
  const reader=()=>previewStoredOrdinaryEmail(readerDb,f.owner.actor,saved.id,{key:f.key});
  const first=order==='reader-first'?reader():writer();await held.promise;
  let settled=false;const second=(order==='reader-first'?writer():reader()).then(value=>{settled=true;pending.done();return value},error=>{settled=true;pending.done();throw error;});
  // Observe the actual PostgreSQL wait; do not rely on scheduling sleeps.
  let blocked=false;for(let i=0;i<100&&!blocked;i++){
    const [row]=await db.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS blocked`;blocked=row.blocked;
    if(!blocked)await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(blocked);assert.equal(settled,false);release.done();await first;
  if(order==='reader-first'){const result=await second;assert.equal((result as {ok:boolean}).ok,true);}else await assert.rejects(second,denied);
  await pending.promise;await assert.rejects(previewStoredOrdinaryEmail(db,f.owner.actor,saved.id,{key:f.key}),denied);
});
