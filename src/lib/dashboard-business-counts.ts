import type { Dossier, Prisma } from '@prisma/client';
import { canViewClient, canViewCommercialOffer, canViewProject } from './access-control';
import type { AuthSession } from './auth';
import { canViewPaymentListRecord, canViewPreAnalysisListRecord } from './business-list-access';
import { prisma } from './prisma';

const batchSize = 100;
const transactionOptions = {
  isolationLevel: 'RepeatableRead',
  maxWait: 5_000,
  timeout: 30_000,
} as const;
const clientSelect = { id: true, salesOwnerId: true, consultantId: true } as const;
const projectSelect = { id: true, clientId: true, consultantId: true } as const;

type ClientProjectRecord = { clientId: string; projectId: string | null };

async function loadClientProjectContexts(tx: Prisma.TransactionClient, records: ClientProjectRecord[]) {
  const projectIds = [...new Set(records.map((record) => record.projectId).filter((id): id is string => Boolean(id)))];
  const projects = await tx.project.findMany({
    where: { id: { in: projectIds }, deletedAt: null },
    select: projectSelect,
  });
  const clientIds = [...new Set([
    ...records.map((record) => record.clientId),
    ...projects.map((project) => project.clientId),
  ])];
  const clients = await tx.client.findMany({
    where: { id: { in: clientIds }, deletedAt: null },
    select: clientSelect,
  });
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const projectById = new Map(projects.map((project) => [project.id, {
    ...project,
    client: clientById.get(project.clientId) ?? null,
  }]));
  return { clientById, projectById };
}

function canAccessClientProjectRecord(
  session: AuthSession,
  record: ClientProjectRecord,
  contexts: Awaited<ReturnType<typeof loadClientProjectContexts>>,
  requireProject = true,
) {
  const client = contexts.clientById.get(record.clientId);
  if (!client || !canViewClient(session, client)) return false;
  if (!record.projectId) return !requireProject;
  const project = record.projectId ? contexts.projectById.get(record.projectId) : null;
  // These counters link to lists whose perimeter requires a visible client as
  // well as a visible project. Detail access alone can be broader than a list.
  return Boolean(project && project.clientId === record.clientId && canViewProject(session, project));
}

export type DashboardAccessibleOfferCounts = { sent: number; accepted: number };

// These totals intentionally do not reuse bounded UI previews. Every candidate
// is visited in one snapshot; an error rejects the total instead of truncating it.
export async function countAccessibleDashboardOffers(session: AuthSession): Promise<DashboardAccessibleOfferCounts> {
  return prisma.$transaction(async (tx) => {
    const counts: DashboardAccessibleOfferCounts = { sent: 0, accepted: 0 };
    let afterId: string | undefined;
    while (true) {
      const offers = await tx.commercialOffer.findMany({
        where: {
          deletedAt: null,
          status: { in: ['inviata', 'accettata'] },
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, status: true, createdById: true, leadId: true, clientId: true },
      });
      if (!offers.length) break;
      const leadIds = [...new Set(offers.map((offer) => offer.leadId).filter((id): id is string => Boolean(id)))];
      const clientIds = [...new Set(offers.map((offer) => offer.clientId).filter((id): id is string => Boolean(id)))];
      const leads = await tx.lead.findMany({
        where: { id: { in: leadIds }, deletedAt: null },
        select: { id: true, assignedToId: true, clientId: true },
      });
      const clients = await tx.client.findMany({
        where: { id: { in: clientIds }, deletedAt: null },
        select: clientSelect,
      });
      const leadById = new Map(leads.map((lead) => [lead.id, lead]));
      const clientById = new Map(clients.map((client) => [client.id, client]));
      for (const offer of offers) {
        if (!canViewCommercialOffer(session, {
          ...offer,
          lead: offer.leadId ? leadById.get(offer.leadId) ?? null : null,
          client: offer.clientId ? clientById.get(offer.clientId) ?? null : null,
        })) continue;
        if (offer.status === 'inviata') counts.sent += 1;
        if (offer.status === 'accettata') counts.accepted += 1;
      }
      afterId = offers[offers.length - 1].id;
      if (offers.length < batchSize) break;
    }
    return counts;
  }, transactionOptions);
}

export async function countAccessibleDashboardPayments(session: AuthSession): Promise<number> {
  return prisma.$transaction(async (tx) => {
    let count = 0;
    let afterId: string | undefined;
    while (true) {
      const payments = await tx.payment.findMany({
        where: {
          status: { notIn: ['incassato', 'stornato', 'rimborsato'] },
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, clientId: true, contractId: true },
      });
      if (!payments.length) break;
      const contracts = await tx.contract.findMany({
        where: { id: { in: [...new Set(payments.map((payment) => payment.contractId))] } },
        select: { id: true, clientId: true, projectId: true },
      });
      const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
      const contexts = await loadClientProjectContexts(tx, payments.map((payment) => ({
        clientId: payment.clientId,
        projectId: contractById.get(payment.contractId)?.projectId ?? null,
      })));
      for (const payment of payments) {
        const contract = contractById.get(payment.contractId);
        if (canViewPaymentListRecord(session, {
          payment, contract: contract ?? null,
          client: contexts.clientById.get(payment.clientId) ?? null,
          project: contract?.projectId ? contexts.projectById.get(contract.projectId) ?? null : null,
        })) count += 1;
      }
      afterId = payments[payments.length - 1].id;
      if (payments.length < batchSize) break;
    }
    return count;
  }, transactionOptions);
}
export type DashboardAccessibleDossierCounts = { preReview: number; draftDossiers: number };

export async function countAccessibleDashboardDossiers(session: AuthSession): Promise<DashboardAccessibleDossierCounts> {
  return prisma.$transaction(async (tx) => {
    const counts: DashboardAccessibleDossierCounts = { preReview: 0, draftDossiers: 0 };
    let afterId: string | undefined;
    while (true) {
      const preAnalyses = await tx.preAnalysis.findMany({
        where: {
          status: { in: ['bozza_generata', 'da_revisionare'] },
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, clientId: true, projectId: true, companyId: true },
      });
      if (!preAnalyses.length) break;
      const contexts = await loadClientProjectContexts(tx, preAnalyses);
      const companyIds = [...new Set(preAnalyses.map((item) => item.companyId).filter((id): id is string => Boolean(id)))];
      const companies = await tx.company.findMany({
        where: { id: { in: companyIds }, deletedAt: null },
        select: { id: true, clientId: true },
      });
      const companyById = new Map(companies.map((company) => [company.id, company]));
      for (const preAnalysis of preAnalyses) {
        if (!canViewPreAnalysisListRecord(session, {
          preAnalysis, client: contexts.clientById.get(preAnalysis.clientId) ?? null,
          project: contexts.projectById.get(preAnalysis.projectId) ?? null,
          company: preAnalysis.companyId ? companyById.get(preAnalysis.companyId) ?? null : null,
        })) continue;
        counts.preReview += 1;
      }
      afterId = preAnalyses[preAnalyses.length - 1].id;
      if (preAnalyses.length < batchSize) break;
    }

    afterId = undefined;
    while (true) {
      const dossiers: Pick<Dossier, 'id' | 'clientId' | 'projectId' | 'preAnalysisId'>[] = await tx.dossier.findMany({
        where: {
          status: { in: ['bozza_ai', 'bozza_consulente', 'in_revisione'] },
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, clientId: true, projectId: true, preAnalysisId: true },
      });
      if (!dossiers.length) break;
      const contexts = await loadClientProjectContexts(tx, dossiers);
      const preAnalysisIds = [...new Set(dossiers.map((item) => item.preAnalysisId).filter((id): id is string => Boolean(id)))];
      const preAnalyses = await tx.preAnalysis.findMany({
        where: { id: { in: preAnalysisIds } },
        select: { id: true, clientId: true, projectId: true },
      });
      const preAnalysisById = new Map(preAnalyses.map((preAnalysis) => [preAnalysis.id, preAnalysis]));
      for (const dossier of dossiers) {
        if (!canAccessClientProjectRecord(session, dossier, contexts)) continue;
        if (dossier.preAnalysisId) {
          const preAnalysis = preAnalysisById.get(dossier.preAnalysisId);
          if (!preAnalysis || preAnalysis.clientId !== dossier.clientId || preAnalysis.projectId !== dossier.projectId) continue;
        }
        counts.draftDossiers += 1;
      }
      afterId = dossiers[dossiers.length - 1].id;
      if (dossiers.length < batchSize) break;
    }
    return counts;
  }, transactionOptions);
}
