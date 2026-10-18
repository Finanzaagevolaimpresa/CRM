import type { Prisma } from '@prisma/client';
import { lockInternalUser } from './internal-session-registry';
import type { SelectiveLeadScope } from './selective-lead-policy';

/** Historical selections are exclusions even if expired, revoked or invalid.
 * This loader never authorizes the selected projection or mutates a record. */
export async function loadSelectiveLeadScope(db: Prisma.TransactionClient, recipientId: string, relatedLeadIds: readonly string[] = []): Promise<SelectiveLeadScope & {
  selectiveLeadOfferIds: string[];
}> {
  const grants = await db.selectiveLeadGrant.findMany({ where: { recipientId },
    select: { id: true, leadId: true, revisions: { select: { id: true, commandId: true } } } });
  // Related IDs are server-derived exclusions (for example a converted client),
  // never a request parameter or a grant to a selected-lead projection.
  const selectiveLeadIds = [...new Set([...grants.map(row => row.leadId), ...relatedLeadIds])];
  if (!selectiveLeadIds.length) return { selectiveLeadIds: [], selectiveLeadAuditEntityIds: [], selectiveLeadOfferIds: [], selectiveLeadIntakeIds: [], selectiveLeadInboxEventIds: [] };
  const leadWhere = { leadId: { in: selectiveLeadIds } };
  const [offers, ledgers, inbox, messages, files, privacy, candidates] = await Promise.all([
    db.commercialOffer.findMany({ where: leadWhere, select: { id: true } }),
    db.leadProjectionLedger.findMany({ where: leadWhere, select: { id: true, inboxEventId: true } }),
    db.commercialLeadInboxItem.findMany({ where: leadWhere, select: { id: true,
      activities: { select: { id: true } }, slaCycles: { select: { id: true } } } }),
    db.approvedCommunication.findMany({ where: leadWhere, select: { id: true, replies: { select: { id: true } } } }),
    db.communicationContextFile.findMany({ where: leadWhere, select: { id: true } }),
    db.privacyEvidenceReceipt.findMany({ where: leadWhere, select: { id: true, websiteLeadReceiptId: true, businessInboxEventId: true } }),
    db.leadDuplicateCandidate.findMany({ where: leadWhere, select: { id: true, duplicateCaseId: true } }),
  ]);
  const cases = await db.leadDuplicateCase.findMany({ where: { OR: [
    { id: { in: candidates.map(row => row.duplicateCaseId) } },
    { projectionLedgerId: { in: ledgers.map(row => row.id) } },
  ] }, select: { id: true, projectionLedgerId: true, decisions: { select: { id: true } } } });
  const [caseLedgers, intakes] = await Promise.all([
    db.leadProjectionLedger.findMany({ where: { id: { in: cases.map(row => row.projectionLedgerId) } }, select: { id: true, inboxEventId: true } }),
    db.controlledIntake.findMany({ where: { OR: [leadWhere,
      { duplicateCandidates: { some: leadWhere } }, { duplicateDecision: { candidateLeadId: { in: selectiveLeadIds } } } ] },
      select: { id: true, websiteLeadReceiptId: true, sourceProjectionLedgerId: true,
        duplicateCandidates: { select: { id: true } }, duplicateDecision: { select: { id: true } } } }),
  ]);
  const selectiveLeadOfferIds = offers.map(row => row.id);
  const intakeIds = intakes.map(row => row.id);
  const [practices, offerRevisions] = await Promise.all([
    db.practiceReadiness.findMany({ where: { OR: [
      { controlledIntakeId: { in: intakeIds } }, { commercialOfferId: { in: selectiveLeadOfferIds } },
    ] }, select: { id: true, formalizations: { select: { id: true } },
      funding: { select: { id: true } }, materials: { select: { id: true } },
      materialAttestations: { select: { id: true } }, engagementDossier: { select: { id: true } },
      engagementDossierVersions: { select: { id: true } } } }),
    db.practiceOfferRevision.findMany({ where: { OR: [
      { controlledIntakeId: { in: intakeIds } }, { commercialOfferId: { in: selectiveLeadOfferIds } },
    ] }, select: { id: true, acceptance: { select: { id: true } } } }),
  ]);
  const selectiveLeadAuditEntityIds = [...new Set([
    ...selectiveLeadIds, ...selectiveLeadOfferIds,
    ...offerRevisions.flatMap(row => [row.id, row.acceptance?.id].filter((id): id is string => !!id)),
    ...practices.flatMap(row => [row.id, row.engagementDossier?.id,
      ...row.formalizations.map(item => item.id), ...row.funding.map(item => item.id),
      ...row.materials.map(item => item.id), ...row.materialAttestations.map(item => item.id),
      ...row.engagementDossierVersions.map(item => item.id)].filter((id): id is string => !!id)),
    ...caseLedgers.flatMap(row => [row.id, row.inboxEventId]),
    ...intakes.flatMap(row => [row.id, row.websiteLeadReceiptId, row.sourceProjectionLedgerId,
      row.duplicateDecision?.id, ...row.duplicateCandidates.map(item => item.id)].filter((id): id is string => !!id)),
    ...grants.flatMap(row => [row.id, ...row.revisions.flatMap(revision => [revision.id, revision.commandId])]),
    ...ledgers.flatMap(row => [row.id, row.inboxEventId]),
    ...inbox.flatMap(row => [row.id, ...row.activities.map(item => item.id), ...row.slaCycles.map(item => item.id)]),
    ...messages.flatMap(row => [row.id, ...row.replies.map(reply => reply.id)]), ...files.map(row => row.id),
    ...privacy.flatMap(row => [row.id, row.websiteLeadReceiptId, row.businessInboxEventId].filter((id): id is string => !!id)),
    ...candidates.map(row => row.id), ...cases.flatMap(row => [row.id, row.projectionLedgerId, ...row.decisions.map(item => item.id)]),
  ])];
  // Audit entity IDs deliberately span cuid/text and UUID domains. Typed
  // resource queries must receive only IDs from their own table.
  const selectiveLeadInboxEventIds = [...new Set([...ledgers, ...caseLedgers].map(row => row.inboxEventId)
    .concat(privacy.flatMap(row => row.businessInboxEventId ? [row.businessInboxEventId] : [])))];
  return { selectiveLeadIds, selectiveLeadOfferIds, selectiveLeadAuditEntityIds,
    selectiveLeadIntakeIds: intakeIds, selectiveLeadInboxEventIds };
}

/** Confirmation holds the same recipient lock before changing any perimeter. */
export async function assertNoSelectiveLeadMutation(db: Prisma.TransactionClient, recipientId: string, leadId?: string | null) {
  if (!leadId) return;
  await lockInternalUser(db, recipientId);
  if (await db.selectiveLeadGrant.findUnique({ where: { leadId_recipientId: { leadId, recipientId } }, select: { id: true } })) {
    throw new Error('SELECTIVE_LEAD_READ_ONLY');
  }
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { clientId: true } });
  if (await db.client.findFirst({ where: {
    OR: [{ leadId }, ...(lead?.clientId ? [{ id: lead.clientId }] : [])],
    selectiveGrants: { some: { recipientId } },
  }, select: { id: true } })) throw new Error('SELECTIVE_CLIENT_READ_ONLY');
}
