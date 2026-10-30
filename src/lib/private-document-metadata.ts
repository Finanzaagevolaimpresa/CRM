import { Prisma, type Document } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';

export const privateMetadataModel='AdminPrivateDocumentMetadata';
export const privateMetadataClassification=z.enum(['TECHNICAL_DOCUMENT','CONTRACT','PAYMENT','OTHER_CONFIDENTIAL']);
export const privateMetadataValues=z.object({
  title:z.string().trim().min(1).max(240),
  classification:privateMetadataClassification,
  expiresAt:z.string().datetime().nullable(),
}).strict();
export type PrivateMetadataValues=z.infer<typeof privateMetadataValues>;
export const privateMetadataSnapshot=z.object({
  id:z.string().min(1).max(128),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
  revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),values:privateMetadataValues,
}).strict();
const categories={TECHNICAL_DOCUMENT:'documento_tecnico',CONTRACT:'contratto',PAYMENT:'pagamento',OTHER_CONFIDENTIAL:'riservato'} as const;
export const privateMetadataDigest=(value:unknown)=>canonicalSha256(JSON.parse(JSON.stringify(value)));
export function privateDocumentSourceHash(document:Document){
  const {selectiveEpoch: _epoch,...source}=document;void _epoch;
  return privateMetadataDigest(source);
}
export class PrivateDocumentMetadataError extends Error{
  constructor(readonly code:'DENIED'|'INVALID'|'STALE'|'CLOSED'|'INTEGRITY'){super('PRIVATE_DOCUMENT_METADATA_'+code);}
}
/** Source rows, the signed acquisition and its only original version stay exact.
 * Current administrative metadata is a separate immutable, audited revision. */
export async function readPrivateDocumentMetadata(tx:Prisma.TransactionClient,document:Document,classification:PrivateMetadataValues['classification']){
  if(document.visibilityLevel!==technicalDocumentPrivateVisibility)throw new PrivateDocumentMetadataError('DENIED');
  const original=privateMetadataSnapshot.parse({id:document.id,sourceHash:privateDocumentSourceHash(document),revision:0,
    values:{title:document.title,classification,expiresAt:document.validUntil?.toISOString()??null}});
  // A self-consistent latest row is insufficient: it may hide a missing,
  // duplicated or corrupt predecessor. Validate every revision and anchor the
  // chain to the exact signed source. CLOSE receipts do not change metadata.
  const rows=await tx.adminRecordRevision.findMany({where:{model:privateMetadataModel,recordId:document.id,operation:{not:'CLOSE'}},
    select:{commandId:true,operation:true,before:true,after:true,beforeHash:true,afterHash:true}});
  const revisions=rows.map(row=>{
    const before=privateMetadataSnapshot.safeParse(row.before),after=privateMetadataSnapshot.safeParse(row.after);
    if(row.operation!=='UPDATE'||!before.success||!after.success||after.data.id!==document.id||before.data.id!==document.id
      ||after.data.sourceHash!==original.sourceHash||before.data.sourceHash!==original.sourceHash
      ||after.data.revision!==before.data.revision+1||privateMetadataDigest(row.before)!==row.beforeHash
      ||privateMetadataDigest(row.after)!==row.afterHash||privateMetadataDigest(before.data)!==row.beforeHash
      ||privateMetadataDigest(after.data)!==row.afterHash)throw new PrivateDocumentMetadataError('INTEGRITY');
    return {commandId:row.commandId,before:before.data,after:after.data};
  }).sort((a,b)=>a.after.revision-b.after.revision);
  let current=original,commandId:string|null=null;
  for(const revision of revisions){
    if(revision.after.revision!==current.revision+1||privateMetadataDigest(revision.before)!==privateMetadataDigest(current))
      throw new PrivateDocumentMetadataError('INTEGRITY');
    current=revision.after;commandId=revision.commandId;
  }
  return {original,current,commandId};
}
export function effectivePrivateDocument(document:Document,values:PrivateMetadataValues):Document{
  return {...document,title:values.title,documentCategory:categories[values.classification],type:categories[values.classification],
    containsSensitiveData:document.containsSensitiveData||values.classification!=='TECHNICAL_DOCUMENT',
    validUntil:values.expiresAt?new Date(values.expiresAt):null};
}
