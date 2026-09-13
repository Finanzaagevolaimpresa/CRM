import type { AiOutput, Prisma, Task } from '@prisma/client';
import {
  canViewAiOutput,
  canViewClient,
  canViewClientContext,
  canViewCommercialOffer,
  canViewProject,
  canViewTask,
} from './access-control';
import { UserFacingActionError } from './action-errors';
import type { AuthSession } from './auth';
import { coreQueryCandidateLimit, normalizeCoreQueryLimit } from './core-query-policy';
import { prisma } from './prisma';

const inaccessibleMessage = 'Risorsa non disponibile o non accessibile.';
const clientSelect = { id: true, salesOwnerId: true, consultantId: true } as const;
const aiOutputAccessSelect = {
  id: true,
  aiRunId: true,
  clientId: true,
  clientServiceId: true,
  projectId: true,
  status: true,
  requiresHumanReview: true,
  forbiddenPhrases: true,
  reviewedById: true,
  reviewedAt: true,
} as const;
const aiRunAccessSelect = {
  id: true,
  agentId: true,
  clientId: true,
  clientServiceId: true,
  projectId: true,
  status: true,
  provider: true,
  model: true,
  promptVersion: true,
  reliabilityVersion: true,
  agentConfigVersion: true,
  failureCode: true,
  finishedAt: true,
  egressStartedAt: true,
  createdById: true,
  createdAt: true,
} as const;
type AiRunAccessRecord = Prisma.AiRunGetPayload<{ select: typeof aiRunAccessSelect }>;

export type ClientReadContext = {
  clientId: string;
  projectId?: string | null;
  clientServiceId?: string | null;
};

export function denyReadAccess(): never {
  throw new UserFacingActionError(inaccessibleMessage);
}

async function loadClient(clientId: string) {
  return prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: clientSelect });
}

async function loadProject(projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (!project) return null;
  const client = await loadClient(project.clientId);
  return client ? { ...project, client } : null;
}

async function loadService(clientServiceId: string) {
  const service = await prisma.clientService.findFirst({ where: { id: clientServiceId, deletedAt: null } });
  if (!service) return null;
  const [client, project] = await Promise.all([
    loadClient(service.clientId),
    service.projectId ? loadProject(service.projectId) : null,
  ]);
  if (!client || (service.projectId && (!project || project.clientId !== service.clientId))) return null;
  return { ...service, client, project };
}

export async function getClientReadAccess(session: AuthSession, clientId: string) {
  const client = await loadClient(clientId);
  return client && canViewClient(session, client) ? client : null;
}

export async function requireClientReadAccess(session: AuthSession, clientId: string) {
  const client = await getClientReadAccess(session, clientId);
  if (!client) denyReadAccess();
  return client;
}

export async function getProjectReadAccess(session: AuthSession, projectId: string) {
  const project = await loadProject(projectId);
  return project && canViewProject(session, project) ? project : null;
}

export async function requireProjectReadAccess(session: AuthSession, projectId: string) {
  const project = await getProjectReadAccess(session, projectId);
  if (!project) denyReadAccess();
  return project;
}

export async function getCompanyReadAccess(session: AuthSession, companyId: string) {
  const company = await prisma.company.findFirst({ where: { id: companyId, deletedAt: null } });
  if (!company) return null;
  const client = await getClientReadAccess(session, company.clientId);
  return client ? { company, client } : null;
}

export async function getCommercialOfferReadAccess(session: AuthSession, offerId: string) {
  const offer = await prisma.commercialOffer.findFirst({ where: { id: offerId, deletedAt: null } });
  if (!offer) return null;
  const [lead, client] = await Promise.all([
    offer.leadId ? prisma.lead.findFirst({ where: { id: offer.leadId, deletedAt: null } }) : null,
    offer.clientId ? loadClient(offer.clientId) : null,
  ]);
  return canViewCommercialOffer(session, { ...offer, lead, client }) ? { offer, lead, client } : null;
}

export async function requireCommercialOfferReadAccess(session: AuthSession, offerId: string) {
  const context = await getCommercialOfferReadAccess(session, offerId);
  if (!context) denyReadAccess();
  return context;
}

export async function getContractReadAccess(session: AuthSession, contractId: string) {
  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) return null;
  const context = await getClientContextReadAccess(session, { clientId: contract.clientId, projectId: contract.projectId });
  return context ? { contract, ...context } : null;
}

export async function getPaymentReadAccess(session: AuthSession, paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return null;
  const contract = await prisma.contract.findFirst({ where: { id: payment.contractId, clientId: payment.clientId } });
  if (!contract) return null;
  const context = await getClientContextReadAccess(session, { clientId: payment.clientId, projectId: contract.projectId });
  return context ? { payment, contract, ...context } : null;
}

export async function getPreAnalysisReadAccess(session: AuthSession, preAnalysisId: string) {
  const preAnalysis = await prisma.preAnalysis.findUnique({ where: { id: preAnalysisId } });
  if (!preAnalysis) return null;
  const context = await getClientContextReadAccess(session, { clientId: preAnalysis.clientId, projectId: preAnalysis.projectId });
  if (!context) return null;
  if (preAnalysis.companyId) {
    const company = await prisma.company.findFirst({ where: { id: preAnalysis.companyId, clientId: preAnalysis.clientId, deletedAt: null }, select: { id: true } });
    if (!company) return null;
  }
  return { preAnalysis, ...context };
}

export async function getLegacyDossierReadAccess(session: AuthSession, dossierId: string) {
  const dossier = await prisma.dossier.findUnique({ where: { id: dossierId } });
  if (!dossier) return null;
  const context = await getClientContextReadAccess(session, { clientId: dossier.clientId, projectId: dossier.projectId });
  if (!context) return null;
  if (dossier.preAnalysisId) {
    const preAnalysis = await prisma.preAnalysis.findFirst({
      where: { id: dossier.preAnalysisId, clientId: dossier.clientId, projectId: dossier.projectId },
      select: { id: true },
    });
    if (!preAnalysis) return null;
  }
  return { dossier, ...context };
}

export async function getClientDossierReadAccess(session: AuthSession, dossierId: string) {
  const dossier = await prisma.clientDossier.findUnique({ where: { id: dossierId } });
  if (!dossier) return null;
  const context = await getClientContextReadAccess(session, {
    clientId: dossier.clientId,
    clientServiceId: dossier.clientServiceId,
    projectId: dossier.projectId,
  });
  return context ? { dossier, ...context } : null;
}

export async function getClientContextReadAccess(session: AuthSession, context: ClientReadContext) {
  const [client, project, clientService] = await Promise.all([
    loadClient(context.clientId),
    context.projectId ? loadProject(context.projectId) : null,
    context.clientServiceId ? loadService(context.clientServiceId) : null,
  ]);
  if (!client) return null;
  if (context.projectId && (!project || project.clientId !== context.clientId)) return null;
  if (context.clientServiceId && (!clientService || clientService.clientId !== context.clientId)) return null;
  if (project && clientService?.projectId && clientService.projectId !== project.id) return null;
  const hydrated = { clientId: context.clientId, client, project, clientService };
  return canViewClientContext(session, hydrated) ? hydrated : null;
}

export async function requireClientContextReadAccess(session: AuthSession, context: ClientReadContext) {
  const hydrated = await getClientContextReadAccess(session, context);
  if (!hydrated) denyReadAccess();
  return hydrated;
}

type AiOutputAccessRecord = Pick<AiOutput,
  'id' | 'aiRunId' | 'clientId' | 'clientServiceId' | 'projectId' | 'status' |
  'requiresHumanReview' | 'forbiddenPhrases' | 'reviewedById' | 'reviewedAt'
>;

type HydratedAiContext<TOutput extends AiOutputAccessRecord = AiOutputAccessRecord> = {
  output: TOutput;
  run: AiRunAccessRecord;
  client: Awaited<ReturnType<typeof loadClient>>;
  project: Awaited<ReturnType<typeof loadProject>>;
  clientService: Awaited<ReturnType<typeof loadService>>;
};

async function hydrateAiOutputs<TOutput extends AiOutputAccessRecord>(
  outputs: TOutput[],
  db: Prisma.TransactionClient = prisma,
): Promise<Array<HydratedAiContext<TOutput>>> {
  if (!outputs.length) return [];
  const runs = await db.aiRun.findMany({
    where: { id: { in: [...new Set(outputs.map((output) => output.aiRunId))] } },
    select: aiRunAccessSelect,
  });
  const runById = new Map(runs.map((run) => [run.id, run]));
  const services = await db.clientService.findMany({
    where: { id: { in: [...new Set(outputs.map((output) => output.clientServiceId).filter((id): id is string => Boolean(id)))] }, deletedAt: null },
  });
  const projectIds = [...new Set([
    ...outputs.map((output) => output.projectId),
    ...services.map((service) => service.projectId),
  ].filter((id): id is string => Boolean(id)))];
  const projects = await db.project.findMany({ where: { id: { in: projectIds }, deletedAt: null } });
  const clientIds = [...new Set([
    ...outputs.map((output) => output.clientId),
    ...projects.map((project) => project.clientId),
    ...services.map((service) => service.clientId),
  ].filter((id): id is string => Boolean(id)))];
  const clients = await db.client.findMany({ where: { id: { in: clientIds }, deletedAt: null }, select: clientSelect });
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const projectById = new Map(projects.map((project) => [project.id, { ...project, client: clientById.get(project.clientId) ?? null }]));
  const serviceById = new Map(services.map((service) => [service.id, {
    ...service,
    client: clientById.get(service.clientId) ?? null,
    project: service.projectId ? projectById.get(service.projectId) ?? null : null,
  }]));

  const contexts = outputs.map((output) => {
    const run = runById.get(output.aiRunId);
    if (!run) return null;
    const client = output.clientId ? clientById.get(output.clientId) ?? null : null;
    const project = output.projectId ? projectById.get(output.projectId) ?? null : null;
    const clientService = output.clientServiceId ? serviceById.get(output.clientServiceId) ?? null : null;
    if (output.clientId && !client) return null;
    if (output.projectId && !project) return null;
    if (output.clientServiceId && !clientService) return null;
    return { output, run, client, project, clientService };
  });
  return contexts.filter((context): context is HydratedAiContext<TOutput> => context !== null);
}

function canAccessHydratedAiOutput(session: AuthSession, context: HydratedAiContext) {
  return canViewAiOutput(session, {
    ...context.output,
    run: context.run,
    client: context.client,
    project: context.project,
    clientService: context.clientService,
  });
}

export async function listAccessibleAiOutputs(
  session: AuthSession,
  args: Pick<Prisma.AiOutputFindManyArgs, 'where' | 'orderBy' | 'take'> = {},
) {
  const { take, ...candidateArgs } = args;
  const limit = normalizeCoreQueryLimit(take);
  const candidateLimit = coreQueryCandidateLimit(limit);
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.aiOutput.findMany({
      ...candidateArgs,
      take: candidateLimit,
      select: aiOutputAccessSelect,
    });
    const visibleContexts = (await hydrateAiOutputs(candidates, tx))
      .filter((context) => canAccessHydratedAiOutput(session, context))
      .slice(0, limit);
    if (!visibleContexts.length) return [];
    const outputs = await tx.aiOutput.findMany({
      where: { id: { in: visibleContexts.map((context) => context.output.id) } },
    });
    const outputById = new Map(outputs.map((output) => [output.id, output]));
    return visibleContexts.flatMap((context) => {
      const output = outputById.get(context.output.id);
      return output ? [{ ...context, output }] : [];
    });
  }, { isolationLevel: 'RepeatableRead' });
}

export async function getAiOutputReadAccess(session: AuthSession, outputId: string) {
  const contexts = await listAccessibleAiOutputs(session, { where: { id: outputId }, take: 1 });
  return contexts[0] ?? null;
}

export async function requireAiOutputReadAccess(session: AuthSession, outputId: string) {
  const context = await getAiOutputReadAccess(session, outputId);
  if (!context) denyReadAccess();
  return context;
}

export async function listAccessibleAiRuns(session: AuthSession, take = 100) {
  const limit = normalizeCoreQueryLimit(take, 100);
  const candidateLimit = coreQueryCandidateLimit(limit);
  return prisma.$transaction(async (tx) => {
    const runs = await tx.aiRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: candidateLimit,
      select: aiRunAccessSelect,
    });
    const pseudoOutputs: AiOutputAccessRecord[] = runs.map((run) => ({
      id: `run:${run.id}`,
      aiRunId: run.id,
      clientId: run.clientId,
      clientServiceId: run.clientServiceId,
      projectId: run.projectId,
      status: 'needs_review' as const,
      requiresHumanReview: true,
      forbiddenPhrases: null,
      reviewedById: null,
      reviewedAt: null,
    }));
    const contexts = await hydrateAiOutputs(pseudoOutputs, tx);
    return contexts
      .filter((context) => canAccessHydratedAiOutput(session, context))
      .slice(0, limit)
      .map((context) => context.run);
  }, { isolationLevel: 'RepeatableRead' });
}

type TaskAccessRecord = Pick<Task,
  'clientId' | 'projectId' | 'clientServiceId' | 'assignedToId' | 'createdById'
>;

async function filterAccessibleTasks<TTask extends TaskAccessRecord>(
  session: AuthSession,
  tasks: TTask[],
  db: Prisma.TransactionClient = prisma,
): Promise<TTask[]> {
  if (!tasks.length) return [];

  const serviceIds = [...new Set(tasks.map((task) => task.clientServiceId).filter((id): id is string => Boolean(id)))];
  const services = await db.clientService.findMany({
    where: { id: { in: serviceIds }, deletedAt: null },
    select: { id: true, clientId: true, projectId: true, assignedToId: true },
  });
  const projectIds = [...new Set([
    ...tasks.map((task) => task.projectId),
    ...services.map((service) => service.projectId),
  ].filter((id): id is string => Boolean(id)))];
  const projects = await db.project.findMany({
    where: { id: { in: projectIds }, deletedAt: null },
    select: { id: true, clientId: true, consultantId: true },
  });
  const clientIds = [...new Set([
    ...tasks.map((task) => task.clientId),
    ...projects.map((project) => project.clientId),
    ...services.map((service) => service.clientId),
  ].filter((id): id is string => Boolean(id)))];
  const clients = await db.client.findMany({ where: { id: { in: clientIds }, deletedAt: null }, select: clientSelect });
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const projectById = new Map(projects.map((project) => [project.id, {
    ...project,
    client: clientById.get(project.clientId) ?? null,
  }]));
  const serviceById = new Map(services.map((service) => [service.id, {
    ...service,
    client: clientById.get(service.clientId) ?? null,
    project: service.projectId ? projectById.get(service.projectId) ?? null : null,
  }]));

  return tasks.filter((task) => canViewTask(session, {
    ...task,
    client: task.clientId ? clientById.get(task.clientId) ?? null : null,
    project: task.projectId ? projectById.get(task.projectId) ?? null : null,
    clientService: task.clientServiceId ? serviceById.get(task.clientServiceId) ?? null : null,
  }));
}

export async function listAccessibleTasks(
  session: AuthSession,
  args: Pick<Prisma.TaskFindManyArgs, 'where' | 'orderBy' | 'take'> = {},
): Promise<Task[]> {
  const { take, ...candidateArgs } = args;
  const limit = normalizeCoreQueryLimit(take);
  const candidateLimit = coreQueryCandidateLimit(limit);
  const tasks = await prisma.task.findMany({ ...candidateArgs, take: candidateLimit });
  return (await filterAccessibleTasks(session, tasks)).slice(0, limit);
}

export type DashboardTaskCountWindow = {
  now: Date;
  startOfToday: Date;
  endOfToday: Date;
  next7: Date;
};

export type DashboardAccessibleTaskCounts = {
  open: number;
  today: number;
  overdue: number;
  dueSoon: number;
  mine: number;
};

const dashboardCountBatchSize = 100;
const dashboardCountTransaction = {
  isolationLevel: 'RepeatableRead',
  maxWait: 5_000,
  timeout: 30_000,
} as const;

// Lists intentionally remain bounded. Dashboard totals scan every candidate in
// one snapshot and propagate failures, so an interrupted scan is never a total.
export async function getAccessibleDashboardTaskCounts(
  session: AuthSession,
  window: DashboardTaskCountWindow,
): Promise<DashboardAccessibleTaskCounts> {
  return prisma.$transaction(async (tx) => {
    const counts: DashboardAccessibleTaskCounts = { open: 0, today: 0, overdue: 0, dueSoon: 0, mine: 0 };
    let afterId: string | undefined;
    while (true) {
      const candidates = await tx.task.findMany({
        where: {
          deletedAt: null,
          status: { in: ['aperta', 'in_lavorazione'] },
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: dashboardCountBatchSize,
        select: {
          id: true,
          clientId: true,
          projectId: true,
          clientServiceId: true,
          assignedToId: true,
          createdById: true,
          dueAt: true,
        },
      });
      if (!candidates.length) break;
      const visible = await filterAccessibleTasks(session, candidates, tx);
      for (const task of visible) {
        counts.open += 1;
        if (task.assignedToId === session.userId) counts.mine += 1;
        if (task.dueAt) {
          if (task.dueAt >= window.startOfToday && task.dueAt <= window.endOfToday) counts.today += 1;
          if (task.dueAt < window.now) counts.overdue += 1;
          if (task.dueAt >= window.now && task.dueAt <= window.next7) counts.dueSoon += 1;
        }
      }
      afterId = candidates[candidates.length - 1].id;
      if (candidates.length < dashboardCountBatchSize) break;
    }
    return counts;
  }, dashboardCountTransaction);
}

export async function getAccessibleDashboardAiReviewCount(session: AuthSession): Promise<number> {
  return prisma.$transaction(async (tx) => {
    let count = 0;
    let afterId: string | undefined;
    while (true) {
      const candidates = await tx.aiOutput.findMany({
        where: {
          status: { in: ['needs_review', 'flagged'] },
          requiresHumanReview: true,
          ...(afterId === undefined ? {} : { id: { gt: afterId } }),
        },
        orderBy: { id: 'asc' },
        take: dashboardCountBatchSize,
        select: aiOutputAccessSelect,
      });
      if (!candidates.length) break;
      const contexts = await hydrateAiOutputs(candidates, tx);
      count += contexts.filter((context) => canAccessHydratedAiOutput(session, context)).length;
      afterId = candidates[candidates.length - 1].id;
      if (candidates.length < dashboardCountBatchSize) break;
    }
    return count;
  }, dashboardCountTransaction);
}
