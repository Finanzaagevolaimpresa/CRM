import { Prisma } from '@prisma/client';
import type { AuthSession, Permission } from './auth';
import { canViewClient, canViewLead, canViewProject, canViewTechnicalPractice } from './access-control';
import { hasPermission } from './permission-evaluator';
import { loadClientReadScope } from './client-read-perimeter';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError, type RecordUpdateKind } from './record-update-contract';
import type { UpdatePatch } from './record-update-input';

type Tx = Prisma.TransactionClient;
export function recordUpdatePermission(actor: Pick<AuthSession, 'active' | 'role' | 'permissionOverrides'>, permission: Permission) {
  // Explicit denial also suspends this Admin operation.
  return !actor.permissionOverrides.some(item => item.permission === permission && !item.allowed) && hasPermission(actor, permission);
}
export const recordReadPermissions = { LEAD: 'lead.read', CLIENT: 'client.read', PROJECT: 'project.read', PRACTICE: 'technical.read' } as const;
export const recordWritePermissions = { LEAD: 'lead.write', CLIENT: 'client.write', PROJECT: 'project.write', PRACTICE: 'technical.write' } as const;
export async function currentRecordUpdateUser(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true,
    active: true, deletedAt: true, recordUpdateEpoch: true, permissionOverrides: { select: { permission: true, allowed: true } } } });
  if (!user || !user.active || user.deletedAt) return null;
  return { ...user, userId: user.id, clientReadScope: await loadClientReadScope(tx, id), ...await loadSelectiveProjectScope(tx, id) };
}
type RecordUser = NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>;
export type RecordUpdateContext = {
  kind: RecordUpdateKind; id: string; label: string; href: string; clientId: string | null;
  version: Date; scope: Prisma.JsonValue; scopeDigest: string; patch: UpdatePatch;
  canRead: (actor: RecordUser) => boolean;
};
async function rowLock(tx: Tx, table: 'Lead' | 'Client' | 'Project' | 'ClientService' | 'TechnicalPractice', id: string, write: boolean) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"' + table + '"')} WHERE id=${id} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
}
const day = (value: Date | null) => value?.toISOString() ?? '';
export async function recordUpdateContext(tx: Tx, kind: RecordUpdateKind, id: string, write = false): Promise<RecordUpdateContext> {
  function denied(): never { throw new RecordUpdateError('DENIED'); }
  let context: Omit<RecordUpdateContext, 'scope' | 'scopeDigest'>;
  if (kind === 'LEAD') {
    await rowLock(tx, 'Lead', id, write);
    const lead = await tx.lead.findUnique({ where: { id } });
    if (!lead || lead.deletedAt || lead.status === 'archiviato') denied();
    context = { kind, id, label: lead.companyName || `${lead.firstName} ${lead.lastName}`, href: `/leads/${id}`,
      version: lead.updatedAt, clientId: lead.clientId,
      patch: { kind, nextActionDate: day(lead.nextActionDate), nextActionNote: lead.nextActionNote ?? '' },
      canRead: user => recordUpdatePermission(user, 'lead.read') && canViewLead(user, lead) };
  } else if (kind === 'CLIENT') {
    await rowLock(tx, 'Client', id, write);
    const client = await tx.client.findUnique({ where: { id } });
    if (!client || client.deletedAt || ['archiviato', 'sospeso'].includes(client.status)) denied();
    context = { kind, id, label: client.displayName, href: `/clients/${id}`, version: client.updatedAt, clientId: id,
      patch: { kind, displayName: client.displayName, type: client.type },
      canRead: user => recordUpdatePermission(user, 'client.read') && canViewClient(user, client) };
  } else {
    const first = kind === 'PROJECT' ? await tx.project.findUnique({ where: { id } }) : await tx.technicalPractice.findUnique({ where: { id } });
    if (!first) denied();
    await rowLock(tx, 'Client', first.clientId, false);
    const client = await tx.client.findUnique({ where: { id: first.clientId } });
    if (!client || client.deletedAt || ['archiviato', 'sospeso'].includes(client.status)) denied();
    if (kind === 'PROJECT') {
      await rowLock(tx, 'Project', id, write);
      const project = await tx.project.findUnique({ where: { id } });
      if (!project || project.clientId !== client.id || project.deletedAt || project.status === 'archiviato') denied();
      context = { kind, id, label: project.title, href: `/projects/${id}`, version: project.updatedAt, clientId: client.id,
        patch: { kind, title: project.title, status: project.status as Extract<UpdatePatch, { kind: 'PROJECT' }>['status'] },
        canRead: user => recordUpdatePermission(user, 'project.read') && canViewProject(user, { ...project, client }) };
    } else {
      await rowLock(tx, 'TechnicalPractice', id, write);
      const practice = await tx.technicalPractice.findUnique({ where: { id } });
      if (!practice || practice.clientId !== client.id || practice.deletedAt || practice.status === 'archiviata') denied();
      if (practice.clientServiceId) await rowLock(tx, 'ClientService', practice.clientServiceId, false);
      const service = practice.clientServiceId ? await tx.clientService.findUnique({ where: { id: practice.clientServiceId } }) : null;
      if (practice.clientServiceId && (!service || service.deletedAt || service.clientId !== client.id)) denied();
      const projectIds = [...new Set([practice.projectId, service?.projectId].filter((x): x is string => Boolean(x)))].sort();
      for (const projectId of projectIds) await rowLock(tx, 'Project', projectId, false);
      const projects = await tx.project.findMany({ where: { id: { in: projectIds } } });
      if (projects.length !== projectIds.length || projects.some(p => p.clientId !== client.id || p.deletedAt || p.status === 'archiviato')) denied();
      if (practice.projectId && service?.projectId && practice.projectId !== service.projectId) denied();
      const project = projects.find(p => p.id === practice.projectId);
      const serviceProject = projects.find(p => p.id === service?.projectId);
      context = { kind, id, label: practice.title, href: `/technical-office/practices/${id}`, version: practice.updatedAt, clientId: client.id,
        patch: { kind, status: practice.status as Extract<UpdatePatch, { kind: 'PRACTICE' }>['status'],
          clientVisibleStatus: practice.clientVisibleStatus ?? '', dueDate: day(practice.dueDate), nextClientUpdateAt: day(practice.nextClientUpdateAt) },
        canRead: user => recordUpdatePermission(user, 'technical.read') && canViewTechnicalPractice(user, { ...practice, client,
          project: project ? { ...project, client } : null,
          clientService: service ? { ...service, client, project: serviceProject ? { ...serviceProject, client } : null } : null }) };
    }
  }
  const [row] = await tx.$queryRaw<Array<{ scope: Prisma.JsonValue | null }>>`SELECT fai_record_update_scope(${kind},${id}) AS scope`;
  if (!row?.scope) denied();
  return { ...context, scope: row.scope, scopeDigest: canonicalSha256(row.scope) };
}
