import type { Prisma } from '@prisma/client';
import type { SelectiveProjectScope } from './selective-project-policy';

type Db = Prisma.TransactionClient;
export async function loadSelectiveProjectScope(db: Db, recipientId: string): Promise<SelectiveProjectScope> {
  // Deliberately includes revoked, expired and invalid grants. A missing proof
  // denies the projection; it must never restore an older, broader permission.
  const grants = await db.selectiveProjectGrant.findMany({ where: { recipientId }, select: { id: true, projectId: true } });
  const selectiveProjectIds = grants.map(row => row.projectId);
  if (!selectiveProjectIds.length) return { selectiveProjectIds: [], selectiveServiceIds: [], selectiveDocumentIds: [], selectiveContractIds: [], selectiveOfferIds: [] };
  const [linkedServices, practices] = await Promise.all([
    db.clientService.findMany({ where: { projectId: { in: selectiveProjectIds } }, select: { contractId: true } }),
    db.practiceReadiness.findMany({ where: { projectId: { in: selectiveProjectIds } }, select: { id: true, commercialOfferId: true, acceptedOfferRevisionId: true } }),
  ]);
  const offerRevisions = await db.practiceOfferRevision.findMany({ where: { OR: [{ projectId: { in: selectiveProjectIds } },
    { id: { in: practices.flatMap(row => row.acceptedOfferRevisionId ? [row.acceptedOfferRevisionId] : []) } }] }, select: { id: true, commercialOfferId: true } });
  const selectiveOfferIds = [...new Set([...practices.map(row => row.commercialOfferId), ...offerRevisions.map(row => row.commercialOfferId)])];
  const formalizations = await db.practiceFormalization.findMany({ where: { practiceId: { in: practices.map(row => row.id) } },
    select: { id: true, contractId: true, signedDocumentId: true } });
  const contracts = await db.contract.findMany({ where: { OR: [
    { projectId: { in: selectiveProjectIds } },
    { id: { in: [...linkedServices.flatMap(row => row.contractId ? [row.contractId] : []), ...formalizations.map(row => row.contractId)] } },
  ] }, select: { id: true, signedDocumentId: true } });
  const selectiveContractIds = contracts.map(row => row.id);
  const [services, payments] = await Promise.all([
    db.clientService.findMany({ where: { OR: [{ projectId: { in: selectiveProjectIds } }, { contractId: { in: selectiveContractIds } }] }, select: { id: true } }),
    db.payment.findMany({ where: { contractId: { in: selectiveContractIds } }, select: { id: true, accountingDocumentId: true } }),
  ]);
  const selectiveServiceIds = services.map(row => row.id);
  const materials = await db.practiceMaterialEvidence.findMany({ where: { practiceId: { in: practices.map(row => row.id) } }, select: { documentId: true } });
  const documents = await db.document.findMany({ where: { OR: [
    { projectId: { in: selectiveProjectIds } }, { clientServiceId: { in: selectiveServiceIds } },
    { id: { in: [...contracts.map(row => row.signedDocumentId), ...formalizations.map(row => row.signedDocumentId), ...payments.map(row => row.accountingDocumentId), ...materials.map(row => row.documentId)].filter((id): id is string => Boolean(id)) } },
  ] }, select: { id: true } });
  const projectWhere = { projectId: { in: selectiveProjectIds } };
  const contextWhere = { OR: [projectWhere, { clientServiceId: { in: selectiveServiceIds } }] };
  const idOnly = { id: true } as const;
  const related = await Promise.all([
    db.projectExpense.findMany({ where: projectWhere, select: idOnly }),
    db.preAnalysis.findMany({ where: projectWhere, select: idOnly }),
    db.dossier.findMany({ where: projectWhere, select: idOnly }),
    db.clientDossier.findMany({ where: contextWhere, select: idOnly }),
    db.technicalPractice.findMany({ where: contextWhere, select: idOnly }),
    db.practiceCommunication.findMany({ where: contextWhere, select: idOnly }),
    db.task.findMany({ where: contextWhere, select: idOnly }),
    db.documentChecklistItem.findMany({ where: contextWhere, select: idOnly }),
    db.aiOutput.findMany({ where: contextWhere, select: idOnly }),
    db.aiRun.findMany({ where: contextWhere, select: idOnly }),
    db.aiExecutionRequest.findMany({ where: contextWhere, select: idOnly }),
    db.bankabilityAssessment.findMany({ where: projectWhere, select: idOnly }),
    db.corporateFinancingAssessment.findMany({ where: contextWhere, select: idOnly }),
    db.grantAssessment.findMany({ where: projectWhere, select: idOnly }),
    db.documentVersion.findMany({ where: { documentId: { in: documents.map(row => row.id) } }, select: idOnly }),
  ]);
  const selectiveDocumentIds = documents.map(row => row.id);
  const selectiveAuditEntityIds = [...new Set([...selectiveProjectIds, ...selectiveServiceIds, ...selectiveContractIds, ...selectiveOfferIds, ...selectiveDocumentIds,
    ...offerRevisions.map(row => row.id),
    ...grants.map(row => row.id), ...payments.map(row => row.id), ...practices.map(row => row.id), ...formalizations.map(row => row.id), ...related.flatMap(rows => rows.map(row => row.id))])];
  return { selectiveProjectIds, selectiveServiceIds, selectiveContractIds, selectiveOfferIds, selectiveDocumentIds, selectiveAuditEntityIds };
}

/** Fresh check inside a transaction, also for actors rebuilt by legacy services. */
export async function assertNoSelectiveProjectMutation(db: Db, recipientId: string, projectId?: string | null, serviceId?: string | null) {
  if (projectId && await db.selectiveProjectGrant.findUnique({ where: { projectId_recipientId: { projectId, recipientId } }, select: { id: true } })) {
    throw new Error('SELECTIVE_PROJECT_READ_ONLY');
  }
  if (serviceId && (await loadSelectiveProjectScope(db, recipientId)).selectiveServiceIds?.includes(serviceId)) {
    throw new Error('SELECTIVE_PROJECT_READ_ONLY');
  }
}
