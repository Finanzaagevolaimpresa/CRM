import { z } from 'zod';
export const operationalLinkModel = 'AdminOperationalLink';
export const linkRoot = z.enum(['Lead', 'Client', 'ClientService', 'PracticeReadiness']);
export type LinkRoot = z.infer<typeof linkRoot>;
export const linkId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const linkChoice = z.object({ model: linkRoot, id: linkId, values: z.record(z.string(), z.string().max(128)) }).strict();
export const linkCommand = linkChoice.extend({ commandId: z.string().uuid(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true) }).strict();
export type LinkChoice = z.infer<typeof linkChoice>;
export class OperationalLinkError extends Error {
  constructor(readonly code: 'DENIED' | 'INVALID' | 'STALE' | 'CONTEXT' | 'CLOSED' | 'FORMALIZED' | 'PAYMENT') { super('ADMIN_OPERATIONAL_LINK_' + code); }
}
export const linkFields = {
  PracticeReadiness: [{ name: 'acceptedOfferRevisionId', target: 'PracticeOfferRevision', label: 'Revisione del preventivo già accettata', required: true },
    { name: 'contractId', target: 'Contract', label: 'Contratto firmato', required: true },
    { name: 'signedDocumentVersionId', target: 'DocumentVersion', label: 'Versione esatta del documento firmato', required: true },
    { name: 'clientServiceId', target: 'ClientService', label: 'Servizio operativo collegato', required: true },
    { name: 'paymentId', target: 'Payment', label: 'Pagamento collegato al servizio', required: false }],
  Lead: [{ name: 'clientId', target: 'Client', label: 'Cliente operativo', required: false }],
  Client: [{ name: 'leadId', target: 'Lead', label: 'Lead operativo', required: false }],
  ClientService: [{ name: 'serviceCatalogId', target: 'ServiceCatalog', label: 'Servizio di catalogo', required: true },
    { name: 'contractId', target: 'Contract', label: 'Contratto operativo', required: false },
    { name: 'paymentId', target: 'Payment', label: 'Pagamento collegato', required: false }],
} as const;
