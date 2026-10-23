import assert from 'node:assert/strict';
import test from 'node:test';
import { admitsTechnicalAssignmentAction, boundedAssignmentExpiry, technicalAssignmentCommand, technicalAssignmentSelection, technicalFieldPatch, type CurrentTechnicalAssignmentAdmission, type TechnicalAssignmentSelection } from '../src/lib/technical-assignment-contract';

const now = new Date('2026-10-22T12:00:00Z');
const selection: TechnicalAssignmentSelection = { kind:'TechnicalPractice', userId:'tech_a', responsibility:'co_responsabile',
  actions:['update_fields','request_admin'], readableFields:['title','dueDate'], editableFields:['dueDate'], expiresAt:'2026-10-23T12:00:00Z', documents:[] };
const admission: CurrentTechnicalAssignmentAdmission = { userId:'tech_a',role:'consulente',active:true,sessionLive:true,targetId:'practice_a',kind:'TechnicalPractice',targetWorkable:true,parentContextValid:true,selectiveCeilingAllows:true,currentContextSha256:'a'.repeat(64),currentRecipientEpoch:2,currentRevision:4,assignmentRevision:4,assignmentContextSha256:'a'.repeat(64),assignmentRecipientEpoch:2,revoked:false };
const requested = { targetId:'practice_a',kind:'TechnicalPractice' as const,action:'request_admin' as const };

test('multiple named technicians retain independent rights on the same target without commercial owner fields', () => {
  const second = { ...selection,userId:'tech_b',actions:['manage_checklist'] as const,editableFields:[] };
  assert.equal(admitsTechnicalAssignmentAction(admission,selection,requested,now),true);
  const b = technicalAssignmentSelection.parse(second);
  assert.equal(admitsTechnicalAssignmentAction({...admission,userId:'tech_b',role:'backoffice'},b,{...requested,action:'manage_checklist'},now),true);
  assert.equal(admitsTechnicalAssignmentAction({...admission,userId:'tech_b'},b,requested,now),false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,commercialOwnerId:'sales_b'}).success,false);
});
test('read-only sharing cannot silently become an operational assignment', () => {
  assert.equal(technicalAssignmentSelection.safeParse({...selection,actions:[],editableFields:[]}).success,false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,actions:['read']}).success,false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,actions:['update_status'],editableFields:[]}).success,false);
});
test('financial, unrelated and unselected fields never enter a patch', () => {
  assert.deepEqual(technicalFieldPatch(selection,{dueDate:'2026-11-01'}),{dueDate:'2026-11-01'});
  for (const key of ['title','commercialOwnerId','technicalOwnerId','clientId','projectId','clientServiceId','payment','contract','totalInvestment','internalNotes']) {
    assert.equal(technicalFieldPatch(selection,{dueDate:'2026-11-01',[key]:'foreign'}),null,key);
  }
  assert.equal(technicalFieldPatch(selection,{}),null);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,editableFields:['dueDate','dueDate']}).success,false);
});
test('revocation, session/role/epoch/context/lifecycle changes deny old snapshots', () => {
  const changes: Partial<CurrentTechnicalAssignmentAdmission>[] = [{revoked:true},{active:false},{sessionLive:false},{role:'commerciale'},{role:'admin'},{currentRevision:5},{currentRecipientEpoch:3},{currentContextSha256:'b'.repeat(64)},{currentContextSha256:'bad'},{targetWorkable:false},{parentContextValid:false},{selectiveCeilingAllows:false},{userId:'other'}];
  for (const delta of changes) assert.equal(admitsTechnicalAssignmentAction({...admission,...delta},selection,requested,now),false,JSON.stringify(delta));
  assert.equal(admitsTechnicalAssignmentAction(admission,selection,requested,new Date(selection.expiresAt)),false);
});
test('same client or linked project does not widen the exact target or action', () => {
  assert.equal(admitsTechnicalAssignmentAction(admission,selection,{...requested,targetId:'practice_b'},now),false);
  assert.equal(admitsTechnicalAssignmentAction(admission,selection,{...requested,kind:'Project'},now),false);
  assert.equal(admitsTechnicalAssignmentAction(admission,selection,{...requested,action:'upload_document'},now),false);
});
test('exact document versions need content and context hashes and separate download choice', () => {
  const doc = {documentId:'document_a',fileId:'file_v1',version:1,contentSha256:'b'.repeat(64),contextSha256:'c'.repeat(64),allowDownload:false};
  assert.equal(technicalAssignmentSelection.parse({...selection,documents:[doc]}).documents[0].allowDownload,false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,documents:[doc,{...doc,fileId:'other'}]}).success,false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,documents:[{...doc,version:0}]}).success,false);
  assert.equal(technicalAssignmentSelection.safeParse({...selection,documents:[{...doc,contentSha256:'unknown'}]}).success,false);
});
test('expiry is explicit, finite and bounded, with no silent permanent assignment', () => {
  assert.equal(boundedAssignmentExpiry(selection.expiresAt,now),true);
  for (const date of [now.toISOString(),'2027-10-22T12:00:00Z','invalid']) assert.equal(boundedAssignmentExpiry(date,now),false);
  assert.equal(boundedAssignmentExpiry(selection.expiresAt,new Date('invalid')),false);
  assert.equal(boundedAssignmentExpiry(selection.expiresAt,now,365),false);
});
test('command binds expected revision, recipient epoch and context without accepting role or approval claims', () => {
  const command={commandId:'7c96abbd-8900-4fd0-bf29-21e23e58f2ac',targetId:'practice_a',expectedRevision:4,expectedRecipientEpoch:2,expectedContextSha256:'a'.repeat(64),selection,reason:'Supporto tecnico'};
  assert.equal(technicalAssignmentCommand.safeParse(command).success,true);
  for (const extra of [{role:'admin'},{approved:true},{commercialOwnerId:'sales_b'}]) assert.equal(technicalAssignmentCommand.safeParse({...command,...extra}).success,false);
  assert.equal(technicalAssignmentCommand.safeParse({...command,expectedRevision:-1}).success,false);
});
