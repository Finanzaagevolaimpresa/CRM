import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import {PrismaClient} from '@prisma/client';
import {syntheticAuthority,syntheticPerson,syntheticSession} from './selective-sharing/fixtures';
import {assertAiOrchestratorEphemeralDatabaseIdentity} from './db/ai-orchestrator-db-test-guard';
import {createPrivilegedStepUpToken} from '../src/lib/privileged-step-up-token';
import {readAdminDraftReplacement,listAdminDraftTargets,replaceAdminCommunicationDraft,reconcileAdminDraftReplacement} from '../src/lib/admin-draft-context';
import {saveApprovedMessageDraft,submitApprovedMessage} from '../src/lib/approved-communications';
import {emptyCommunicationRecipientSelection} from '../src/lib/communication-recipient-policy';
import {storedNoticeMessage,linkedOrdinaryNoticeReply} from './record-updates/communication-fixtures';
import {readAdminOperationalState,saveAdminOperationalState} from '../src/lib/admin-operational-lifecycle';
const enabled=process.env.ADMIN_DRAFT_CONTEXT_DB_TESTS==='1'&&process.env.RUN_DB_TESTS==='1',options={skip:!enabled},db=new PrismaClient();
type Person=Awaited<ReturnType<typeof syntheticPerson>>;
let admin:Person;
const key={version:Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),secret:process.env.PRIVILEGED_STEP_UP_SECRET!};
before(async()=>{
  if(!enabled)return;await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const [ledger]=await db.$queryRaw<Array<{count:bigint}>>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(ledger.count,73n);
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
async function fixture(classification:'ORDINARY'|'SENSITIVE'='ORDINARY'){
  const lead=await db.lead.create({data:{firstName:'Sorgente sintetica',lastName:randomUUID(),assignedToId:admin.user.id}});
  const client=await db.client.create({data:{displayName:'Destinazione sintetica '+randomUUID(),type:'societa'}});
  const m=await storedNoticeMessage(db,{leadId:lead.id,authorId:admin.user.id,classification});
  const source=await readAdminDraftReplacement(db,admin.session,m.message.id);
  const command={commandId:randomUUID(),id:m.message.id,expectedVersion:source.expectedVersion,reason:'Correzione sintetica del contesto',confirmed:true as const,
    draft:{context:{kind:'CLIENT' as const,id:client.id},mailboxId:m.mailbox.id,replyTo:m.mailbox.address,to:['new-recipient@invalid.test'],cc:[],bcc:[],
      subject:'Bozza sostitutiva sintetica',body:'Testo riveduto esplicitamente',classification,attachmentVersionIds:[] as string[],contextFileIds:[] as string[],
      recipientSelection:emptyCommunicationRecipientSelection()}};
  return {lead,client,...m,source,command};
}
const save=(c:Awaited<ReturnType<typeof fixture>>['command'],person=admin,secondsAgo=0)=>replaceAdminCommunicationDraft(db,person.session,c,proof(person,secondsAgo));
test('replacement persists a new explicit draft and archives source atomically without rewriting versions, approvals or origin',options,async()=>{
  const f=await fixture(),version=await db.communicationVersion.findFirstOrThrow({where:{messageId:f.message.id}});
  const result=await save(f.command);
  assert.equal(result.replayed,false);assert(result.href.includes(f.client.id));
  assert.deepEqual(await db.approvedCommunication.findUniqueOrThrow({where:{id:f.message.id}}),f.message);
  assert.deepEqual(await db.communicationVersion.findUniqueOrThrow({where:{id:version.id}}),version);
  const next=await db.approvedCommunication.findUniqueOrThrow({where:{id:f.command.commandId}});
  assert.equal(next.state,'DRAFT');assert.equal(next.clientId,f.client.id);assert.equal(next.createdById,admin.user.id);
  const draft=await db.communicationVersion.findFirstOrThrow({where:{messageId:next.id}});
  assert.deepEqual((draft.snapshot as {to:string[]}).to,['new-recipient@invalid.test']);
  assert.deepEqual((draft.snapshot as {attachments:unknown[]}).attachments,[]);
  assert.equal((await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id)).state,'ARCHIVED');
  assert.equal(await db.communicationApproval.count({where:{versionId:draft.id}}),0);
  assert.equal(await db.ordinaryEmailAttempt.count({where:{messageId:next.id}}),0);
  assert.equal(await db.communicationAttempt.count({where:{messageId:next.id}}),0);
  assert.equal(await db.adminRecordRevision.count({where:{commandId:f.command.commandId}}),1);
  assert.equal((await readAdminDraftReplacement(db,admin.session,f.message.id)).links[0]?.id,next.id);
  assert.equal((await readAdminDraftReplacement(db,admin.session,next.id)).links[0]?.id,f.message.id);
  assert.equal((await reconcileAdminDraftReplacement(db,admin.session,{id:f.message.id,commandId:f.command.commandId,close:true})).status,'RECORDED');
});
test('exact replay returns the persisted destination; a different payload cannot reuse a command',options,async()=>{
  const f=await fixture();await save(f.command);assert.equal((await save(f.command)).replayed,true);
  await assert.rejects(save({...f.command,reason:'Un altro motivo'}),/STALE/);
  assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),1);
  assert.equal(await db.auditLog.count({where:{id:'admin-record:'+f.command.commandId}}),1);
});
test('expired Admin confirmation retains the same preparation and renewed proof produces one effect',options,async()=>{
  const f=await fixture();await assert.rejects(save(f.command,admin,1801));
  assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),0);
  await save(f.command,admin,1790);assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),1);
});
test('current role, override and native personal authority remain necessary',options,async()=>{
  const f=await fixture(),technician=await syntheticPerson(db,'Tecnico bozza sintetica','consulente'),other=await syntheticPerson(db,'Altro Admin bozza','admin');
  await assert.rejects(replaceAdminCommunicationDraft(db,technician.session,f.command,proof(technician)));
  await assert.rejects(replaceAdminCommunicationDraft(db,other.session,f.command,proof(other)));
  await db.userPermissionOverride.create({data:{userId:admin.user.id,permission:'practice_communications.write',allowed:false}});
  try{await assert.rejects(save(f.command));}finally{await db.userPermissionOverride.deleteMany({where:{userId:admin.user.id,permission:'practice_communications.write'}});}
  assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),0);
});
test('stale source and disabled target reject the entire replacement',options,async()=>{
  const f=await fixture();await db.client.update({where:{id:f.client.id},data:{deletedAt:new Date()}});
  await assert.rejects(save(f.command));assert.equal((await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id)).state,'ACTIVE');
  const g=await fixture();await db.approvedCommunication.update({where:{id:g.message.id},data:{updatedAt:new Date(Date.now()+1000)}});
  await assert.rejects(save(g.command),/STALE/);assert.equal(await db.approvedCommunication.count({where:{id:g.command.commandId}}),0);
});
test('sensitive source cannot be downgraded during contextual replacement',options,async()=>{
  const f=await fixture('SENSITIVE');
  await assert.rejects(save({...f.command,draft:{...f.command.draft,classification:'ORDINARY'}}),/DENIED/);
  await save(f.command);
});
test('pending, uncertain, received and source-bound history cannot be represented as a new unencumbered draft',options,async()=>{
  for(const state of ['PENDING','UNCERTAIN']as const){
    const f=await fixture();await db.approvedCommunication.update({where:{id:f.message.id},data:{state}});
    assert.equal((await readAdminDraftReplacement(db,admin.session,f.message.id)).eligible,false);
    await assert.rejects(save(f.command));assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),0);
  }
  const f=await fixture();await linkedOrdinaryNoticeReply(db,f.message.id,f.mailbox.id,admin.user.id);
  assert.equal((await readAdminDraftReplacement(db,admin.session,f.message.id)).eligible,false);await assert.rejects(save(f.command));
  const g=await fixture();await assert.rejects(replaceAdminCommunicationDraft(db,admin.session,{...g.command,
    draft:{...g.command.draft,updateSource:{deliveryId:randomUUID(),sourceHash:'a'.repeat(64)}}},proof()));
});
test('unknown then close prevents a late command; a fresh explicit command remains usable',options,async()=>{
  const f=await fixture(),ref={id:f.message.id,commandId:f.command.commandId};
  assert.equal((await reconcileAdminDraftReplacement(db,admin.session,{...ref,close:false})).status,'UNKNOWN');
  assert.equal((await reconcileAdminDraftReplacement(db,admin.session,{...ref,close:true})).status,'CLOSED');
  await assert.rejects(save(f.command),/CLOSED/);assert.equal(await db.approvedCommunication.count({where:{id:ref.commandId}}),0);
  await save({...f.command,commandId:randomUUID()});
});
test('concurrent replacements produce exactly one destination and one archive transition',options,async()=>{
  const f=await fixture(),second={...f.command,commandId:randomUUID()};
  const outcomes=await Promise.allSettled([save(f.command),save(second)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.approvedCommunication.count({where:{id:{in:[f.command.commandId,second.commandId]}}}),1);
  assert.equal((await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id)).version,1);
});
test('old native draft form is blocked after replacement; explicit restore still requires a fresh version',options,async()=>{
  const f=await fixture(),original=await db.communicationVersion.findFirstOrThrow({where:{messageId:f.message.id}});await save(f.command);
  const oldDraft={...f.command.draft,context:{kind:'LEAD' as const,id:f.lead.id},messageId:f.message.id,expectedRevision:1};
  await assert.rejects(saveApprovedMessageDraft(db,admin.session,oldDraft));
  const state=await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id);
  await saveAdminOperationalState(db,admin.session,{commandId:randomUUID(),model:'ApprovedCommunication',id:f.message.id,expectedVersion:state.expectedVersion,
    state:'ACTIVE',reason:'Ripristino esplicito sintetico della fonte',confirmed:true},proof());
  await assert.rejects(submitApprovedMessage(db,admin.session,{messageId:f.message.id,expectedRevision:1,snapshotHash:original.snapshotHash}),/CONFLICT/);
});
test('journal failure rolls back new draft, source archive and native events together',options,async()=>{
  const f=await fixture();
  const failing=db.$extends({query:{adminRecordRevision:{async create(){throw new Error('SYNTHETIC_REPLACEMENT_JOURNAL_FAILURE');}}}}) as unknown as PrismaClient;
  await assert.rejects(replaceAdminCommunicationDraft(failing,admin.session,f.command,proof()),/SYNTHETIC_REPLACEMENT_JOURNAL_FAILURE/);
  assert.equal(await db.approvedCommunication.count({where:{id:f.command.commandId}}),0);
  assert.equal(await db.communicationEvent.count({where:{messageId:f.command.commandId}}),0);
  assert.equal((await readAdminOperationalState(db,admin.session,'ApprovedCommunication',f.message.id)).state,'ACTIVE');
});
test('target directory uses native current scope and excludes deleted contexts',options,async()=>{
  const f=await fixture(),q={kind:'CLIENT',query:f.client.id,page:1};
  assert.equal((await listAdminDraftTargets(db,admin.session,q)).records[0]?.id,f.client.id);
  const other=await syntheticPerson(db,'Admin senza autorità personale','admin');
  assert.equal((await listAdminDraftTargets(db,other.session,q)).records.length,0);
  await db.client.update({where:{id:f.client.id},data:{deletedAt:new Date()}});
  assert.equal((await listAdminDraftTargets(db,admin.session,q)).records.length,0);
});
test('revoked session cannot write or recover; renewed current session can complete the prepared command',options,async()=>{
  const f=await fixture(),session=await syntheticSession(db,admin.user),revoked={user:admin.user,...session};
  await db.internalSession.update({where:{id:session.session.sessionId!},data:{revokedAt:new Date()}});
  await assert.rejects(save(f.command,revoked));
  await assert.rejects(reconcileAdminDraftReplacement(db,revoked.session,{id:f.message.id,commandId:f.command.commandId,close:true}));
  await save(f.command);
});
