import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { Permission } from './permissions';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { canViewLead } from './access-control';
import { isSelectiveLead } from './selective-lead-policy';
import { adminPracticeReadinessSource } from './practice-readiness';
import { adminCommunicationSourceContext } from './approved-communications';
import { adminTechnicalAcquisitionHistory } from './technical-document-acquired-access';
import { mapSerializableConflict, SerializableConflictError } from './serializable';
import { PracticeReadinessError } from './practice-readiness';
import { ApprovedCommunicationError } from './approved-communication-contract';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { RecordUpdateError } from './record-update-contract';
import { adminOperationalModels, adminOperationalStates, operationalReference, readOperationalState,
  lockOperationalStateTransition, AdminOperationalStateError, type AdminOperationalModel, type AdminOperationalState } from './admin-operational-state';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof updateActor>>;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => canonicalSha256(plain(value));
const deny = (): never => { throw new AdminOperationalStateError('DENIED'); };
const policy: Record<AdminOperationalModel,{ read: Permission; write: Permission; label: string }> = {
  ControlledIntake: { read: 'lead.read', write: 'lead.write', label: 'Acquisizione' },
  PracticeReadiness: { read: 'service.read', write: 'service.write', label: 'Pratica preventivo e avvio' },
  ApprovedCommunication: { read: 'practice_communications.read', write: 'practice_communications.write', label: 'Comunicazione' },
  CommunicationReply: { read: 'practice_communications.read', write: 'practice_communications.write', label: 'Risposta ricevuta' },
  Document: { read: 'document.download', write: 'document.upload', label: 'Documento acquisito privatamente' },
};
export const adminOperationalCommand = z.object({
  commandId: z.string().uuid(), model: z.enum(adminOperationalModels), id: z.string().min(1).max(128),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(adminOperationalStates),
  reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true),
}).strict();
export type AdminOperationalCommand = z.infer<typeof adminOperationalCommand>;
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await work(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; return result;
  }, { isolationLevel: 'Serializable', timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, session: AuthSession, model: AdminOperationalModel, proof?: UpdateCredentials) {
  const current = await updateActor(tx,session,proof);
  if (current.actor.role !== 'admin' || !recordUpdatePermission(current.actor,policy[model].read)
    || proof && !recordUpdatePermission(current.actor,policy[model].write)) deny();
  return current;
}
async function source(tx: Tx, session: AuthSession, current: Authority, model: AdminOperationalModel, id: string, write = false) {
  const table = { ControlledIntake: Prisma.sql`"ControlledIntake"`, PracticeReadiness: Prisma.sql`"PracticeReadiness"`,
    ApprovedCommunication: Prisma.sql`"ApprovedCommunication"`, CommunicationReply: Prisma.sql`"CommunicationReply"`, Document: Prisma.sql`"Document"` }[model];
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${table} WHERE id=${id}${model === 'Document' ? Prisma.empty : Prisma.sql`::uuid`} ${write ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}`);
  if (model === 'ControlledIntake') {
    const row = await tx.controlledIntake.findUnique({ where: { id } }); if (!row) return deny();
    const lead = await tx.lead.findUnique({ where: { id: row.leadId } });
    if (!lead || lead.deletedAt || isSelectiveLead(current.actor,lead.id) || !canViewLead(current.actor,lead)) return deny();
    return { row, label: row.subjectName || row.firstName+' '+row.lastName, href: '/controlled-intakes#intake-'+id };
  }
  if (model === 'PracticeReadiness') {
    const admitted = await adminPracticeReadinessSource(tx,session,id);
    return { row: admitted.source, label: admitted.label, href: admitted.href };
  }
  if (model === 'ApprovedCommunication' || model === 'CommunicationReply') {
    const admitted = await adminCommunicationSourceContext(tx,current.actor,model,id);
    if (model === 'CommunicationReply') {
      const row = await tx.communicationReply.findUnique({where:{id}}); if (!row) return deny();
      return { row, label: row.subject, href: admitted.href };
    }
    const row = await tx.approvedCommunication.findUnique({where:{id}}); if (!row) return deny();
    const version = await tx.communicationVersion.findUnique({where:{messageId_revision:{messageId:id,revision:row.currentRevision}},select:{snapshot:true}});
    const label = z.object({subject:z.string()}).safeParse(version?.snapshot);
    return {row,label:label.success?label.data.subject:'Comunicazione conservata',href:admitted.href};
  }
  const row = await tx.document.findUnique({where:{id}});if(!row?.clientId)return deny();
  await adminTechnicalAcquisitionHistory(tx,current.actor.id,row);
  return {row,label:row.title,href:'/clients/'+encodeURIComponent(row.clientId)+'/acquired-documents'};
}
/** Shared metadata-only admission for receipts and the source editor. */
export async function assertAdminOperationalSource(tx: Tx, session: AuthSession, rawModel: string, rawId: string) {
  const reference=operationalReference(rawModel,rawId), current=await authority(tx,session,reference.model);
  const admitted=await source(tx,session,current,reference.model,reference.id);await current.finish();return admitted;
}
function stateSnapshot(id: string, state: AdminOperationalState, version: number, sourceHash: string) {
  return { id, operationalLifecycle: { state, version }, sourceHash };
}
async function assertNoOpenDispatch(tx: Tx, model: AdminOperationalModel, id: string) {
  if (!['ControlledIntake','PracticeReadiness','ApprovedCommunication'].includes(model)) return;
  // The exclusive source-state lock is already held. Native reservations share
  // that lock; query the existence of an unresolved outcome, not a bounded
  // sample of the history. A large completed history must remain administrable.
  const [pending]=await tx.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS(SELECT 1 FROM "ApprovedCommunication" m
    LEFT JOIN "PracticeReadiness" p ON p.id=m."readinessId"
    LEFT JOIN "TechnicalPractice" t ON t.id=m."technicalPracticeId"
    LEFT JOIN "PracticeReadiness" sp ON sp."clientServiceId"=t."clientServiceId"
    LEFT JOIN "ControlledIntake" i ON i."leadId"=m."leadId"
    WHERE ((${model}='ApprovedCommunication' AND m.id::text=${id})
      OR (${model}='PracticeReadiness' AND (p.id::text=${id} OR sp.id::text=${id}))
      OR (${model}='ControlledIntake' AND (i.id::text=${id} OR p."controlledIntakeId"::text=${id} OR sp."controlledIntakeId"::text=${id})))
    AND (m.state IN ('SENDING','UNCERTAIN')
      OR EXISTS(SELECT 1 FROM "CommunicationAttempt" a WHERE a."messageId"=m.id AND a.state IN ('SENDING','UNCERTAIN'))
      OR EXISTS(SELECT 1 FROM "OrdinaryEmailAttempt" a WHERE a."messageId"=m.id AND a.state IN ('RESERVED','CLAIMED','UNCERTAIN')))) AS blocked`;
  if(pending.blocked)throw new AdminOperationalStateError('IN_FLIGHT');
}
async function journal(tx: Tx,current:Authority,input:{commandId:string;model:AdminOperationalModel;id:string;reason:string},
  requestHash:string,operation:'UPDATE'|'TRASH'|'RESTORE'|'CLOSE',before:unknown,after:unknown){
  const beforeHash=digest(before),afterHash=digest(after);
  await tx.adminRecordRevision.create({data:{commandId:input.commandId,model:input.model,recordId:input.id,
    actorId:current.actor.id,sessionId:current.registry.id,operation,requestHash,beforeHash,afterHash,
    before:before===null?Prisma.JsonNull:plain(before),after:after===null?Prisma.JsonNull:plain(after),reason:input.reason}});
  await tx.auditLog.create({data:{id:'admin-record:'+input.commandId,actorId:current.actor.id,entityType:input.model,entityId:input.id,
    event:operation==='CLOSE'?'admin_record_attempt_closed':'admin_record_changed',
    after:operation==='CLOSE'?{commandId:input.commandId}:{commandId:input.commandId,action:operation,beforeHash,afterHash,changedPaths:['operationalLifecycle']}}});
}
export async function readAdminOperationalState(db:PrismaClient,session:AuthSession,rawModel:string,rawId:string,page=1){
  z.number().int().min(1).max(10000).parse(page);
  const reference=operationalReference(rawModel,rawId);
  return transaction(db,async tx=>{
    const current=await authority(tx,session,reference.model), admitted=await source(tx,session,current,reference.model,reference.id);
    const stored=await readOperationalState(tx,reference.model,reference.id);
    const state=stored?.state??'ACTIVE',version=stored?.version??0;
    const history=await tx.adminRecordRevision.findMany({where:{model:reference.model,recordId:reference.id,
      after:{path:['operationalLifecycle','version'],not:Prisma.AnyNull}},orderBy:[{createdAt:'desc'},{commandId:'desc'}],skip:(page-1)*50,take:51,
      select:{commandId:true,operation:true,reason:true,createdAt:true,before:true,after:true}});
    await current.finish();
    return {...reference,label:admitted.label,kindLabel:policy[reference.model].label,href:admitted.href,state,version,
      expectedVersion:digest({source:admitted.row,state:stored}),
      canWrite:recordUpdatePermission(current.actor,policy[reference.model].write),
      page,hasMore:history.length>50,history:history.slice(0,50).map(row=>({...row,createdAt:row.createdAt.toISOString()}))};
  });
}
export async function saveAdminOperationalState(db:PrismaClient,session:AuthSession,raw:unknown,proof:UpdateCredentials){
  const input=adminOperationalCommand.parse(raw),reference=operationalReference(input.model,input.id);
  input.id=reference.id;const requestHash=digest({protocol:'ADMIN_OPERATIONAL_STATE_V1',input});
  return transaction(db,async tx=>{
    const current=await authority(tx,session,input.model,proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
    const previous=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
    if(previous){
      if(previous.actorId!==current.actor.id||previous.model!==input.model||previous.recordId!==input.id)return deny();
      if(previous.operation==='CLOSE')throw new AdminOperationalStateError('CLOSED');
      if(previous.requestHash!==requestHash)throw new AdminOperationalStateError('STALE');
      await source(tx,session,current,input.model,input.id);await current.finish();
      return {commandId:input.commandId,model:input.model,id:input.id,replayed:true};
    }
    const state=await lockOperationalStateTransition(tx,input.model,input.id);
    const admitted=await source(tx,session,current,input.model,input.id,true);
    if(digest({source:admitted.row,state})!==input.expectedVersion||state.state===input.state)throw new AdminOperationalStateError('STALE');
    await assertNoOpenDispatch(tx,input.model,input.id);
    const nextVersion=state.version+1,sourceHash=digest(admitted.row);
    const before=stateSnapshot(input.id,state.state,state.version,sourceHash);

    await tx.$executeRaw`UPDATE "AdminOperationalState" SET state=${input.state},version=${nextVersion},"lastCommandId"=${input.commandId}::uuid
      WHERE model=${input.model} AND "recordId"=${input.id}`;
    const operation=input.state==='TRASHED'?'TRASH':input.state==='ACTIVE'?'RESTORE':'UPDATE';
    const afterSourceHash=input.model==='Document'?digest(await tx.document.findUniqueOrThrow({where:{id:input.id}})):sourceHash;
    await journal(tx,current,input,requestHash,operation,before,stateSnapshot(input.id,input.state,nextVersion,afterSourceHash));
    await current.finish();return {commandId:input.commandId,model:input.model,id:input.id,replayed:false};
  });
}
export async function reconcileAdminOperationalState(db:PrismaClient,session:AuthSession,raw:unknown){
  const input=z.object({commandId:z.string().uuid(),model:z.enum(adminOperationalModels),id:z.string(),close:z.boolean()}).strict().parse(raw);
  input.id=operationalReference(input.model,input.id).id;
  const settle=()=>transaction(db,async tx=>{
    const current=await authority(tx,session,input.model);
    if(!recordUpdatePermission(current.actor,policy[input.model].write))return deny();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:'+input.commandId},0))::text`;
    await source(tx,session,current,input.model,input.id);
    const previous=await tx.adminRecordRevision.findUnique({where:{commandId:input.commandId}});
    if(previous){
      if(previous.actorId!==current.actor.id||previous.model!==input.model||previous.recordId!==input.id)return deny();
      if(previous.operation!=='CLOSE'&&!z.object({operationalLifecycle:z.object({state:z.enum(adminOperationalStates),version:z.number().int().positive()})}).safeParse(previous.after).success)return deny();
      await current.finish();return {status:previous.operation==='CLOSE'?'CLOSED' as const:'RECORDED' as const};
    }
    if(!input.close){await current.finish();return {status:'UNKNOWN' as const};}
    await journal(tx,current,{...input,reason:'Tentativo di lifecycle verificato e chiuso senza modifica operativa.'},
      digest({protocol:'ADMIN_OPERATIONAL_STATE_V1',close:input}),'CLOSE',null,null);
    await current.finish();return {status:'CLOSED' as const};
  });
  for(let attempt=0;;attempt++){
    try{return await settle();}
    catch(error){if(!(error instanceof SerializableConflictError)||attempt>=2)throw error;}
  }
}

/** Bounded metadata index. Each candidate must pass its own native admission. */
export async function listAdminOperationalSources(db:PrismaClient,session:AuthSession,raw:unknown){
  const input=z.object({model:z.enum(adminOperationalModels),state:z.enum([...adminOperationalStates,'ALL']),
    query:z.string().trim().max(128),page:z.number().int().min(1).max(10000)}).strict().parse(raw);
  return transaction(db,async tx=>{
    const current=await authority(tx,session,input.model);
    const table={ControlledIntake:Prisma.sql`"ControlledIntake"`,PracticeReadiness:Prisma.sql`"PracticeReadiness"`,
      ApprovedCommunication:Prisma.sql`"ApprovedCommunication"`,CommunicationReply:Prisma.sql`"CommunicationReply"`,Document:Prisma.sql`"Document"`}[input.model];
    const privateOnly=input.model==='Document'?Prisma.sql`AND t."visibilityLevel"='technical_admin_private_v1'`:Prisma.empty;
    const candidates=await tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT t.id::text AS id FROM ${table} t
      LEFT JOIN "AdminOperationalState" s ON s.model=${input.model} AND s."recordId"=t.id::text
      WHERE (${input.state}='ALL' OR COALESCE(s.state,'ACTIVE')=${input.state})
      AND position(lower(${input.query}) in lower(t.id::text))>0 ${privateOnly}
      ORDER BY t.id LIMIT 51 OFFSET ${(input.page-1)*50}`);
    const records=[];
    for(const candidate of candidates.slice(0,50)){
      try{
        const admitted=await source(tx,session,current,input.model,candidate.id);
        const state=await readOperationalState(tx,input.model,candidate.id);
        records.push({id:candidate.id,label:admitted.label,state:state?.state??'ACTIVE' as const,href:admitted.href});
      }catch(error){
        if(error instanceof AdminOperationalStateError||error instanceof PracticeReadinessError
          ||error instanceof ApprovedCommunicationError||error instanceof TechnicalAssignmentError||error instanceof RecordUpdateError)continue;
        throw error;
      }
    }
    await current.finish();return {...input,records,hasMore:candidates.length>50,kindLabel:policy[input.model].label};
  });
}
