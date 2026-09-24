import { Prisma, type PrismaClient } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { authorizeManualAssignment, type AssignmentActor } from './manual-assignment-guard';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { internalSessionMode } from './session';
import { responsibilityAcceptance, responsibilityDecision, sameResponsibility, type ResponsibilityKind, type ResponsibilityState } from './responsibility-contract';

type Db = Prisma.TransactionClient | PrismaClient;
const deny = (message = 'Assegnazione non disponibile o cambiata. Riapri la scheda.') => { throw new UserFacingActionError(message); };
export const commercialRoles = ['admin', 'direzione', 'commerciale'] as const;
export const technicalRoles = ['admin', 'direzione', 'consulente', 'backoffice'] as const;

export async function responsibilityContext(db: Db, kind: ResponsibilityKind, id: string) {
  if (kind === 'Lead') {
    const row = await db.lead.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    return { state: { clientId: row.clientId, projectId: null, clientServiceId: null, commercialOwnerId: row.assignedToId, technicalOwnerId: null }, updatedAt: row.updatedAt,
      workable: !['archiviato', 'cliente_acquisito', 'vinto', 'perso', 'non_qualificato'].includes(row.status) };
  }
  const row = await db.technicalPractice.findFirst({ where: { id, deletedAt: null } });
  if (!row) return null;
  const client = await db.client.findFirst({ where: { id: row.clientId, deletedAt: null }, select: { id: true } });
  const project = row.projectId ? await db.project.findFirst({ where: { id: row.projectId, clientId: row.clientId, deletedAt: null } }) : null;
  const service = row.clientServiceId ? await db.clientService.findFirst({ where: { id: row.clientServiceId, clientId: row.clientId, deletedAt: null } }) : null;
  if (!client || (row.projectId && !project) || (row.clientServiceId && !service)) return null;
  if (service?.projectId) {
    if (project && project.id !== service.projectId) return null;
    if (!await db.project.findFirst({ where: { id: service.projectId, clientId: row.clientId, deletedAt: null }, select: { id: true } })) return null;
  }
  return { state: { clientId: row.clientId, projectId: row.projectId, clientServiceId: row.clientServiceId,
    commercialOwnerId: row.commercialOwnerId, technicalOwnerId: row.technicalOwnerId }, updatedAt: row.updatedAt,
    workable: !['archiviata', 'approvata', 'respinta'].includes(row.status) };
}
async function lockContext(tx: Prisma.TransactionClient, kind: ResponsibilityKind, id: string) {
  if (kind === 'Lead') await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "TechnicalPractice" WHERE "id"=${id} FOR UPDATE`;
  return responsibilityContext(tx, kind, id);
}
export async function latestResponsibility(db: Db, kind: ResponsibilityKind, id: string) {
  const entry = await db.auditLog.findFirst({ where: { entityType: kind, entityId: id, event: 'responsibility_assigned' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!entry) return null;
  const parsed = responsibilityDecision.safeParse(entry.after);
  if (!parsed.success || !entry.actorId) return deny('Storico delle responsabilità da verificare con l’amministratore.');
  return { ...entry, decision: parsed.data };
}

// Called inside the same transaction as a canonical assignment/context change, after its row is locked.
// A new decision also invalidates old acceptance when the owner changes A -> B -> A.
export async function appendResponsibilityDecision(tx: Prisma.TransactionClient, input: {
  kind: ResponsibilityKind; id: string; actorId: string; state: ResponsibilityState;
  departmentCode?: string | null; allowed: boolean; reason: string;
}) {
  const previous = await latestResponsibility(tx, input.kind, input.id);
  if (input.kind === 'TechnicalPractice') {
    const handoff = await tx.auditLog.findFirst({ where: { entityType: 'TechnicalPractice', entityId: input.id, event: 'purchased_service_handoff' } });
    if (handoff) {
      const binding = handoff.after as Record<string, unknown> | null;
      if (!binding || binding.type !== 'R05_PURCHASED_SERVICE_HANDOFF_V1' || binding.clientId !== input.state.clientId
        || binding.projectId !== input.state.projectId || binding.clientServiceId !== input.state.clientServiceId || !previous) return deny('Il passaggio acquistato è vincolato al suo cliente e servizio.');
      await tx.$queryRaw`SELECT "id" FROM "ClientService" WHERE "id"=${input.state.clientServiceId} FOR UPDATE`;
      const service = await tx.clientService.findFirst({ where: { id: input.state.clientServiceId!, clientId: input.state.clientId!, deletedAt: null } });
      if (!service || service.projectId !== input.state.projectId || service.assignedToId !== previous.decision.state.technicalOwnerId) return deny('Responsabilità di servizio e pratica non allineate: verifica amministrativa richiesta.');
      if (service.assignedToId !== input.state.technicalOwnerId) {
        if (!input.allowed) return deny();
        await tx.clientService.update({ where: { id: service.id }, data: { assignedToId: input.state.technicalOwnerId } });
      }
    }
  }
  const departmentCode = input.departmentCode === undefined ? previous?.decision.departmentCode ?? null : input.departmentCode;
  const after = responsibilityDecision.parse({ type: 'R05_RESPONSIBILITY_V1', version: (previous?.decision.version ?? 0) + 1,
    state: input.state, departmentCode, allowed: input.allowed, reason: input.reason });
  const entry = await tx.auditLog.create({ data: { actorId: input.actorId, entityType: input.kind, entityId: input.id,
    event: 'responsibility_assigned', createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
    before: previous?.decision ?? Prisma.JsonNull, after } });
  responsibilityDecision.parse(entry.after); // Verify the database's shared sanitizer preserved the metadata contract.
  return entry;
}

export async function requireUnboundServiceAssignment(tx: Prisma.TransactionClient, serviceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "ClientService" WHERE "id"=${serviceId} FOR UPDATE`;
  if (await tx.auditLog.findFirst({ where: { event: 'purchased_service_handoff', entityType: 'TechnicalPractice',
    after: { path: ['clientServiceId'], equals: serviceId } }, select: { id: true } })) {
    return deny('Questo servizio segue il referente tecnico della pratica: usa Responsabilità e presa in carico.');
  }
}

export async function savePracticeResponsibility(tx: Prisma.TransactionClient, actor: AssignmentActor, input: {
  id: string; expectedEntryId: string; expectedUpdatedAt: string; commercialOwnerId: string | null;
  technicalOwnerId: string | null; departmentCode: string | null; reason: string;
}, admitted: boolean) {
  if (!admitted) return deny('Conferma amministrativa richiesta.');
  await authorizeManualAssignment(tx, actor, [{ userId: input.commercialOwnerId, roles: commercialRoles }, { userId: input.technicalOwnerId, roles: technicalRoles }]);
  const context = await lockContext(tx, 'TechnicalPractice', input.id);
  const current = await latestResponsibility(tx, 'TechnicalPractice', input.id);
  if (!context?.workable || context.updatedAt.toISOString() !== input.expectedUpdatedAt || (current?.id ?? '') !== input.expectedEntryId) return deny();
  if (input.technicalOwnerId && !input.departmentCode) return deny('Indica il reparto del referente tecnico.');
  const state = { ...context.state, commercialOwnerId: input.commercialOwnerId, technicalOwnerId: input.technicalOwnerId };
  await tx.technicalPractice.update({ where: { id: input.id }, data: { commercialOwnerId: input.commercialOwnerId, technicalOwnerId: input.technicalOwnerId } });
  return appendResponsibilityDecision(tx, { kind: 'TechnicalPractice', id: input.id, actorId: actor.userId,
    state, departmentCode: input.departmentCode, allowed: true, reason: input.reason });
}
export async function confirmLeadResponsibility(tx: Prisma.TransactionClient, actor: AssignmentActor, input: {
  id: string; expectedEntryId: string; expectedUpdatedAt: string; reason: string;
}, admitted: boolean) {
  if (!admitted) return deny('Conferma amministrativa richiesta.');
  await authorizeManualAssignment(tx, actor, []);
  const context = await lockContext(tx, 'Lead', input.id), current = await latestResponsibility(tx, 'Lead', input.id);
  if (!context?.workable || context.updatedAt.toISOString() !== input.expectedUpdatedAt || (current?.id ?? '') !== input.expectedEntryId) return deny();
  await authorizeManualAssignment(tx, actor, [{ userId: context.state.commercialOwnerId, roles: commercialRoles }]);
  return appendResponsibilityDecision(tx, { kind: 'Lead', id: input.id, actorId: actor.userId, state: context.state,
    allowed: true, reason: input.reason });
}

export async function acceptResponsibility(tx: Prisma.TransactionClient, actor: AssignmentActor, input: {
  kind: ResponsibilityKind; id: string; decisionId: string; role: 'commerciale' | 'tecnico';
}) {
  if (internalSessionMode() !== 'registry' || !actor.sessionId) return deny();
  const session = await lockAuthoritativeInternalSession(tx, { userId: actor.userId, sessionId: actor.sessionId });
  if (!session || !session.active || session.deletedAt || session.revokedAt || !session.live) return deny();
  if (!hasPermission(session, 'assignment.accept') || !hasPermission(session, input.kind === 'Lead' ? 'lead.read' : 'technical.read')) return deny();
  const context = await lockContext(tx, input.kind, input.id), current = await latestResponsibility(tx, input.kind, input.id);
  if (!context?.workable || !current || current.id !== input.decisionId || !current.decision.allowed || !sameResponsibility(context.state, current.decision.state)) return deny();
  const ownerId = input.role === 'commerciale' ? context.state.commercialOwnerId : context.state.technicalOwnerId;
  const roles: readonly string[] = input.role === 'commerciale' ? commercialRoles : technicalRoles;
  if (ownerId !== session.userId || !roles.includes(session.role) || (input.role === 'tecnico' && !current.decision.departmentCode)) return deny('Solo il referente individuale corrente può confermare la propria presa in carico.');
  const existing = await tx.auditLog.findFirst({ where: { entityType: input.kind, entityId: input.id, event: 'responsibility_accepted',
    AND: [{ after: { path: ['decisionId'], equals: current.id } }, { after: { path: ['role'], equals: input.role } }] } });
  if (existing) {
    const parsed = responsibilityAcceptance.safeParse(existing.after);
    if (!parsed.success || parsed.data.userId !== session.userId || existing.actorId !== session.userId) return deny();
    return existing;
  }
  return tx.auditLog.create({ data: { actorId: session.userId, entityType: input.kind, entityId: input.id, event: 'responsibility_accepted',
    after: responsibilityAcceptance.parse({ type: 'R05_RESPONSIBILITY_ACCEPTANCE_V1', decisionId: current.id, role: input.role, userId: session.userId }) } });
}

export async function readResponsibility(db: Db, kind: ResponsibilityKind, id: string, beforeId?: string) {
  const historyWhere = { entityType: kind, entityId: id, event: { in: ['responsibility_assigned', 'responsibility_accepted'] } };
  const cursor = beforeId ? await db.auditLog.findFirst({ where: { ...historyWhere, id: beforeId } }) : null;
  if (beforeId && !cursor) return deny('Pagina dello storico non disponibile.');
  const [context, current, history] = await Promise.all([responsibilityContext(db, kind, id), latestResponsibility(db, kind, id),
    db.auditLog.findMany({ where: { ...historyWhere, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 })]);
  const valid = Boolean(context?.workable && current && current.decision.allowed && sameResponsibility(context.state, current.decision.state));
  const accepted = current ? await db.auditLog.findMany({ where: { entityType: kind, entityId: id, event: 'responsibility_accepted',
    after: { path: ['decisionId'], equals: current.id } }, orderBy: { createdAt: 'asc' } }) : [];
  return { context, current, valid, history: history.slice(0, 50), next: history.length > 50 ? history[49].id : null, accepted: accepted.flatMap(row => {
    const p = responsibilityAcceptance.safeParse(row.after);
    return valid && p.success && row.actorId === p.data.userId ? [{ ...row, acceptance: p.data }] : [];
  }) };
}
