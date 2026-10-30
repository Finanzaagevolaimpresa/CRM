import { leadVisibilityWhere } from './core-query-policy';
import { canAccessFinancialDocument } from './financial-document-access';
import type { Prisma, RoleCode } from '@prisma/client';
import {
  canAssignService,
  canEditChecklistItem,
  canEditClient,
  canEditCommercialOffer,
  canEditDocument,
  canEditLead,
  canEditProject,
  canEditService,
  canEditTask,
  canEditTechnicalPractice,
  canViewTechnicalPractice,
} from './access-control';
import { UserFacingActionError } from './action-errors';
import { hasPermission, type AuthSession } from './auth';
import { prisma } from './prisma';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { lockAuthoritativeInternalSession, lockInternalUser } from './internal-session-registry';
import { internalSessionMode } from './session';
import type { Permission } from './permissions';
import { assertProjectOperational } from './project-lifecycle-lock';

const inaccessibleMessage = 'Risorsa non disponibile o non accessibile.';
type ContextDb = Pick<Prisma.TransactionClient, 'client' | 'company' | 'project' | 'clientService' | '$queryRaw'>;
const clientSelect = { id: true, salesOwnerId: true, consultantId: true } as const;

export type ClientWriteContext = {
  clientId: string;
  companyId?: string | null;
  projectId?: string | null;
  clientServiceId?: string | null;
};

export function denyWriteAccess(): never {
  throw new UserFacingActionError(inaccessibleMessage);
}

export async function requireActiveUser(userId?: string | null, allowedRoles?: readonly RoleCode[]) {
  if (!userId) return null;
  const user = await prisma.user.findFirst({
    where: { id: userId, active: true, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!user || (allowedRoles && !allowedRoles.includes(user.role))) denyWriteAccess();
  return user;
}

type LeadWriteDb = Pick<Prisma.TransactionClient, 'lead' | 'client' | 'commercialOffer'>;

export async function requireLeadEditAccess(session: AuthSession, leadId: string, db: LeadWriteDb = prisma) {
  const lead = await db.lead.findFirst({ where: { id: leadId, deletedAt: null, AND: [leadVisibilityWhere(session)] } });
  if (!lead || !canEditLead(session, lead)) denyWriteAccess();
  return lead;
}

async function loadOfferContext(session: AuthSession, offerId: string, db: LeadWriteDb = prisma) {
  const offer = await db.commercialOffer.findFirst({ where: { id: offerId, deletedAt: null } });
  if (!offer) denyWriteAccess();
  const [lead, client] = await Promise.all([
    offer.leadId ? db.lead.findFirst({ where: { id: offer.leadId, deletedAt: null, AND: [leadVisibilityWhere(session)] } }) : null,
    offer.clientId ? db.client.findFirst({ where: { id: offer.clientId, deletedAt: null }, select: clientSelect }) : null,
  ]);
  return { offer, lead, client };
}

export async function requireCommercialOfferEditAccess(session: AuthSession, offerId: string, db: LeadWriteDb = prisma) {
  const context = await loadOfferContext(session, offerId, db);
  if (!canEditCommercialOffer(session, { ...context.offer, lead: context.lead, client: context.client })) denyWriteAccess();
  return context;
}

export async function requireCommercialOfferTargetAccess(
  session: AuthSession,
  target: { leadId?: string | null; clientId?: string | null },
  db: LeadWriteDb = prisma,
) {
  const [lead, client] = await Promise.all([
    target.leadId ? db.lead.findFirst({ where: { id: target.leadId, deletedAt: null, AND: [leadVisibilityWhere(session)] } }) : null,
    target.clientId ? db.client.findFirst({ where: { id: target.clientId, deletedAt: null }, select: clientSelect }) : null,
  ]);
  if (target.leadId && (!lead || !canEditLead(session, lead))) denyWriteAccess();
  if (target.clientId && (!client || !canEditClient(session, client))) denyWriteAccess();
  if (lead?.clientId && target.clientId && lead.clientId !== target.clientId) denyWriteAccess();
  return { lead, client };
}

async function loadProjectContext(projectId: string, db: ContextDb = prisma) {
  if (db !== prisma) await assertProjectOperational(db as Prisma.TransactionClient, { projectId });
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null, status: { not: 'archiviato' } },
  });
  if (!project) denyWriteAccess();
  const [client, company] = await Promise.all([
    db.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: clientSelect }),
    project.companyId
      ? db.company.findFirst({ where: { id: project.companyId, clientId: project.clientId, deletedAt: null }, select: { id: true } })
      : null,
  ]);
  if (!client || (project.companyId && !company)) denyWriteAccess();
  return { ...project, client };
}

async function loadServiceContext(serviceId: string, db: ContextDb = prisma) {
  const service = await db.clientService.findFirst({
    where: { id: serviceId, deletedAt: null },
  });
  if (!service) denyWriteAccess();
  const [client, company, project] = await Promise.all([
    db.client.findFirst({ where: { id: service.clientId, deletedAt: null }, select: clientSelect }),
    service.companyId
      ? db.company.findFirst({ where: { id: service.companyId, clientId: service.clientId, deletedAt: null }, select: { id: true } })
      : null,
    service.projectId ? loadProjectContext(service.projectId, db) : null,
  ]);
  if (!client || (service.companyId && !company) || (project && project.clientId !== service.clientId)) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  return { ...service, client, project };
}

export async function requireClientContextWriteAccess(
  session: AuthSession,
  context: ClientWriteContext,
  db: ContextDb = prisma,
) {
  const [client, company, project, clientService] = await Promise.all([
    db.client.findFirst({ where: { id: context.clientId, deletedAt: null }, select: clientSelect }),
    context.companyId
      ? db.company.findFirst({ where: { id: context.companyId, clientId: context.clientId, deletedAt: null }, select: { id: true, clientId: true } })
      : null,
    context.projectId ? loadProjectContext(context.projectId, db) : null,
    context.clientServiceId ? loadServiceContext(context.clientServiceId, db) : null,
  ]);
  if (!client) denyWriteAccess();
  if (context.companyId && !company) denyWriteAccess();
  if (context.projectId && (!project || project.clientId !== context.clientId)) denyWriteAccess();
  if (context.clientServiceId && (!clientService || clientService.clientId !== context.clientId)) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== company.id) denyWriteAccess();

  const allowed = clientService
      ? canEditService(session, clientService)
      : project
        ? canEditProject(session, project)
        : canEditClient(session, client);
  if (!allowed) denyWriteAccess();
  return { client, company, project, clientService };
}

export async function requireProjectEditAccess(session: AuthSession, projectId: string, db: ContextDb = prisma) {
  const project = await loadProjectContext(projectId, db);
  if (!canEditProject(session, project)) denyWriteAccess();
  return project;
}

export async function requireServiceEditAccess(session: AuthSession, serviceId: string) {
  const service = await loadServiceContext(serviceId);
  if (!canEditService(session, service)) denyWriteAccess();
  return service;
}

export async function requireServiceAssignAccess(session: AuthSession, serviceId: string) {
  const service = await loadServiceContext(serviceId);
  if (!canAssignService(session, service)) denyWriteAccess();
  return service;
}

async function loadDocumentContext(documentId: string) {
  const document = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document) denyWriteAccess();
  const [client, company, project, clientService] = await Promise.all([
    document.clientId
      ? prisma.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: clientSelect })
      : null,
    document.companyId && document.clientId
      ? prisma.company.findFirst({ where: { id: document.companyId, clientId: document.clientId, deletedAt: null }, select: { id: true } })
      : null,
    document.projectId ? loadProjectContext(document.projectId) : null,
    document.clientServiceId ? loadServiceContext(document.clientServiceId) : null,
  ]);
  if (document.clientId && !client) denyWriteAccess();
  if (document.companyId && !company) denyWriteAccess();
  if (document.projectId && (!project || !document.clientId || project.clientId !== document.clientId)) denyWriteAccess();
  if (document.clientServiceId && (!clientService || !document.clientId || clientService.clientId !== document.clientId)) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== document.companyId) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== document.companyId) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  return { ...document, client, project, clientService };
}

export async function requireDocumentEditAccess(session: AuthSession, documentId: string) {
  const document = await loadDocumentContext(documentId);
  if (!await canAccessFinancialDocument(prisma, session, document) || !canEditDocument(session, document, hasPermission(session, 'document.sensitive.read'))) denyWriteAccess();
  return document;
}

export async function requireChecklistEditAccess(session: AuthSession, itemId: string) {
  const item = await prisma.documentChecklistItem.findFirst({
    where: { technicalPrivate: false, id: itemId, active: true, deletedAt: null },
  });
  if (!item) denyWriteAccess();
  const [client, project, clientService, document] = await Promise.all([
    prisma.client.findFirst({ where: { id: item.clientId, deletedAt: null }, select: clientSelect }),
    item.projectId ? loadProjectContext(item.projectId) : null,
    item.clientServiceId ? loadServiceContext(item.clientServiceId) : null,
    item.documentId ? loadDocumentContext(item.documentId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (item.projectId && (!project || project.clientId !== item.clientId)) denyWriteAccess();
  if (item.clientServiceId && (!clientService || clientService.clientId !== item.clientId)) denyWriteAccess();
  if (document && document.clientId !== item.clientId) denyWriteAccess();
  if (document && (!await canAccessFinancialDocument(prisma, session, document) || !canEditDocument(session, document, hasPermission(session, 'document.sensitive.read')))) denyWriteAccess();
  const context = { ...item, client, project, clientService };
  if (!canEditChecklistItem(session, context)) denyWriteAccess();
  return context;
}

export async function requireTaskEditAccess(session: AuthSession, taskId: string) {
  const task = await prisma.task.findFirst({ where: { technicalPrivate: false, id: taskId, deletedAt: null } });
  if (!task?.clientId) denyWriteAccess();
  const [client, company, project, clientService] = await Promise.all([
    prisma.client.findFirst({ where: { id: task.clientId, deletedAt: null }, select: clientSelect }),
    task.companyId
      ? prisma.company.findFirst({ where: { id: task.companyId, clientId: task.clientId, deletedAt: null }, select: { id: true } })
      : null,
    task.projectId ? loadProjectContext(task.projectId) : null,
    task.clientServiceId ? loadServiceContext(task.clientServiceId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (task.projectId && (!project || project.clientId !== task.clientId)) denyWriteAccess();
  if (task.clientServiceId && (!clientService || clientService.clientId !== task.clientId)) denyWriteAccess();
  if (task.companyId && !company) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== company.id) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  const context = { ...task, client, project, clientService };
  if (!canEditTask(session, context)) denyWriteAccess();
  return context;
}

async function loadTechnicalPracticeContext(practiceId: string, db: Prisma.TransactionClient = prisma) {
  const practice = await db.technicalPractice.findFirst({ where: { id: practiceId, deletedAt: null } });
  if (!practice) denyWriteAccess();
  const [client, project, clientService] = await Promise.all([
    db.client.findFirst({ where: { id: practice.clientId, deletedAt: null }, select: clientSelect }),
    practice.projectId ? loadProjectContext(practice.projectId, db) : null,
    practice.clientServiceId ? loadServiceContext(practice.clientServiceId, db) : null,
  ]);
  if (!client) denyWriteAccess();
  if (practice.projectId && (!project || project.clientId !== practice.clientId)) denyWriteAccess();
  if (practice.clientServiceId && (!clientService || clientService.clientId !== practice.clientId)) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  return { practice, client, project, clientService };
}

export async function requireTechnicalPracticeViewAccess(session: AuthSession, practiceId: string, db: Prisma.TransactionClient = prisma) {
  const context = await loadTechnicalPracticeContext(practiceId, db);
  const current = { ...session, ...await loadSelectiveProjectScope(db, session.userId) };
  if (!canViewTechnicalPractice(current, { ...context.practice, client: context.client, project: context.project, clientService: context.clientService })) denyWriteAccess();
  return context;
}

export async function requireTechnicalPracticeEditAccess(session: AuthSession, practiceId: string, db: Prisma.TransactionClient = prisma) {
  const context = await loadTechnicalPracticeContext(practiceId, db);
  const current = { ...session, ...await loadSelectiveProjectScope(db, session.userId) };
  if (!canEditTechnicalPractice(current, { ...context.practice, project: context.project, clientService: context.clientService })) denyWriteAccess();
  return context.practice;
}

/** Recheck fresh context while excluding concurrent grants and practice moves. */
export async function requireTechnicalPracticeMutationAccess(session: AuthSession, practiceId: string, tx: Prisma.TransactionClient,
  mode: 'edit' | 'view' = 'edit', operationPermissions: readonly Permission[] = []) {
  if (internalSessionMode() !== 'registry' || !session.sessionId) denyWriteAccess();
  await lockInternalUser(tx, session.userId);
  const actor = await lockAuthoritativeInternalSession(tx, { userId: session.userId, sessionId: session.sessionId! });
  if (!actor || actor.revokedAt || !actor.active || actor.deletedAt) denyWriteAccess();
  const current = { ...session, role: actor.role, active: actor.active, permissionOverrides: [...actor.permissionOverrides] };
  const permissions: readonly Permission[] = [...(mode === 'edit' ? ['technical.read', 'technical.write'] as const : ['technical.read'] as const), ...operationPermissions];
  if (permissions.some(permission => !hasPermission(current, permission)
    || current.permissionOverrides.some(item => item.permission === permission && !item.allowed))) denyWriteAccess();
  const identity = await tx.technicalPractice.findUnique({ where: { id: practiceId }, select: { clientId: true } });
  if (!identity) denyWriteAccess();
  await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id"=${identity.clientId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "TechnicalPractice" WHERE "id"=${practiceId} FOR UPDATE`;
  const practice = mode === 'edit' ? await requireTechnicalPracticeEditAccess(current, practiceId, tx)
    : (await requireTechnicalPracticeViewAccess(current, practiceId, tx)).practice;
  if (practice.clientId !== identity.clientId) denyWriteAccess();
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!clock || !Number.isFinite(session.expiresAt) || session.expiresAt * 1000 <= clock.now.getTime()
    || actor.expiresAt <= clock.now) denyWriteAccess();
  return practice;
}
