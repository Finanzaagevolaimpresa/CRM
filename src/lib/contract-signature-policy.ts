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
