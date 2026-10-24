import type { Prisma } from '@prisma/client';
import { canonicalJson } from './canonical-json';
import { TechnicalAssignmentError, technicalAssignmentClock, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { readTechnicalUploadReviewRecord, technicalUploadReviewCommand, type TechnicalUploadReviewRecord } from './technical-upload-review-contract';

type Tx = Prisma.TransactionClient;
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }
export async function loadTechnicalUploadReview(tx: Tx, state: Pick<TechnicalAssignmentTransaction, 'key'>, commandId: string) {
  technicalUploadReviewCommand.shape.commandId.parse(commandId);
  const rows = await tx.$queryRaw<Array<{ command: unknown; receipt: unknown; proof: string }>>`
    SELECT command,receipt,proof FROM "TechnicalUploadReview" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  const saved = rows.length === 1 && readTechnicalUploadReviewRecord(state.key, rows[0], await technicalAssignmentClock(tx));
  if (!saved) unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: commandId },
    select: { actorId: true, event: true, entityType: true, entityId: true, before: true, after: true } });
  if (!audit || audit.actorId !== saved.receipt.actorId || audit.event !== 'technical_upload_reviewed'
    || audit.entityType !== 'TechnicalUploadSubmission' || audit.entityId !== saved.command.submissionCommandId
    || canonicalJson(audit.before) !== '{}' || canonicalJson(audit.after) !== canonicalJson({ status: saved.command.verdict })) unavailable();
  return saved;
}
export async function loadTechnicalUploadReviewForSubmission(tx: Tx, state: TechnicalAssignmentTransaction, submissionCommandId: string) {
  technicalUploadReviewCommand.shape.submissionCommandId.parse(submissionCommandId);
  const rows = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalUploadReview"
    WHERE "submissionCommandId"=${submissionCommandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  if (rows.length !== 1) unavailable();
  const record = await loadTechnicalUploadReview(tx, state, rows[0].commandId);
  if (!record || record.command.submissionCommandId !== submissionCommandId) unavailable();
  return record;
}
export async function persistTechnicalUploadReview(tx: Tx, state: TechnicalAssignmentTransaction, record: TechnicalUploadReviewRecord) {
  const { command: c, receipt: r, proof } = record;
  if (r.actorId !== state.current.userId || r.sessionId !== state.current.sessionId) unavailable();
  await tx.$executeRaw`INSERT INTO "TechnicalUploadReview" ("commandId","submissionCommandId","actorId","sessionId",command,receipt,proof,"createdAt")
    VALUES (${c.commandId}::uuid,${c.submissionCommandId}::uuid,${r.actorId},${r.sessionId}::uuid,
      ${JSON.stringify(c)}::jsonb,${JSON.stringify(r)}::jsonb,${proof},${new Date(r.recordedAt)})`;
  await tx.auditLog.create({ data: { id: c.commandId, actorId: r.actorId, event: 'technical_upload_reviewed',
    entityType: 'TechnicalUploadSubmission', entityId: c.submissionCommandId, before: {}, after: { status: c.verdict },
    createdAt: new Date(r.recordedAt) } });
  const saved = await loadTechnicalUploadReview(tx, state, c.commandId);
  if (!saved || canonicalJson(saved) !== canonicalJson(record)) unavailable();
  return saved.receipt;
}
