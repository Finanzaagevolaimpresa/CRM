import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import {PrismaClient} from '@prisma/client';
import {syntheticAuthority,syntheticPerson,syntheticSession} from './selective-sharing/fixtures';
import {assertAiOrchestratorEphemeralDatabaseIdentity} from './db/ai-orchestrator-db-test-guard';
import {lifecyclePrivateDocumentFixture} from './admin-lifecycle/fixtures';
import {createPrivilegedStepUpToken} from '../src/lib/privileged-step-up-token';
import {readAdminPrivateDocumentMetadata,saveAdminPrivateDocumentMetadata,reconcileAdminPrivateDocumentMetadata} from '../src/lib/admin-private-document-metadata';
import {privateMetadataModel,type PrivateMetadataValues} from '../src/lib/private-document-metadata';
import {readPersonalAcquiredDocument,listPersonalAcquiredDocuments,selectedTechnicalAcquisition} from '../src/lib/technical-document-acquired-access';
import {selectClientDocuments} from '../src/lib/selective-client-documents';
import {assignTechnical} from './technical-assignments/fixtures';
import {readTechnicalWorkDocument} from '../src/lib/technical-assignment-access';
import {readPrivateDocumentBounded} from '../src/lib/storage';
import {readAdminOperationalState,saveAdminOperationalState} from '../src/lib/admin-operational-lifecycle';
const enabled=process.env.ADMIN_PRIVATE_METADATA_DB_TESTS==='1'&&process.env.RUN_DB_TESTS==='1',options={skip:!enabled},db=new PrismaClient();
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
});
after(()=>db.$disconnect());
function proof(person=admin,secondsAgo=0){
  return {key,sessionToken:person.token,stepUpToken:createPrivilegedStepUpToken({key,userId:person.user.id,sessionToken:person.token,
    role:person.user.role,nowSeconds:Math.floor(Date.now()/1000)-secondsAgo})};
}
async function command(id:string,values:Partial<PrivateMetadataValues>={}){
  const data=await readAdminPrivateDocumentMetadata(db,admin.session,id);
  return {commandId:randomUUID(),id,expectedVersion:data.expectedVersion,values:{...data.current.values,title:'Titolo corretto sintetico',...values},
    reason:'Rettifica amministrativa sintetica isolata',confirmed:true as const};
}
const save=(input:Awaited<ReturnType<typeof command>>,person=admin,secondsAgo=0)=>saveAdminPrivateDocumentMetadata(db,person.session,input,proof(person,secondsAgo));
async function history(id:string){return db.adminRecordRevision.findMany({where:{model:privateMetadataModel,recordId:id,operation:'UPDATE'}});}
async function selected(f:Awaited<ReturnType<typeof lifecyclePrivateDocumentFixture>>,person=f.techA){
  return db.$transaction(tx=>selectClientDocuments(tx,admin.user.id,{...person.session,id:person.user.id},f.client.id,[{versionId:f.receipt.versionId,download:true}]),
    {isolationLevel:'Serializable',timeout:30000});
}

test('metadata correction persists and replays once while exact source version acquisition and original audit remain unchanged',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId;
  const original=await db.document.findUniqueOrThrow({where:{id}}),version=await db.documentVersion.findUniqueOrThrow({where:{id:f.receipt.versionId}}),
    audit=await db.auditLog.findUniqueOrThrow({where:{id:f.receipt.commandId}});
  const source=await db.$queryRaw`SELECT record FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${f.receipt.commandId}::uuid`;
  const input=await command(id);assert.equal((await save(input)).replayed,false);assert.equal((await save(input)).replayed,true);
  const reopened=await readAdminPrivateDocumentMetadata(db,admin.session,id);
  assert.equal(reopened.current.revision,1);assert.equal(reopened.current.values.title,input.values.title);assert.equal(reopened.original.values.title,original.title);
  const after=await db.document.findUniqueOrThrow({where:{id}});
  assert.equal(after.selectiveEpoch,original.selectiveEpoch+1);assert.deepEqual({...after,selectiveEpoch:original.selectiveEpoch},original);
  assert.deepEqual(await db.documentVersion.findUniqueOrThrow({where:{id:version.id}}),version);
  assert.deepEqual(await db.auditLog.findUniqueOrThrow({where:{id:f.receipt.commandId}}),audit);
  assert.deepEqual(await db.$queryRaw`SELECT record FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${f.receipt.commandId}::uuid`,source);
  assert.equal((await history(id)).length,1);assert.equal(await db.auditLog.count({where:{id:'admin-record:'+input.commandId}}),1);
  assert.deepEqual((await readPersonalAcquiredDocument(db,admin.session,id)).bytes,f.bytes);
  assert.equal((await listPersonalAcquiredDocuments(db,admin.session,f.client.id)).find(d=>d.id===id)?.title,input.values.title);
});
test('current Admin permission and thirty-minute proof are enforced without accepting altered or foreign commands',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),input=await command(f.receipt.documentId);
  await assert.rejects(save(input,f.techA));await assert.rejects(save(input,admin,1801));
  await assert.rejects(saveAdminPrivateDocumentMetadata(db,admin.session,{...input,values:{...input.values,visibility:'interno'}},proof()));
  await db.userPermissionOverride.create({data:{userId:admin.user.id,permission:'document.upload',allowed:false}});
  try{await assert.rejects(save(input));}finally{await db.userPermissionOverride.deleteMany({where:{userId:admin.user.id,permission:'document.upload'}});}
  assert.equal((await history(input.id)).length,0);await save(input,admin,1790);
});
test('expired administrative validity blocks bytes and selection while Admin can correct and reopen the same source',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId;
  await save(await command(id,{expiresAt:new Date(Date.now()-60000).toISOString()}));
  await assert.rejects(readPersonalAcquiredDocument(db,admin.session,id));await assert.rejects(selected(f));
  const view=await readAdminPrivateDocumentMetadata(db,admin.session,id);assert.equal(view.current.revision,1);
  await save(await command(id,{expiresAt:new Date(Date.now()+3600000).toISOString()}));
  assert.deepEqual((await readPersonalAcquiredDocument(db,admin.session,id)).bytes,f.bytes);
  assert.equal((await selected(f)).snapshots[0].title,'Titolo corretto sintetico');
});
test('correction invalidates an old technical selection through restoration; a new explicit selection admits current metadata',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId,versionId=f.receipt.versionId;
  await assignTechnical(db,admin,f.target,f.techA,{documents:[{fileId:versionId,allowDownload:true}]});
  await readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded);
  const original=(await readAdminPrivateDocumentMetadata(db,admin.session,id)).original.values;
  await save(await command(id));await assert.rejects(readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded));
  await save(await command(id,original));await assert.rejects(readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded));
  await assignTechnical(db,admin,f.target,f.techA,{documents:[{fileId:versionId,allowDownload:true}]});
  await readTechnicalWorkDocument(db,f.techA.session,f.target,versionId,true,readPrivateDocumentBounded);
  assert.equal((await readAdminPrivateDocumentMetadata(db,admin.session,id)).current.revision,2);
});
test('new financial classification closes nonfinancial recipients and original financial ceilings survive later relabelling',options,async()=>{
  const technical=await lifecyclePrivateDocumentFixture(db,admin);
  assert.equal((await selected(technical)).snapshots.length,1);
  await save(await command(technical.receipt.documentId,{classification:'PAYMENT'}));await assert.rejects(selected(technical));
  const financial=await lifecyclePrivateDocumentFixture(db,admin,'CONTRACT');
  await assert.rejects(selected(financial));
  await save(await command(financial.receipt.documentId,{classification:'TECHNICAL_DOCUMENT'}));await assert.rejects(selected(financial));
  assert.deepEqual((await readPersonalAcquiredDocument(db,admin.session,financial.receipt.documentId)).bytes,financial.bytes);
});
test('current sensitive permission denial prevents a correction that would require protected metadata access',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),input=await command(f.receipt.documentId,{classification:'OTHER_CONFIDENTIAL'});
  await db.userPermissionOverride.create({data:{userId:admin.user.id,permission:'document.sensitive.read',allowed:false}});
  try{await assert.rejects(save(input));}finally{await db.userPermissionOverride.deleteMany({where:{userId:admin.user.id,permission:'document.sensitive.read'}});}
  assert.equal((await history(input.id)).length,0);
});
test('competing metadata corrections commit one effect and reject a stale source snapshot',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),a=await command(f.receipt.documentId),b={...a,commandId:randomUUID(),values:{...a.values,title:'Seconda scelta sintetica'}};
  const results=await Promise.allSettled([save(a),save(b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await history(a.id)).length,1);
  await assert.rejects(save({...a,commandId:randomUUID()}));
});
test('unknown attempt closes durably and a delayed write cannot create a duplicate correction',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),input=await command(f.receipt.documentId);
  assert.equal((await reconcileAdminPrivateDocumentMetadata(db,admin.session,{commandId:input.commandId,id:input.id,close:false})).status,'UNKNOWN');
  assert.equal((await reconcileAdminPrivateDocumentMetadata(db,admin.session,{commandId:input.commandId,id:input.id,close:true})).status,'CLOSED');
  await assert.rejects(save(input),/CLOSED/);assert.equal((await history(input.id)).length,0);
  const fresh={...input,commandId:randomUUID()};await save(fresh);
  assert.equal((await reconcileAdminPrivateDocumentMetadata(db,admin.session,{commandId:fresh.commandId,id:fresh.id,close:true})).status,'RECORDED');
  assert.equal((await history(input.id)).length,1);
});
test('audit insertion failure rolls back metadata journal and selection epoch atomically',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),input=await command(f.receipt.documentId),original=await db.document.findUniqueOrThrow({where:{id:input.id}});
  const failing=new Proxy(db, {get(target,property){
    if(property==='$transaction')return (work:(tx:unknown)=>unknown,options:unknown)=>target.$transaction(tx=>work(new Proxy(tx,{get(t,p){
      if(p==='auditLog')return {...t.auditLog,create:async()=>{throw new Error('SYNTHETIC_METADATA_AUDIT_FAILURE');}};return Reflect.get(t,p);
    }})) as never,options as never);
    return Reflect.get(target,property);
  }});
  await assert.rejects(saveAdminPrivateDocumentMetadata(failing,admin.session,input,proof()),/SYNTHETIC_METADATA_AUDIT_FAILURE/);
  assert.deepEqual(await db.document.findUniqueOrThrow({where:{id:input.id}}),original);assert.equal((await history(input.id)).length,0);
});
test('another Admin cannot acquire metadata authority from an ID or reconcile a foreign receipt',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),other=await syntheticPerson(db,'Altro Admin sintetico metadati'),input=await command(f.receipt.documentId);
  await save(input);await assert.rejects(readAdminPrivateDocumentMetadata(db,other.session,input.id));
  await assert.rejects(reconcileAdminPrivateDocumentMetadata(db,other.session,{commandId:input.commandId,id:input.id,close:false}));
  await assert.rejects(save({...input,commandId:randomUUID()},other));
});
test('metadata correction of an archived source never restores bytes or revives its lifecycle',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId;
  const data=await readAdminOperationalState(db,admin.session,'Document',id);
  await saveAdminOperationalState(db,admin.session,{commandId:randomUUID(),model:'Document',id,expectedVersion:data.expectedVersion,
    state:'ARCHIVED',reason:'Archivio sintetico isolato',confirmed:true},proof());
  await save(await command(id));
  assert.equal((await readAdminOperationalState(db,admin.session,'Document',id)).state,'ARCHIVED');
  await assert.rejects(readPersonalAcquiredDocument(db,admin.session,id));await assert.rejects(selected(f));
});
test('admitted private byte reads retain their source epoch until the read transaction completes',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),id=f.receipt.documentId,input=await command(id);
  let admitted!:()=>void,resume!:()=>void;
  const entered=new Promise<void>(r=>{admitted=r;}),continued=new Promise<void>(r=>{resume=r;});
  const reading=db.$transaction(async tx=>{
    const document=await tx.document.findUniqueOrThrow({where:{id}});
    assert(await selectedTechnicalAcquisition(tx,admin.user.id,document));admitted();await continued;
  },{timeout:30000});
  await entered;
  try{
    await assert.rejects(db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
      await tx.$executeRaw`UPDATE "Document" SET "selectiveEpoch"="selectiveEpoch"+1 WHERE id=${id}`;
    }),/lock timeout/);
  }finally{resume();await reading;}
  await save(input);assert.equal((await history(id)).length,1);
});
test('revoked sessions cannot write or read a previously prepared correction',options,async()=>{
  const f=await lifecyclePrivateDocumentFixture(db,admin),input=await command(f.receipt.documentId);
  await db.internalSession.update({where:{id:admin.session.sessionId},data:{revokedAt:new Date()}});
  await assert.rejects(save(input));await assert.rejects(readAdminPrivateDocumentMetadata(db,admin.session,input.id));
  admin={user:admin.user,...await syntheticSession(db,admin.user)};
  await save(input);assert.equal((await history(input.id)).length,1);
});

