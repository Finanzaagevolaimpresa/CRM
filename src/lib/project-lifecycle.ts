import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canEditProject } from './access-control';
import { hasPermission } from './permission-evaluator';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { internalSessionMode } from './session';
import { loadPersonalSelectiveProjectScope } from './selective-project-scope';
import { withSerializableTransaction } from './serializable';
import { lifecycleActionAllowed, projectLifecycleSchema, projectLifecycleState, type ProjectLifecycleState } from './project-lifecycle-policy';

export class ProjectLifecycleError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE') { super(`PROJECT_LIFECYCLE_${code}`); }
}
type Tx = Prisma.TransactionClient;
async function clock(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!rows[0]) throw new ProjectLifecycleError('DENIED');
  return rows[0].now;
}
async function actor(tx: Tx, claimed: AuthSession) {
  if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) throw new ProjectLifecycleError('DENIED');
  const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
  if (!row || row.revokedAt || !row.active || row.deletedAt) throw new ProjectLifecycleError('DENIED');
  // Only this management surface omits lifecycle exclusions. Real selective
  // perimeters, including revoked/expired ones, are never removed or bypassed.
  const current = { ...claimed, role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
    ...await loadPersonalSelectiveProjectScope(tx, claimed.userId), registryExpiresAt: row.expiresAt };
  if (!hasPermission(current, 'project.write')) throw new ProjectLifecycleError('DENIED');
  await live(tx, current);
  return current;
}
async function live(tx: Tx, current: AuthSession & { registryExpiresAt: Date }) {
  const time = await clock(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= time.getTime() || current.registryExpiresAt <= time) throw new ProjectLifecycleError('DENIED');
}
export async function listManagedProjectLifecycle(db: PrismaClient, claimed: AuthSession, state: Exclude<ProjectLifecycleState, 'active'>) {
  return withSerializableTransaction(db, async tx => {
    const current = await actor(tx, claimed);
    const projects = await tx.project.findMany({ where: state === 'trash' ? { deletedAt: { not: null } } : { deletedAt: null, status: 'archiviato' }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
    const clients = await tx.client.findMany({ where: { id: { in: projects.map(p => p.clientId) }, deletedAt: null }, select: { id: true, displayName: true, salesOwnerId: true, consultantId: true } });
    const clientMap = new Map(clients.map(c => [c.id, c]));
    const rows = projects.filter(project => canEditProject(current, { ...project, client: clientMap.get(project.clientId) }))
      .map(project => ({ id: project.id, title: project.title, clientName: clientMap.get(project.clientId)!.displayName,
        updatedAt: project.updatedAt.toISOString(), state: projectLifecycleState(project) }));
    await live(tx, current);
    return rows;
  });
}
export async function transitionProjectLifecycle(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = projectLifecycleSchema.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const current = await actor(tx, claimed);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.id} FOR UPDATE`;
    const before = await tx.project.findUnique({ where: { id: input.id } });
    const client = before ? await tx.client.findFirst({ where: { id: before.clientId, deletedAt: null } }) : null;
    if (!before || !client || !canEditProject(current, { ...before, client })) throw new ProjectLifecycleError('DENIED');
    if (before.updatedAt.toISOString() !== input.updatedAt || !lifecycleActionAllowed(projectLifecycleState(before), input.action)) throw new ProjectLifecycleError('STALE');
    const time = await clock(tx);
    const updatedAt = new Date(Math.max(time.getTime(), before.updatedAt.getTime() + 1));
    const status = input.action === 'reactivate' ? 'idea' : input.action === 'trash' ? before.status : 'archiviato';
    const after = await tx.project.update({ where: { id: before.id, updatedAt: before.updatedAt },
      data: { status, deletedAt: input.action === 'trash' ? time : null, updatedAt } });
    // status, deletedAt, projectId, action and stateVersion survive the native
    // audit minimizer. This receipt also invalidates pre-transition grants.
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'project_lifecycle_changed', entityType: 'Project', entityId: before.id,
      createdAt: time, before: { status: before.status, deletedAt: before.deletedAt?.toISOString() ?? null },
      after: { projectId: before.id, action: input.action, status: after.status, deletedAt: after.deletedAt?.toISOString() ?? null, stateVersion: after.updatedAt.toISOString() } } });
    await live(tx, current);
    return { id: after.id, state: projectLifecycleState(after), updatedAt: after.updatedAt.toISOString() };
  });
}
