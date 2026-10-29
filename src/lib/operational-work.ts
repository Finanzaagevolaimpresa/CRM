import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewProject, canViewTechnicalPractice } from './access-control';
import { hasPermission } from './permission-evaluator';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';
import { technicalWorkCatalogueInTransaction } from './technical-assignment-access';
import { technicalWorkPath, type TechnicalTargetReference } from './technical-assignment-display';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient } from './technical-assignment-transaction';
import { selectOperationalWork, type OperationalWorkQuery, type OperationalWorkRow } from './operational-work-projection';

type Tx = Prisma.TransactionClient;
type Kind = TechnicalTargetReference['kind'];
const selectClient = { id: true, displayName: true, salesOwnerId: true, consultantId: true, deletedAt: true } as const;
const selectPerson = { id: true, name: true } as const;
const permission = (kind: Kind) => kind === 'Project' ? 'project.read' : 'technical.read';
export const isOperationalTechnician = (role: string) => role === 'consulente' || role === 'backoffice';
function unavailable(): never { throw new Error('OPERATIONAL_WORK_UNAVAILABLE'); }

async function ordinaryRows(tx: Tx, current: AuthSession, kind: Kind): Promise<OperationalWorkRow[]> {
  if (!isOperationalTechnician(current.role) || !hasPermission(current, permission(kind))) unavailable();
  // Always restore the complete ordinary ceiling. In particular, an expired,
  // revoked or invalid technical assignment never reopens legacy ownership.
  const actor = { ...current, ...await loadSelectiveProjectScope(tx, current.userId) };
  if (kind === 'Project') {
    const ownedClients = await tx.client.findMany({ where: { deletedAt: null,
      OR: [{ consultantId: actor.userId }, { salesOwnerId: actor.userId }] }, select: { id: true } });
    const rows = await tx.project.findMany({ where: { deletedAt: null, status: { not: 'archiviato' },
      OR: [{ consultantId: actor.userId }, { consultantId: null, clientId: { in: ownedClients.map(row => row.id) } }] },
      orderBy: { id: 'asc' }, take: 6001 });
    if (rows.length > 6000) unavailable();
    const clients = new Map((await tx.client.findMany({ where: { id: { in: rows.map(row => row.clientId) }, deletedAt: null },
      select: selectClient })).map(row => [row.id, row]));
    const people = new Map((await tx.user.findMany({ where: { id: { in: rows.flatMap(row => row.consultantId ? [row.consultantId] : []) } },
      select: selectPerson })).map(row => [row.id, row]));
    return rows.flatMap(row => {
      const client = clients.get(row.clientId);
      if (!client || !canViewProject(actor, { ...row, client })) return [];
      return [{
      id: row.id, kind, admission: 'ORDINARY', href: '/projects/' + row.id, title: row.title, status: row.status,
      priority: row.priority, dueDate: null, client: { id: client.id, name: client.displayName },
      technicalOwner: row.consultantId ? people.get(row.consultantId) ?? null : null,
      commercialOwner: null, responsibility: null, expiresAt: null,
    } satisfies OperationalWorkRow]; });
  }
  const rows = await tx.technicalPractice.findMany({ where: { deletedAt: null, status: { not: 'archiviata' },
    OR: [{ technicalOwnerId: actor.userId }, { commercialOwnerId: actor.userId },
      { technicalOwnerId: null, commercialOwnerId: null }] },
    orderBy: { id: 'asc' }, take: 6001 });
  if (rows.length > 6000) unavailable();
  const services = await tx.clientService.findMany({ where: { id: { in: rows.flatMap(row => row.clientServiceId ? [row.clientServiceId] : []) }, deletedAt: null } });
  const projects = await tx.project.findMany({ where: { id: { in: [...rows, ...services].flatMap(row => row.projectId ? [row.projectId] : []) },
    deletedAt: null, status: { not: 'archiviato' } } });
  const clients = new Map((await tx.client.findMany({ where: { id: { in: [...rows, ...services, ...projects].map(row => row.clientId) },
    deletedAt: null }, select: selectClient })).map(row => [row.id, row]));
  const projectById = new Map(projects.map(row => [row.id, { ...row, client: clients.get(row.clientId) ?? null }]));
  const serviceById = new Map(services.map(row => [row.id, { ...row, client: clients.get(row.clientId) ?? null,
    project: row.projectId ? projectById.get(row.projectId) ?? null : null }]));
  const people = new Map((await tx.user.findMany({ where: { id: { in: rows.flatMap(row => [row.technicalOwnerId, row.commercialOwnerId].filter((id): id is string => Boolean(id))) }, active: true },
    select: selectPerson })).map(row => [row.id, row]));
  return rows.flatMap(row => {
    const client = clients.get(row.clientId), project = row.projectId ? projectById.get(row.projectId) ?? null : null;
    const clientService = row.clientServiceId ? serviceById.get(row.clientServiceId) ?? null : null;
    if (!client || !canViewTechnicalPractice(actor, { ...row, client, project, clientService })) return [];
    return [{
      id: row.id, kind, admission: 'ORDINARY', href: '/technical-office/practices/' + row.id,
      title: row.title, status: row.status, priority: row.priority, dueDate: row.dueDate?.toISOString() ?? null,
      client: { id: client.id, name: client.displayName }, technicalOwner: row.technicalOwnerId ? people.get(row.technicalOwnerId) ?? null : null,
      commercialOwner: row.commercialOwnerId ? people.get(row.commercialOwnerId) ?? null : null,
      responsibility: null, expiresAt: null,
    } satisfies OperationalWorkRow]; });
}

/** Ordinary access remains usable if the independent personal capability is
 * disabled. This fallback never substitutes for selective admission and keeps
 * every historical exclusion, current session and permission check. */
async function ordinaryOnly(db: PrismaClient, claimed: AuthSession, kind: Kind) {
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) unavailable();
    await lockCommunicationDirectory(tx);
    const live = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!live || !live.active || live.deletedAt || live.revokedAt || !live.live) unavailable();
    const current = { ...claimed, role: live.role, active: live.active, permissionOverrides: [...live.permissionOverrides] };
    const records = await ordinaryRows(tx, current, kind);
    const now = await technicalAssignmentClock(tx);
    if (!Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= now.getTime() || live.expiresAt <= now) unavailable();
    return { records, selectiveAvailable: false, observedAt: now.toISOString() };
  });
}

export async function loadOperationalWorkCatalogue(db: PrismaClient, claimed: AuthSession, kind: Kind) {
  z.enum(['Project', 'TechnicalPractice']).parse(kind);
  try {
    return await withTechnicalAssignmentRecipient(db, claimed, kind, async (tx, state) => {
      const records = await ordinaryRows(tx, state.current, kind);
      for (const row of await technicalWorkCatalogueInTransaction(tx, state, kind)) {
        const field = (key: string) => row.fields.find(item => item.key === key)?.value ?? null;
        records.push({ id: row.target.targetId, kind, admission: 'SELECTIVE', href: technicalWorkPath(row.target),
          title: field('title'), status: field('status'), priority: field('priority'), dueDate: field('dueDate'),
          client: null,
          technicalOwner: field('technicalOwnerName') ? { id: null, name: field('technicalOwnerName')! } : null,
          commercialOwner: field('commercialOwnerName') ? { id: null, name: field('commercialOwnerName')! } : null,
          responsibility: row.responsibility, expiresAt: row.expiresAt });
      }
      return { records, selectiveAvailable: true, observedAt: (await technicalAssignmentClock(tx)).toISOString() };
    });
  } catch (error) {
    if (!(error instanceof TechnicalAssignmentError && ['DENIED', 'UNAVAILABLE'].includes(error.code))) throw error;
    return ordinaryOnly(db, claimed, kind);
  }
}
export async function readOperationalWork(db: PrismaClient, claimed: AuthSession, kind: Kind, query: OperationalWorkQuery = {}) {
  const catalogue = await loadOperationalWorkCatalogue(db, claimed, kind);
  return { ...selectOperationalWork(catalogue.records, query), selectiveAvailable: catalogue.selectiveAvailable };
}
