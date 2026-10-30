import type { Document, Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { loadTechnicalDocumentAcquisition } from './technical-document-acquisition-persistence';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentManagementRead } from './technical-assignment-transaction';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { admitsTechnicalAssignmentManager } from './technical-assignment-permissions';
import { hasPermission } from './permission-evaluator';
import { canAccessFinancialDocument } from './financial-document-access';
import { readTechnicalUploadPrivateFile } from './technical-upload-storage';
import { documentPreviewMime } from './document-preview';
import { assertOperationalActive, readOperationalState } from './admin-operational-state';
import { readPrivateDocumentMetadata,effectivePrivateDocument } from './private-document-metadata';

type Tx = Prisma.TransactionClient;
const deny = (): never => { throw new TechnicalAssignmentError('DENIED'); };
/** Additional gate for explicit version selection only. Ordinary readers never
 * call this as a fallback. The caller still checks target, live recipient,
 * document permissions, financial ceiling and every selection fingerprint. */
async function technicalAcquisitionBasis(tx: Tx, authorityId: string, document: Document, administrativeHistory: boolean) {
  if (document.visibilityLevel !== technicalDocumentPrivateVisibility) return null;
  // Hold the source epoch through admission and byte delivery. A concurrent
  // metadata correction cannot commit between the last check and the read.
  const [locked]=await tx.$queryRaw<Array<{selectiveEpoch:number}>>`SELECT "selectiveEpoch" FROM "Document" WHERE id=${document.id} FOR SHARE`;
  if(!locked||locked.selectiveEpoch!==document.selectiveEpoch)return deny();
  const key = await loadActivePrivilegedStepUpKey(tx);
  if (!key) return deny();
  const [authority] = await tx.$queryRaw<Array<{ userId: string; revision: number; enabled: boolean }>>`
    SELECT "userId",revision,enabled FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment' FOR SHARE`;
  if (!authority?.enabled || authority.userId !== authorityId) return deny();
  const author = await tx.user.findUnique({ where: { id: authorityId }, include: { permissionOverrides: true } });
  const [row] = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalDocumentAcquisition" WHERE "documentId"=${document.id}`;
  if (!row || !author?.active || author.deletedAt) return deny();
  if (author.permissionOverrides.some(p => !p.allowed && (p.permission === 'document.download'
    || (document.containsSensitiveData && p.permission === 'document.sensitive.read')))) return deny();
  const saved = await loadTechnicalDocumentAcquisition(tx, { key }, row.commandId);
  if (!saved || saved.record.receipt.documentId !== document.id || saved.record.receipt.actorId !== authorityId
    || !admitsTechnicalAssignmentManager(author, saved.record.receipt.reference.kind)
    || saved.record.admission.authorityRevision !== authority.revision) return deny();
  const metadata=await readPrivateDocumentMetadata(tx,document,saved.record.command.classification);
  const effectiveDocument=effectivePrivateDocument(document,metadata.current.values);
  if(effectiveDocument.containsSensitiveData&&author.permissionOverrides.some(p=>p.permission==='document.sensitive.read'&&!p.allowed)
    ||!await canAccessFinancialDocument(tx,author,document)||!await canAccessFinancialDocument(tx,author,effectiveDocument))return deny();
  const reference = saved.record.receipt.reference;
  const context = await lockTechnicalAssignmentContext(tx, { kind: reference.kind, targetId: reference.targetId });
  const now = await technicalAssignmentClock(tx);
  if (!context?.operational || context.clientId !== document.clientId || context.projectId !== document.projectId
    || context.clientServiceId !== document.clientServiceId || (!administrativeHistory && effectiveDocument.validUntil && effectiveDocument.validUntil <= now)) return deny();
  if (!administrativeHistory) await assertOperationalActive(tx, 'Document', document.id);
  return { ...saved, metadata,effectiveDocument,contextSha256: context.contextSha256 };
}

export async function selectedTechnicalAcquisition(tx: Tx, authorityId: string, document: Document) {
  return technicalAcquisitionBasis(tx, authorityId, document, false);
}

/** Metadata/history admission only. This does not serve bytes or a recipient grant. */
export async function adminTechnicalAcquisitionHistory(tx: Tx, authorityId: string, document: Document) {
  const saved = await technicalAcquisitionBasis(tx, authorityId, document, true);
  const author = await tx.user.findUnique({ where: { id: authorityId }, include: { permissionOverrides: true } });
  if (!saved || author?.role !== 'admin' || !await canAccessFinancialDocument(tx, author, document)) return deny();
  return saved;
}

export async function listPersonalAcquiredDocuments(db: PrismaClient, claimed: AuthSession, clientId: string) {
  return withTechnicalAssignmentManagementRead(db, claimed, 'Project', null, async (tx, state) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR SHARE`;
    const client = await tx.client.findUnique({ where: { id: clientId } });
    if (!client || client.deletedAt || !hasPermission(state.current, 'document.download')) return deny();
    const rows = await tx.document.findMany({ where: { clientId, visibilityLevel: technicalDocumentPrivateVisibility, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 101 });
    if (rows.length > 100) return deny();
    const result = [];
    for (const document of rows) {
      try {
        const saved = state.current.role === 'admin'
          ? await adminTechnicalAcquisitionHistory(tx, state.current.userId, document)
          : await selectedTechnicalAcquisition(tx, state.current.userId, document);
        if (!saved || hasSelectiveClientContext(state.current, document) || hasSelectiveContext(state.current, document)
          || (saved.record.receipt.reference.kind === 'TechnicalPractice' && isSelectivePractice(state.current, saved.record.receipt.reference.targetId))
          || !await canAccessFinancialDocument(tx, state.current, document)
          || (document.containsSensitiveData && !hasPermission(state.current, 'document.sensitive.read'))) continue;
        const lifecycle = await readOperationalState(tx, 'Document', document.id);
        const effective=saved.effectiveDocument;
        result.push({ lifecycleState: lifecycle?.state ?? 'ACTIVE' as const, available: (!lifecycle || lifecycle.state === 'ACTIVE') && (!effective.validUntil || effective.validUntil > await technicalAssignmentClock(tx)), id: document.id, title: effective.title, fileName: document.fileName, mimeType: document.mimeType, versionId: saved.version.id,
          classification: saved.metadata.current.values.classification,metadataRevision:saved.metadata.current.revision,acquiredAt: saved.record.receipt.recordedAt });
      } catch { /* A stale private record does not become an ordinary document. */ }
    }
    return result;
  });
}

export async function readPersonalAcquiredDocument(db: PrismaClient, claimed: AuthSession, documentId: string) {
  return withTechnicalAssignmentManagementRead(db, claimed, 'Project', null, async (tx, state) => {
    const identity = await tx.document.findUnique({ where: { id: documentId } });
    if (!identity || !hasPermission(state.current, 'document.download')) return deny();
    const saved = await selectedTechnicalAcquisition(tx, state.current.userId, identity);
    if (!saved || hasSelectiveClientContext(state.current, identity) || hasSelectiveContext(state.current, identity)
      || (saved.record.receipt.reference.kind === 'TechnicalPractice' && isSelectivePractice(state.current, saved.record.receipt.reference.targetId))
      || (identity.containsSensitiveData && !hasPermission(state.current, 'document.sensitive.read'))
      || !await canAccessFinancialDocument(tx, state.current, identity)) return deny();
    const r = saved.source, bytes = await readTechnicalUploadPrivateFile({ storageKey: r.storageKey, sha256: r.contentSha256, sizeBytes: r.sizeBytes });
    await selectedTechnicalAcquisition(tx, state.current.userId, identity);
    return { bytes, fileName: identity.fileName, previewMime: documentPreviewMime(identity.fileName, bytes) };
  });
}
