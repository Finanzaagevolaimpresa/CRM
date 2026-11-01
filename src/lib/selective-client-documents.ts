import { technicalVersionDisclosuresAllowed } from './technical-document-disclosure';
import { Prisma, type Document } from '@prisma/client';
import type { AuthSession } from './auth';
import { isSensitiveDocument } from './access-control';
import { canonicalSha256 } from './canonical-json';
import { filterFinancialDocuments } from './financial-document-access';
import { hasPermission } from './permission-evaluator';
import { guardProjectResources } from './project-resource-guard';
import { loadIndependentProjectExclusions, loadTechnicalDocumentProjectCeilings } from './selective-project-scope';
import { clientDocumentSnapshotSchema, maxClientDocumentBytes, type ClientDocumentChoice, type ClientDocumentSnapshot } from './selective-client-document-policy';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';
import { selectedTechnicalAcquisition, acquiredVersionDocument } from './technical-document-acquired-access';
import { selectedDocumentMode } from './selected-document-formats';
import { TechnicalAssignmentError } from './technical-assignment-transaction';

type Tx = Prisma.TransactionClient;
type Recipient = Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'> & { id: string };
const unavailable = () => { throw new Error('SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE'); };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

/** Bounded management catalogue. This is not an authorization to grant or read
 * bytes; selectedState performs the complete locked check for the recipient. */
export async function listClientDocumentOptions(tx: Tx, manager: Recipient, clientId: string) {
  return readClientDocumentOptions(tx, manager, clientId, { documents: 100, versions: 200, complete: false });
}

/** Technical management only: the ceiling is checked on the complete source
 * set, before admission or user-controlled filters. The canonical locked
 * recipient/target snapshots still run before any catalogue projection. */
export async function listTechnicalDocumentCandidates(tx: Tx, manager: Recipient, clientId: string) {
  return readClientDocumentOptions(tx, manager, clientId, { documents: 256, versions: 256, complete: true });
}

async function readClientDocumentOptions(tx: Tx, manager: Recipient, clientId: string,
  limits: { documents: number; versions: number; complete: boolean }) {
  if (manager.role !== 'admin' || !manager.active || manager.permissionOverrides.some(p => p.permission === 'document.download' && !p.allowed)) return unavailable();
  const [rows, scope, clock] = await Promise.all([
    tx.document.findMany({ where: { clientId, deletedAt: null, visibilityLevel: { in: ['interno', technicalDocumentPrivateVisibility] },
      status: { notIn: ['archiviato', 'respinto', 'scaduto'] } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limits.documents + 1 }),
    loadIndependentProjectExclusions(tx, manager.id),
    tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`,
  ]);
  if (!clock[0]) return unavailable();
  const completeVersions = limits.complete ? await tx.documentVersion.findMany({
    where: { documentId: { in: rows.map(row => row.id) } }, orderBy: { id: 'asc' }, take: limits.versions + 1 }) : null;
  if (limits.complete && (rows.length > limits.documents || completeVersions!.length > limits.versions)) {
    return { documentsLimited: true, documentOptions: [] };
  }
  const ids = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => !!v))];
  const [companies, projects, services] = await Promise.all([
    tx.company.findMany({ where: { id: { in: ids(rows.map(r => r.companyId)) }, clientId, deletedAt: null }, select: { id: true } }),
    tx.project.findMany({ where: { id: { in: ids(rows.map(r => r.projectId)) }, clientId, deletedAt: null, status: { not: 'archiviato' } }, select: { id: true } }),
    tx.clientService.findMany({ where: { id: { in: ids(rows.map(r => r.clientServiceId)) }, clientId, deletedAt: null }, select: { id: true, projectId: true } }),
  ]);
  const provenanceAllowed = [], privateVersionDocuments = new Map<string, Document>();
  for (const d of rows.slice(0, limits.documents)) {
    if (d.visibilityLevel === 'interno') provenanceAllowed.push(d);
    else {
      try { const saved=await selectedTechnicalAcquisition(tx, manager.id, d);if(saved){
        provenanceAllowed.push(saved.effectiveDocument);
        for(const versionId of [saved.version.id,...saved.administrativeVersions.additions.map(v=>v.version.id)]){
          const metadata=acquiredVersionDocument(saved,versionId);if(metadata)privateVersionDocuments.set(versionId,metadata);
        }
      } }
      catch (error) {
        // Preserve the existing sharing catalogue. A complete technical read
        // may omit a denied private version, never a storage/serialization error.
        if (limits.complete && !(error instanceof TechnicalAssignmentError && error.code === 'DENIED')) throw error;
      }
    }
  }
  const eligible = (await filterFinancialDocuments(tx, manager, provenanceAllowed)).filter(d =>
    (!d.validUntil || d.validUntil > clock[0].now) && d.sizeBytes >= 0 && d.sizeBytes <= maxClientDocumentBytes
    && clientDocumentSnapshotSchema.shape.mimeType.safeParse(d.mimeType).success
    && selectedDocumentMode(d) !== null
    && !scope.selectiveDocumentIds?.includes(d.id)
    && (!d.projectId || (!scope.selectiveProjectIds?.includes(d.projectId) && projects.some(p => p.id === d.projectId)))
    && (!d.companyId || companies.some(c => c.id === d.companyId))
    && (!d.clientServiceId || (!scope.selectiveServiceIds?.includes(d.clientServiceId) && services.some(s => s.id === d.clientServiceId
      && (!d.projectId || !s.projectId || s.projectId === d.projectId))))
    && (!isSensitiveDocument(d) || hasPermission(manager, 'document.sensitive.read')));
  const byId = new Map(eligible.map(row => [row.id, row]));
  const versions = completeVersions ?? await tx.documentVersion.findMany({ where: { documentId: { in: [...byId.keys()] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limits.versions + 1 });
  return { documentsLimited: rows.length > limits.documents || versions.length > limits.versions,
    documentOptions: versions.slice(0, limits.versions).filter(v => byId.has(v.documentId) && v.checksum && /^[a-f0-9]{64}$/.test(v.checksum)).map(v => {
      const d = privateVersionDocuments.get(v.id) ?? byId.get(v.documentId)!;
      return { documentId: d.id, versionId: v.id, version: v.version, title: d.title, fileName: d.fileName,
        mimeType: d.mimeType, category: d.documentCategory, area: d.serviceArea };
    }) };
}

/** Caller has locked authority, both people/session and the client. The normal
 * document route remains excluded for a selected client. This function admits
 * only exact versions, preserving independent project ceilings and lifecycle. */
export async function selectClientDocuments(tx: Tx, authorityId: string, target: Recipient, clientId: string,
  choices: readonly ClientDocumentChoice[]): Promise<{ snapshots: ClientDocumentSnapshot[]; paths: Map<string, string>; disclosedVersionIds: Set<string> }> {
  return selectDocumentVersions(tx, authorityId, target, clientId, choices, loadIndependentProjectExclusions);
}

/** Internal technical capability path only. The caller holds the distinct
 * authority, recipient/session, canonical target and signed-assignment locks.
 * Its own legacy exclusion is replaced by that narrower projection; existing
 * personal project/document selections remain independent ceilings. */
export async function selectClientDocumentsForTechnicalAssignment(tx: Tx, authorityId: string, target: Recipient, clientId: string,
  choices: readonly ClientDocumentChoice[]) {
  return selectDocumentVersions(tx, authorityId, target, clientId, choices, loadTechnicalDocumentProjectCeilings, false);
}

async function selectDocumentVersions(tx: Tx, authorityId: string, target: Recipient, clientId: string,
  choices: readonly ClientDocumentChoice[], ceilings: typeof loadIndependentProjectExclusions, enforceDisclosure = true): Promise<{ snapshots: ClientDocumentSnapshot[]; paths: Map<string, string>; disclosedVersionIds: Set<string> }> {
  const snapshots: ClientDocumentSnapshot[] = [], paths = new Map<string, string>(), disclosedVersionIds = new Set<string>();
  if (!choices.length) return { snapshots, paths, disclosedVersionIds };
  if (!target.active || target.permissionOverrides.some(p => p.permission === 'document.download' && !p.allowed)) unavailable();
  const scope = await ceilings(tx, target.id);
  const ordered = [...choices].sort((a, b) => a.versionId.localeCompare(b.versionId));
  const identities = await tx.documentVersion.findMany({ where: { id: { in: ordered.map(row => row.versionId) } },
    select: { id: true, documentId: true } });
  if (identities.length !== ordered.length) return unavailable();
  const documentIds = [...new Set(identities.map(row => row.documentId))].sort();
  // Acquire the entire project's resource set before any document/version lock.
  // Two selections containing the same files in a different order cannot invert
  // project/document locks. Concurrent re-association still fails SERIALIZABLE.
  await guardProjectResources(tx, authorityId, documentIds.map(documentId => ({ documentId })));

  await tx.$queryRawUnsafe('SELECT id FROM "Document" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', documentIds);
  await tx.$queryRawUnsafe('SELECT id FROM "DocumentVersion" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', ordered.map(row => row.versionId));
  const [versions, originals] = await Promise.all([
    tx.documentVersion.findMany({ where: { id: { in: ordered.map(row => row.versionId) } } }),
    tx.document.findMany({ where: { id: { in: documentIds } } }),
  ]);
  if (versions.length !== ordered.length || originals.length !== documentIds.length) return unavailable();
  const acquiredById = new Map<string, Awaited<ReturnType<typeof selectedTechnicalAcquisition>>>();
  for (const document of originals) if (document.visibilityLevel === technicalDocumentPrivateVisibility) {
    acquiredById.set(document.id, await selectedTechnicalAcquisition(tx, authorityId, document));
  }
  const entries = ordered.map(choice => {
    const version = versions.find(row => row.id === choice.versionId);
    const identity = identities.find(row => row.id === choice.versionId);
    const original = originals.find(row => row.id === identity?.documentId);
    if (!version || !original || version.documentId !== original.id) return unavailable();
    const acquired = acquiredById.get(original.id);
    const document = acquired ? acquiredVersionDocument(acquired, choice.versionId) : original;
    if (!document) return unavailable();
    return { choice, document, version, original, acquired };
  });
  const effective = entries.map(row => row.document);
  const allowedOriginals = new Set((await filterFinancialDocuments(tx, target, originals)).map(row => row.id));
  // Effective metadata may differ per private version; keep object identity so
  // one allowed version cannot authorize another version of the same document.
  const allowedEffective = await filterFinancialDocuments(tx, target, effective);
  const disclosed = await technicalVersionDisclosuresAllowed(tx, target, entries);
  const [clock] = await tx.$queryRawUnsafe<Array<{ now: Date }>>('SELECT clock_timestamp() AS now');
  if (!clock) return unavailable();
  const ids = (values: Array<string | null>) => [...new Set(values.filter((id): id is string => !!id))];
  const [companies, projects, services, allContracts, allPayments, allFormalizations, allMaterials] = await Promise.all([
    tx.company.findMany({ where: { id: { in: ids(effective.map(row => row.companyId)) } } }),
    tx.project.findMany({ where: { id: { in: ids(effective.map(row => row.projectId)) } } }),
    tx.clientService.findMany({ where: { id: { in: ids(effective.map(row => row.clientServiceId)) } } }),
    tx.contract.findMany({ where: { signedDocumentId: { in: documentIds } }, orderBy: { id: 'asc' }, select: { signedDocumentId: true, id: true, clientId: true, projectId: true, updatedAt: true, status: true } }),
    tx.payment.findMany({ where: { accountingDocumentId: { in: documentIds } }, orderBy: { id: 'asc' }, select: { accountingDocumentId: true, id: true, contractId: true, updatedAt: true, status: true } }),
    tx.practiceFormalization.findMany({ where: { signedDocumentId: { in: documentIds } }, orderBy: { id: 'asc' }, select: { signedDocumentId: true, id: true, contractId: true, practiceId: true, practice: { select: { clientId: true, projectId: true, clientServiceId: true } } } }),
    tx.practiceMaterialEvidence.findMany({ where: { documentId: { in: documentIds } }, orderBy: { id: 'asc' }, select: { documentId: true, id: true, practiceId: true, practice: { select: { clientId: true, projectId: true, clientServiceId: true } } } }),
  ]);
  const boundRows = await tx.contract.findMany({ where: { id: { in: ids([...allPayments.map(row => row.contractId), ...allFormalizations.map(row => row.contractId)]) } },
    orderBy: { id: 'asc' }, select: { id: true, clientId: true, projectId: true, updatedAt: true, status: true } });
  for (const { choice, document, version, original, acquired } of entries) {
    if (document.deletedAt || document.clientId !== clientId || (document.visibilityLevel !== 'interno' && !acquired)
      || ['archiviato', 'respinto', 'scaduto'].includes(document.status)
      || document.sizeBytes < 0 || document.sizeBytes > maxClientDocumentBytes || selectedDocumentMode(document) === null
      || (document.validUntil && document.validUntil <= clock.now)
      || (isSensitiveDocument(document) && !hasPermission(target, 'document.sensitive.read'))
      || (choice.download && !hasPermission(target, 'document.download'))
      || !allowedOriginals.has(original.id) || !allowedEffective.includes(document)
      || scope.selectiveDocumentIds?.includes(document.id)
      || (document.projectId && scope.selectiveProjectIds?.includes(document.projectId))
      || (document.clientServiceId && scope.selectiveServiceIds?.includes(document.clientServiceId))) return unavailable();
    if (enforceDisclosure && !disclosed.has(version.id)) return unavailable();
    if (disclosed.has(version.id)) disclosedVersionIds.add(version.id);
    const company = companies.find(row => row.id === document.companyId) ?? null;
    const project = projects.find(row => row.id === document.projectId) ?? null;
    const service = services.find(row => row.id === document.clientServiceId) ?? null;
    // Strip grouping columns to preserve the exact historical snapshot format.
    const contracts = allContracts.filter(row => row.signedDocumentId === document.id).map(({ signedDocumentId: _id, ...row }) => { void _id; return row; });
    const payments = allPayments.filter(row => row.accountingDocumentId === document.id).map(({ accountingDocumentId: _id, ...row }) => { void _id; return row; });
    const formalizations = allFormalizations.filter(row => row.signedDocumentId === document.id).map(({ signedDocumentId: _id, ...row }) => { void _id; return row; });
    const materials = allMaterials.filter(row => row.documentId === document.id).map(({ documentId: _id, ...row }) => { void _id; return row; });
    const boundIds = ids([...payments.map(row => row.contractId), ...formalizations.map(row => row.contractId)]);
    const boundContracts = boundRows.filter(row => boundIds.includes(row.id));
    if ((document.companyId && (!company || company.deletedAt || company.clientId !== clientId))
      || (document.projectId && (!project || project.deletedAt || project.status === 'archiviato' || project.clientId !== clientId))
      || (document.clientServiceId && (!service || service.deletedAt || service.clientId !== clientId
        || (document.projectId && service.projectId && service.projectId !== document.projectId)))
      || [...contracts, ...boundContracts].some(row => row.status === 'archiviato' || row.clientId !== clientId)
      || [...formalizations, ...materials].some(row => row.practice.clientId !== clientId)) return unavailable();
    const snapshot = clientDocumentSnapshotSchema.parse({ documentId: document.id, versionId: version.id,
      version: version.version, checksum: version.checksum, title: document.title, fileName: document.fileName,
      mimeType: document.mimeType, download: choice.download,
      stateHash: canonicalSha256(json({ document, version, company, project, service, contracts, payments, formalizations, materials, boundContracts,
        ...(acquired ? { acquisition: { record: acquired.record, contextSha256: acquired.contextSha256 } } : {}) })),
    });
    snapshots.push(snapshot); paths.set(version.id, version.storagePath);
  }
  return { snapshots, paths, disclosedVersionIds };
}
