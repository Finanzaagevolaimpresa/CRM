import type { Prisma } from '@prisma/client';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { loadTechnicalUploadRecord } from './technical-upload-persistence';
import { loadTechnicalUploadReview } from './technical-upload-review-persistence';
import { technicalAssignmentClock, TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { readTechnicalDocumentAcquisitionRecord, technicalDocumentAcquisitionReceipt,
  type TechnicalDocumentAcquisitionRecord } from './technical-document-acquisition-journal';
import { technicalDocumentCanonicalRows, technicalDocumentCanonicalProjection } from './technical-document-acquisition-projection';
import { readPrivateDocumentVersions } from './private-document-versions';

type Tx = Prisma.TransactionClient;
type Reader = Pick<TechnicalAssignmentTransaction, 'key'>;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const fail = (): never => { throw new TechnicalAssignmentError('UNAVAILABLE'); };

/** Integrity only. Callers separately enforce the current personal authority or
 * an exact selected version. Neither a historical signature nor an uploader is
 * a read grant. Epoch-only increments invalidate old selections without erasing
 * canonical provenance. */
export async function loadTechnicalDocumentAcquisition(tx: Tx, state: Reader, commandId: string) {
  technicalDocumentAcquisitionReceipt.shape.commandId.parse(commandId);
  const rows = await tx.$queryRaw<Array<{ record: unknown; documentId: string; versionId: string;
    submissionCommandId: string; reviewCommandId: string; actorId: string; sessionId: string; createdAt: Date }>>`
    SELECT record,"documentId","versionId","submissionCommandId","reviewCommandId","actorId","sessionId","createdAt"
    FROM "TechnicalDocumentAcquisition" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  const row = rows[0], now = await technicalAssignmentClock(tx);
  const saved = rows.length === 1 && readTechnicalDocumentAcquisitionRecord(state.key, row.record, now);
  if (!saved) return fail();
  const r = saved.receipt;
  if (r.commandId !== commandId || row.documentId !== r.documentId || row.versionId !== r.versionId
    || row.submissionCommandId !== r.submissionCommandId || row.reviewCommandId !== r.reviewCommandId
    || row.actorId !== r.actorId || row.sessionId !== r.sessionId || row.createdAt.toISOString() !== r.recordedAt) fail();
  const source = await loadTechnicalUploadRecord(tx, state, r.submissionCommandId);
  const review = await loadTechnicalUploadReview(tx, state, r.reviewCommandId);
  if (!source || !review || review.command.verdict !== 'APPROVE_PRIVATE'
    || review.command.submissionCommandId !== r.submissionCommandId || review.receipt.actorId !== r.actorId
    || canonicalSha256(review) !== saved.admission.reviewSha256) return fail();
  const expected = technicalDocumentCanonicalRows(state.key, saved, source.record, now);
  const document = await tx.document.findUnique({ where: { id: r.documentId } });
  const versions = await tx.documentVersion.findMany({ where: { documentId: r.documentId } });
  const audit = await tx.auditLog.findUnique({ where: { id: r.commandId }, select: { id: true, actorId: true,
    event: true, entityType: true, entityId: true, before: true, after: true, createdAt: true } });
  const originalVersion = versions.find(v => v.id === r.versionId);
  if (!document || document.selectiveEpoch < 2 || !originalVersion
    || canonicalJson(json({ ...document, selectiveEpoch: 1 })) !== canonicalJson(json(expected.document))
    || canonicalJson(json(originalVersion)) !== canonicalJson(json(expected.version))
    || canonicalJson(json(audit)) !== canonicalJson(json(expected.audit))) return fail();
  const administrativeVersions = await readPrivateDocumentVersions(tx, document.id, commandId, originalVersion, versions, r.actorId);
  return { record: saved, source: source.record, document, version: originalVersion, administrativeVersions };
}

export async function technicalAcquisitionForSubmission(tx: Tx, submissionCommandId: string) {
  technicalDocumentAcquisitionReceipt.shape.submissionCommandId.parse(submissionCommandId);
  const rows = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalDocumentAcquisition"
    WHERE "submissionCommandId"=${submissionCommandId}::uuid`;
  if (rows.length > 1) fail();
  return rows[0]?.commandId ?? null;
}

export async function persistTechnicalDocumentAcquisition(tx: Tx, state: TechnicalAssignmentTransaction,
  record: TechnicalDocumentAcquisitionRecord, source: unknown, bytes: Uint8Array) {
  const r = record.receipt;
  if (r.actorId !== state.current.userId || r.sessionId !== state.current.sessionId) fail();
  const projection = technicalDocumentCanonicalProjection(state.key, record, source, bytes, await technicalAssignmentClock(tx));
  await tx.document.create({ data: projection.document });
  await tx.documentVersion.create({ data: projection.version });
  await tx.$executeRaw`INSERT INTO "TechnicalDocumentAcquisition"
    ("commandId","submissionCommandId","reviewCommandId","documentId","versionId","actorId","sessionId",record,"createdAt")
    VALUES (${r.commandId}::uuid,${r.submissionCommandId}::uuid,${r.reviewCommandId}::uuid,${r.documentId},${r.versionId},
      ${r.actorId},${r.sessionId}::uuid,${JSON.stringify(record)}::jsonb,${new Date(r.recordedAt)})`;
  await tx.auditLog.create({ data: projection.audit });
  const saved = await loadTechnicalDocumentAcquisition(tx, state, r.commandId);
  if (!saved || canonicalJson(saved.record) !== canonicalJson(record)) return fail();
  return saved.record.receipt;
}
