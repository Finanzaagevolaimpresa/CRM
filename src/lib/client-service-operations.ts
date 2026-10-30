import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { clientServicePipelineSchema, serviceStatusSchema, documentServiceLinkSchema } from './validation';
import { denyWriteAccess, requireServiceEditAccess, requireServiceAssignAccess, requireDocumentEditAccess } from './write-access';
import { withProjectResources } from './project-resource-guard';
import { assertLeadActorLive, lockLeadWriteActor } from './lead-lifecycle-lock';
import { assertClientOperational } from './client-operational-hold';
import { authorizeManualAssignment, denyManualAssignment } from './manual-assignment-guard';
import { requireUnboundServiceAssignment } from './responsibility';
import { financialReadAccess } from './financial-access';
import { redactAuditPayload } from './data-classification';
import { UserFacingActionError } from './action-errors';

type Service = Awaited<ReturnType<typeof requireServiceEditAccess>>;
type Actor = Awaited<ReturnType<typeof lockLeadWriteActor>>;
type Tx = Prisma.TransactionClient;

// The initial admission is bound to its exact parent context. Current authority
// is reloaded under the same locks as the write, including services with no project.
async function withServiceMutation<T>(db: PrismaClient, claimed: AuthSession, id: string,
  permission: 'service.write' | 'service.assign', work: (tx: Tx, current: Actor, before: Service) => Promise<T>) {
  const admit = permission === 'service.assign' ? requireServiceAssignAccess : requireServiceEditAccess;
  const admitted = await admit(claimed, id, db);
  return withProjectResources(db, claimed.userId, [{ clientServiceId: id, clientId: admitted.clientId,
    companyId: admitted.companyId, projectId: admitted.projectId }], async tx => {
    const current = await lockLeadWriteActor(tx, claimed, [permission]);
    await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${admitted.clientId} FOR SHARE`;
    const before = await admit(current, id, tx);
    if (before.clientId !== admitted.clientId || before.companyId !== admitted.companyId
      || before.projectId !== admitted.projectId) denyWriteAccess();
    const result = await work(tx, current, before);
    await assertLeadActorLive(tx, current);
    return result;
  });
}

function requireClose(actor: Actor) {
  if (!hasPermission(actor, 'service.close')
    || actor.permissionOverrides.some(item => item.permission === 'service.close' && !item.allowed)) denyWriteAccess();
}
async function requireOrdinaryService(tx: Tx, id: string) {
  if (await tx.practiceReadiness.findUnique({ where: { clientServiceId: id }, select: { id: true } }))
    throw new UserFacingActionError('Questa pratica è gestita dal percorso preventivo-avvio: usa il comando esplicito nella pratica.');
}
async function audit(tx: Tx, current: Actor, events: string[], before: Service, after: unknown) {
  await tx.auditLog.createMany({ data: events.map(event => ({ actorId: current.userId, event,
    entityType: 'ClientService', entityId: before.id, after: redactAuditPayload({ before, after }) as Prisma.InputJsonValue })) });
}

export async function updateClientServiceStatusRecord(db: PrismaClient, claimed: AuthSession, id: string, raw: unknown) {
  const next = serviceStatusSchema.parse(raw);
  return withServiceMutation(db, claimed, id, 'service.write', async (tx, current, before) => {
    if (next === 'pagato' && !financialReadAccess(current).payment) denyWriteAccess();
    const final = ['chiuso', 'archiviato', 'consegnato'];
    if (before.status !== next && (final.includes(before.status) || final.includes(next))) requireClose(current);
    if (!['richiesto', 'sospeso', 'chiuso', 'archiviato'].includes(next)) await assertClientOperational(tx, before.clientId);
    await requireOrdinaryService(tx, id);
    const service = await tx.clientService.update({ where: { id }, data: { status: next,
      completedAt: final.includes(next) ? new Date() : undefined } });
    await audit(tx, current, ['client_service_status_change'], before, service);
    return service;
  });
}

export async function updateClientServicePipelineRecord(db: PrismaClient, claimed: AuthSession, raw: unknown, assignmentSubmitted: boolean) {
  const data = clientServicePipelineSchema.parse(raw);
  return withServiceMutation(db, claimed, data.id, 'service.write', async (tx, current, before) => {
    const nextAssignedToId = assignmentSubmitted ? data.assignedToId ?? null : before.assignedToId;
    const assigneeChanged = before.assignedToId !== nextAssignedToId;
    const final = ['chiusa', 'archiviata'];
    if (before.operationalStatus !== data.operationalStatus
      && (final.includes(before.operationalStatus) || final.includes(data.operationalStatus))) requireClose(current);
    if (assigneeChanged && current.role !== 'admin') denyManualAssignment();
    if (assigneeChanged) {
      await authorizeManualAssignment(tx, current, [{ userId: nextAssignedToId }]);
      await requireUnboundServiceAssignment(tx, data.id);
    }
    if (!['nuova', 'chiusa', 'archiviata'].includes(data.operationalStatus)) await assertClientOperational(tx, before.clientId);
    await requireOrdinaryService(tx, data.id);
    const service = await tx.clientService.update({ where: { id: data.id }, data: {
      operationalStatus: data.operationalStatus,
      statusUpdatedAt: before.operationalStatus === data.operationalStatus ? before.statusUpdatedAt : new Date(),
      practiceType: data.practiceType ?? null, requestedAmount: data.requestedAmount ?? null,
      plannedInvestment: data.plannedInvestment ?? null, assignedToId: assigneeChanged ? nextAssignedToId : undefined,
      operationalNotes: data.operationalNotes ?? null,
    } });
    const events = ['client_service_pipeline_update'];
    if (before.operationalStatus !== service.operationalStatus) events.push('client_service_operational_status_change');
    if (String(before.requestedAmount ?? '') !== String(service.requestedAmount ?? '')
      || String(before.plannedInvestment ?? '') !== String(service.plannedInvestment ?? '')) events.push('client_service_amounts_change');
    if (assigneeChanged) events.push('client_service_assign');
    await audit(tx, current, events, before, service);
    return service;
  });
}

export async function assignClientServiceRecord(db: PrismaClient, claimed: AuthSession, id: string, assignedToId: string) {
  return withServiceMutation(db, claimed, id, 'service.assign', async (tx, current, before) => {
    await authorizeManualAssignment(tx, current, [{ userId: assignedToId || null }]);
    await requireUnboundServiceAssignment(tx, id);
    const service = await tx.clientService.update({ where: { id }, data: { assignedToId: assignedToId || null } });
    await audit(tx, current, ['client_service_assign'], before, service);
    return service;
  });
}


/** Bind both endpoints: a still-visible document cannot be linked to a service
 * that moved to a different client between the page admission and the write. */
export async function linkDocumentToServiceRecord(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const data = documentServiceLinkSchema.parse(raw);
  const admitted = await requireDocumentEditAccess(claimed, data.documentId, db);
  const serviceIds = [...new Set([admitted.clientServiceId, data.clientServiceId].filter((id): id is string => !!id))].sort();
  const services = await Promise.all(serviceIds.map(id => requireServiceEditAccess(claimed, id, db)));
  return withProjectResources(db, claimed.userId, [{ ...admitted, documentId: admitted.id },
    ...services.map(s => ({ clientServiceId: s.id, clientId: s.clientId, projectId: s.projectId, companyId: s.companyId }))], async tx => {
    const current = await lockLeadWriteActor(tx, claimed, ['service.write']);
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${admitted.id} FOR UPDATE`;
    if (admitted.clientId) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${admitted.clientId} FOR SHARE`;
    const before = await requireDocumentEditAccess(current, admitted.id, tx);
    if (before.clientId !== admitted.clientId || before.projectId !== admitted.projectId
      || before.companyId !== admitted.companyId || before.clientServiceId !== admitted.clientServiceId) denyWriteAccess();
    for (const prior of services) {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${prior.clientId} FOR SHARE`;
      const service = await requireServiceEditAccess(current, prior.id, tx);
      if (service.clientId !== prior.clientId || service.companyId !== prior.companyId || service.projectId !== prior.projectId) denyWriteAccess();
      if (service.id === data.clientServiceId && (!before.clientId || service.clientId !== before.clientId
        || service.projectId && before.projectId && service.projectId !== before.projectId
        || service.companyId && before.companyId && service.companyId !== before.companyId)) denyWriteAccess();
    }
    const document = await tx.document.update({ where: { id: data.documentId }, data: {
      clientServiceId: data.clientServiceId ?? null, serviceArea: data.serviceArea, documentCategory: data.documentCategory } });
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'document_service_link',
      entityType: 'Document', entityId: document.id, after: redactAuditPayload({ before, after: document }) as Prisma.InputJsonValue } });
    await assertLeadActorLive(tx, current);
    return document;
  });
}
