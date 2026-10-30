import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor,type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { canonicalSha256 } from './canonical-json';
import { communicationContextSchema,ApprovedCommunicationError } from './approved-communication-contract';
import { communicationRecipientSelectionSchema } from './communication-recipient-policy';
import { admitAdminDraftSource,admitAdminDraftTarget,saveApprovedMessageDraftInTransaction } from './approved-communications';
import { readOperationalState,lockOperationalStateTransition,AdminOperationalStateError } from './admin-operational-state';
import { mapSerializableConflict,SerializableConflictError } from './serializable';

type Tx=Prisma.TransactionClient;
type Authority=Awaited<ReturnType<typeof updateActor>>;
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const digest=(v:unknown)=>canonicalSha256(plain(v));
const deny=():never=>{throw new ApprovedCommunicationError('DENIED');};
export class AdminDraftContextError extends Error{
  constructor(readonly code:'STALE'|'CLOSED'|'INELIGIBLE'){super('ADMIN_DRAFT_CONTEXT_'+code);}
}
export const draftReplacementCommand=z.object({
  commandId:z.string().uuid(),id:z.string().uuid(),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),
  reason:z.string().trim().min(3).max(2000),confirmed:z.literal(true),
  draft:z.object({
    context:communicationContextSchema,mailboxId:z.string().uuid(),replyTo:z.string().email().max(254),
    to:z.array(z.string()).max(20),cc:z.array(z.string()).max(20),bcc:z.array(z.string()).max(20),
    subject:z.string(),body:z.string(),classification:z.enum(['ORDINARY','SENSITIVE','COMPLAINT']),
    attachmentVersionIds:z.array(z.string().min(1).max(128)).max(20),contextFileIds:z.array(z.string().uuid()).max(20),
    recipientSelection:communicationRecipientSelectionSchema,
  }).strict(),
}).strict();
async function transaction<T>(db:PrismaClient,work:(tx:Tx)=>Promise<T>){
  try{return await db.$transaction(async tx=>{const r=await work(tx);await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;return r;},
    {isolationLevel:'Serializable',timeout:30000});}catch(error){throw mapSerializableConflict(error);}
}
async function authority(tx:Tx,session:AuthSession,proof?:UpdateCredentials){
  const current=await updateActor(tx,session,proof);
  if(current.actor.role!=='admin'||!recordUpdatePermission(current.actor,'practice_communications.read')
    ||!recordUpdatePermission(current.actor,'practice_communications.write'))return deny();
  return current;
}
async function source(tx:Tx,session:AuthSession,id:string,write=false){
  const saved=await admitAdminDraftSource(tx,session,id,write),state=await readOperationalState(tx,'ApprovedCommunication',id);
  return {...saved,state,expectedVersion:digest({row:saved.row,snapshotHash:saved.snapshotHash,state})};
}
const href=(context:z.infer<typeof communicationContextSchema>,id?:string)=>'/communications?'+new URLSearchParams({
  kind:context.kind,practice:context.id,...(id?{focus:id}:{})});
async function journal(tx:Tx,current:Authority,input:{commandId:string;id:string;reason:string},requestHash:string,
  operation:'UPDATE'|'CLOSE',before:unknown,after:unknown){
  const beforeHash=digest(before),afterHash=digest(after);
  await tx.adminRecordRevision.create({data:{commandId:input.commandId,model:'ApprovedCommunication',recordId:input.id,
    actorId:current.actor.id,sessionId:current.registry.id,operation,requestHash,beforeHash,afterHash,
    before:before===null?Prisma.JsonNull:plain(before),after:after===null?Prisma.JsonNull:plain(after),reason:input.reason}});
  await tx.auditLog.create({data:{id:'admin-record:'+input.commandId,actorId:current.actor.id,entityType:'ApprovedCommunication',entityId:input.id,
    event:operation==='CLOSE'?'admin_record_attempt_closed':'admin_record_changed',
    after:operation==='CLOSE'?{commandId:input.commandId}:{commandId:input.commandId,action:operation,beforeHash,afterHash,
      changedPaths:['operationalLifecycle','replacementDraft']}}});
}
export async function readAdminDraftReplacement(db:PrismaClient,session:AuthSession,id:string){
  z.string().uuid().parse(id);
  return transaction(db,async tx=>{
    const current=await authority(tx,session),saved=await source(tx,session,id);
    const revisions=await tx.adminRecordRevision.findMany({where:{model:'ApprovedCommunication',operation:'UPDATE',
      OR:[{recordId:id},{commandId:id}],after:{path:['replacementDraft'],not:Prisma.AnyNull}},
      orderBy:[{createdAt:'desc'},{commandId:'desc'}],take:51});
    const links:Array<{id:string;label:string;href:string;relation:'ORIGINAL'|'REPLACEMENT'}>=[];
    for(const revision of revisions.slice(0,50)){
      const result=replacement(revision);if(!result.success)continue;
      const next=result.data.replacementDraft,otherId=revision.recordId===id?next.id:revision.recordId;
      if(otherId===id)continue;
      try{
        const other=await admitAdminDraftSource(tx,session,otherId);
        links.push({id:otherId,label:other.snapshot.subject,href:href(other.snapshot.context,otherId),
          relation:revision.recordId===id?'REPLACEMENT':'ORIGINAL'});
      }catch(error){if(error instanceof ApprovedCommunicationError||error instanceof AdminOperationalStateError)continue;throw error;}
    }
    await current.finish();
    return {id,expectedVersion:saved.expectedVersion,sourceContext:saved.snapshot.context,sourceHref:href(saved.snapshot.context,id),
      subject:saved.snapshot.subject,body:saved.snapshot.body,classification:saved.snapshot.classification,
      eligible:saved.eligible&&saved.state.state==='ACTIVE',state:saved.state.state,links,moreHistory:revisions.length>50};
  });
}
export async function listAdminDraftTargets(db:PrismaClient,session:AuthSession,raw:unknown){
  const input=z.object({kind:z.enum(['CLIENT','LEAD','READINESS','TECHNICAL','INTERNAL']),query:z.string().trim().max(128),
    page:z.number().int().min(1).max(10000)}).strict().parse(raw);
  return transaction(db,async tx=>{
    const current=await authority(tx,session);
    const query={
      CLIENT:Prisma.sql`SELECT id, "displayName" AS label FROM "Client" WHERE "deletedAt" IS NULL`,
      LEAD:Prisma.sql`SELECT id, concat_ws(' ',"firstName","lastName","companyName",email) AS label FROM "Lead" WHERE "deletedAt" IS NULL`,
      READINESS:Prisma.sql`SELECT p.id::text AS id,concat_ws(' · ',c."displayName",p.id::text) AS label FROM "PracticeReadiness" p JOIN "Client" c ON c.id=p."clientId" WHERE c."deletedAt" IS NULL`,
      TECHNICAL:Prisma.sql`SELECT p.id,concat_ws(' · ',p.title,c."displayName") AS label FROM "TechnicalPractice" p JOIN "Client" c ON c.id=p."clientId" WHERE p."deletedAt" IS NULL AND c."deletedAt" IS NULL`,
      INTERNAL:Prisma.sql`SELECT id::text AS id,title AS label FROM "InternalCommunicationThread" WHERE "deletedAt" IS NULL`,
    }[input.kind];
    const candidates=await tx.$queryRaw<Array<{id:string;label:string}>>(Prisma.sql`SELECT * FROM (${query}) c
      WHERE position(lower(${input.query}) in lower(c.id||' '||c.label))>0 ORDER BY c.label,c.id LIMIT 51 OFFSET ${(input.page-1)*50}`);
    const records=[];
    for(const row of candidates.slice(0,50)){
      try{await admitAdminDraftTarget(tx,session,{kind:input.kind,id:row.id});records.push({...row,kind:input.kind});}
      catch(error){if(error instanceof ApprovedCommunicationError||error instanceof AdminOperationalStateError)continue;throw error;}
    }
    await current.finish();return {...input,records,hasMore:candidates.length>50};
  });
}
function replacement(row:{after:Prisma.JsonValue}){
  return z.object({replacementDraft:z.object({id:z.string().uuid(),context:communicationContextSchema})}).safeParse(row.after);
}
export async function replaceAdminCommunicationDraft(db:PrismaClient,session:AuthSession,raw:unknown,proof:UpdateCredentials){
  const input=draftReplacementCommand.parse(raw),requestHash=digest({protocol:'ADMIN_DRAFT_CONTEXT_V1',input});
  return transaction(db,async tx=>{
    const current=await authority(tx,session,proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
    const previous=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
    if(previous){
      if(previous.actorId!==current.actor.id||previous.model!=='ApprovedCommunication'||previous.recordId!==input.id)return deny();
      if(previous.operation==='CLOSE')throw new AdminDraftContextError('CLOSED');
      if(previous.requestHash!==requestHash)throw new AdminDraftContextError('STALE');
      const result=replacement(previous);if(!result.success||result.data.replacementDraft.id!==input.commandId)return deny();
      await source(tx,session,input.id);await admitAdminDraftSource(tx,session,input.commandId);await current.finish();
      return {id:input.commandId,href:href(result.data.replacementDraft.context,input.commandId),replayed:true};
    }
    const state=await lockOperationalStateTransition(tx,'ApprovedCommunication',input.id);
    const saved=await source(tx,session,input.id,true);
    if(!saved.eligible||state.state!=='ACTIVE')throw new AdminDraftContextError('INELIGIBLE');
    if(saved.expectedVersion!==input.expectedVersion)throw new AdminDraftContextError('STALE');
    if(digest(saved.snapshot.context)===digest(input.draft.context)||input.commandId===input.id)return deny();
    if(saved.snapshot.classification==='COMPLAINT'&&input.draft.classification!=='COMPLAINT'
      ||saved.snapshot.classification==='SENSITIVE'&&input.draft.classification==='ORDINARY')return deny();
    await tx.$queryRaw`SELECT id FROM "CommunicationMailbox" WHERE id=${input.draft.mailboxId}::uuid FOR SHARE`;
    const [oldBox,newBox]=await Promise.all([
      tx.communicationMailbox.findUnique({where:{id:saved.row.mailboxId}}),tx.communicationMailbox.findUnique({where:{id:input.draft.mailboxId}})]);
    if(!oldBox||!newBox||oldBox.restricted&&!newBox.restricted)return deny();
    if(await tx.approvedCommunication.findUnique({where:{id:input.commandId}}))throw new AdminDraftContextError('STALE');
    await admitAdminDraftTarget(tx,session,input.draft.context);
    const created=await saveApprovedMessageDraftInTransaction(tx,session,{...input.draft,messageId:input.commandId,expectedRevision:0});
    const before={id:input.id,sourceHash:digest(saved.row),operationalLifecycle:{state:state.state,version:state.version}};
    const after={...before,operationalLifecycle:{state:'ARCHIVED',version:state.version+1},
      replacementDraft:{id:created.id,context:input.draft.context,snapshotHash:created.snapshotHash}};
    await tx.$executeRaw`UPDATE "AdminOperationalState" SET state='ARCHIVED',version=${state.version+1},"lastCommandId"=${input.commandId}::uuid
      WHERE model='ApprovedCommunication' AND "recordId"=${input.id}`;
    await journal(tx,current,input,requestHash,'UPDATE',before,after);
    await current.finish();return {id:created.id,href:href(input.draft.context,created.id),replayed:false};
  });
}
export async function reconcileAdminDraftReplacement(db:PrismaClient,session:AuthSession,raw:unknown){
  const input=z.object({commandId:z.string().uuid(),id:z.string().uuid(),close:z.boolean()}).strict().parse(raw);
  for(let attempt=0;;attempt++){
    try{return await transaction(db,async tx=>{
      const current=await authority(tx,session);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
      await source(tx,session,input.id);
      const row=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
      if(row){
        if(row.actorId!==current.actor.id||row.model!=='ApprovedCommunication'||row.recordId!==input.id)return deny();
        if(row.operation==='CLOSE'){await current.finish();return {status:'CLOSED' as const};}
        const result=replacement(row);if(!result.success||result.data.replacementDraft.id!==input.commandId)return deny();
        await admitAdminDraftSource(tx,session,input.commandId);await current.finish();
        return {status:'RECORDED' as const,href:href(result.data.replacementDraft.context,input.commandId)};
      }
      if(!input.close){await current.finish();return {status:'UNKNOWN' as const};}
      if(await tx.approvedCommunication.findUnique({where:{id:input.commandId}}))return deny();
      await journal(tx,current,{...input,reason:'Tentativo di sostituzione della bozza chiuso senza effetto.'},
        digest({protocol:'ADMIN_DRAFT_CONTEXT_CLOSE_V1',input}),'CLOSE',null,null);
      await current.finish();return {status:'CLOSED' as const};
    });}catch(error){if(!(error instanceof SerializableConflictError)||attempt>=2)throw error;}
  }
}
