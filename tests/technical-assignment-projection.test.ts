import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTechnicalDocument, projectTechnicalFields, type CurrentTechnicalDocument, type TechnicalProjectionAdmission } from '../src/lib/technical-assignment-projection';
import type { TechnicalAssignmentSelection } from '../src/lib/technical-assignment-contract';

const now = new Date('2026-10-22T12:00:00Z');
const target = { targetId: 'practice_a', kind: 'TechnicalPractice' as const };
const current: TechnicalProjectionAdmission = { userId:'tech_a', role:'consulente', active:true, sessionLive:true,
  targetId:target.targetId, kind:target.kind, targetWorkable:true, parentContextValid:true, selectiveCeilingAllows:true,
  currentContextSha256:'a'.repeat(64), assignmentContextSha256:'a'.repeat(64), currentRecipientEpoch:2,
  assignmentRecipientEpoch:2, currentRevision:3, assignmentRevision:3, revoked:false, recordReadAllowed:true };
const selection: TechnicalAssignmentSelection = { kind:target.kind, userId:'tech_a', responsibility:'co_responsabile',
  actions:['request_admin'], readableFields:['title','dueDate'], editableFields:[], expiresAt:'2026-10-23T12:00:00Z',
  documents:[{documentId:'doc_a',fileId:'file_a_v1',version:1,contentSha256:'b'.repeat(64),contextSha256:'c'.repeat(64),allowDownload:false}] };
const document: CurrentTechnicalDocument = { documentId:'doc_a',fileId:'file_a_v1',version:1,
  targetId:target.targetId,kind:target.kind,contentSha256:'b'.repeat(64),contextSha256:'c'.repeat(64),
  fileName:'relazione-tecnica.pdf',mimeType:'application/pdf',sizeBytes:2050,deleted:false,contextValid:true,readable:true,
  financialBindingsChecked:true,hasFinancialBinding:false,sensitive:false,sensitiveReadAllowed:false };

test('technical projection returns only individually selected fields, not owners, parent dossier or financial data', () => {
  const row = {title:'Relazione tecnica',dueDate:new Date('2026-11-01T09:00:00Z'),internalNotes:'private',
    client:{name:'not selected'},commercialOwnerId:'sales_a',technicalOwnerId:'tech_b',totalInvestment:50000,
    contract:{amount:9000},payment:{reference:'private'},futureField:'not selected'};
  assert.deepEqual(projectTechnicalFields(current,selection,target,row,now),{fields:{title:'Relazione tecnica',dueDate:'2026-11-01T09:00:00.000Z'}});
  const second: TechnicalAssignmentSelection = {...selection,userId:'tech_b',readableFields:['dueDate']};
  assert.deepEqual(projectTechnicalFields({...current,userId:'tech_b',role:'backoffice'},second,target,row,now),{fields:{dueDate:'2026-11-01T09:00:00.000Z'}});
  assert.equal(projectTechnicalFields({...current,userId:'tech_b'},selection,target,row,now),null);
});
test('revocation, permission removal and changed target block fresh field and document projections without logout', () => {
  for (const delta of [{revoked:true},{recordReadAllowed:false},{currentRecipientEpoch:3},{sessionLive:false},{currentRevision:4},{targetWorkable:false}]) {
    assert.equal(projectTechnicalFields({...current,...delta},selection,target,{title:'ok',dueDate:null},now),null);
    assert.equal(projectTechnicalDocument({...current,...delta},selection,target,document,'preview',now),null);
  }
  assert.equal(projectTechnicalFields(current,selection,{...target,targetId:'practice_b'},{title:'ok',dueDate:null},now),null);
  assert.equal(projectTechnicalFields(current,selection,target,{title:'ok'},now),null);
  assert.equal(projectTechnicalFields(current,selection,target,{title:{unexpected:'object'},dueDate:null},now),null);
});
test('a selected technical PDF is previewable, while download needs its separate explicit choice', () => {
  const preview = projectTechnicalDocument(current,selection,target,{...document,storagePath:'/private'} as CurrentTechnicalDocument,'preview',now);
  assert.deepEqual(preview,{documentId:'doc_a',fileId:'file_a_v1',version:1,fileName:'relazione-tecnica.pdf',mimeType:'application/pdf',sizeBytes:2050});
  assert.equal(projectTechnicalDocument(current,selection,target,document,'download',now),null);
  const download = {...selection,documents:[{...selection.documents[0],allowDownload:true}]};
  assert.ok(projectTechnicalDocument(current,download,target,document,'download',now));
});
test('financial metadata and canonical bindings independently override a selected document', () => {
  for (const delta of [{fileName:'contratto.pdf'},{documentCategory:'pagamento'},{type:'fattura'},{hasFinancialBinding:true},{financialBindingsChecked:false},{fileName:'documenti.zip'}]) {
    assert.equal(projectTechnicalDocument(current,selection,target,{...document,...delta},'preview',now),null);
  }
});
test('changed version, content, context, sensitivity, deletion or unrelated association denies old document choice', () => {
  for (const delta of [{fileId:'file_v2'},{version:2},{contentSha256:'d'.repeat(64)},{contextSha256:'d'.repeat(64)},
    {targetId:'practice_b'},{kind:'Project' as const},{deleted:true},{contextValid:false},{readable:false},
    {sensitive:true},{sizeBytes:0},{mimeType:'text/html'}]) {
    assert.equal(projectTechnicalDocument(current,selection,target,{...document,...delta},'preview',now),null);
  }
  assert.equal(projectTechnicalDocument(current,selection,target,document,'preview',new Date(selection.expiresAt)),null);
  assert.equal(projectTechnicalDocument(current,{...selection,documents:[]},target,document,'preview',now),null);
});
