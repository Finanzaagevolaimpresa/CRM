import type { Prisma } from '@prisma/client';
import { lockInternalUser } from './internal-session-registry';
import type { SelectiveClientScope } from './selective-client-policy';
import { loadTechnicalAssignmentExclusions } from './technical-assignment-exclusions';

type Db = Prisma.TransactionClient;
const idOnly = { id: true } as const;
const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id);
const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))];

/** Resource IDs retain their table domain. Only the audit exclusion is mixed. */
export type LoadedSelectiveClientScope = Required<SelectiveClientScope> & {
  selectiveClientCompanyIds: string[];
  selectiveClientPersonIds: string[];
  selectiveClientLeadIds: string[];
  selectiveClientProjectIds: string[];
  selectiveClientServiceIds: string[];
  selectiveClientContractIds: string[];
  selectiveClientOfferIds: string[];
  selectiveClientDocumentIds: string[];
  selectiveClientReadinessIds: string[];
  selectiveClientTechnicalPracticeIds: string[];
};

/** Current server-side exclusions, including revoked, expired or invalid grants.
 * This loader neither validates a projection nor creates permissions. It reads
 * identifiers only; routes must still apply their own authorization checks. */
export async function loadSelectiveClientScope(db: Db, recipientId: string, technicalClientIds?: readonly string[]): Promise<LoadedSelectiveClientScope> {
  const grants = await db.selectiveClientGrant.findMany({ where: { recipientId }, select: {
    id: true, clientId: true, revisions: { select: { id: true, commandId: true } },
  } });
  const technicalClients = technicalClientIds ?? (await loadTechnicalAssignmentExclusions(db, recipientId)).clientIds;
  const selectiveClientIds = unique([...grants.map(row => row.clientId), ...technicalClients]);
  const empty: LoadedSelectiveClientScope = {
    selectiveClientIds, selectiveClientAuditEntityIds: [], selectiveClientCompanyIds: [],
    selectiveClientPersonIds: [], selectiveClientLeadIds: [], selectiveClientProjectIds: [],
    selectiveClientServiceIds: [], selectiveClientContractIds: [], selectiveClientOfferIds: [],
    selectiveClientDocumentIds: [], selectiveClientReadinessIds: [], selectiveClientTechnicalPracticeIds: [],
  };
  if (!selectiveClientIds.length) return empty;

  const clientWhere = { clientId: { in: selectiveClientIds } };
  const [clients, companies] = await Promise.all([
    db.client.findMany({ where: { id: { in: selectiveClientIds } }, select: { id: true, leadId: true } }),
    db.company.findMany({ where: clientWhere, select: idOnly }),
  ]);
  const selectiveClientCompanyIds = ids(companies);
  const companyWhere = { companyId: { in: selectiveClientCompanyIds } };
  // Both links exist in the legacy model. Neither may hide a converted lead.
  const [leads, people, projects] = await Promise.all([
    db.lead.findMany({ where: { OR: [clientWhere, { id: { in: unique(clients.map(row => row.leadId)) } }] }, select: idOnly }),
    db.companyPerson.findMany({ where: companyWhere, select: { id: true, personId: true } }),
    db.project.findMany({ where: { OR: [clientWhere, companyWhere] }, select: idOnly }),
  ]);
  const selectiveClientLeadIds = ids(leads);
  const selectiveClientProjectIds = ids(projects);
  const projectWhere = { projectId: { in: selectiveClientProjectIds } };
  const services = await db.clientService.findMany({ where: { OR: [clientWhere, companyWhere, projectWhere] },
    select: { id: true, contractId: true, paymentId: true } });
  const selectiveClientServiceIds = ids(services);
  const serviceWhere = { clientServiceId: { in: selectiveClientServiceIds } };
  const contextWhere = { OR: [clientWhere, projectWhere, serviceWhere] };
  const companyContextWhere = { OR: [...contextWhere.OR, companyWhere] };
  const [practices, technical] = await Promise.all([
    db.practiceReadiness.findMany({ where: contextWhere, select: {
      id: true, controlledIntakeId: true, commercialOfferId: true, acceptedOfferRevisionId: true,
      contractId: true, signedDocumentId: true, signedDocumentVersionId: true,
      formalizations: { select: { id: true, contractId: true, signedDocumentId: true, signedDocumentVersionId: true } },
      materials: { select: { id: true, documentId: true, documentVersionId: true, checklistItemId: true } },
      funding: { select: idOnly }, materialAttestations: { select: idOnly },
    } }),
    db.technicalPractice.findMany({ where: contextWhere, select: idOnly }),
  ]);
  const selectiveClientReadinessIds = ids(practices);
  const selectiveClientTechnicalPracticeIds = ids(technical);
  const [offers, revisions] = await Promise.all([
    db.commercialOffer.findMany({ where: { OR: [clientWhere,
      { leadId: { in: selectiveClientLeadIds } }, { id: { in: practices.map(row => row.commercialOfferId) } },
    ] }, select: idOnly }),
    db.practiceOfferRevision.findMany({ where: { OR: [clientWhere, projectWhere,
      { id: { in: practices.map(row => row.acceptedOfferRevisionId) } },
    ] }, select: { id: true, commercialOfferId: true, controlledIntakeId: true, acceptance: { select: idOnly } } }),
  ]);
  const selectiveClientOfferIds = unique([...ids(offers), ...revisions.map(row => row.commercialOfferId)]);
  // Restrict a shared financial resource without pulling its other clients or
  // their operational services into this recipient's selected-client scope.
  const linkedContractIds = unique([...services.map(row => row.contractId), ...practices.flatMap(row =>
    [row.contractId, ...row.formalizations.map(item => item.contractId)])]);
  const contracts = await db.contract.findMany({ where: { OR: [clientWhere, projectWhere, { id: { in: linkedContractIds } }] },
    select: { id: true, signedDocumentId: true } });
  const payments = await db.payment.findMany({ where: { OR: [clientWhere, { contractId: { in: ids(contracts) } },
    { id: { in: unique(services.map(row => row.paymentId)) } }] }, select: { id: true, contractId: true, accountingDocumentId: true } });
  const paymentContracts = await db.contract.findMany({ where: { id: { in: unique(payments.map(row => row.contractId)) } },
    select: { id: true, signedDocumentId: true } });
  const selectiveClientContractIds = unique([...ids(contracts), ...ids(paymentContracts)]);
  const explicitVersionIds = unique(practices.flatMap(row => [row.signedDocumentVersionId,
    ...row.formalizations.map(item => item.signedDocumentVersionId), ...row.materials.map(item => item.documentVersionId)]));
  const referencedVersions = await db.documentVersion.findMany({ where: { id: { in: explicitVersionIds } }, select: { id: true, documentId: true } });
  const referencedDocumentIds = unique([...contracts, ...paymentContracts].map(row => row.signedDocumentId).concat(
    payments.map(row => row.accountingDocumentId), referencedVersions.map(row => row.documentId),
    practices.flatMap(row => [row.signedDocumentId, ...row.formalizations.map(item => item.signedDocumentId),
      ...row.materials.map(item => item.documentId)])));
  const documents = await db.document.findMany({ where: { OR: [...companyContextWhere.OR, { id: { in: referencedDocumentIds } }] }, select: idOnly });
  const selectiveClientDocumentIds = ids(documents);
  const messageContext = { OR: [clientWhere, { leadId: { in: selectiveClientLeadIds } },
    { readinessId: { in: selectiveClientReadinessIds } }, { technicalPracticeId: { in: selectiveClientTechnicalPracticeIds } }] };
  const [messages, files, dossiers, requests, workflows] = await Promise.all([
    db.approvedCommunication.findMany({ where: messageContext, select: { id: true,
      versions: { select: idOnly }, attempts: { select: idOnly }, events: { select: idOnly }, replies: { select: idOnly },
      ordinaryEmailDecisions: { select: idOnly }, ordinaryEmailAttempts: { select: idOnly },
    } }),
    db.communicationContextFile.findMany({ where: messageContext, select: idOnly }),
    db.clientDossier.findMany({ where: { OR: [...contextWhere.OR, { practiceReadinessId: { in: selectiveClientReadinessIds } }] }, select: {
      id: true, versions: { select: idOnly }, versionReviews: { select: idOnly },
      versionExports: { select: idOnly }, deliveryAuthorizations: { select: idOnly },
    } }),
    db.aiExecutionRequest.findMany({ where: companyContextWhere, select: { id: true,
      decisions: { select: idOnly }, adminNotifications: { select: idOnly },
    } }),
    db.aiWorkflowInstance.findMany({ where: companyContextWhere, select: { id: true,
      commands: { select: idOnly }, transitions: { select: idOnly }, jobs: { select: idOnly },
      jobOutboxEvents: { select: idOnly }, jobRuntimes: { select: idOnly },
      jobRuntimeEvents: { select: idOnly }, jobResults: { select: idOnly },
    } }),
  ]);
  const runs = await db.aiRun.findMany({ where: { OR: [...contextWhere.OR, { aiExecutionRequestId: { in: ids(requests) } }] }, select: idOnly });
  const updateWhere = { OR: [
    { kind: 'CLIENT', recordId: { in: selectiveClientIds } },
    { kind: 'LEAD', recordId: { in: selectiveClientLeadIds } },
    { kind: 'PROJECT', recordId: { in: selectiveClientProjectIds } },
    { kind: 'PRACTICE', recordId: { in: selectiveClientTechnicalPracticeIds } },
  ] };
  const related = await Promise.all([
    db.clientReadGrant.findMany({ where: clientWhere, select: idOnly }),
    db.selectiveProjectGrant.findMany({ where: projectWhere, select: idOnly }),
    db.projectExpense.findMany({ where: projectWhere, select: idOnly }),
    db.preAnalysis.findMany({ where: { OR: [clientWhere, companyWhere, projectWhere] }, select: idOnly }),
    db.dossier.findMany({ where: { OR: [clientWhere, projectWhere] }, select: idOnly }),
    db.practiceCommunication.findMany({ where: { OR: [...contextWhere.OR, { technicalPracticeId: { in: selectiveClientTechnicalPracticeIds } }] }, select: idOnly }),
    db.task.findMany({ where: companyContextWhere, select: idOnly }),
    db.documentChecklistItem.findMany({ where: { OR: [...contextWhere.OR,
      { id: { in: practices.flatMap(row => row.materials.map(item => item.checklistItemId)) } }] }, select: idOnly }),
    db.aiOutput.findMany({ where: { OR: [...contextWhere.OR, { aiRunId: { in: ids(runs) } }] }, select: idOnly }),
    db.bankabilityAssessment.findMany({ where: { OR: [clientWhere, companyWhere, projectWhere] }, select: idOnly }),
    db.corporateFinancingAssessment.findMany({ where: companyContextWhere, select: idOnly }),
    db.grantAssessment.findMany({ where: projectWhere, select: idOnly }),
    db.cumulabilityAssessment.findMany({ where: projectWhere, select: idOnly }),
    db.documentVersion.findMany({ where: { documentId: { in: selectiveClientDocumentIds } }, select: idOnly }),
    db.documentExtraction.findMany({ where: { documentId: { in: selectiveClientDocumentIds } }, select: idOnly }),
    db.visuraAnalysis.findMany({ where: { OR: [companyWhere, { documentId: { in: selectiveClientDocumentIds } }] }, select: idOnly }),
    db.recordUpdateRule.findMany({ where: updateWhere, select: { id: true, deliveries: { select: idOnly } } }),
    db.recordUpdateCommand.findMany({ where: updateWhere, select: { id: true, deliveries: { select: idOnly } } }),
    db.recordUpdateEvent.findMany({ where: updateWhere, select: { id: true, deliveries: { select: idOnly } } }),
  ]);
  const audit = unique([
    ...selectiveClientIds, ...selectiveClientCompanyIds, ...people.flatMap(row => [row.id, row.personId]),
    ...selectiveClientLeadIds, ...selectiveClientProjectIds, ...selectiveClientServiceIds,
    ...selectiveClientContractIds, ...selectiveClientOfferIds, ...selectiveClientDocumentIds,
    ...selectiveClientTechnicalPracticeIds, ...ids(payments), ...ids(referencedVersions),
    ...grants.flatMap(row => [row.id, ...row.revisions.flatMap(item => [item.id, item.commandId])]),
    ...practices.flatMap(row => [row.id, row.controlledIntakeId, ...ids(row.formalizations),
      ...ids(row.materials), ...ids(row.funding), ...ids(row.materialAttestations)]),
    ...revisions.flatMap(row => [row.id, row.controlledIntakeId, row.acceptance?.id]),
    ...messages.flatMap(row => [row.id, ...ids(row.versions), ...ids(row.attempts), ...ids(row.events),
      ...ids(row.replies), ...ids(row.ordinaryEmailDecisions), ...ids(row.ordinaryEmailAttempts)]),
    ...ids(files), ...dossiers.flatMap(row => [row.id, ...ids(row.versions), ...ids(row.versionReviews),
      ...ids(row.versionExports), ...ids(row.deliveryAuthorizations)]),
    ...requests.flatMap(row => [row.id, ...ids(row.decisions), ...ids(row.adminNotifications)]), ...ids(runs),
    ...workflows.flatMap(row => [row.id, ...ids(row.commands), ...ids(row.transitions), ...ids(row.jobs),
      ...ids(row.jobOutboxEvents), ...ids(row.jobRuntimes), ...ids(row.jobRuntimeEvents), ...ids(row.jobResults)]),
    ...related.flatMap(rows => rows.flatMap(row => [row.id, ...('deliveries' in row ? ids(row.deliveries) : [])])),
  ]);
  return { ...empty, selectiveClientCompanyIds, selectiveClientPersonIds: unique(people.map(row => row.personId)),
    selectiveClientLeadIds, selectiveClientProjectIds, selectiveClientServiceIds, selectiveClientContractIds,
    selectiveClientOfferIds, selectiveClientDocumentIds, selectiveClientReadinessIds, selectiveClientTechnicalPracticeIds,
    selectiveClientAuditEntityIds: audit };
}

/** Call inside the mutation/audit transaction for both the current and proposed
 * client identities. Confirmation serializes on the same recipient user lock. */
export async function assertNoSelectiveClientMutation(db: Db, recipientId: string, ...clientIds: (string | null | undefined)[]) {
  const selected = unique(clientIds);
  if (!selected.length) return;
  await lockInternalUser(db, recipientId);
  if (await db.selectiveClientGrant.findFirst({ where: { recipientId, clientId: { in: selected } }, select: idOnly })) {
    throw new Error('SELECTIVE_CLIENT_READ_ONLY');
  }
  const technical = await loadTechnicalAssignmentExclusions(db, recipientId);
  if (technical.clientIds.some(id => selected.includes(id))) throw new Error('TECHNICAL_ASSIGNMENT_EXPLICIT_OPERATION_REQUIRED');
}
