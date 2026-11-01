import assert from 'node:assert/strict';
import test from 'node:test';
import {technicalCollaborationSelection} from '../src/lib/technical-collaboration';
import {technicalAssignmentSelection,type TechnicalAssignmentSelection} from '../src/lib/technical-assignment-contract';
const now=new Date('2026-11-01T10:00:00Z');
const selection:TechnicalAssignmentSelection={kind:'Project',userId:'synthetic-first',responsibility:'responsabile',
 readableFields:['title','description','priority','technicalOwnerName'],editableFields:['title','description'],
 actions:['update_fields','request_admin','manage_deadlines'],expiresAt:'2026-11-02T10:00:00Z',
 documents:[{documentId:'synthetic-doc',fileId:'synthetic-v1',version:1,contentSha256:'a'.repeat(64),contextSha256:'b'.repeat(64),allowDownload:false}],
 workItems:[{kind:'Task',itemId:'synthetic-task',generation:1,scopeGeneration:1,scopeSha256:'c'.repeat(64),readableFields:['title','description','dueAt'],editableFields:['description','dueAt']}]};
test('copy is an explicit independent draft with equal selected versions and expiry, no notes or assumed responsibility',()=>{
 const before=structuredClone(selection);
 for(const recipientId of ['synthetic-second','synthetic-third']){
  const copied=technicalCollaborationSelection({recipientId:selection.userId,revokedAt:null,selection},recipientId,now);
  assert.equal(copied.userId,recipientId);assert.equal(copied.responsibility,'supporto');
  assert.deepEqual(copied.readableFields,['title','priority','technicalOwnerName']);assert.deepEqual(copied.editableFields,['title']);
  assert.equal(copied.expiresAt,selection.expiresAt);assert.deepEqual(copied.documents,selection.documents);
  assert.deepEqual(copied.workItems?.[0].readableFields,['title','dueAt']);assert.deepEqual(copied.workItems?.[0].editableFields,['dueAt']);
  assert.equal(technicalAssignmentSelection.safeParse(copied).success,true);
  copied.documents[0].allowDownload=true;assert.equal(selection.documents[0].allowDownload,false);
 }
 assert.deepEqual(selection,before);
});
test('self, revoked, expired, malformed and inconsistent source selections cannot create a draft',()=>{
 const source={recipientId:selection.userId,revokedAt:null,selection};
 assert.throws(()=>technicalCollaborationSelection(source,selection.userId,now));
 assert.throws(()=>technicalCollaborationSelection({...source,revokedAt:now},'synthetic-second',now));
 assert.throws(()=>technicalCollaborationSelection(source,'synthetic-second',new Date(selection.expiresAt)));
 assert.throws(()=>technicalCollaborationSelection({...source,selection:{...selection,expiresAt:'invalid'}},'synthetic-second',now));
 assert.throws(()=>technicalCollaborationSelection({...source,recipientId:'other'},'synthetic-second',now));
});
