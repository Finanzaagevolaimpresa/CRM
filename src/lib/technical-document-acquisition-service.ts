import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { technicalAssignmentReference, type TechnicalAssignmentReference } from './technical-assignment-decision';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentDecision, withTechnicalAssignmentManagementRead,
  type TechnicalAssignmentPersonalProof, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { lockedTechnicalUploadSubmission } from './technical-upload-review-service';
import { loadTechnicalUploadReviewForSubmission } from './technical-upload-review-persistence';
import { readTechnicalUploadPrivateFile } from './technical-upload-storage';
import { technicalDocumentAcquisitionCommand, createTechnicalDocumentAcquisitionPreview, readTechnicalDocumentAcquisitionPreview,
  technicalDocumentAcquisitionAdmission } from './technical-document-acquisition-contract';
import { prepareTechnicalDocumentAcquisitionRecord } from './technical-document-acquisition-journal';
import { loadTechnicalDocumentAcquisition, persistTechnicalDocumentAcquisition, technicalAcquisitionForSubmission } from './technical-document-acquisition-persistence';

type Tx = Prisma.TransactionClient;
const stale = (): never => { throw new TechnicalAssignmentError('STALE'); };
async function admission(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference, submissionId: string, write = false) {
  const found = await lockedTechnicalUploadSubmission(tx, state, ref, submissionId, write);
  const review = await loadTechnicalUploadReviewForSubmission(tx, state, submissionId);
  if (!review || review.command.verdict !== 'APPROVE_PRIVATE' || review.receipt.actorId !== state.current.userId) return stale();
  const current = technicalDocumentAcquisitionAdmission.parse({ ...found.admission,
    reviewCommandId: review.command.commandId, reviewSha256: canonicalSha256(review),
    existingAcquisitionId: await technicalAcquisitionForSubmission(tx, submissionId),
    clientId: found.context.clientId, projectId: found.context.projectId, clientServiceId: found.context.clientServiceId,
    fileSha256: found.record.contentSha256, sizeBytes: found.record.sizeBytes });
  return { ...found, current, review };
}
async function bytesAndRecheck(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference,
  found: Awaited<ReturnType<typeof admission>>, write = false) {
  const r = found.record;
  const bytes = await readTechnicalUploadPrivateFile({ storageKey: r.storageKey, sha256: r.contentSha256, sizeBytes: r.sizeBytes });
  const after = await admission(tx, state, ref, r.commandId, write);
  if (canonicalJson(found.current) !== canonicalJson(after.current) || canonicalJson(found.review) !== canonicalJson(after.review)) stale();
  return bytes;
}
export async function previewTechnicalDocumentAcquisition(db: PrismaClient, claimed: AuthSession, rawRef: TechnicalAssignmentReference, raw: unknown) {
  const ref = technicalAssignmentReference.parse(rawRef), command = technicalDocumentAcquisitionCommand.parse(raw);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const found = await admission(tx, state, ref, command.submissionCommandId);
    await bytesAndRecheck(tx, state, ref, found);
    return { reference: ref, command, clientId: found.context.clientId,
      file: { fileName: found.record.command.file.fileName, sizeBytes: found.record.sizeBytes, contentSha256: found.record.contentSha256 },
      token: createTechnicalDocumentAcquisitionPreview(state.key, command, found.current, found.review, (await technicalAssignmentClock(tx)).getTime()) };
  });
}
async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference, commandId: string, command?: unknown) {
  const found = await loadTechnicalDocumentAcquisition(tx, state, commandId);
  if (!found) return null;
  const r = found.record.receipt;
  if (r.actorId !== state.current.userId || r.sessionId !== state.current.sessionId
    || canonicalJson(r.reference) !== canonicalJson(ref) || (command && canonicalJson(found.record.command) !== canonicalJson(command))) return stale();
  return r;
}
export async function confirmTechnicalDocumentAcquisition(db: PrismaClient, claimed: AuthSession, proof: TechnicalAssignmentPersonalProof,
  rawRef: TechnicalAssignmentReference, raw: unknown, token: string, confirmed: boolean) {
  const ref = technicalAssignmentReference.parse(rawRef), command = technicalDocumentAcquisitionCommand.parse(raw);
  if (!confirmed) return stale();
  return withTechnicalAssignmentDecision(db, claimed, ref.kind, ref.recipientId, proof, async (tx, state) => {
    const prior = await outcome(tx, state, ref, command.commandId, command);
    if (prior) return prior;
    const found = await admission(tx, state, ref, command.submissionCommandId, true);
    if (found.current.existingAcquisitionId) return stale();
    const bytes = await bytesAndRecheck(tx, state, ref, found, true);
    const record = prepareTechnicalDocumentAcquisitionRecord(state.key, token, command, found.current, found.review,
      { documentId: randomUUID(), versionId: randomUUID() }, await technicalAssignmentClock(tx));
    const receipt = await persistTechnicalDocumentAcquisition(tx, state, record, found.record, bytes);
    if (!readTechnicalDocumentAcquisitionPreview(state.key, token, command, found.current, found.review, (await technicalAssignmentClock(tx)).getTime())) stale();
    await tx.$executeRaw`SET CONSTRAINTS technical_acquisition_atomic, technical_acquisition_document_atomic, technical_acquisition_version_atomic IMMEDIATE`;
    return receipt;
  });
}
export async function readTechnicalDocumentAcquisitionOutcome(db: PrismaClient, claimed: AuthSession, rawRef: TechnicalAssignmentReference, commandId: string) {
  const ref = technicalAssignmentReference.parse(rawRef); technicalDocumentAcquisitionCommand.shape.commandId.parse(commandId);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const receipt = await outcome(tx, state, ref, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  }, { inactiveRecipientForRevocation: true });
}
