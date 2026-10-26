import type { Prisma } from '@prisma/client';
import { listTechnicalDocumentCandidates } from './selective-client-documents';
import { snapshotTechnicalAssignmentDocuments } from './technical-assignment-documents';
import type { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import type { TechnicalDocumentOption } from './technical-document-catalog';

type Context = NonNullable<Awaited<ReturnType<typeof lockTechnicalAssignmentContext>>>;

function denied(error: unknown) {
  return (error instanceof TechnicalAssignmentError && error.code === 'DENIED')
    || (error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message));
}

/** Internal, bounded complete admission. No snapshots, paths or denied titles
 * leave the transaction before the caller projects one admitted page. Canonical
 * batches are at most 20; a denied batch is split without bypassing its checks.
 * Serialization/deadlock/storage errors are never converted into an empty list. */
export async function readAdmittedTechnicalDocumentOptions(tx: Prisma.TransactionClient,
  state: TechnicalAssignmentTransaction, context: Context) {
  const candidates = await listTechnicalDocumentCandidates(tx, state.actor, context.clientId);
  if (candidates.documentsLimited) throw new TechnicalAssignmentError('UNAVAILABLE');
  const ids = candidates.documentOptions.map(row => row.versionId).sort();
  const admitted: TechnicalDocumentOption[] = [];
  let validUntil = Number.MAX_SAFE_INTEGER;
  async function admit(batch: string[]): Promise<void> {
    try {
      const result = await snapshotTechnicalAssignmentDocuments(tx, state, context,
        batch.map(fileId => ({ fileId, allowDownload: false })));
      validUntil = Math.min(validUntil, result.validUntil);
      for (const snapshot of result.documents) {
        const metadata = result.metadata.find(row => row.fileId === snapshot.fileId);
        if (!metadata) throw new TechnicalAssignmentError('UNAVAILABLE');
        admitted.push({ ...snapshot, ...metadata });
      }
    } catch (error) {
      if (!denied(error)) throw error;
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        await admit(batch.slice(0, middle)); await admit(batch.slice(middle));
      }
    }
  }
  for (let start = 0; start < ids.length; start += 20) await admit(ids.slice(start, start + 20));
  return { options: admitted.sort((a, b) => a.fileId.localeCompare(b.fileId)), validUntil };
}
