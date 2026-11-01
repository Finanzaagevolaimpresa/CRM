import assert from 'node:assert/strict';
import test from 'node:test';
import type { Document, DocumentVersion } from '@prisma/client';
import { originalDisclosure, disclosureDigest, disclosureSource, readDisclosure, technicalVersionDisclosureAllowed,
  restrictedDocumentMetadata, technicalVersionDisclosuresAllowed, technicalDisclosureModel, type DisclosureDb, type DisclosureSnapshot } from '../src/lib/technical-document-disclosure';
const document = {id:'synthetic-document',title:'Elaborato geometrico',fileName:'elaborato.pdf',type:'tecnico',
  documentCategory:'tecnica',serviceArea:'progetto',mimeType:'application/pdf',status:'validato',deletedAt:null,
  checksum:'a'.repeat(64),storagePath:'synthetic/private/elaborato.pdf',sizeBytes:100} as unknown as Document;
const version={id:'synthetic-version',documentId:document.id,version:1,checksum:document.checksum,storagePath:document.storagePath} as DocumentVersion;
const assertions={noPayments:true,noSignedCustomerContracts:true,noFreeOrInternalNotes:true,reviewedExactVersion:true} as const;
function fixture(approved=true,binding:'contract'|'payment'|'practiceFormalization'|null=null){
 const before=originalDisclosure(version.id), after={...before,revision:1,classification:'TECHNICAL_CONTENT' as const,sourceSha256:disclosureSource(document,version),contentSha256:version.checksum,assertions};
 const rows:Array<{commandId:string;operation:string;before:DisclosureSnapshot;after:DisclosureSnapshot;beforeHash:string;afterHash:string;reason:string;createdAt:Date}>=approved?[{commandId:'synthetic-command',operation:'UPDATE',before,after,beforeHash:disclosureDigest(before),afterHash:disclosureDigest(after),reason:'Synthetic exact-version review',createdAt:new Date('2026-11-01T10:00:00Z')}]:[];
 const locks:string[]=[];
 const db={$queryRawUnsafe:async(q:string)=>{locks.push(q);return[];},adminRecordRevision:{findMany:async()=>rows},
  documentVersion:{findMany:async()=>[version]},contract:{findFirst:async()=>binding==='contract'?{id:'synthetic-contract'}:null},
  payment:{findFirst:async()=>binding==='payment'?{id:'synthetic-payment'}:null},
  practiceFormalization:{findFirst:async()=>binding==='practiceFormalization'?{id:'synthetic-formalization'}:null}} as unknown as DisclosureDb;
 return {db,rows,locks,after};
}
test('both technical roles require exact positive classification; a grant alone is insufficient',async()=>{
 for(const role of ['consulente','backoffice']){
  assert.equal(await technicalVersionDisclosureAllowed(fixture(false).db,{role},document,version),false);
  const f=fixture();assert.equal(await technicalVersionDisclosureAllowed(f.db,{role},document,version),true);
  assert.ok(f.locks.some(q=>q.includes('lock_shared')));
 }
});
test('canonical payment and any customer-signed contract binding override even positive technical classification',async()=>{
 for(const binding of ['contract','payment','practiceFormalization'] as const){
  assert.equal(await technicalVersionDisclosureAllowed(fixture(true,binding).db,{role:'consulente'},document,version),false);
 }
});
test('metadata correction or replacement of the reviewed version invalidates its classification',async()=>{
 for(const d of [{title:'Nuovo titolo'},{fileName:'altro.pdf'},{status:'archiviato'},{deletedAt:new Date()}] as Partial<Document>[]){
  assert.equal(await technicalVersionDisclosureAllowed(fixture().db,{role:'backoffice'},{...document,...d},version),false);
 }
 assert.equal(await technicalVersionDisclosureAllowed(fixture().db,{role:'consulente'},{...document,checksum:'b'.repeat(64),storagePath:'newer/version.pdf',selectiveEpoch:20,updatedAt:new Date()},version),true);
 for(const v of [{id:'new-version'},{version:2},{checksum:'c'.repeat(64)},{documentId:'other-document'}]){
  await assert.rejects(async()=>{const ok=await technicalVersionDisclosureAllowed(fixture().db,{role:'consulente'},document,{...version,...v});if(!ok)throw new Error('DENIED');},/DENIED|INTEGRITY/);
 }
});
test('free notes, payment references, signed material and opaque signed envelopes remain reserved by metadata',()=>{
 for(const fileName of ['note-tecniche.pdf','appunti.txt','contratto-cliente-firmato.pdf','ricevuta.pdf','iban.txt','documento.p7m']){
  assert.equal(restrictedDocumentMetadata({...document,fileName}),true,fileName);
 }
 assert.equal(restrictedDocumentMetadata(document),false);
});
test('revocation of classification is append-only and serialized; tampered history is not accepted',async()=>{
 const f=fixture();const before=f.after,after={...before,revision:2,classification:'RESTRICTED' as const,assertions:null};
 f.rows.push({commandId:'synthetic-revocation',operation:'UPDATE',before,after,beforeHash:disclosureDigest(before),afterHash:disclosureDigest(after),reason:'Synthetic withdrawal',createdAt:new Date('2026-11-01T10:01:00Z')} as typeof f.rows[number]);
 assert.equal(await technicalVersionDisclosureAllowed(f.db,{role:'consulente'},document,version),false);
 await readDisclosure(f.db,version.id,true);assert.ok(f.locks.some(q=>q.includes('pg_advisory_xact_lock(')));
 f.rows[1].afterHash='0'.repeat(64);await assert.rejects(readDisclosure(f.db,version.id),/INTEGRITY/);
});
test('Admin and ordinary commercial admission remain separate from this technical ceiling',async()=>{
 for(const role of ['admin','commerciale'])assert.equal(await technicalVersionDisclosureAllowed(fixture(false).db,{role},document,version),true);
 assert.equal(await technicalVersionDisclosureAllowed(fixture(false).db,{role:'amministrazione',technicalRestricted:true},document,version),false);
});


test('batched disclosure isolates exact journals, metadata and signed/payment bindings under shared locks', async () => {
  const f = fixture(), otherDocument = { ...document, id: 'other-document', title: 'Altro elaborato' };
  const otherVersion = { ...version, id: 'other-version', documentId: otherDocument.id };
  const rows = f.rows.map(row => ({ ...row, recordId: version.id, model: technicalDisclosureModel }));
  const queries: string[] = [];
  let signed: Array<{ signedDocumentId: string }> = [];
  const db = { ...f.db, $queryRawUnsafe: async (sql: string) => {
    queries.push(sql); return sql.includes('row_number()') ? rows : [];
  }, contract: { findMany: async () => signed }, payment: { findMany: async () => [] },
  practiceFormalization: { findMany: async () => [] } } as unknown as DisclosureDb;
  const entries = [{ document, version }, { document: otherDocument, version: otherVersion }];
  assert.deepEqual([...await technicalVersionDisclosuresAllowed(db, { role: 'backoffice' }, entries)], [version.id]);
  assert.equal(queries.length, 2, 'one ordered shared-lock query and one bounded journal query');
  assert.match(queries[0], /lock_shared/); assert.match(queries[0], /ORDER BY 1/);
  signed = [{ signedDocumentId: document.id }];
  assert.equal((await technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, entries)).size, 0);
  signed = [];
  rows[0].recordId = otherVersion.id;
  await assert.rejects(technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, entries), /INTEGRITY/);
});
test('a malformed, oversized or incomplete batch cannot borrow another version classification', async () => {
  const f = fixture(), base = { ...f.rows[0], recordId: version.id, model: technicalDisclosureModel };
  let rows = [base];
  const db = { ...f.db, $queryRawUnsafe: async (sql: string) => sql.includes('row_number()') ? rows : [],
    contract: { findMany: async () => [] }, payment: { findMany: async () => [] },
    practiceFormalization: { findMany: async () => [] } } as unknown as DisclosureDb;
  const entries = [{ document, version }];
  rows = Array.from({ length: 1001 }, () => base);
  await assert.rejects(technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, entries), /UNAVAILABLE/);
  rows = [{ ...base, afterHash: '0'.repeat(64) }];
  await assert.rejects(technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, entries), /INTEGRITY/);
  await assert.rejects(technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, [...entries, ...entries]), /UNAVAILABLE/);
  rows = [];
  assert.equal((await technicalVersionDisclosuresAllowed(db, { role: 'consulente' }, entries)).size, 0);
});
