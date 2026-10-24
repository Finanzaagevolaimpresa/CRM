import assert from 'node:assert/strict';
import test from 'node:test';
import { readTechnicalAssignmentProof, technicalAssignmentProof, type CurrentTechnicalAssignmentProof, type TechnicalAssignmentPayload } from '../src/lib/technical-assignment-proof';

const key = {version:1,secret:'synthetic-assignment-test-key-0001'};
const now = new Date('2026-10-22T12:00:00Z');
const payload: TechnicalAssignmentPayload = { protocol:'TECHNICAL_ASSIGNMENT_V1',id:'06a22f84-cb56-49f5-b195-bce7e637610c',
  commandId:'7fc37d5d-414f-4bed-bac2-7e1b57409fd1',revision:1,targetId:'practice_a',
  selection:{kind:'TechnicalPractice',userId:'tech_a',responsibility:'co_responsabile',actions:['request_admin'],
    readableFields:['title'],editableFields:[],documents:[],expiresAt:'2026-10-23T12:00:00Z'},
  approvedById:'personal_admin',approvedAt:'2026-10-22T11:00:00Z',authorityRevision:1,actorEpoch:2,recipientEpoch:3,
  contextSha256:'a'.repeat(64),keyVersion:1 };
const current: CurrentTechnicalAssignmentProof = {userId:'tech_a',role:'consulente',active:true,sessionLive:true,
  targetId:'practice_a',kind:'TechnicalPractice',targetWorkable:true,parentContextValid:true,selectiveCeilingAllows:true,
  currentContextSha256:'a'.repeat(64),assignmentContextSha256:'a'.repeat(64),currentRecipientEpoch:3,
  assignmentRecipientEpoch:3,currentRevision:1,assignmentRevision:1,revoked:false,assignmentId:payload.id,recordReadAllowed:true,
  authority:{purpose:'technical-assignment',userId:'personal_admin',enabled:true,revision:1,actorEpoch:2,
    actorActive:true,actorRole:'admin',assignmentWriteAllowed:true} };
const row = {payload,proof:technicalAssignmentProof(key,'assignment',payload),revokedAt:null};

test('a synthetic assignment signature from before the Zod update retains its exact scope', () => {
  const legacyProof = '0e7122272ee1581ca3891f8d36419a5331b90897ad9837c0f7c4e613e3f15a97';
  assert.equal(row.proof, legacyProof);
  assert.deepEqual(readTechnicalAssignmentProof({ ...row, proof: legacyProof }, key, current, now), payload);
});

test('exact personal decision verifies, but changed fields, actions, recipient or target cannot reuse its proof', () => {
  assert.deepEqual(readTechnicalAssignmentProof(row,key,current,now),payload);
  for (const changed of [
    {...payload,targetId:'practice_b'},
    {...payload,selection:{...payload.selection,userId:'tech_b'}},
    {...payload,selection:{...payload.selection,actions:['request_admin','manage_checklist']}},
    {...payload,selection:{...payload.selection,readableFields:['title','status']}},
  ]) assert.equal(readTechnicalAssignmentProof({...row,payload:changed},key,current,now),null);
});
test('preview, receipt and another key cannot serve as an operational assignment', () => {
  for (const purpose of ['preview','receipt'] as const) {
    assert.equal(readTechnicalAssignmentProof({...row,proof:technicalAssignmentProof(key,purpose,payload)},key,current,now),null);
  }
  assert.equal(readTechnicalAssignmentProof(row,{...key,secret:'synthetic-assignment-test-key-0002'},current,now),null);
  assert.equal(readTechnicalAssignmentProof(row,{...key,version:2},current,now),null);
  assert.equal(readTechnicalAssignmentProof({...row,proof:'a'},key,current,now),null);
});
test('an admin role alone cannot inherit personal assignment authority, nor can an inactive authority survive', () => {
  for (const delta of [{userId:'another_admin'},{enabled:false},{revision:2},{actorEpoch:3},{actorActive:false},
    {actorRole:'direzione'},{assignmentWriteAllowed:false}]) {
    assert.equal(readTechnicalAssignmentProof(row,key,{...current,authority:{...current.authority,...delta}},now),null);
  }
  const self={...payload,approvedById:'tech_a'};
  assert.equal(readTechnicalAssignmentProof({...row,payload:self,proof:technicalAssignmentProof(key,'assignment',self)},key,
    {...current,authority:{...current.authority,userId:'tech_a'}},now),null);
});
test('a retained signature cannot survive revocation, expiry, stale scope, changed session or revision', () => {
  for (const delta of [{revoked:true},{currentRevision:2},{currentContextSha256:'b'.repeat(64)},
    {currentRecipientEpoch:4},{assignmentId:'another'},{recordReadAllowed:false},{parentContextValid:false},{sessionLive:false}]) {
    assert.equal(readTechnicalAssignmentProof(row,key,{...current,...delta},now),null);
  }
  assert.equal(readTechnicalAssignmentProof({...row,revokedAt:now.toISOString()},key,current,now),null);
  assert.equal(readTechnicalAssignmentProof(row,key,current,new Date(payload.selection.expiresAt)),null);
  assert.equal(readTechnicalAssignmentProof(row,key,current,new Date('2026-10-22T10:59:59Z')),null);
  assert.equal(readTechnicalAssignmentProof(row,key,current,new Date('invalid')),null);
});
