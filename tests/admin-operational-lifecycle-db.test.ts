import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { before, after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { adminHistoryFixture } from './admin-records/history-fixture';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from './record-updates/communication-fixtures';
import { lifecycleReadinessFixture, lifecyclePrivateDocumentFixture } from './admin-lifecycle/fixtures';
import { assignTechnical } from './technical-assignments/fixtures';
import { readTechnicalWorkDocument } from '../src/lib/technical-assignment-access';
import { readPersonalAcquiredDocument, listPersonalAcquiredDocuments } from '../src/lib/technical-document-acquired-access';
import { readAdminOperationalState, saveAdminOperationalState, reconcileAdminOperationalState, listAdminOperationalSources, type AdminOperationalCommand } from '../src/lib/admin-operational-lifecycle';
import { readOperationalState } from '../src/lib/admin-operational-state';
import { readPracticeCommunications, saveApprovedMessageDraft, submitApprovedMessage } from '../src/lib/approved-communications';
import { listAccessiblePracticeReadiness } from '../src/lib/practice-readiness';
import { loadAdminRecord } from '../src/lib/admin-records';
import { readPrivateDocumentBounded } from '../src/lib/storage';
import { getEngagementDossierReadAccess, reviseEngagementDossier, mutateInitialServiceWorkflow } from '../src/lib/engagement-dossier';

const enabled=process.env.ADMIN_LIFECYCLE_DB_TESTS==='1'&&process.env.RUN_DB_TESTS==='1';
const options={skip:!enabled}, db=new PrismaClient();
type Person=Awaited<ReturnType<typeof syntheticPerson>>;
let admin:Person;
const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
before(async()=>{
  if(!enabled)return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const migration='20261030100000_admin_operational_lifecycle_v1';
  const sql=readFileSync(resolve(import.meta.dirname,'../prisma/migrations',migration,'migration.sql'),'utf8').replaceAll('\r\n','\n');
  const ledger=await db.$queryRaw<Array<{migration_name:string;checksum:string}>>`SELECT migration_name,checksum
    FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
  assert.equal(ledger.length,73);assert.equal(ledger.at(-1)?.migration_name,migration);
  assert.equal(ledger.at(-1)?.checksum,createHash('sha256').update(sql).digest('hex'),'CURRENT_LIFECYCLE_SQL_REQUIRED');
  const existing=await db.selectiveAccessAuthority.findFirst();
  if(existing){const user=await db.user.findUniqueOrThrow({where:{id:existing.userId}});admin={user,...await syntheticSession(db,user)};}
  else admin=await syntheticAuthority(db);
  const mailbox=await db.communicationMailbox.findUniqueOrThrow({where:{address:'comunicazioni@finanzaagevolaimpresa.it'}});
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority"(id,"userId","mailboxId",enabled) VALUES('ordinary-email',${admin.user.id},${mailbox.id}::uuid,true)
    ON CONFLICT(id) DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId",enabled=true,revision="OrdinaryEmailAuthority".revision+1`;
});
after(()=>db.$disconnect());
function proof(person=admin,secondsAgo=0){
  return {key,sessionToken:person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:person.user.id,sessionToken:person.token,
    role:person.user.role,nowSeconds:Math.floor(Date.now()/1000)-secondsAgo})};
}
async function command(model:AdminOperationalCommand['model'],id:string,state:AdminOperationalCommand['state'],person=admin){
  const data=await readAdminOperationalState(db,person.session,model,id);
  return {commandId:randomUUID(),model,id,state,expectedVersion:data.expectedVersion,reason:'Cambio di stato sintetico isolato',confirmed:true} satisfies AdminOperationalCommand;
}
const save=(input:AdminOperationalCommand,person=admin,secondsAgo=0)=>saveAdminOperationalState(db,person.session,input,proof(person,secondsAgo));
async function intake(){return adminHistoryFixture(db,admin.user.id);}
async function message(){
  const f=await intake(),m=await storedNoticeMessage(db,{leadId:f.lead.id,authorId:admin.user.id});
  return {...f,...m};
}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

test('each new immutable source is enrolled once at active zero without an invented administrative decision',options,async()=>{
  const f=await message(),reply=await linkedOrdinaryNoticeReply(db,f.message.id,f.mailbox.id,admin.user.id);
  for(const [model,id]of [['ControlledIntake',f.intake.id],['ApprovedCommunication',f.message.id],['CommunicationReply',reply.reply.id]] as const){
    const state=await readAdminOperationalState(db,admin.session,model,id);
    assert.equal(state.state,'ACTIVE');assert.equal(state.version,0);assert.equal(state.history.length,0);
    assert.equal(await db.adminOperationalState.count({where:{model,recordId:id}}),1);
  }
});

test('block archive trash and restore persist with one journal per transition and unchanged acquisition source',options,async()=>{
  const f=await intake(),before=await db.controlledIntake.findUniqueOrThrow({where:{id:f.intake.id}});
  let version=0;
  for(const state of ['BLOCKED','ARCHIVED','TRASHED','ACTIVE'] as const){
    const input=await command('ControlledIntake',f.intake.id,state);
    assert.equal((await save(input)).replayed,false);assert.equal((await save(input)).replayed,true);
    const reopened=await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id);
    assert.equal(reopened.state,state);assert.equal(reopened.version,++version);
    assert.equal(await db.auditLog.count({where:{id:'admin-record:'+input.commandId}}),1);
    assert.deepEqual(await db.controlledIntake.findUniqueOrThrow({where:{id:f.intake.id}}),before);
  }
  const source=await loadAdminRecord(db,admin.session,'ControlledIntake',f.intake.id);
  assert.equal(source.history.length,0);assert(source.relationships.some(row=>row.href.includes('/admin/lifecycle/')));
});

test('current Admin role permissions thirty-minute proof and revoked session are checked before state changes',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'BLOCKED');
  const outsider=await syntheticPerson(db,'Tecnico sintetico lifecycle','consulente');
  await assert.rejects(readAdminOperationalState(db,outsider.session,'ControlledIntake',f.intake.id));
  await assert.rejects(save(input,outsider));
  await assert.rejects(save(input,admin,1801));
  await db.userPermissionOverride.create({data:{userId:admin.user.id,permission:'lead.write',allowed:false}});
  try{await assert.rejects(save(input));}finally{await db.userPermissionOverride.delete({where:{userId_permission:{userId:admin.user.id,permission:'lead.write'}}});}
  await save(input,admin,1700);
  const second=await syntheticPerson(db,'Admin revocato sintetico','admin');
  const restore=await command('ControlledIntake',f.intake.id,'ACTIVE',second);
  await db.internalSession.update({where:{id:second.session.sessionId},data:{revokedAt:new Date()}});
  await assert.rejects(save(restore,second));
  assert.equal((await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id)).state,'BLOCKED');
});

test('changed source and substituted command are refused while the exact persisted command is replayable',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'BLOCKED');
  await db.controlledIntake.update({where:{id:f.intake.id},data:{version:{increment:1}}});
  await assert.rejects(save(input),/STALE/);
  const current=await command('ControlledIntake',f.intake.id,'BLOCKED');await save(current);
  await assert.rejects(save({...current,state:'ARCHIVED'}),/STALE/);
  const other=await syntheticPerson(db,'Altro Admin sintetico','admin');
  await assert.rejects(reconcileAdminOperationalState(db,other.session,{commandId:current.commandId,model:current.model,id:current.id,close:false}),/DENIED/);
  assert.equal((await reconcileAdminOperationalState(db,admin.session,{commandId:current.commandId,model:current.model,id:current.id,close:false})).status,'RECORDED');
});

test('closing an unused attempt fences late delivery and a fresh command changes state once',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'ARCHIVED');
  const query={commandId:input.commandId,model:input.model,id:input.id,close:false};
  assert.equal((await reconcileAdminOperationalState(db,admin.session,query)).status,'UNKNOWN');
  assert.equal((await reconcileAdminOperationalState(db,admin.session,{...query,close:true})).status,'CLOSED');
  await assert.rejects(save(input),/CLOSED/);
  assert.equal((await readAdminOperationalState(db,admin.session,input.model,input.id)).state,'ACTIVE');
  await save({...input,commandId:randomUUID()});
  assert.equal((await readAdminOperationalState(db,admin.session,input.model,input.id)).state,'ARCHIVED');
});

test('audit failure rolls back state journal and source together',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'BLOCKED');
  const before=await db.adminOperationalState.findUniqueOrThrow({where:{model_recordId:{model:input.model,recordId:input.id}}});
  const failing=db.$extends({query:{auditLog:{async create(){throw Error('SYNTHETIC_LIFECYCLE_AUDIT_FAILURE');}}}}) as unknown as PrismaClient;
  await assert.rejects(saveAdminOperationalState(failing,admin.session,input,proof()),/SYNTHETIC_LIFECYCLE_AUDIT_FAILURE/);
  assert.deepEqual(await db.adminOperationalState.findUniqueOrThrow({where:{model_recordId:{model:input.model,recordId:input.id}}}),before);
  assert.equal(await db.adminRecordRevision.count({where:{commandId:input.commandId}}),0);
  await save(input);
});

test('a native serializable snapshot admitted before the first block cannot operate after the block commits',options,async()=>{
  const f=await intake(),entered=latch(),resume=latch(),input=await command('ControlledIntake',f.intake.id,'BLOCKED');
  const pending=db.$transaction(async tx=>{
    await tx.controlledIntake.findUniqueOrThrow({where:{id:f.intake.id}});
    entered.release();await resume.promise;
    await tx.controlledIntake.update({where:{id:f.intake.id},data:{version:{increment:1}}});
  },{isolationLevel:'Serializable',timeout:30_000});
  const observed=pending.then(()=>({ok:true as const}),error=>({ok:false as const,error}));
  await entered.promise;await save(input);resume.release();
  const outcome=await observed;assert.equal(outcome.ok,false);
  assert.equal((await db.controlledIntake.findUniqueOrThrow({where:{id:f.intake.id}})).version,f.intake.version);
  assert.equal((await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id)).state,'BLOCKED');
});

test('two state decisions on one source settle as exactly one change and one audit',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'BLOCKED'),other={...input,commandId:randomUUID(),state:'ARCHIVED' as const};
  const outcomes=await Promise.allSettled([save(input),save(other)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(await db.adminRecordRevision.count({where:{commandId:{in:[input.commandId,other.commandId]}}}),1);
  assert.equal((await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id)).version,1);
});

test('a receipt recheck after commit observes one decision without replaying the writer',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'TRASHED'),entered=latch(),resume=latch();
  const intercepted=db.$extends({query:{adminRecordRevision:{async create({args,query}){entered.release();await resume.promise;return query(args);}}}}) as unknown as PrismaClient;
  const saving=saveAdminOperationalState(intercepted,admin.session,input,proof());
  await entered.promise;
  const closing=reconcileAdminOperationalState(db,admin.session,{commandId:input.commandId,model:input.model,id:input.id,close:true});
  resume.release();await saving;
  assert.equal((await closing).status,'RECORDED');
  assert.equal(await db.adminRecordRevision.count({where:{commandId:input.commandId}}),1);
});

test('database triggers refuse an unjournalled state change deletion and truncation',options,async()=>{
  const f=await intake(),input=await command('ControlledIntake',f.intake.id,'BLOCKED');
  await assert.rejects(db.$executeRaw`UPDATE "AdminOperationalState" SET state='BLOCKED',version=1,"lastCommandId"=${input.commandId}::uuid WHERE model='ControlledIntake' AND "recordId"=${f.intake.id}`);
  await assert.rejects(db.adminOperationalState.delete({where:{model_recordId:{model:'ControlledIntake',recordId:f.intake.id}}}));
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE "AdminOperationalState"'));
  assert.equal((await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id)).state,'ACTIVE');
});

test('holding a started readiness practice stops native work and restores it without changing personal start or financial proofs',options,async()=>{
  const f=await lifecycleReadinessFixture(db,admin.session);
  const original=await db.practiceReadiness.findUniqueOrThrow({where:{id:f.practice.id},include:{funding:true,formalizations:true}});
  await save(await command('PracticeReadiness',f.practice.id,'ARCHIVED'));
  await assert.rejects(db.task.create({data:{clientId:f.client.id,projectId:f.project.id,clientServiceId:f.service.id,title:'Must not start',createdById:admin.user.id}}));
  await assert.rejects(db.clientService.update({where:{id:f.service.id},data:{internalNotes:'Must not change'}}));
  assert((await listAccessiblePracticeReadiness(db,admin.session)).some(p=>p.id===f.practice.id&&!p.operational));
  assert(!(await listAccessiblePracticeReadiness(db,f.actors.operator)).some(p=>p.id===f.practice.id));
  await save(await command('PracticeReadiness',f.practice.id,'ACTIVE'));
  assert.deepEqual(await db.practiceReadiness.findUniqueOrThrow({where:{id:f.practice.id},include:{funding:true,formalizations:true}}),original);
  assert((await listAccessiblePracticeReadiness(db,f.actors.operator)).some(p=>p.id===f.practice.id&&p.operational));
});

test('holding the intake also suspends its existing readiness and service without changing their recorded start',options,async()=>{
  const f=await lifecycleReadinessFixture(db,admin.session),original=await db.practiceReadiness.findUniqueOrThrow({where:{id:f.practice.id}});
  await save(await command('ControlledIntake',original.controlledIntakeId,'BLOCKED'));
  const visible=(await listAccessiblePracticeReadiness(db,admin.session)).find(p=>p.id===f.practice.id);
  assert(visible&&!visible.operational);
  await assert.rejects(db.clientService.update({where:{id:f.service.id},data:{operationalNotes:'No work through a held intake'}}));
  await save(await command('ControlledIntake',original.controlledIntakeId,'ACTIVE'));
  assert.deepEqual(await db.practiceReadiness.findUniqueOrThrow({where:{id:f.practice.id}}),original);
});

test('clearing or changing the service on existing work cannot bypass a hold on its original readiness context',options,async()=>{
  const f=await lifecycleReadinessFixture(db,admin.session);
  const task=await db.task.create({data:{clientId:f.client.id,projectId:f.project.id,clientServiceId:f.service.id,
    title:'Synthetic held work',createdById:admin.user.id}});
  const practice=await db.technicalPractice.create({data:{clientId:f.client.id,projectId:f.project.id,clientServiceId:f.service.id,
    title:'Synthetic held practice',practiceType:'SYNTHETIC',targetEntity:'Synthetic only',createdById:admin.user.id}});
  await save(await command('PracticeReadiness',f.practice.id,'BLOCKED'));
  await assert.rejects(db.task.update({where:{id:task.id},data:{clientServiceId:null}}),/ADMIN_OPERATIONAL_INACTIVE/);
  await assert.rejects(db.technicalPractice.update({where:{id:practice.id},data:{clientServiceId:null}}),/ADMIN_OPERATIONAL_INACTIVE/);
  await save(await command('PracticeReadiness',f.practice.id,'ACTIVE'));
  await db.task.update({where:{id:task.id},data:{clientServiceId:null}});
  assert.equal((await db.technicalPractice.findUniqueOrThrow({where:{id:practice.id}})).clientServiceId,f.service.id);
});

test('message restore preserves source versions but requires a fresh draft before another approval',options,async()=>{
  const f=await message(),original=await db.communicationVersion.findFirstOrThrow({where:{messageId:f.message.id}});
  await save(await command('ApprovedCommunication',f.message.id,'BLOCKED'));
  const transition={messageId:f.message.id,expectedRevision:1,snapshotHash:original.snapshotHash};
  await assert.rejects(submitApprovedMessage(db,admin.session,transition));
  await save(await command('ApprovedCommunication',f.message.id,'ACTIVE'));
  await assert.rejects(submitApprovedMessage(db,admin.session,transition),/CONFLICT/);
  const context={kind:'LEAD' as const,id:f.lead.id},data=await readPracticeCommunications(db,admin.session,context);
  assert(data.messages[0].needsFreshVersion);
  const saved=await saveApprovedMessageDraft(db,admin.session,{messageId:f.message.id,expectedRevision:1,context,
    mailboxId:f.mailbox.id,replyTo:f.mailbox.address,to:['recipient@invalid.test'],cc:[],bcc:[],
    subject:'Fresh synthetic version',body:'Synthetic body preserved by explicit new decision',attachmentVersionIds:[],contextFileIds:[],classification:'ORDINARY'});
  await submitApprovedMessage(db,admin.session,{messageId:saved.id,expectedRevision:saved.revision,snapshotHash:saved.snapshotHash});
  assert.deepEqual(await db.communicationVersion.findUniqueOrThrow({where:{id:original.id}}),original);
});

test('held readiness makes its dossier read-only, hides archived history from operators and restores the original version',options,async()=>{
  const f=await lifecycleReadinessFixture(db,admin.session);
  const original=await db.engagementDossierVersion.findUniqueOrThrow({where:{id:f.version.id}});
  await save(await command('PracticeReadiness',f.practice.id,'BLOCKED'));
  assert.equal((await getEngagementDossierReadAccess(db,admin.session,f.dossier.id))?.operational,false);
  assert.equal((await getEngagementDossierReadAccess(db,f.actors.operator,f.dossier.id))?.operational,false);
  await assert.rejects(reviseEngagementDossier(db,admin.session,{dossierId:f.dossier.id,expectedVersionId:f.version.id,
    title:'Must not revise held dossier',content:f.version.content}),/DENIED/);
  await assert.rejects(mutateInitialServiceWorkflow(db,admin.session,{dossierId:f.dossier.id,intent:'configure',value:{}}),/DENIED/);
  await assert.rejects(db.clientDossier.update({where:{id:f.dossier.id},data:{title:'Native SQL guard'}}),/ADMIN_OPERATIONAL_INACTIVE/);
  await save(await command('PracticeReadiness',f.practice.id,'ARCHIVED'));
  assert.equal(await getEngagementDossierReadAccess(db,f.actors.operator,f.dossier.id),null);
  assert.equal((await getEngagementDossierReadAccess(db,admin.session,f.dossier.id))?.operational,false);
  await save(await command('PracticeReadiness',f.practice.id,'ACTIVE'));
  assert.equal((await getEngagementDossierReadAccess(db,f.actors.operator,f.dossier.id))?.operational,true);
  assert.deepEqual(await db.engagementDossierVersion.findUniqueOrThrow({where:{id:f.version.id}}),original);
  const revised=await reviseEngagementDossier(db,f.actors.operator,{dossierId:f.dossier.id,expectedVersionId:f.version.id,
    title:'Explicit new version after restore',content:f.version.content});
  assert.notEqual(revised.id,original.id);assert.equal(revised.version,2);
});

test('technical communications inherit readiness holds and require a new version after its restore',options,async()=>{
  const f=await lifecycleReadinessFixture(db,admin.session);
  const practice=await db.technicalPractice.create({data:{clientId:f.client.id,projectId:f.project.id,
    clientServiceId:f.service.id,title:'Synthetic lifecycle technical context',practiceType:'SYNTHETIC',
    targetEntity:'Synthetic only',createdById:admin.user.id}});
  const mailbox=await db.communicationMailbox.findUniqueOrThrow({where:{address:'comunicazioni@finanzaagevolaimpresa.it'}});
  const draft={messageId:randomUUID(),expectedRevision:0,context:{kind:'TECHNICAL' as const,id:practice.id},mailboxId:mailbox.id,replyTo:mailbox.address,
    to:['recipient@invalid.test'],cc:[],bcc:[],subject:'Synthetic technical draft',body:'No provider or send involved',
    attachmentVersionIds:[],contextFileIds:[],classification:'ORDINARY'};
  const first=await saveApprovedMessageDraft(db,admin.session,draft);
  const original=await db.communicationVersion.findFirstOrThrow({where:{messageId:first.id,revision:first.revision}});
  await save(await command('PracticeReadiness',f.practice.id,'BLOCKED'));
  assert.equal((await readPracticeCommunications(db,admin.session,draft.context)).canWrite,false);
  await assert.rejects(saveApprovedMessageDraft(db,admin.session,{...draft,messageId:first.id,expectedRevision:first.revision}),/DENIED/);
  await assert.rejects(db.approvedCommunication.update({where:{id:first.id},data:{state:'PENDING'}}),/ADMIN_OPERATIONAL_INACTIVE/);
  await save(await command('PracticeReadiness',f.practice.id,'ACTIVE'));
  await assert.rejects(submitApprovedMessage(db,admin.session,{messageId:first.id,expectedRevision:first.revision,snapshotHash:first.snapshotHash}),/CONFLICT/);
  const fresh=await saveApprovedMessageDraft(db,admin.session,{...draft,messageId:first.id,expectedRevision:first.revision});
  assert.equal(fresh.revision,first.revision+1);
  await submitApprovedMessage(db,admin.session,{messageId:fresh.id,expectedRevision:fresh.revision,snapshotHash:fresh.snapshotHash});
  assert.deepEqual(await db.communicationVersion.findUniqueOrThrow({where:{id:original.id}}),original);
});

test('an open or uncertain external outcome prevents both application and raw database hold',options,async()=>{
  const f=await message();await db.approvedCommunication.update({where:{id:f.message.id},data:{state:'UNCERTAIN'}});
  const input=await command('ApprovedCommunication',f.message.id,'ARCHIVED');
  await assert.rejects(save(input),/IN_FLIGHT/);
  await assert.rejects(db.$executeRaw`UPDATE "AdminOperationalState" SET state='ARCHIVED',version=1,"lastCommandId"=${input.commandId}::uuid
    WHERE model='ApprovedCommunication' AND "recordId"=${f.message.id}`,/ADMIN_OPERATIONAL_IN_FLIGHT/);
  await assert.rejects(save(await command('ControlledIntake',f.intake.id,'BLOCKED')),/IN_FLIGHT/);
  assert.equal((await db.approvedCommunication.findUniqueOrThrow({where:{id:f.message.id}})).state,'UNCERTAIN');
});

test('a history exceeding two hundred messages remains administrable when no external outcome is unresolved',options,async()=>{
  const f=await intake();
  for(let index=0;index<201;index++)await storedNoticeMessage(db,{leadId:f.lead.id,authorId:admin.user.id});
  await save(await command('ControlledIntake',f.intake.id,'ARCHIVED'));
  assert.equal((await readAdminOperationalState(db,admin.session,'ControlledIntake',f.intake.id)).state,'ARCHIVED');
  await save(await command('ControlledIntake',f.intake.id,'ACTIVE'));
  assert.equal(await db.approvedCommunication.count({where:{leadId:f.lead.id}}),201);
});

test('reply archive is hidden from an admitted reader, visible in Admin history and never changes the original source',options,async()=>{
  const f=await message(),incoming=await linkedOrdinaryNoticeReply(db,f.message.id,f.mailbox.id,admin.user.id);
  const reader=await syntheticPerson(db,'Commerciale lifecycle','commerciale');
  await db.lead.update({where:{id:f.lead.id},data:{assignedToId:reader.user.id}});
  await db.userPermissionOverride.create({data:{userId:reader.user.id,permission:'practice_communications.read',allowed:true}});
  const context={kind:'LEAD' as const,id:f.lead.id};
  assert.equal((await readPracticeCommunications(db,reader.session,context)).messages[0].replies.length,1);
  await save(await command('CommunicationReply',incoming.reply.id,'ARCHIVED'));
  assert.equal((await readPracticeCommunications(db,reader.session,context)).messages[0].replies.length,0);
  assert.equal((await readPracticeCommunications(db,admin.session,context)).messages[0].replies[0].lifecycleState,'ARCHIVED');
  assert.deepEqual(await db.communicationReply.findUniqueOrThrow({where:{id:incoming.reply.id}}),incoming.reply);
  await save(await command('CommunicationReply',incoming.reply.id,'ACTIVE'));
  assert.equal((await readPracticeCommunications(db,reader.session,context)).messages[0].replies.length,1);
});

test('an archived outgoing message still admits new immutable inbound receipts without reopening outgoing work',options,async()=>{
  const f=await message();await save(await command('ApprovedCommunication',f.message.id,'ARCHIVED'));
  const incoming=await linkedOrdinaryNoticeReply(db,f.message.id,f.mailbox.id,admin.user.id);
  assert.equal((await readPracticeCommunications(db,admin.session,{kind:'LEAD',id:f.lead.id})).messages[0].replies[0].id,incoming.reply.id);
  assert.equal((await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id)).state,'ARCHIVED');
});

test('private document lifecycle closes bytes and invalidates old selection through restore while retaining signed acquisition',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId,versionId=f.receipt.versionId;
  const original=await db.document.findUniqueOrThrow({where:{id}}),version=await db.documentVersion.findUniqueOrThrow({where:{id:versionId}});
  await assignTechnical(db,admin,f.target,f.techA,{documents:[{fileId:versionId,allowDownload:true}]});
  await readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded);
  const before=await db.$queryRaw`SELECT "record"::text FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${f.receipt.commandId}::uuid`;
  await save(await command('Document',id,'TRASHED'));
  await assert.rejects(readPersonalAcquiredDocument(db,admin.session,id));
  await assert.rejects(readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded));
  const listed=(await listPersonalAcquiredDocuments(db,admin.session,f.client.id)).find(row=>row.id===id);
  assert(listed&&!listed.available&&listed.lifecycleState==='TRASHED');
  await save(await command('Document',id,'ACTIVE'));
  assert.deepEqual((await readPersonalAcquiredDocument(db,admin.session,id)).bytes,f.bytes);
  await assert.rejects(readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded));
  const after=await db.document.findUniqueOrThrow({where:{id}});
  assert.equal(after.selectiveEpoch,original.selectiveEpoch+2);
  assert.deepEqual({...after,selectiveEpoch:original.selectiveEpoch},original);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({where:{id:versionId}}),version);
  assert.deepEqual(await db.$queryRaw`SELECT "record"::text FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${f.receipt.commandId}::uuid`,before);
});

test('metadata index finds an archived source and excludes an ordinary document from the private lifecycle',options,async()=>{
  const f=await intake();await save(await command('ControlledIntake',f.intake.id,'ARCHIVED'));
  const listed=await listAdminOperationalSources(db,admin.session,{model:'ControlledIntake',state:'ARCHIVED',query:f.intake.id,page:1});
  assert.equal(listed.records.length,1);assert.equal(listed.records[0].id,f.intake.id);
  const doc=await db.document.create({data:{title:'Ordinary synthetic',fileName:'ordinary.txt',mimeType:'text/plain',type:'altro',sizeBytes:1,storagePath:'synthetic/ordinary.txt',checksum:'a'.repeat(64),uploadedById:admin.user.id}});
  await assert.rejects(readAdminOperationalState(db,admin.session,'Document',doc.id));
  await assert.rejects(db.$transaction(tx=>readOperationalState(tx,'Document',doc.id)));
});
