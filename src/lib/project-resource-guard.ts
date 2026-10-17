import type { Prisma, PrismaClient } from '@prisma/client';
import { lockInternalUser } from './internal-session-registry';
import { assertProjectOperational, ProjectUnavailableError } from './project-lifecycle-lock';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { withSerializableTransaction } from './serializable';

export type ProjectResource = {
  projectId?: string | null; clientServiceId?: string | null;
  documentId?: string | null; contractId?: string | null; commercialOfferId?: string | null;
};

/** Authorization is still the caller's responsibility. This additional guard
 * locks the linked projects and rechecks exclusions in the same transaction as
 * the operation, including documents attached through financial/material rows. */
export async function guardProjectResources(tx: Prisma.TransactionClient, userId: string, resources: readonly ProjectResource[]) {
  await lockInternalUser(tx, userId);
  const contexts = [...resources];
  const documents = [...new Set(resources.flatMap(r => r.documentId ? [r.documentId] : []))];
  const contracts = new Set(resources.flatMap(r => r.contractId ? [r.contractId] : []));
  const offers = [...new Set(resources.flatMap(r => r.commercialOfferId ? [r.commercialOfferId] : []))];
  if (documents.length) {
    const [rows, signed, payments, formalizations, materials] = await Promise.all([
      tx.document.findMany({ where: { id: { in: documents } }, select: { projectId: true, clientServiceId: true } }),
      tx.contract.findMany({ where: { signedDocumentId: { in: documents } }, select: { id: true } }),
      tx.payment.findMany({ where: { accountingDocumentId: { in: documents } }, select: { contractId: true } }),
      tx.practiceFormalization.findMany({ where: { signedDocumentId: { in: documents } }, select: { contractId: true } }),
      tx.practiceMaterialEvidence.findMany({ where: { documentId: { in: documents } }, select: { practice: { select: { projectId: true, clientServiceId: true } } } }),
    ]);
    contexts.push(...rows, ...materials.map(r => r.practice));
    signed.forEach(r => contracts.add(r.id));
    [...payments, ...formalizations].forEach(r => contracts.add(r.contractId));
  }
  if (contracts.size) {
    const ids = [...contracts];
    const [rows, services, formalizations] = await Promise.all([
      tx.contract.findMany({ where: { id: { in: ids } }, select: { projectId: true } }),
      tx.clientService.findMany({ where: { contractId: { in: ids } }, select: { id: true, projectId: true } }),
      tx.practiceFormalization.findMany({ where: { contractId: { in: ids } }, select: { practice: { select: { projectId: true, clientServiceId: true } } } }),
    ]);
    contexts.push(...rows, ...services.map(r => ({ projectId: r.projectId })), ...formalizations.map(r => r.practice));
  }
  if (offers.length) {
    const [practices, revisions] = await Promise.all([
      tx.practiceReadiness.findMany({ where: { commercialOfferId: { in: offers } }, select: { projectId: true, clientServiceId: true } }),
      tx.practiceOfferRevision.findMany({ where: { commercialOfferId: { in: offers } }, select: { projectId: true } }),
    ]);
    contexts.push(...practices, ...revisions);
  }
  for (const context of contexts.sort((a, b) => `${a.projectId ?? ''}:${a.clientServiceId ?? ''}`.localeCompare(`${b.projectId ?? ''}:${b.clientServiceId ?? ''}`))) {
    await assertProjectOperational(tx, context);
  }
  const scope = await loadSelectiveProjectScope(tx, userId);
  if (contexts.some(r => (r.projectId && scope.selectiveProjectIds?.includes(r.projectId)) || (r.clientServiceId && scope.selectiveServiceIds?.includes(r.clientServiceId)))
    || documents.some(id => scope.selectiveDocumentIds?.includes(id)) || [...contracts].some(id => scope.selectiveContractIds?.includes(id))
    || offers.some(id => scope.selectiveOfferIds?.includes(id))) throw new ProjectUnavailableError();
  return scope;
}

export function withProjectResources<T>(db: PrismaClient, userId: string, resources: readonly ProjectResource[], work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return withSerializableTransaction(db, async tx => {
    await guardProjectResources(tx, userId, resources);
    return work(tx);
  });
}
