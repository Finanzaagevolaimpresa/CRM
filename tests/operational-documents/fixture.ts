import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { createOperationalDocument, prepareOperationalDocument, saveOperationalTemplate } from '../../src/lib/operational-documents';
import { documentFields, type DraftDocumentCommand, type DocumentField } from '../../src/lib/operational-document-contract';

export async function documentFixture(db: PrismaClient, passwordHash?: string, options: { unlinked?: boolean } = {}) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); await collectionKey(db);
  const admin = await syntheticPerson(db, 'Admin documenti sintetici', 'admin', passwordHash);
  const owner = await syntheticPerson(db, 'Consulente commerciale sintetico', 'commerciale', passwordHash);
  const other = await syntheticPerson(db, 'Altro commerciale sintetico', 'commerciale', passwordHash);
  const technical = await syntheticPerson(db, 'Tecnico documenti sintetici', 'consulente', passwordHash);
  const companyName = 'Azienda documenti sintetici ' + randomUUID();
  const client = await db.client.create({ data: { type: 'societa', displayName: companyName, salesOwnerId: owner.user.id } });
  const company = await db.company.create({ data: { clientId: client.id, name: companyName, vatNumber: '12345678903', taxCode: '12345678903', legalAddress: 'Via Sintetica 1, 00100 Roma' } });
  const signer = await db.person.create({ data: { firstName: 'Firmatario', lastName: 'Sintetico' } });
  await db.companyPerson.create({ data: { companyId: company.id, personId: signer.id, role: 'Amministratore', isAdministrator: true } });
  const lead = await db.lead.create({ data: { firstName: 'Persona', lastName: 'Sintetica', companyName, email: 'synthetic@invalid.test', phone: '+390612345678', assignedToId: owner.user.id, clientId: options.unlinked ? null : client.id } });
  const service = await db.serviceCatalogRevision.findFirstOrThrow({ where: { status: 'PUBLISHED', priceMode: 'FIXED', serviceCatalog: { active: true } } });
  const template = { commandId: randomUUID(), templateId: randomUUID(), expectedVersion: 0, operation: 'SAVE' as const,
    title: 'Contratto sintetico da modello', kind: 'CONTRACT' as const, body: 'Cliente: {{denominazione}}\nSede: {{indirizzo}}\nP.IVA: {{partita_iva}}\nFirmatario: {{firmatario}}\nServizio: {{servizio}}\nImponibile: {{imponibile}}\nIVA: {{iva}}\nTotale: {{totale}}\nRate: {{rate}}',
    required: ['denominazione', 'indirizzo', 'firmatario'] as DocumentField[], approved: false };
  await saveOperationalTemplate(db, admin.session, template, clientProof(admin));
  const publication = { ...template, commandId: randomUUID(), expectedVersion: 1, operation: 'PUBLISH' as const, approved: true };
  await saveOperationalTemplate(db, admin.session, publication, clientProof(admin));
  const proformaTemplate = { ...template, commandId: randomUUID(), templateId: randomUUID(), kind: 'PROFORMA' as const,
    title: 'Proforma sintetica autorizzata', body: 'Emittente: FAI prova sintetica, Via Esempio 1, P.IVA solo prova.\n' + template.body + '\nScadenza: {{scadenza}}' };
  await saveOperationalTemplate(db, admin.session, proformaTemplate, clientProof(admin));
  const proformaPublication = { ...proformaTemplate, commandId: randomUUID(), expectedVersion: 1, operation: 'PUBLISH' as const, approved: true };
  await saveOperationalTemplate(db, admin.session, proformaPublication, clientProof(admin));
  const selection = { context: { leadId: lead.id }, templateCommandId: publication.commandId, serviceRevisionId: service.id };
  const prepare = () => prepareOperationalDocument(db, owner.session, selection);
  const input = async (extra: Partial<DraftDocumentCommand> = {}): Promise<DraftDocumentCommand> => {
    const prepared = await prepare();
    const manual: Partial<Record<DocumentField, string>> = options.unlinked
      ? { indirizzo: 'Via Nuovo Lead 1, Roma', partita_iva: '12345678903', firmatario: 'Firmatario nuovo lead' } : {};
    return { commandId: randomUUID(), ...selection, sourceHash: prepared.sourceHash, termsConfirmed: true,
      choices: Object.fromEntries(documentFields.map(field => [field, field === 'rate' ? 'Saldo unico alla scadenza concordata' : prepared.candidates[field][0]?.value ?? manual[field] ?? ''])) as Record<DocumentField, string>, ...extra };
  };
  const create = async (extra: Partial<DraftDocumentCommand> = {}) => createOperationalDocument(db, owner.session, await input(extra));
  return { admin, owner, other, technical, client, company, lead, service, template, publication, proformaPublication, selection, prepare, input, create };
}
