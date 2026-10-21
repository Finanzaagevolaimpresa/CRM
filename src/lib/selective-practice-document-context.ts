import type { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { documentEligibleForPractice, type PracticeDocumentContext } from './selective-practice-document-policy';

type Context = { clientId: string | null; projectId: string | null; clientServiceId: string | null };
const contextFields = { clientId: true, projectId: true, clientServiceId: true } as const;
const unique = (values: Array<string | null>) => [...new Set(values.filter((id): id is string => !!id))].sort();

/** Read the same canonical financial/material paths as the resource guard.
 * This is practice compatibility only; it never replaces financial/lifecycle
 * authorization. The caller rereads it after the existing resource locks. */
export async function practiceDocumentContexts(tx: Prisma.TransactionClient, context: PracticeDocumentContext, documentIds: string[]) {
  const ids = unique(documentIds);
  if (!ids.length) return new Map<string, { eligible: boolean; hash: string }>();
  const [documents, signed, payments, formalizations, materials] = await Promise.all([
    tx.document.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, ...contextFields } }),
    tx.contract.findMany({ where: { signedDocumentId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, signedDocumentId: true } }),
    tx.payment.findMany({ where: { accountingDocumentId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, accountingDocumentId: true, contractId: true, clientId: true } }),
    tx.practiceFormalization.findMany({ where: { signedDocumentId: { in: ids } }, orderBy: { id: 'asc' },
      select: { id: true, signedDocumentId: true, contractId: true, practice: { select: contextFields } } }),
    tx.practiceMaterialEvidence.findMany({ where: { documentId: { in: ids } }, orderBy: { id: 'asc' },
      select: { id: true, documentId: true, practice: { select: contextFields } } }),
  ]);
  const contractIds = unique([...signed.map(row => row.id), ...payments.map(row => row.contractId), ...formalizations.map(row => row.contractId)]);
  const [contracts, contractServices, contractFormalizations] = await Promise.all([
    tx.contract.findMany({ where: { id: { in: contractIds } }, orderBy: { id: 'asc' }, select: { id: true, clientId: true, projectId: true } }),
    tx.clientService.findMany({ where: { contractId: { in: contractIds } }, orderBy: { id: 'asc' }, select: { id: true, contractId: true, clientId: true, projectId: true } }),
    tx.practiceFormalization.findMany({ where: { contractId: { in: contractIds } }, orderBy: { id: 'asc' },
      select: { id: true, contractId: true, practice: { select: contextFields } } }),
  ]);
  const contexts = new Map<string, Context[]>(), references = new Map<string, unknown[]>(), missing = new Set<string>();
  for (const document of documents) {
    const boundSigned = signed.filter(row => row.signedDocumentId === document.id);
    const boundPayments = payments.filter(row => row.accountingDocumentId === document.id);
    const boundFormalizations = formalizations.filter(row => row.signedDocumentId === document.id);
    const boundMaterials = materials.filter(row => row.documentId === document.id);
    const boundIds = unique([...boundSigned.map(row => row.id), ...boundPayments.map(row => row.contractId), ...boundFormalizations.map(row => row.contractId)]);
    const boundContracts = contracts.filter(row => boundIds.includes(row.id));
    if (boundContracts.length !== boundIds.length) missing.add(document.id);
    const services = contractServices.filter(row => row.contractId && boundIds.includes(row.contractId));
    const forms = contractFormalizations.filter(row => boundIds.includes(row.contractId));
    contexts.set(document.id, [document,
      ...boundPayments.map(row => ({ clientId: row.clientId, projectId: null, clientServiceId: null })),
      ...boundContracts.map(row => ({ ...row, clientServiceId: null })),
      ...services.map(row => ({ ...row, clientServiceId: row.id })),
      ...[...boundFormalizations, ...boundMaterials, ...forms].map(row => row.practice)]);
    references.set(document.id, [document, boundSigned, boundPayments, boundFormalizations, boundMaterials, boundContracts, services, forms]);
  }
  const serviceIds = unique([...contexts.values()].flatMap(rows => rows.map(row => row.clientServiceId)));
  const services = await tx.clientService.findMany({ where: { id: { in: serviceIds } }, orderBy: { id: 'asc' },
    select: { id: true, clientId: true, projectId: true, recordUpdateEpoch: true, deletedAt: true } });
  const projectIds = unique([...contexts.values()].flatMap(rows => rows.map(row => row.projectId)).concat(services.map(row => row.projectId)));
  const projects = await tx.project.findMany({ where: { id: { in: projectIds } }, orderBy: { id: 'asc' },
    select: { id: true, clientId: true, recordUpdateEpoch: true, deletedAt: true, status: true } });
  return new Map(ids.map(id => {
    const rows = contexts.get(id) ?? [];
    const selectedServiceIds = unique(rows.map(row => row.clientServiceId));
    const selectedServices = services.filter(row => selectedServiceIds.includes(row.id));
    const selectedProjectIds = unique(rows.map(row => row.projectId).concat(selectedServices.map(row => row.projectId)));
    const selectedProjects = projects.filter(row => selectedProjectIds.includes(row.id));
    const eligible = rows.length > 0 && !missing.has(id)
      && rows.every(row => documentEligibleForPractice(context, row))
      && selectedServices.length === selectedServiceIds.length
      && selectedServices.every(row => !row.deletedAt && documentEligibleForPractice(context, { ...row, clientServiceId: row.id }))
      && selectedProjects.length === selectedProjectIds.length
      && selectedProjects.every(row => !row.deletedAt && row.status !== 'archiviato' && row.clientId === context.clientId);
    const hash = canonicalSha256(JSON.parse(JSON.stringify({ references: references.get(id) ?? [], services: selectedServices, projects: selectedProjects })) as Prisma.InputJsonValue);
    return [id, { eligible, hash }];
  }));
}
