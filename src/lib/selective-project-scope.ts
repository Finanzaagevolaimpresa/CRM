import type { Prisma } from '@prisma/client';
import type { SelectiveProjectScope } from './selective-project-policy';
import { lockInternalUser } from './internal-session-registry';

type Db = Prisma.TransactionClient;
export async function loadSelectiveProjectScope(db: Db, recipientId: string): Promise<SelectiveProjectScope> {
  // Deliberately includes revoked, expired and invalid grants. A missing proof
  // denies the projection; it must never restore an older, broader permission.
  const grants = await db.selectiveProjectGrant.findMany({ where: { recipientId }, select: { id: true, projectId: true } });
  const selectiveProjectIds = grants.map(row => row.projectId);
  if (!selectiveProjectIds.length) return { selectiveProjectIds: [], selectiveServiceIds: [], selectiveDocumentIds: [], selectiveContractIds: [], selectiveOfferIds: [] };
  // A shared financial contract is restricted, but must not pull another
  // project's operational services into this project/recipient perimeter.
  const linkedServices = await db.clientService.findMany({ where: { projectId: { in: selectiveProjectIds } }, select: { id: true, contractId: true } });
  const selectiveServiceIds = linkedServices.map(row => row.id);
  const contextWhere = { OR: [{ projectId: { in: selectiveProjectIds } }, { clientServiceId: { in: selectiveServiceIds } }] };
  const [practices, technicalPractices] = await Promise.all([
    db.practiceReadiness.findMany({ where: contextWhere, select: { id: true, commercialOfferId: true, acceptedOfferRevisionId: true } }),
    db.technicalPractice.findMany({ where: contextWhere, select: { id: true } }),
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
  const payments = await db.payment.findMany({ where: { contractId: { in: selectiveContractIds } }, select: { id: true, accountingDocumentId: true } });
  const messages = await db.approvedCommunication.findMany({ where: { OR: [
    { readinessId: { in: practices.map(row => row.id) } }, { technicalPracticeId: { in: technicalPractices.map(row => row.id) } },
  ] }, select: { id: true, replies: { select: { id: true } } } });
  const materials = await db.practiceMaterialEvidence.findMany({ where: { practiceId: { in: practices.map(row => row.id) } }, select: { documentId: true } });
  const documents = await db.document.findMany({ where: { OR: [
    { projectId: { in: selectiveProjectIds } }, { clientServiceId: { in: selectiveServiceIds } },
    { id: { in: [...contracts.map(row => row.signedDocumentId), ...formalizations.map(row => row.signedDocumentId), ...payments.map(row => row.accountingDocumentId), ...materials.map(row => row.documentId)].filter((id): id is string => Boolean(id)) } },
  ] }, select: { id: true } });
  const projectWhere = { projectId: { in: selectiveProjectIds } };
  const idOnly = { id: true } as const;
  const related = await Promise.all([
    db.projectExpense.findMany({ where: projectWhere, select: idOnly }),
    db.preAnalysis.findMany({ where: projectWhere, select: idOnly }),
    db.dossier.findMany({ where: projectWhere, select: idOnly }),
    db.clientDossier.findMany({ where: contextWhere, select: idOnly }),
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
    ...offerRevisions.map(row => row.id), ...technicalPractices.map(row => row.id), ...messages.flatMap(row => [row.id, ...row.replies.map(reply => reply.id)]),
    ...grants.map(row => row.id), ...payments.map(row => row.id), ...practices.map(row => row.id), ...formalizations.map(row => row.id), ...related.flatMap(rows => rows.map(row => row.id))])];
  return { selectiveProjectIds, selectiveServiceIds, selectiveContractIds, selectiveOfferIds, selectiveDocumentIds, selectiveAuditEntityIds };
}

/** Fresh check inside a transaction, also for actors rebuilt by legacy services. */
export async function assertNoSelectiveProjectMutation(db: Db, recipientId: string, projectId?: string | null, serviceId?: string | null) {
  // Confirmation locks this same recipient before changing its perimeter.
  await lockInternalUser(db, recipientId);
  if (projectId && await db.selectiveProjectGrant.findUnique({ where: { projectId_recipientId: { projectId, recipientId } }, select: { id: true } })) {
    throw new Error('SELECTIVE_PROJECT_READ_ONLY');
  }
  if (serviceId && (await loadSelectiveProjectScope(db, recipientId)).selectiveServiceIds?.includes(serviceId)) {
    throw new Error('SELECTIVE_PROJECT_READ_ONLY');
  }
}
