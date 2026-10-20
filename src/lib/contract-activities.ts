import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClient, canViewProject } from './access-control';
import { canonicalSha256 } from './canonical-json';
import { updateActor } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { guardProjectResources } from './project-resource-guard';
import { withSerializableTransaction } from './serializable';
import { contractActivitiesCommand, ContractActivitiesError,
  type ContractActivitiesCommand, type ContractActivitiesPreview } from './contract-activities-contract';

type Tx = Prisma.TransactionClient;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const EVENT = 'contract_activities_completed_v1';
const receiptSchema = z.object({ type: z.literal('CONTRACT_ACTIVITIES_V1'), action: z.literal('COMPLETE_MISSING'),
  clientId: z.string().min(1), sourceHash: hash, sessionHash: hash, beforeHash: hash, afterHash: hash,
}).strict();
const fingerprint = (value: unknown) => canonicalSha256(JSON.parse(JSON.stringify(value)));
function fail(code: ContractActivitiesError['code']): never { throw new ContractActivitiesError(code); }

async function context(tx: Tx, claimed: AuthSession, clientId: string, contractId: string, write = false) {
  const auth = await updateActor(tx, claimed);
  if (auth.actor.role !== 'admin' || !(['client.read', 'contract.read', 'contract.write'] as const)
    .every(permission => recordUpdatePermission(auth.actor, permission))) fail('DENIED');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Client" WHERE id=${clientId} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const client = await tx.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt || ['archiviato', 'sospeso'].includes(client.status) || !canViewClient(auth.actor, client)) fail('DENIED');
  // The receipt reader takes the same row lock as the writer. A concurrent
  // SERIALIZABLE snapshot must reconcile or fail, never report false absence.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Contract" WHERE id=${contractId} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const contract = await tx.contract.findUnique({ where: { id: contractId } });
  if (!contract || contract.clientId !== client.id) fail('DENIED');
  const project = contract.projectId ? await tx.project.findUnique({ where: { id: contract.projectId } }) : null;
  if (contract.projectId && (!project || project.clientId !== client.id || project.deletedAt || project.status === 'archiviato'
    || !canViewProject(auth.actor, { ...project, client }))) fail('DENIED');
  await guardProjectResources(tx, auth.actor.id, [{ clientId, contractId, projectId: contract.projectId }]);
  await auth.finish();
  return { ...auth, client, contract, project };
}
type Context = Awaited<ReturnType<typeof context>>;
async function openForCompletion(tx: Tx, c: Context) {
  return !c.contract.serviceDescription?.trim()
    && ['da_preparare', 'preparato', 'inviato_manualmente', 'firmato'].includes(c.contract.status)
    && await tx.clientService.count({ where: { contractId: c.contract.id } }) === 0
    && await tx.practiceFormalization.count({ where: { contractId: c.contract.id } }) === 0;
}
async function proposal(tx: Tx, c: Context, input: ContractActivitiesCommand) {
  if (!await openForCompletion(tx, c)) fail('CLOSED');
  const digest = fingerprint({ input, actorId: c.actor.id, sessionId: c.registry.id,
    client: c.client, contract: c.contract, project: c.project });
  const preview: ContractActivitiesPreview = { digest, client: c.client.displayName,
    contract: c.contract.contractNumber, service: c.contract.serviceName,
    activities: input.activities, project: c.project?.title ?? null };
  await c.finish();
  return preview;
}
async function receipt(tx: Tx, c: Context, commandId: string, input?: ContractActivitiesCommand) {
  const row = await tx.auditLog.findUnique({ where: { id: 'contract_activities_' + commandId } });
  if (!row) return null;
  const parsed = receiptSchema.safeParse(row.after);
  if (!parsed.success || row.event !== EVENT || row.entityType !== 'Contract' || row.entityId !== c.contract.id
    || row.actorId !== c.actor.id || parsed.data.clientId !== c.client.id
    || (input && (parsed.data.sourceHash !== fingerprint(input) || parsed.data.sessionHash !== fingerprint(c.registry.id)))) fail('DENIED');
  await c.finish();
  return { clientId: c.client.id, contractId: c.contract.id };
}
export async function previewContractActivities(db: PrismaClient, actor: AuthSession, raw: unknown) {
  const input = contractActivitiesCommand.parse(raw);
  return withSerializableTransaction(db, async tx => proposal(tx, await context(tx, actor, input.clientId, input.contractId), input));
}
export async function confirmContractActivities(db: PrismaClient, actor: AuthSession, raw: unknown, digest: string) {
  const input = contractActivitiesCommand.parse(raw); hash.parse(digest);
  return withSerializableTransaction(db, async tx => {
    const c = await context(tx, actor, input.clientId, input.contractId, true);
    const prior = await receipt(tx, c, input.commandId, input);
    if (prior) return prior;
    if ((await proposal(tx, c, input)).digest !== digest) fail('STALE');
    const updated = await tx.contract.update({ where: { id: c.contract.id }, data: { serviceDescription: input.activities } });
    const after = receiptSchema.parse({ type: 'CONTRACT_ACTIVITIES_V1', action: 'COMPLETE_MISSING', clientId: c.client.id,
      sourceHash: fingerprint(input), sessionHash: fingerprint(c.registry.id), beforeHash: fingerprint(c.contract), afterHash: fingerprint(updated) });
    const recorded = await tx.auditLog.create({ data: { id: 'contract_activities_' + input.commandId,
      actorId: c.actor.id, entityType: 'Contract', entityId: c.contract.id, event: EVENT, after } });
    // Check the effective N04-minimized receipt, not merely the input object.
    if (fingerprint(receiptSchema.parse(recorded.after)) !== fingerprint(after)) fail('INVALID');
    await c.finish();
    return { clientId: c.client.id, contractId: c.contract.id };
  });
}
export async function readContractActivitiesReceipt(db: PrismaClient, actor: AuthSession, clientId: string, contractId: string, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => receipt(tx, await context(tx, actor, clientId, contractId), commandId));
}
export async function contractActivitiesSetup(db: PrismaClient, actor: AuthSession, contractId: string) {
  return withSerializableTransaction(db, async tx => {
    const initial = await tx.contract.findUnique({ where: { id: contractId }, select: { clientId: true } });
    if (!initial) fail('DENIED');
    const c = await context(tx, actor, initial.clientId, contractId);
    const reconciliationOnly = !await openForCompletion(tx, c);
    await c.finish();
    return { clientId: c.client.id, contractId, client: c.client.displayName, contract: c.contract.contractNumber,
      service: c.contract.serviceName, reconciliationOnly };
  });
}
