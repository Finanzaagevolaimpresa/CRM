import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor,type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { canAccessFinancialDocument } from './financial-document-access';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { adminTechnicalAcquisitionHistory } from './technical-document-acquired-access';
import { mapSerializableConflict,SerializableConflictError } from './serializable';
import { privateMetadataModel,privateMetadataValues,privateMetadataSnapshot,privateMetadataDigest as digest,
  effectivePrivateDocument,PrivateDocumentMetadataError as MetadataError } from './private-document-metadata';

type Tx=Prisma.TransactionClient;
type Authority=Awaited<ReturnType<typeof updateActor>>;
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const deny=():never=>{throw new MetadataError('DENIED');};
export const privateMetadataCommand=z.object({
  commandId:z.string().uuid(),id:z.string().min(1).max(128),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),
  values:privateMetadataValues,reason:z.string().trim().min(3).max(2000),confirmed:z.literal(true),
}).strict();
async function transaction<T>(db:PrismaClient,work:(tx:Tx)=>Promise<T>){
  try{return await db.$transaction(async tx=>{const result=await work(tx);await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;return result;},
    {isolationLevel:'Serializable',timeout:30000});}catch(error){throw mapSerializableConflict(error);}
}
async function authority(tx:Tx,session:AuthSession,proof?:UpdateCredentials){
  const current=await updateActor(tx,session,proof);
  if(current.actor.role!=='admin'||!recordUpdatePermission(current.actor,'document.download')
    ||proof&&!recordUpdatePermission(current.actor,'document.upload'))deny();
  return current;
}
async function source(tx:Tx,current:Authority,id:string,write=false){
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Document" WHERE id=${id} ${write?Prisma.sql`FOR UPDATE`:Prisma.sql`FOR SHARE`}`);
  const document=await tx.document.findUnique({where:{id}});
  if(!document?.clientId)return deny();
  const saved=await adminTechnicalAcquisitionHistory(tx,current.actor.id,document);
  if(hasSelectiveClientContext(current.actor,document)||hasSelectiveContext(current.actor,document)
    ||saved.record.receipt.reference.kind==='TechnicalPractice'&&isSelectivePractice(current.actor,saved.record.receipt.reference.targetId))return deny();
  return {document,saved,profile:saved.metadata,expectedVersion:digest({document,metadata:saved.metadata.current})};
}
async function journal(tx:Tx,current:Authority,input:{commandId:string;id:string;reason:string},requestHash:string,
  operation:'UPDATE'|'CLOSE',before:unknown,after:unknown){
  const beforeHash=digest(before),afterHash=digest(after);
  await tx.adminRecordRevision.create({data:{commandId:input.commandId,model:privateMetadataModel,recordId:input.id,
    actorId:current.actor.id,sessionId:current.registry.id,requestHash,operation,beforeHash,afterHash,
    before:before===null?Prisma.JsonNull:plain(before),after:after===null?Prisma.JsonNull:plain(after),reason:input.reason}});
  await tx.auditLog.create({data:{id:'admin-record:'+input.commandId,actorId:current.actor.id,entityType:privateMetadataModel,entityId:input.id,
    event:operation==='CLOSE'?'admin_record_attempt_closed':'admin_record_changed',
    after:operation==='CLOSE'?{commandId:input.commandId}:{commandId:input.commandId,action:operation,beforeHash,afterHash,
      changedPaths:['administrativeMetadata']}}});
}
export async function readAdminPrivateDocumentMetadata(db:PrismaClient,session:AuthSession,id:string,page=1){
  z.number().int().min(1).max(10000).parse(page);
  return transaction(db,async tx=>{
    const current=await authority(tx,session),value=await source(tx,current,id);
    const history=await tx.adminRecordRevision.findMany({where:{model:privateMetadataModel,recordId:id,operation:'UPDATE'},
      orderBy:[{createdAt:'desc'},{commandId:'desc'}],skip:(page-1)*50,take:51,
      select:{commandId:true,reason:true,createdAt:true,before:true,after:true}});
    await current.finish();
    return {id,title:value.document.title,fileName:value.document.fileName,sourceVersionId:value.saved.version.id,
      clientId:value.document.clientId!,original:value.profile.original,current:value.profile.current,
      expectedVersion:value.expectedVersion,canWrite:recordUpdatePermission(current.actor,'document.upload'),
      page,hasMore:history.length>50,history:history.slice(0,50).map(row=>({commandId:row.commandId,reason:row.reason,
        createdAt:row.createdAt.toISOString(),before:privateMetadataSnapshot.parse(row.before),after:privateMetadataSnapshot.parse(row.after)}))};
  });
}
export async function saveAdminPrivateDocumentMetadata(db:PrismaClient,session:AuthSession,raw:unknown,proof:UpdateCredentials){
  const input=privateMetadataCommand.parse(raw),requestHash=digest({protocol:'ADMIN_PRIVATE_METADATA_V1',input});
  return transaction(db,async tx=>{
    const current=await authority(tx,session,proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
    const previous=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
    if(previous){
      if(previous.model!==privateMetadataModel||previous.recordId!==input.id||previous.actorId!==current.actor.id)return deny();
      if(previous.operation==='CLOSE')throw new MetadataError('CLOSED');
      if(previous.requestHash!==requestHash)throw new MetadataError('STALE');
      await source(tx,current,input.id);await current.finish();return {replayed:true};
    }
    const value=await source(tx,current,input.id,true);
    if(value.expectedVersion!==input.expectedVersion)throw new MetadataError('STALE');
    if(digest(input.values)===digest(value.profile.current.values))throw new MetadataError('INVALID');
    const effective=effectivePrivateDocument(value.document,input.values);
    if(effective.containsSensitiveData&&!recordUpdatePermission(current.actor,'document.sensitive.read')
      ||!await canAccessFinancialDocument(tx,current.actor,effective))return deny();
    const after={...value.profile.current,revision:value.profile.current.revision+1,values:input.values};
    // The canonical signed row changes only its permitted selection epoch. Old
    // grants remain invalid even if a later correction restores the old values.
    await tx.$executeRaw`UPDATE "Document" SET "selectiveEpoch"="selectiveEpoch"+1 WHERE id=${input.id}`;
    await journal(tx,current,input,requestHash,'UPDATE',value.profile.current,after);
    await current.finish();return {replayed:false};
  });
}
export async function reconcileAdminPrivateDocumentMetadata(db:PrismaClient,session:AuthSession,raw:unknown){
  const input=z.object({commandId:z.string().uuid(),id:z.string().min(1).max(128),close:z.boolean()}).strict().parse(raw);
  for(let attempt=0;;attempt++){
    try{return await transaction(db,async tx=>{
      const current=await authority(tx,session);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
      await source(tx,current,input.id);
      const row=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
      if(row){
        if(row.model!==privateMetadataModel||row.recordId!==input.id||row.actorId!==current.actor.id)return deny();
        await current.finish();return {status:row.operation==='CLOSE'?'CLOSED' as const:'RECORDED' as const};
      }
      if(!input.close){await current.finish();return {status:'UNKNOWN' as const};}
      await journal(tx,current,{...input,reason:'Chiusura esplicita di un tentativo senza modifica registrata'},
        digest({protocol:'ADMIN_PRIVATE_METADATA_CLOSE_V1',input}),'CLOSE',null,null);
      await current.finish();return {status:'CLOSED' as const};
    });}catch(error){if(!(error instanceof SerializableConflictError)||attempt>=2)throw error;}
  }
}
