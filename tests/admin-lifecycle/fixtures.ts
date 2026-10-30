import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '@/lib/auth';
import { syntheticCase, syntheticUser } from '../m5/fixtures';
import { technicalFixture, technicalTarget } from '../technical-assignments/fixtures';
import { leadProof, type Person } from '../selective-leads/fixtures';
import { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '@/lib/technical-assignment-service';
import { previewTechnicalUpload, confirmTechnicalUpload, readOwnTechnicalUploads } from '@/lib/technical-upload-service';
import { readTechnicalUploadReviewQueue, previewTechnicalUploadReview, confirmTechnicalUploadReview } from '@/lib/technical-upload-review-service';
import { previewTechnicalDocumentAcquisition, confirmTechnicalDocumentAcquisition } from '@/lib/technical-document-acquisition-service';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export async function lifecycleReadinessFixture(db:PrismaClient,admin:AuthSession){
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const operator=await syntheticUser(db,'consulente','Operatore sintetico lifecycle');
  return syntheticCase(db,'dossier_preanalisi',{admin,operator,human1:await syntheticUser(db,'revisore','Revisore sintetico 1'),
    human2:await syntheticUser(db,'revisore','Revisore sintetico 2')});
}
export async function lifecyclePrivateDocumentFixture(db:PrismaClient,admin:Person){
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled)
    VALUES('technical-assignment',${admin.user.id},1,true) ON CONFLICT(id) DO UPDATE SET "userId"=EXCLUDED."userId",enabled=true,revision="TechnicalAssignmentAuthority".revision+1`;
  const f=await technicalFixture(db,admin),target=technicalTarget(f),ref={...target,recipientId:f.techA.user.id};
  const setup=await readTechnicalAssignmentManagement(db,admin.session,target,f.techA.user.id);
  const input={commandId:randomUUID(),targetId:target.targetId,expectedRevision:0,expectedContextSha256:setup.contextSha256,
    expectedRecipientEpoch:setup.recipient!.epoch,selection:{kind:target.kind,userId:f.techA.user.id,responsibility:'supporto',actions:['upload_document'],
      readableFields:['title'],editableFields:[],documents:[],expiresAt:new Date(Date.now()+3_600_000).toISOString(),
      uploadProfile:{purpose:'Prova lifecycle isolata',formats:['.txt'],maxFileBytes:1024,maxFilesPerRevision:2,maxBytesPerRevision:2048,visibility:'PRIVATE_PENDING_ADMIN_REVIEW'}},reason:'Solo prova sintetica'};
  const assign=await previewTechnicalAssignment(db,admin.session,ref,'ASSIGN',input);
  await confirmTechnicalAssignment(db,admin.session,leadProof(admin),ref,'ASSIGN',input,assign.token,true);
  const state=await readOwnTechnicalUploads(db,f.techA.session,target),bytes=Buffer.from('SYNTHETIC_LIFECYCLE_PRIVATE_DOCUMENT');
  const upload=await previewTechnicalUpload(db,f.techA.session,target,{commandId:randomUUID(),assignmentId:state.assignmentId,
    assignmentRevision:state.assignmentRevision,expectedContextSha256:state.contextSha256,title:'Documento lifecycle',action:'deposit_private_document'},'lifecycle.txt',bytes);
  await confirmTechnicalUpload(db,f.techA.session,target,upload.command,upload.token,bytes,true);
  const deposit=(await readTechnicalUploadReviewQueue(db,admin.session,ref)).deposits[0];
  const review=await previewTechnicalUploadReview(db,admin.session,ref,{commandId:randomUUID(),submissionCommandId:deposit.commandId,
    sourceSha256:deposit.sourceSha256,verdict:'APPROVE_PRIVATE',reason:'Approvazione sintetica dei byte'});
  await confirmTechnicalUploadReview(db,admin.session,leadProof(admin),ref,review.command,review.token,true);
  const reviewed=(await readTechnicalUploadReviewQueue(db,admin.session,ref)).deposits[0];
  const command={commandId:randomUUID(),submissionCommandId:deposit.commandId,sourceSha256:deposit.sourceSha256,
    reviewCommandId:reviewed.review!.commandId,reviewSha256:reviewed.review!.sha256,classification:'TECHNICAL_DOCUMENT',title:'Documento privato lifecycle',
    expiresAt:null,visibility:'ADMIN_PRIVATE'};
  const acquisition=await previewTechnicalDocumentAcquisition(db,admin.session,ref,command);
  const receipt=await confirmTechnicalDocumentAcquisition(db,admin.session,leadProof(admin),ref,acquisition.command,acquisition.token,true);
  return {...f,target,ref,receipt,bytes};
}
