import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { canEditClient, canViewClient } from './access-control';
import { hasPermission } from './permission-evaluator';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { assertSyntheticCatalogDatabase, catalogRevisionIsSelectable } from './service-catalog-v2-persistence';
import { FAI_SERVICE_CATALOG_V2 } from './service-catalog-v2';

export class PracticeReadinessError extends Error { constructor(readonly code:'DISABLED'|'DENIED'|'CONFLICT'|'NOT_READY'){super(code);} }
export const exactMoneySchema=z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/,'Importo monetario non valido.').refine(v=>new Prisma.Decimal(v).gt(0),'Importo monetario non valido.');
const nonnegativeMoneySchema=z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/,'Importo monetario non valido.');
const setupSchema=z.object({controlledIntakeId:z.string().uuid(),commercialOfferId:z.string().min(1),serviceRevisionId:z.string().uuid(),clientId:z.string().min(1),projectId:z.string().optional().nullable(),requiredInitialAmount:nonnegativeMoneySchema,expectedOfferUpdatedAt:z.coerce.date()});
const fundingSchema=z.object({practiceId:z.string().uuid(),reference:z.string().trim().min(1).max(120),amount:exactMoneySchema,currency:z.literal('EUR'),expectedVersion:z.coerce.number().int().positive()});
const fundingTransitionSchema=z.object({practiceId:z.string().uuid(),evidenceId:z.string().uuid(),expectedVersion:z.coerce.number().int().positive()});
const materialSchema=z.object({practiceId:z.string().uuid(),checklistItemId:z.string().min(1),documentId:z.string().optional().nullable(),status:z.enum(['VALIDATED','NOT_NEEDED','INVALIDATED']),reason:z.string().trim().max(500).optional().nullable(),expectedVersion:z.coerce.number().int().positive()}).superRefine((v,c)=>{if(v.status==='NOT_NEEDED'&&!v.reason)c.addIssue({code:'custom',message:'Motivazione obbligatoria.'});});
const startSchema=z.object({practiceId:z.string().uuid(),expectedVersion:z.coerce.number().int().positive()});
type Db=Pick<PrismaClient,'$transaction'|'$queryRaw'>;
function enabled(){if(process.env.PRACTICE_READINESS_MODE!=='synthetic')throw new PracticeReadinessError('DISABLED');}
async function actor(tx:Prisma.TransactionClient,claimed:AuthSession,permission:'service.read'|'service.write'='service.write'){const s=claimed.sessionId?await lockAuthoritativeInternalSession(tx,{sessionId:claimed.sessionId,userId:claimed.userId}):null;if(!s||s.revokedAt||!s.live||!s.active||s.deletedAt||!hasPermission({role:s.role,active:s.active,permissionOverrides:s.permissionOverrides},permission))throw new PracticeReadinessError('DENIED');return s;}
async function practiceScope(tx:Prisma.TransactionClient,a:Awaited<ReturnType<typeof actor>>,id:string,write=true){const practice=await tx.practiceReadiness.findUnique({where:{id}});if(!practice)throw new PracticeReadinessError('DENIED');const [client,project,intake]=await Promise.all([tx.client.findUnique({where:{id:practice.clientId}}),practice.projectId?tx.project.findUnique({where:{id:practice.projectId}}):null,tx.controlledIntake.findUnique({where:{id:practice.controlledIntakeId}})]);const lead=intake?await tx.lead.findUnique({where:{id:intake.leadId}}):null;if(!client||client.deletedAt||(practice.projectId&&(!project||project.deletedAt||project.clientId!==client.id))||!intake||!lead||lead.deletedAt||lead.clientId!==client.id||(write?!canEditClient(a,client):!canViewClient(a,client)))throw new PracticeReadinessError('DENIED');return {practice,client,project,intake,lead};}

export function practiceOfferSnapshotHash(input:{offerId:string;updatedAt:Date;taxableAmount:Prisma.Decimal;vatAmount:Prisma.Decimal;totalAmount:Prisma.Decimal;revisionId:string}){
  return canonicalSha256({
    offerId:input.offerId,
    updatedAt:input.updatedAt.toISOString(),
    amounts:[input.taxableAmount.toFixed(2),input.vatAmount.toFixed(2),input.totalAmount.toFixed(2)],
    revisionId:input.revisionId,
  });
}

export async function createPracticeReadiness(db:Db,claimed:AuthSession,raw:unknown){enabled();const input=setupSchema.parse(raw);await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed);const [intake,offer,revision,client,project]=await Promise.all([tx.controlledIntake.findUnique({where:{id:input.controlledIntakeId}}),tx.commercialOffer.findUnique({where:{id:input.commercialOfferId}}),tx.serviceCatalogRevision.findUnique({where:{id:input.serviceRevisionId},include:{serviceCatalog:true}}),tx.client.findUnique({where:{id:input.clientId}}),input.projectId?tx.project.findUnique({where:{id:input.projectId}}):null]);const intakeLead=intake?await tx.lead.findUnique({where:{id:intake.leadId}}):null;if(!intake||!intakeLead||intakeLead.deletedAt||!offer||offer.deletedAt||offer.status!=='accettata'||offer.updatedAt.getTime()!==input.expectedOfferUpdatedAt.getTime()||!client||client.deletedAt||!canEditClient(a,client)||offer.clientId!==client.id||intakeLead.clientId!==client.id||(input.projectId&&(!project||project.deletedAt))||(project&&project.clientId!==client.id))throw new PracticeReadinessError('DENIED');const definition=FAI_SERVICE_CATALOG_V2.find(x=>x.code===revision?.serviceCatalog.code);if(!revision||!definition||!catalogRevisionIsSelectable(definition,revision,new Date()))throw new PracticeReadinessError('DENIED');const hash=practiceOfferSnapshotHash({offerId:offer.id,updatedAt:offer.updatedAt,taxableAmount:offer.taxableAmount,vatAmount:offer.vatAmount,totalAmount:offer.totalAmount,revisionId:revision.id});const record=await tx.practiceReadiness.create({data:{controlledIntakeId:intake.id,commercialOfferId:offer.id,offerSnapshotHash:hash,offerRevision:1,serviceRevisionId:revision.id,clientId:client.id,projectId:project?.id,requiredInitialAmount:new Prisma.Decimal(input.requiredInitialAmount),updatedAt:new Date()}});await tx.auditLog.create({data:{actorId:a.userId,event:'practice_readiness_created',entityType:'PracticeReadiness',entityId:record.id,after:{offerRevision:1}}});return record;},{isolationLevel:'Serializable'});}
export async function recordPracticeFunding(db:Db,claimed:AuthSession,raw:unknown){
  enabled(); const input=fundingSchema.parse(raw); await assertSyntheticCatalogDatabase(db);
  const payloadHash=canonicalSha256({operation:'DECLARE',reference:input.reference,amount:input.amount,currency:input.currency});
  return fundingTransaction(db,async tx=>{
    const a=await actor(tx,claimed); const {practice}=await practiceScope(tx,a,input.practiceId);
    const old=await tx.practiceFundingEvidence.findFirst({where:{practiceId:practice.id,reference:input.reference,sequence:1}});
    if(old){if(old.payloadHash!==payloadHash)throw new PracticeReadinessError('CONFLICT');return old;}
    if(practice.version!==input.expectedVersion)throw new PracticeReadinessError('CONFLICT');
    const row=await tx.practiceFundingEvidence.create({data:{practiceId:practice.id,reference:input.reference,amount:new Prisma.Decimal(input.amount),currency:input.currency,status:'DECLARED',sequence:1,payloadHash}});
    await tx.practiceReadiness.update({where:{id:practice.id,version:input.expectedVersion},data:{version:{increment:1}}});
    await writeFundingAudit(tx,a.userId,practice.id,row);
    return row;
  });
}

async function transitionPracticeFunding(db:Db,claimed:AuthSession,raw:unknown,status:'CONFIRMED'|'REVERSED'){
  enabled(); const input=fundingTransitionSchema.parse(raw); await assertSyntheticCatalogDatabase(db);
  return fundingTransaction(db,async tx=>{
    const a=await actor(tx,claimed); const {practice}=await practiceScope(tx,a,input.practiceId);
    const source=await tx.practiceFundingEvidence.findUnique({where:{id:input.evidenceId},include:{successor:true}});
    if(!source||source.practiceId!==practice.id)throw new PracticeReadinessError('DENIED');
    const payloadHash=canonicalSha256({operation:status,sourceId:source.id,reference:source.reference,amount:String(source.amount),currency:source.currency});
    if(source.successor){if(source.successor.status!==status||source.successor.payloadHash!==payloadHash)throw new PracticeReadinessError('CONFLICT');return source.successor;}
    if(practice.version!==input.expectedVersion)throw new PracticeReadinessError('CONFLICT');
    if((status==='CONFIRMED'&&source.status!=='DECLARED')||(status==='REVERSED'&&source.status!=='CONFIRMED'))throw new PracticeReadinessError('CONFLICT');
    const row=await tx.practiceFundingEvidence.create({data:{practiceId:practice.id,reference:source.reference,amount:source.amount,currency:source.currency,status,sequence:source.sequence+1,predecessorId:source.id,payloadHash,verifiedAt:new Date(),verifiedById:a.userId}});
    await tx.practiceReadiness.update({where:{id:practice.id,version:input.expectedVersion},data:{version:{increment:1}}});
    await writeFundingAudit(tx,a.userId,practice.id,row);
    return row;
  });
}

async function fundingTransaction<T>(db:Db,fn:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>{
  for(let attempt=0;attempt<3;attempt+=1){
    try{return await db.$transaction(fn,{isolationLevel:'Serializable'});}
    catch(error){if(!(error instanceof Prisma.PrismaClientKnownRequestError)||!['P2002','P2034'].includes(error.code)||attempt===2)throw error;}
  }
  throw new PracticeReadinessError('CONFLICT');
}

async function writeFundingAudit(tx:Prisma.TransactionClient,actorId:string,practiceId:string,row:{id:string;reference:string;status:string;amount:Prisma.Decimal}){
  await tx.auditLog.create({data:{actorId,event:`practice_funding_${row.status.toLowerCase()}`,entityType:'PracticeReadiness',entityId:practiceId,after:{fundingEvidenceId:row.id,reference:row.reference,status:row.status,amount:String(row.amount)}}});
  if(process.env.PRACTICE_READINESS_TEST_FAIL_AUDIT==='1')throw new PracticeReadinessError('CONFLICT');
}

export function currentAvailableFunding(rows:Array<{id:string;status:string;amount:Prisma.Decimal;successor?:unknown}>){
  return rows.filter(row=>row.status==='CONFIRMED'&&!row.successor).reduce((sum,row)=>sum.add(row.amount),new Prisma.Decimal(0));
}
export function confirmPracticeFunding(db:Db,claimed:AuthSession,raw:unknown){return transitionPracticeFunding(db,claimed,raw,'CONFIRMED');}
export function reversePracticeFunding(db:Db,claimed:AuthSession,raw:unknown){return transitionPracticeFunding(db,claimed,raw,'REVERSED');}
export async function decidePracticeMaterial(db:Db,claimed:AuthSession,raw:unknown){enabled();const input=materialSchema.parse(raw);await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed);const {practice:p}=await practiceScope(tx,a,input.practiceId);const item=await tx.documentChecklistItem.findUnique({where:{id:input.checklistItemId}});if(!p||p.version!==input.expectedVersion||!item||item.clientId!==p.clientId||item.deletedAt||!item.active||(input.status==='VALIDATED'&&(!input.documentId||item.documentId!==input.documentId)))throw new PracticeReadinessError('DENIED');const hash=canonicalSha256(input);const row=await tx.practiceMaterialEvidence.upsert({where:{practiceId_checklistItemId:{practiceId:p.id,checklistItemId:item.id}},create:{practiceId:input.practiceId,checklistItemId:input.checklistItemId,documentId:input.documentId,status:input.status,reason:input.reason,payloadHash:hash,decidedAt:new Date(),decidedById:a.userId},update:{documentId:input.documentId,status:input.status,reason:input.reason,payloadHash:hash,decidedAt:new Date(),decidedById:a.userId}});await tx.practiceReadiness.update({where:{id:p.id},data:{version:{increment:1},materialsCompleteAt:null,materialsCompleteById:null}});return row;},{isolationLevel:'Serializable'});}
export async function startPractice(db:Db,claimed:AuthSession,raw:unknown){enabled();const input=startSchema.parse(raw);await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed);await practiceScope(tx,a,input.practiceId);const p=await tx.practiceReadiness.findUnique({where:{id:input.practiceId},include:{funding:true,materials:true}});if(!p||p.version!==input.expectedVersion||p.startedAt)throw new PracticeReadinessError('CONFLICT');const funding=await tx.practiceFundingEvidence.findMany({where:{practiceId:p.id},include:{successor:true}});const paid=currentAvailableFunding(funding);if(!p.formalizedAt||!p.contractId||!p.materialsCompleteAt||!p.materials.length||p.materials.some(x=>!['VALIDATED','NOT_NEEDED'].includes(x.status))||paid.lt(p.requiredInitialAmount))throw new PracticeReadinessError('NOT_READY');const evidence={offerSnapshotHash:p.offerSnapshotHash,contractId:p.contractId,fundingIds:funding.filter(x=>x.status==='CONFIRMED'&&!x.successor).map(x=>x.id),materialIds:p.materials.map(x=>x.id)};const row=await tx.practiceReadiness.update({where:{id:p.id},data:{startedAt:new Date(),startedById:a.userId,startEvidence:evidence,version:{increment:1}}});await tx.auditLog.create({data:{actorId:a.userId,event:'practice_started',entityType:'PracticeReadiness',entityId:p.id,after:evidence}});return row;},{isolationLevel:'Serializable'});}

const formalizeSchema=z.object({practiceId:z.string().uuid(),contractId:z.string().min(1),signedDocumentId:z.string().min(1),expectedVersion:z.coerce.number().int().positive()});
const completenessSchema=z.object({practiceId:z.string().uuid(),expectedVersion:z.coerce.number().int().positive()});
export async function formalizePractice(db:Db,claimed:AuthSession,raw:unknown){enabled();const input=formalizeSchema.parse(raw);await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed);const {practice:p}=await practiceScope(tx,a,input.practiceId);const contract=await tx.contract.findUnique({where:{id:input.contractId}});const document=await tx.document.findUnique({where:{id:input.signedDocumentId}});if(!p||p.version!==input.expectedVersion||p.formalizedAt||!contract||contract.clientId!==p.clientId||contract.projectId!==p.projectId||contract.status!=='firmato'||contract.signedDocumentId!==document?.id||document.deletedAt||document.clientId!==p.clientId||(p.projectId&&document.projectId!==p.projectId))throw new PracticeReadinessError('DENIED');const row=await tx.practiceReadiness.update({where:{id:p.id},data:{contractId:contract.id,signedDocumentId:document.id,formalizedAt:new Date(),formalizedById:a.userId,version:{increment:1}}});await tx.auditLog.create({data:{actorId:a.userId,event:'practice_formalized',entityType:'PracticeReadiness',entityId:p.id,after:{contractId:contract.id,signedDocumentId:document.id}}});return row;},{isolationLevel:'Serializable'});}
export async function attestPracticeMaterialsComplete(db:Db,claimed:AuthSession,raw:unknown){enabled();const input=completenessSchema.parse(raw);await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed);await practiceScope(tx,a,input.practiceId);const p=await tx.practiceReadiness.findUnique({where:{id:input.practiceId},include:{materials:true}});if(!p||p.version!==input.expectedVersion||!p.materials.length)throw new PracticeReadinessError('NOT_READY');for(const evidence of p.materials){const item=await tx.documentChecklistItem.findUnique({where:{id:evidence.checklistItemId}});const document=evidence.documentId?await tx.document.findUnique({where:{id:evidence.documentId}}):null;if(!item||item.deletedAt||!item.active||item.clientId!==p.clientId||(p.projectId&&item.projectId!==p.projectId)||evidence.status==='INVALIDATED'||(evidence.status==='VALIDATED'&&(!document||document.deletedAt||item.documentId!==document.id)))throw new PracticeReadinessError('NOT_READY');}const row=await tx.practiceReadiness.update({where:{id:p.id},data:{materialsCompleteAt:new Date(),materialsCompleteById:a.userId,version:{increment:1}}});await tx.auditLog.create({data:{actorId:a.userId,event:'practice_materials_complete',entityType:'PracticeReadiness',entityId:p.id,after:{materialEvidenceIds:p.materials.map(x=>x.id)}}});return row;},{isolationLevel:'Serializable'});}

export async function listAccessiblePracticeReadiness(db:Db,claimed:AuthSession){enabled();await assertSyntheticCatalogDatabase(db);return db.$transaction(async tx=>{const a=await actor(tx,claimed,'service.read');const rows=await tx.practiceReadiness.findMany({include:{funding:true,materials:true},orderBy:{createdAt:'desc'}});const visible=[];for(const row of rows){try{await practiceScope(tx,a,row.id,false);visible.push(row);}catch(error){if(!(error instanceof PracticeReadinessError&&error.code==='DENIED'))throw error;}}return visible;},{isolationLevel:'Serializable'});}
