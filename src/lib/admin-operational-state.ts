import { z } from 'zod';
import type { Prisma } from '@prisma/client';

export const adminOperationalModels = ['ControlledIntake','PracticeReadiness','ApprovedCommunication','CommunicationReply','Document'] as const;
export const adminOperationalStates = ['ACTIVE','BLOCKED','ARCHIVED','TRASHED'] as const;
export type AdminOperationalModel = typeof adminOperationalModels[number];
export type AdminOperationalState = typeof adminOperationalStates[number];
export const adminOperationalModelLabels: Record<AdminOperationalModel,string> = {
  ControlledIntake: 'Acquisizioni controllate', PracticeReadiness: 'Pratiche preventivo e avvio',
  ApprovedCommunication: 'Comunicazioni', CommunicationReply: 'Risposte ricevute', Document: 'Documenti acquisiti privatamente',
};
export const adminOperationalLabels: Record<AdminOperationalState,string> = {
  ACTIVE: 'Operativo', BLOCKED: 'Bloccato', ARCHIVED: 'Archiviato', TRASHED: 'Nel cestino',
};
export class AdminOperationalStateError extends Error {
  constructor(readonly code: 'DENIED'|'INACTIVE'|'STALE'|'INVALID'|'IN_FLIGHT'|'CLOSED') {
    super('ADMIN_OPERATIONAL_' + code);
  }
}
export function operationalReference(model: unknown, id: unknown) {
  const parsed = z.object({ model: z.enum(adminOperationalModels), id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).parse({ model, id });
  if (parsed.model !== 'Document') parsed.id = z.string().uuid().parse(parsed.id).toLowerCase();
  return parsed;
}
export type OperationalStateRow = {
  model: AdminOperationalModel; recordId: string; state: AdminOperationalState; version: number;
  lastCommandId: string|null; createdAt: Date; updatedAt: Date;
};
type Tx = Prisma.TransactionClient;

/** Native writers and transitions share the same lock and persistent state row.
 * A missing registration is denied; no privilege comes from a fallback. */
export async function readOperationalState(tx: Tx, model: AdminOperationalModel, id: string) {
  const reference = operationalReference(model,id);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'admin-operational-state:'+reference.model+':'+reference.id},0))::text`;
  const rows = await tx.$queryRaw<OperationalStateRow[]>`SELECT "model","recordId","state","version","lastCommandId","createdAt","updatedAt"
    FROM "AdminOperationalState" WHERE "model"=${reference.model} AND "recordId"=${reference.id} FOR SHARE`;
  if (rows.length !== 1) throw new AdminOperationalStateError('DENIED');
  return rows[0];
}
export async function lockOperationalStateTransition(tx: Tx, model: AdminOperationalModel, id: string) {
  const reference = operationalReference(model,id);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-operational-state:'+reference.model+':'+reference.id},0))::text`;
  return readOperationalState(tx,reference.model,reference.id);
}
export function operationalStateVisible(state: AdminOperationalState, role: string) {
  return role === 'admin' || state === 'ACTIVE' || state === 'BLOCKED';
}
export async function assertOperationalAccess(tx: Tx, model: AdminOperationalModel, id: string,
  role: string, write: boolean, administrativeHistory = false) {
  const row = await readOperationalState(tx,model,id), state = row.state;
  if (administrativeHistory && role !== 'admin') throw new AdminOperationalStateError('DENIED');
  if (!administrativeHistory && (write ? state !== 'ACTIVE' : !operationalStateVisible(state,role)))
    throw new AdminOperationalStateError('INACTIVE');
  return row;
}
export async function assertOperationalActive(tx: Tx, model: AdminOperationalModel, id: string) {
  return assertOperationalAccess(tx,model,id,'',true);
}
