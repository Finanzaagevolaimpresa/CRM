import type { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { listClientDocumentOptions, selectClientDocuments } from './selective-client-documents';
import { canonicalSha256 } from './canonical-json';
import { practiceDocumentContexts } from './selective-practice-document-context';
import { practiceDocumentSnapshotSchema,
  type PracticeDocumentChoice, type PracticeDocumentContext } from './selective-practice-document-policy';

type Tx = Prisma.TransactionClient;
type Person = Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'> & { id: string };
const unavailable = (): never => { throw new Error('SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'); };

/** Candidates only. Personal confirmation binds the exact chosen versions to
 * this technical practice and recipient, with the immutable grant/audit. */
export async function listPracticeDocumentOptions(tx: Tx, manager: Person, context: PracticeDocumentContext) {
  const options = await listClientDocumentOptions(tx, manager, context.clientId);
  const references = await practiceDocumentContexts(tx, context, options.documentOptions.map(row => row.documentId));
  return { ...options, documentOptions: options.documentOptions.filter(row => references.get(row.documentId)?.eligible) };
}

/** Caller holds client, practice and its ordered parent locks. Reuse the exact
 * version/financial/lifecycle checks; independently recheck contextual identity
 * before and after those locks. Never resolve a PracticeReadiness ID here. */
export async function selectPracticeDocuments(tx: Tx, authorityId: string, target: Person,
  context: PracticeDocumentContext, choices: readonly PracticeDocumentChoice[]) {
  const identities = await tx.documentVersion.findMany({ where: { id: { in: choices.map(row => row.versionId) } },
    select: { id: true, documentId: true } });
  const documentIds = [...new Set(identities.map(row => row.documentId))];
  const before = await practiceDocumentContexts(tx, context, documentIds);
  if (identities.length !== choices.length || documentIds.some(id => !before.get(id)?.eligible)) unavailable();
  const selected = await selectClientDocuments(tx, authorityId, target, context.clientId, choices);
  const current = await practiceDocumentContexts(tx, context, documentIds);
  if (documentIds.some(id => !current.get(id)?.eligible || current.get(id)?.hash !== before.get(id)?.hash)) unavailable();
  return { paths: selected.paths, snapshots: selected.snapshots.map(row => practiceDocumentSnapshotSchema.parse({
    ...row, practiceId: context.id,
    stateHash: canonicalSha256({ document: row.stateHash, practiceReferences: current.get(row.documentId)!.hash }),
  })) };
}
