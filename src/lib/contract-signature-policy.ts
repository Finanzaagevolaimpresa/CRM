import { z } from 'zod';
import type { Client, Contract, Document, DocumentVersion, Project } from '@prisma/client';
import type { AuthSession } from './auth';
import { canEditClient, canEditProject, canViewDocument } from './access-control';
import { hasPermission } from './permission-evaluator';

export class ContractSignatureError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'CLOSED' | 'DOCUMENT_CHANGED' | 'INVALID_DATE') { super(code); }
}
export function signatureCalendarDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const signedOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const contractSignatureSchema = z.object({
  contractId: z.string().min(1).max(191), expectedVersion: z.string().datetime(),
  signedDocumentVersionId: z.string().min(1).max(191), signedOn, confirmed: z.literal(true),
}).strict();
export const contractSignatureDeclarationEvent = 'contract_signature_declared';
export const contractSignatureDeclarationSchema = z.object({
  contractId: z.string().min(1).max(191), expectedVersion: z.string().datetime(),
  expectedDeclarationId: z.string().min(1).max(191).nullable(),
  signedOn, source: z.string().trim().min(3).max(500), confirmed: z.literal(true),
}).strict();
export const storedContractSignatureDeclarationSchema = z.object({
  version: z.literal(1), evidenceKind: z.literal('DECLARED_NOT_VERIFIED'),
  sequence: z.number().int().positive(), previousDeclarationId: z.string().min(1).max(191).nullable(),
  declaredSignedAt: signedOn, source: z.string().min(3).max(500), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function orderedSignatureDeclarations<T extends { id: string; after: unknown }>(rows: T[]) {
  const chain = rows.map(row => {
    const parsed = storedContractSignatureDeclarationSchema.safeParse(row.after);
    if (!parsed.success) throw new ContractSignatureError('STALE');
    return { row, evidence: parsed.data };
  }).sort((a, b) => a.evidence.sequence - b.evidence.sequence);
  for (const [index, item] of chain.entries()) {
    if (item.evidence.sequence !== index + 1 || item.evidence.previousDeclarationId !== (chain[index - 1]?.row.id ?? null)) throw new ContractSignatureError('STALE');
  }
  return chain.reverse();
}
export const unsignedContractStatuses = ['da_preparare', 'preparato', 'inviato_manualmente', 'non_firmato'] as const;
export function contractCanRecordSignature(status: Contract['status']) {
  return (unsignedContractStatuses as readonly string[]).includes(status);
}
export function canRecordContractSignature(actor: AuthSession, client: Client, project: Project | null) {
  if (!hasPermission(actor, 'contract.write') || !hasPermission(actor, 'document.download') || !hasPermission(actor, 'document.sensitive.read')) return false;
  if (client.deletedAt || (project && (project.deletedAt || project.clientId !== client.id))) return false;
  // Administration already has global contract.write; read grants alone never confer it.
  if (actor.role === 'amministrazione') return true;
  return project ? canEditProject(actor, { ...project, client }) : canEditClient(actor, client);
}
export function isSignatureDocument(actor: AuthSession, contract: Contract, client: Client, project: Project | null, document: Document, version: DocumentVersion) {
  return !document.deletedAt && !['respinto', 'scaduto', 'archiviato'].includes(document.status)
    && document.serviceArea === 'contratti' && document.clientId === contract.clientId
    && document.projectId === contract.projectId && document.clientServiceId === null
    && version.documentId === document.id && version.storagePath === document.storagePath
    && typeof document.checksum === 'string' && /^[a-f0-9]{64}$/.test(document.checksum)
    && version.checksum === document.checksum
    && canViewDocument(actor, { ...document, client, project }, hasPermission(actor, 'document.sensitive.read'));
}
