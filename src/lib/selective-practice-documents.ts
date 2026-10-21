import type { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { listClientDocumentOptions, selectClientDocuments } from './selective-client-documents';
import { documentEligibleForPractice, practiceDocumentSnapshotSchema,
  type PracticeDocumentChoice, type PracticeDocumentContext } from './selective-practice-document-policy';

type Tx = Prisma.TransactionClient;
type Person = Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'> & { id: string };
const unavailable = (): never => { throw new Error('SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'); };

/** Candidates only. Personal confirmation binds the exact chosen versions to
 * this technical practice and recipient, with the immutable grant/audit. */
export async function listPracticeDocumentOptions(tx: Tx, manager: Person, context: PracticeDocumentContext) {
  const options = await listClientDocumentOptions(tx, manager, context.clientId);
  const documents = await tx.document.findMany({ where: { id: { in: options.documentOptions.map(row => row.documentId) } },
    select: { id: true, clientId: true, projectId: true, clientServiceId: true } });
  const allowed = new Set(documents.filter(row => documentEligibleForPractice(context, row)).map(row => row.id));
  return { ...options, documentOptions: options.documentOptions.filter(row => allowed.has(row.documentId)) };
}

/** Caller holds client, practice and its ordered parent locks. Reuse the exact
 * version/financial/lifecycle checks; independently recheck contextual identity
 * before and after those locks. Never resolve a PracticeReadiness ID here. */
export async function selectPracticeDocuments(tx: Tx, authorityId: string, target: Person,
  context: PracticeDocumentContext, choices: readonly PracticeDocumentChoice[]) {
  const identities = await tx.documentVersion.findMany({ where: { id: { in: choices.map(row => row.versionId) } },
    select: { id: true, documentId: true } });
  const documentIds = [...new Set(identities.map(row => row.documentId))];
  const documents = await tx.document.findMany({ where: { id: { in: documentIds } },
    select: { id: true, clientId: true, projectId: true, clientServiceId: true } });
  if (identities.length !== choices.length || documents.length !== documentIds.length
    || documents.some(row => !documentEligibleForPractice(context, row))) unavailable();
  const selected = await selectClientDocuments(tx, authorityId, target, context.clientId, choices);
  const current = await tx.document.findMany({ where: { id: { in: selected.snapshots.map(row => row.documentId) } },
    select: { id: true, clientId: true, projectId: true, clientServiceId: true } });
  if (current.length !== new Set(selected.snapshots.map(row => row.documentId)).size
    || current.some(row => !documentEligibleForPractice(context, row))) unavailable();
  return { paths: selected.paths, snapshots: selected.snapshots.map(row => practiceDocumentSnapshotSchema.parse({
    ...row, practiceId: context.id,
  })) };
}
