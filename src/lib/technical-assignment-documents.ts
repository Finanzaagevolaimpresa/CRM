import type { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { selectClientDocuments } from './selective-client-documents';
import { selectPracticeDocuments } from './selective-practice-documents';
import { practiceDocumentContexts } from './selective-practice-document-context';
import type { lockTechnicalAssignmentContext } from './technical-assignment-context';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import { TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';

type Context = NonNullable<Awaited<ReturnType<typeof lockTechnicalAssignmentContext>>>;
type Choices = TechnicalAssignmentSelection['documents'];
const denied = (): never => { throw new TechnicalAssignmentError('DENIED'); };

/** Internal snapshots only: paths never form a route response. Reuses the
 * released financial, exact-version, privacy and canonical resource locks.
 * Selecting a target never includes unrelated client or future documents. */
export async function snapshotTechnicalAssignmentDocuments(tx: Prisma.TransactionClient,
  state: TechnicalAssignmentTransaction, context: Context,
  choices: readonly { fileId: string; allowDownload: boolean }[]) {
  const target = state.recipient;
  if (!target || choices.length > 20 || new Set(choices.map(row => row.fileId)).size !== choices.length) return denied();
  if (!choices.length) return { documents: [] as Choices, paths: new Map<string, string>(), validUntil: Number.MAX_SAFE_INTEGER };
  const selected = choices.map(row => ({ versionId: row.fileId, download: row.allowDownload }));
  const practiceContext = { id: context.targetId, clientId: context.clientId, projectId: context.projectId,
    clientServiceId: context.clientServiceId, serviceProjectId: context.projectId };
  const result = context.kind === 'TechnicalPractice'
    ? await selectPracticeDocuments(tx, state.current.userId, target, practiceContext, selected)
    : await selectClientDocuments(tx, state.current.userId, target, context.clientId, selected);
  const documents: Choices = [];
  const ids = [...new Set(result.snapshots.map(row => row.documentId))];
  const rows = await tx.document.findMany({ where: { id: { in: ids } }, select: {
    id: true, clientId: true, projectId: true, clientServiceId: true, validUntil: true } });
  if (rows.length !== ids.length) return denied();
  for (const snapshot of result.snapshots) {
    const document = rows.find(row => row.id === snapshot.documentId);
    if (!document) return denied();
    let contextSha256 = snapshot.stateHash;
    if (context.kind === 'Project') {
      // A project choice requires that actual project, not merely the client.
      const service = document.clientServiceId ? await tx.clientService.findUnique({
        where: { id: document.clientServiceId }, select: { projectId: true, clientId: true, deletedAt: true } }) : null;
      if (document.projectId !== context.projectId && service?.projectId !== context.projectId) return denied();
      const references = await practiceDocumentContexts(tx, { ...practiceContext, clientServiceId: document.clientServiceId }, [document.id]);
      const current = references.get(document.id);
      if (!current?.eligible) return denied();
      contextSha256 = canonicalSha256({ document: snapshot.stateHash, projectReferences: current.hash });
    }
    documents.push({ documentId: snapshot.documentId, fileId: snapshot.versionId, version: snapshot.version,
      contentSha256: snapshot.checksum, contextSha256, allowDownload: snapshot.download });
  }
  return { documents, paths: result.paths,
    validUntil: Math.min(Number.MAX_SAFE_INTEGER, ...rows.flatMap(row => row.validUntil ? [row.validUntil.getTime()] : [])) };
}

export async function assertTechnicalAssignmentDocuments(tx: Prisma.TransactionClient,
  state: TechnicalAssignmentTransaction, context: Context, choices: Choices) {
  const snapshot = await snapshotTechnicalAssignmentDocuments(tx, state, context, choices);
  if (choices.length !== snapshot.documents.length || choices.some(choice =>
    canonicalSha256(choice) !== canonicalSha256(snapshot.documents.find(row => row.fileId === choice.fileId) ?? null))) {
    throw new TechnicalAssignmentError('STALE');
  }
  return snapshot;
}
