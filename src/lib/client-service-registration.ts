import { Prisma, type PrismaClient, type PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClient, canViewProject } from './access-control';
import { canonicalSha256 } from './canonical-json';
import { updateActor } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { guardProjectResources } from './project-resource-guard';
import { withSerializableTransaction } from './serializable';
import { getHandoffReceipt } from './purchased-service-handoff';
import { serviceRegistrationCommand, registrationServiceId, ServiceRegistrationError,
  type ServiceRegistrationCommand, type ServiceRegistrationPreview } from './client-service-registration-contract';

type Tx = Prisma.TransactionClient;
const EVENT = 'client_service_registration_v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ type: z.literal('CLIENT_SERVICE_REGISTRATION_V1'),
  operation: z.enum(['REGISTER', 'LINK_PAYMENT']), sourceHash: digest, sessionHash: digest,
  serviceId: z.string().min(1), clientId: z.string().min(1), beforeHash: digest.nullable(), afterHash: digest,
}).strict();
function fail(code: ServiceRegistrationError['code']): never { throw new ServiceRegistrationError(code); }
function plain(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
const fingerprint = (value: unknown) => canonicalSha256(plain(value));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function admission(tx: Tx, claimed: AuthSession, clientId: string, write = false) {
  const auth = await updateActor(tx, claimed);
  if (auth.actor.role !== 'admin' || !(['client.read', 'service.read', 'service.write', 'contract.read', 'payment.read'] as const)
    .every(permission => recordUpdatePermission(auth.actor, permission))) fail('DENIED');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Client" WHERE id=${clientId} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt || ['archiviato', 'sospeso'].includes(client.status) || !canViewClient(auth.actor, client)) fail('DENIED');
  return { ...auth, client };
}
async function proposal(tx: Tx, auth: Awaited<ReturnType<typeof admission>>, input: ServiceRegistrationCommand) {
  const serviceId = input.operation === 'LINK_PAYMENT' ? input.serviceId : null;
  if (serviceId) await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${serviceId} FOR UPDATE`;
  const existing = serviceId ? await tx.clientService.findUnique({ where: { id: serviceId } }) : null;
  if (serviceId && (!existing || existing.deletedAt || existing.clientId !== auth.client.id || existing.paymentId
    || existing.status !== 'richiesto' || existing.operationalStatus !== 'nuova'
    || await getHandoffReceipt(tx, serviceId) || await tx.technicalPractice.count({ where: { clientServiceId: serviceId } }))) fail('CLOSED');
  if (existing?.companyId) {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${existing.companyId} FOR SHARE`;
    const company = await tx.company.findUnique({ where: { id: existing.companyId } });
    if (!company || company.deletedAt || company.clientId !== auth.client.id) fail('DENIED');
  }
  const catalogId = input.operation === 'REGISTER' ? input.catalogId : existing!.serviceCatalogId;
  const contractId = input.operation === 'REGISTER' ? input.contractId : existing!.contractId;
  if (!contractId) fail('INVALID');
  await tx.$queryRaw`SELECT id FROM "ServiceCatalog" WHERE id=${catalogId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Contract" WHERE id=${contractId} FOR SHARE`;
  if (input.paymentId) await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${input.paymentId} FOR SHARE`;
  const catalog = await tx.serviceCatalog.findUnique({ where: { id: catalogId } });
  const contract = await tx.contract.findUnique({ where: { id: contractId } });
  const payment = input.paymentId ? await tx.payment.findUnique({ where: { id: input.paymentId } }) : null;
  if (!catalog || (input.operation === 'REGISTER' && !catalog.active) || !contract || contract.clientId !== auth.client.id
    || contract.status !== 'firmato' || !contract.signedAt || contract.signedAt > new Date() || !contract.serviceDescription?.trim()
    || (existing && existing.projectId !== contract.projectId)) fail('INVALID');
  const project = contract.projectId ? await tx.project.findUnique({ where: { id: contract.projectId } }) : null;
  if (contract.projectId && (!project || project.clientId !== auth.client.id || project.deletedAt
    || project.status === 'archiviato' || !canViewProject(auth.actor, { ...project, client: auth.client }))) fail('DENIED');
  await guardProjectResources(tx, auth.actor.id, [{ clientId: auth.client.id, projectId: contract.projectId,
    contractId, clientServiceId: serviceId, companyId: existing?.companyId }]);
  if (input.paymentId && (!payment || payment.clientId !== auth.client.id || payment.contractId !== contract.id
    || payment.status !== 'incassato' || !payment.collectedAt || payment.collectedAt > new Date()
    || !payment.totalAmount.gt(0) || payment.totalAmount.gt(contract.totalAmount))) fail('INVALID');
  const purchasedOn = input.operation === 'REGISTER' ? input.purchasedOn : existing!.purchasedAt.toISOString().slice(0, 10);
  if (purchasedOn > today()) fail('INVALID');
  if (!existing && await tx.clientService.count({ where: { clientId: auth.client.id, contractId, serviceCatalogId: catalogId } })) fail('DUPLICATE');
  const paymentStatus: PaymentStatus = payment ? (payment.totalAmount.eq(contract.totalAmount) ? 'incassato' : 'parziale') : 'da_incassare';
  const sourceHash = fingerprint({ input, sessionId: auth.registry.id, actorId: auth.actor.id,
    client: auth.client, catalog, contract, payment, project, existing });
  const preview: ServiceRegistrationPreview = { digest: sourceHash, client: auth.client.displayName, service: catalog.name,
    contract: `${contract.contractNumber} · ${contract.serviceName}`, scope: contract.serviceDescription, project: project?.title ?? null, purchasedOn,
    payment: payment ? `€ ${payment.totalAmount.toFixed(2)} · ${payment.collectedAt!.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}` : null,
    paymentStatus, operation: input.operation };
  await auth.finish();
  return { preview, existing, contract, payment, catalog, paymentStatus, purchasedOn };
}
async function receipt(tx: Tx, auth: Awaited<ReturnType<typeof admission>>, commandId: string, input?: ServiceRegistrationCommand) {
  const row = await tx.auditLog.findUnique({ where: { id: 'service_registration_' + commandId } });
  if (!row) return null;
  const parsed = receiptSchema.safeParse(row.after);
  if (!parsed.success || row.event !== EVENT || row.entityType !== 'ClientService' || row.actorId !== auth.actor.id
    || parsed.data.clientId !== auth.client.id || row.entityId !== parsed.data.serviceId
    || (input && parsed.data.sessionHash !== fingerprint(auth.registry.id))
    || (input && parsed.data.sourceHash !== fingerprint(input))) fail('DENIED');
  const service = await tx.clientService.findUnique({ where: { id: parsed.data.serviceId } });
  if (!service || service.deletedAt || service.clientId !== auth.client.id) fail('DENIED');
  await guardProjectResources(tx, auth.actor.id, [{ clientId: service.clientId, projectId: service.projectId,
    clientServiceId: service.id, companyId: service.companyId, contractId: service.contractId }]);
  await auth.finish();
  return { serviceId: service.id, clientId: service.clientId };
}
export async function previewServiceRegistration(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = serviceRegistrationCommand.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await admission(tx, claimed, input.clientId);
    return (await proposal(tx, auth, input)).preview;
  });
}
export async function confirmServiceRegistration(db: PrismaClient, claimed: AuthSession, raw: unknown, expectedDigest: string) {
  const input = serviceRegistrationCommand.parse(raw); digest.parse(expectedDigest);
  return withSerializableTransaction(db, async tx => {
    const auth = await admission(tx, claimed, input.clientId, true);
    const prior = await receipt(tx, auth, input.commandId, input);
    if (prior) return prior;
    const current = await proposal(tx, auth, input);
    if (current.preview.digest !== expectedDigest) fail('STALE');
    const service = input.operation === 'REGISTER'
      ? await tx.clientService.create({ data: { id: registrationServiceId(input.commandId), clientId: input.clientId,
        serviceCatalogId: current.catalog.id, contractId: current.contract.id, projectId: current.contract.projectId,
        paymentId: current.payment?.id ?? null, purchasedAt: new Date(current.purchasedOn + 'T12:00:00.000Z'),
        status: 'richiesto', paymentStatus: current.paymentStatus } })
      : await tx.clientService.update({ where: { id: input.serviceId }, data: { paymentId: current.payment!.id,
        paymentStatus: current.paymentStatus, recordUpdateEpoch: { increment: 1 } } });
    // A deliberately closed technical receipt: no names, amounts, descriptions,
    // contract/payment contents, recipient lists or copied full record in audit.
    const after = receiptSchema.parse({ type: 'CLIENT_SERVICE_REGISTRATION_V1', operation: input.operation,
      sourceHash: fingerprint(input), sessionHash: fingerprint(auth.registry.id), serviceId: service.id, clientId: service.clientId,
      beforeHash: current.existing ? fingerprint(current.existing) : null, afterHash: fingerprint(service) });
    await tx.auditLog.create({ data: { id: 'service_registration_' + input.commandId, actorId: auth.actor.id,
      event: EVENT, entityType: 'ClientService', entityId: service.id, after } });
    // Fence receipt reconciliation against an in-flight request: a reader whose
    // serializable snapshot predates this commit must conflict, not report an
    // absent receipt after waiting on an otherwise unchanged Client row.
    await tx.client.update({ where: { id: auth.client.id }, data: { recordUpdateEpoch: { increment: 1 } } });
    await auth.finish();
    return { serviceId: service.id, clientId: service.clientId };
  });
}
export async function readServiceRegistrationReceipt(db: PrismaClient, claimed: AuthSession, clientId: string, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => receipt(tx, await admission(tx, claimed, clientId), commandId));
}
export async function serviceRegistrationSetup(db: PrismaClient, claimed: AuthSession, clientId: string,
  options: { catalogQuery?: string; contractQuery?: string; serviceId?: string } = {}) {
  return withSerializableTransaction(db, async tx => {
    const auth = await admission(tx, claimed, clientId);
    const service = options.serviceId ? await tx.clientService.findUnique({ where: { id: options.serviceId } }) : null;
    if (options.serviceId && (!service || service.deletedAt || service.clientId !== clientId || service.paymentId || service.status !== 'richiesto'
      || service.operationalStatus !== 'nuova' || !service.contractId || await getHandoffReceipt(tx, service.id)
      || await tx.technicalPractice.count({ where: { clientServiceId: service.id } }))) fail('CLOSED');
    if (service) await guardProjectResources(tx, auth.actor.id, [{ clientId, projectId: service.projectId,
      clientServiceId: service.id, companyId: service.companyId, contractId: service.contractId }]);
    const catalogQuery = (options.catalogQuery ?? '').trim().slice(0, 80), contractQuery = (options.contractQuery ?? '').trim().slice(0, 80);
    const catalogs = await tx.serviceCatalog.findMany({ where: service ? { id: service.serviceCatalogId } : { active: true,
      ...(catalogQuery ? { OR: [{ name: { contains: catalogQuery, mode: 'insensitive' } }, { code: { contains: catalogQuery, mode: 'insensitive' } }] } : {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 101, select: { id: true, name: true, code: true } });
    const allowedProjects = await tx.project.findMany({ where: { clientId, deletedAt: null, status: { not: 'archiviato' },
      id: { notIn: [...auth.actor.selectiveProjectIds ?? []] } }, select: { id: true } });
    const contracts = await tx.contract.findMany({ where: { clientId, status: 'firmato', signedAt: { lte: new Date() },
      id: service ? { equals: service.contractId!, notIn: [...auth.actor.selectiveContractIds ?? []] } : { notIn: [...auth.actor.selectiveContractIds ?? []] },
      OR: [{ projectId: null }, { projectId: { in: allowedProjects.map(p => p.id) } }],
      ...(contractQuery ? { AND: [{ OR: [{ contractNumber: { contains: contractQuery, mode: 'insensitive' } }, { serviceName: { contains: contractQuery, mode: 'insensitive' } }] }] } : {}) },
      orderBy: [{ signedAt: 'desc' }, { id: 'asc' }], take: 101,
      select: { id: true, contractNumber: true, serviceName: true, serviceDescription: true } });
    const eligible = contracts.slice(0, 100).filter(c => c.serviceDescription?.trim());
    const payments = await tx.payment.findMany({ where: { clientId, contractId: { in: eligible.map(c => c.id) }, status: 'incassato',
      collectedAt: { lte: new Date() }, totalAmount: { gt: 0 } }, orderBy: [{ collectedAt: 'desc' }, { id: 'asc' }], take: 200,
      select: { id: true, contractId: true, totalAmount: true, collectedAt: true } });
    await auth.finish();
    return { client: { id: auth.client.id, name: auth.client.displayName }, catalogs: catalogs.slice(0, 100),
      contracts: eligible.map(c => ({ id: c.id, label: `${c.contractNumber} · ${c.serviceName}` })),
      payments: payments.map(p => ({ id: p.id, contractId: p.contractId, label: `€ ${p.totalAmount.toFixed(2)} · ${p.collectedAt!.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}` })),
      serviceId: service?.id ?? null, contractId: service?.contractId ?? null, today: today(),
      moreCatalogs: catalogs.length > 100, moreContracts: contracts.length > 100 };
  });
}
