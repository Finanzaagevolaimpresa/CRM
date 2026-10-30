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
  revision:z.number().int().min(0),values:privateMetadataValues,
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
  const rows=await tx.$queryRaw<Array<{commandId:string}>>`
    SELECT "commandId" FROM "AdminRecordRevision" WHERE model=${privateMetadataModel} AND "recordId"=${document.id}
    AND operation='UPDATE' ORDER BY (after->>'revision')::integer DESC LIMIT 1`;
  if(!rows[0])return {original,current:original,commandId:null};
  const row=await tx.adminRecordRevision.findUniqueOrThrow({where:{commandId:rows[0].commandId}});
  const before=privateMetadataSnapshot.safeParse(row.before),after=privateMetadataSnapshot.safeParse(row.after);
  if(!before.success||!after.success||after.data.id!==document.id||before.data.id!==document.id
    ||after.data.sourceHash!==original.sourceHash||before.data.sourceHash!==original.sourceHash
    ||after.data.revision!==before.data.revision+1||privateMetadataDigest(row.before)!==row.beforeHash
    ||privateMetadataDigest(row.after)!==row.afterHash)throw new PrivateDocumentMetadataError('INTEGRITY');
  return {original,current:after.data,commandId:row.commandId};
}
export function effectivePrivateDocument(document:Document,values:PrivateMetadataValues):Document{
  return {...document,title:values.title,documentCategory:categories[values.classification],type:categories[values.classification],
    containsSensitiveData:document.containsSensitiveData||values.classification!=='TECHNICAL_DOCUMENT',
    validUntil:values.expiresAt?new Date(values.expiresAt):null};
}

