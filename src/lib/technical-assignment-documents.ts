import type { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { selectClientDocumentsForTechnicalAssignment } from './selective-client-documents';
import { practiceDocumentContexts } from './selective-practice-document-context';
import type { lockTechnicalAssignmentContext } from './technical-assignment-context';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import { TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';

type Context = NonNullable<Awaited<ReturnType<typeof lockTechnicalAssignmentContext>>>;
type Choices = TechnicalAssignmentSelection['documents'];
const denied = (): never => { throw new TechnicalAssignmentError('DENIED'); };

/** Internal snapshots only: paths never form a route response. Reuses the
 * released financial, exact-version, privacy and canonical resource locks.
 * Selecting a target never includes unrelated client or future documents. */
export async function snapshotTechnicalAssignmentDocuments(tx: Prisma.TransactionClient,
  state: Pick<TechnicalAssignmentTransaction, 'authority' | 'recipient'>, context: Context,
  choices: readonly { fileId: string; allowDownload: boolean }[]) {
  const target = state.recipient;
  if (!target || choices.length > 20 || new Set(choices.map(row => row.fileId)).size !== choices.length) return denied();
  if (!choices.length) return { documents: [] as Choices, paths: new Map<string, string>(), metadata: [], validUntil: Number.MAX_SAFE_INTEGER };
  const selected = choices.map(row => ({ versionId: row.fileId, download: row.allowDownload }));
  const practiceContext = { id: context.targetId, clientId: context.clientId, projectId: context.projectId,
    clientServiceId: context.clientServiceId, serviceProjectId: context.projectId };
  const result = await selectClientDocumentsForTechnicalAssignment(tx, state.authority.userId, target, context.clientId, selected);
  const documents: Choices = [];
  const ids = [...new Set(result.snapshots.map(row => row.documentId))];
  const rows = await tx.document.findMany({ where: { id: { in: ids } } });
  if (rows.length !== ids.length) return denied();
  for (const snapshot of result.snapshots) {
    const document = rows.find(row => row.id === snapshot.documentId);
    if (!document) return denied();
    const version = await tx.documentVersion.findUnique({ where: { id: snapshot.versionId } });
    if (!version || version.documentId !== document.id) return denied();
    const company = document.companyId ? await tx.company.findUnique({ where: { id: document.companyId } }) : null;
    const references = await practiceDocumentContexts(tx, context.kind === 'Project'
      ? { ...practiceContext, clientServiceId: document.clientServiceId } : practiceContext, [document.id], 'technical-assignment');
    const current = references.get(document.id);
    if (!current?.eligible) return denied();
    if (context.kind === 'Project') {
      // A project choice requires that actual project, not merely the client.
      const service = document.clientServiceId ? await tx.clientService.findUnique({
        where: { id: document.clientServiceId }, select: { projectId: true, clientId: true, deletedAt: true } }) : null;
      if (document.projectId !== context.projectId && service?.projectId !== context.projectId) return denied();
    }
    const contextSha256 = canonicalSha256(JSON.parse(JSON.stringify({ protocol: 'TECHNICAL_DOCUMENT_CONTEXT_V1',
      targetContext: context.contextSha256, document, version, company, references: current.hash,
      ...(document.visibilityLevel === technicalDocumentPrivateVisibility ? { acquisitionState: snapshot.stateHash } : {}) })));
    documents.push({ documentId: snapshot.documentId, fileId: snapshot.versionId, version: snapshot.version,
      contentSha256: snapshot.checksum, contextSha256, allowDownload: snapshot.download });
  }
  return { documents, paths: result.paths,
    metadata: result.snapshots.map(row => ({ documentId: row.documentId, fileId: row.versionId, version: row.version,
      title: row.title, fileName: row.fileName, mimeType: row.mimeType, allowDownload: row.download })),
    validUntil: Math.min(Number.MAX_SAFE_INTEGER, ...rows.flatMap(row => row.validUntil ? [row.validUntil.getTime()] : [])) };
}

export async function assertTechnicalAssignmentDocuments(tx: Prisma.TransactionClient,
  state: Pick<TechnicalAssignmentTransaction, 'authority' | 'recipient'>, context: Context, choices: Choices) {
  const snapshot = await snapshotTechnicalAssignmentDocuments(tx, state, context, choices);
  if (choices.length !== snapshot.documents.length || choices.some(choice =>
    canonicalSha256(choice) !== canonicalSha256(snapshot.documents.find(row => row.fileId === choice.fileId) ?? null))) {
    throw new TechnicalAssignmentError('STALE');
  }
  return snapshot;
}
