import assert from 'node:assert/strict';
import test from 'node:test';
import { readTechnicalAssignmentJournal } from '../src/lib/technical-assignment-journal';
import { technicalAssignmentProof, type TechnicalAssignmentPayload, type CurrentTechnicalAssignmentProof } from '../src/lib/technical-assignment-proof';

const key={version:1,secret:'synthetic-technical-journal-key-0001'};
const now=new Date('2026-10-22T12:00:00Z');
const p:TechnicalAssignmentPayload={protocol:'TECHNICAL_ASSIGNMENT_V1',id:'8be93d89-01c4-4efe-8876-d4adb2758dd1',
  commandId:'785267a5-d7ae-4841-9dda-dd8b1cc4b2c6',revision:1,targetId:'practice_a',
  selection:{kind:'TechnicalPractice',userId:'tech_a',responsibility:'co_responsabile',actions:['request_admin'],
    readableFields:['title'],editableFields:[],documents:[],expiresAt:'2026-10-23T12:00:00Z'},
  approvedById:'personal_admin',approvedAt:'2026-10-22T11:00:00Z',authorityRevision:1,actorEpoch:2,
  recipientEpoch:3,contextSha256:'a'.repeat(64),keyVersion:1};
const current:CurrentTechnicalAssignmentProof={userId:'tech_a',role:'consulente',active:true,sessionLive:true,
  targetId:'practice_a',kind:'TechnicalPractice',targetWorkable:true,parentContextValid:true,selectiveCeilingAllows:true,
  currentContextSha256:p.contextSha256,assignmentContextSha256:p.contextSha256,currentRecipientEpoch:3,
  assignmentRecipientEpoch:3,currentRevision:1,assignmentRevision:1,revoked:false,assignmentId:p.id,recordReadAllowed:true,
  authority:{purpose:'technical-assignment',userId:'personal_admin',enabled:true,revision:1,actorEpoch:2,
    actorActive:true,actorRole:'admin',assignmentWriteAllowed:true}};
const revisionId='a4b9afec-2f1c-4e5b-875b-f502bb598e67';
const receipt={protocol:'TECHNICAL_ASSIGNMENT_RECEIPT_V1',commandId:p.commandId,assignmentId:p.id,revisionId,
  revision:1,operation:'ASSIGN',fieldCount:1,actionCount:1,documentCount:0,keyVersion:1};
const assignment={payload:p,proof:technicalAssignmentProof(key,'assignment',p),revokedAt:null};
const journal={assignment,decision:{id:p.commandId,actorId:p.approvedById,
  sessionId:'82bb4a48-3608-45a1-9a3e-fb9893863b06',kind:p.selection.kind,targetId:p.targetId,recipientId:p.selection.userId,
  expectedRevision:0,operation:'ASSIGN',requestDigest:'b'.repeat(64),receipt,
  receiptProof:technicalAssignmentProof(key,'receipt',receipt),transactionId:42n},
  revision:{id:revisionId,assignmentId:p.id,revision:1,commandId:p.commandId,payload:p,proof:assignment.proof,
    revokedAt:null,transactionId:42n},
  audit:{id:revisionId,actorId:p.approvedById,event:'technical_assignment_changed',entityType:'TechnicalAssignmentRevision',
    entityId:revisionId,before:{version:0},after:{version:1,action:'ASSIGN',fieldCount:1,actionCount:1,documentCount:0}}};

test('an exact current assignment admits only with matching decision, revision, receipt and audit',()=>{
  assert.deepEqual(readTechnicalAssignmentJournal(journal,key,current,now),p);
  assert.equal(readTechnicalAssignmentJournal({assignment},key,current,now),null);
});
test('partial, foreign and cross-transaction journals fail even with a valid assignment signature',()=>{
  const changed=[
    {...journal,decision:{...journal.decision,recipientId:'tech_b'}},
    {...journal,decision:{...journal.decision,targetId:'practice_b'}},
    {...journal,decision:{...journal.decision,actorId:'another_admin'}},
    {...journal,decision:{...journal.decision,expectedRevision:1}},
    {...journal,revision:{...journal.revision,transactionId:43n}},
    {...journal,revision:{...journal.revision,commandId:'94f25c67-b759-4d7b-bf60-c89949d61a10'}},
    {...journal,revision:{...journal.revision,payload:{...p,selection:{...p.selection,userId:'tech_b'}}}},
    {...journal,revision:{...journal.revision,revokedAt:now.toISOString()}},
  ];
  for(const row of changed) assert.equal(readTechnicalAssignmentJournal(row,key,current,now),null);
});
test('receipt signatures cannot hide changed counts, operations or another proof purpose',()=>{
  for(const delta of [{fieldCount:2},{actionCount:2},{documentCount:1},{operation:'REVOKE'},{keyVersion:2}]) {
    const receipt={...journal.decision.receipt,...delta};
    const row={...journal,decision:{...journal.decision,receipt,receiptProof:technicalAssignmentProof(key,'receipt',receipt)}};
    assert.equal(readTechnicalAssignmentJournal(row,key,current,now),null);
  }
  assert.equal(readTechnicalAssignmentJournal({...journal,decision:{...journal.decision,
    receiptProof:technicalAssignmentProof(key,'preview',receipt)}},key,current,now),null);
});
test('missing or expanded audit is rejected without exposing record contents in the admission result',()=>{
  for(const delta of [{actorId:'other'},{event:'other'},{before:{version:1}},
    {after:{...journal.audit.after,clientName:'private'}},{after:{...journal.audit.after,documentCount:1}}])
    assert.equal(readTechnicalAssignmentJournal({...journal,audit:{...journal.audit,...delta}},key,current,now),null);
  assert.equal(readTechnicalAssignmentJournal({...journal,audit:null},key,current,now),null);
});
test('a consistent historical journal is still denied after revocation, expiry or a newer assignment',()=>{
  for(const delta of [{revoked:true},{currentRevision:2},{currentRecipientEpoch:4},{sessionLive:false},{selectiveCeilingAllows:false}])
    assert.equal(readTechnicalAssignmentJournal(journal,key,{...current,...delta},now),null);
  assert.equal(readTechnicalAssignmentJournal(journal,key,current,new Date(p.selection.expiresAt)),null);
});
