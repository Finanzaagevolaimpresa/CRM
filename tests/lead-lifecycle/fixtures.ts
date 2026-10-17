import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export async function leadFixture(db: PrismaClient, ownerId: string, withInbox = true) {
  const label = 'LEAD_CESTINO_SINTETICO_' + randomUUID();
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente convertito conservato', salesOwnerId: ownerId } });
  const lead = await db.lead.create({ data: { firstName: 'Nome sintetico', lastName: 'Cognome sintetico', companyName: label,
    assignedToId: ownerId, clientId: client.id, status: 'qualificato', email: randomUUID() + '@invalid.test',
    phone: '+393331234567', notes: 'NOTA_PRIVATA_LEAD_SINTETICO', nextActionDate: new Date(Date.now() - 86_400_000) } });
  const offer = await db.commercialOffer.create({ data: { leadId: lead.id, clientId: client.id, title: 'OFFERTA_CESTINO_' + randomUUID(),
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, status: 'inviata', createdById: ownerId } });
  const doc = await db.document.create({ data: { clientId: client.id, title: 'Documento cliente conservato', type: 'text/plain',
    fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: 0, storagePath: 'synthetic/lead-trash-' + randomUUID(), uploadedById: ownerId } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: doc.storagePath } });
  const availableAt = new Date(Date.now() - 172_800_000);
  const item = withInbox ? await db.commercialLeadInboxItem.create({ data: { leadId: lead.id, originKind: 'MANUAL_CRM',
    sourceSystem: 'CRM_SYNTHETIC', formCode: 'TEST', formVersion: '1', sourceOccurredAt: availableAt, initializedAt: availableAt } }) : null;
  const policy = item ? await db.commercialLeadSlaPolicyVersion.findFirst({ orderBy: { version: 'asc' } })
    ?? await db.commercialLeadSlaPolicyVersion.create({ data: { version: 1, responseTargetSeconds: 86_400 } }) : null;
  const cycle = item && policy ? await db.commercialLeadSlaCycle.create({ data: { inboxItemId: item.id, policyVersionId: policy.id,
    sequence: 1, availableAt, dueAt: new Date(availableAt.getTime() + policy.responseTargetSeconds * 1000),
    firstResponseAt: new Date(availableAt.getTime() + 1000) } }) : null;
  return { lead, client, offer, doc, version, item, cycle, label };
}


export async function readinessLeadFixture(db: PrismaClient, ownerId: string, context: { clientId: string; projectId: string }) {
  const lead = await db.lead.create({ data: { firstName: 'Readiness', lastName: 'Sintetica', assignedToId: ownerId, clientId: context.clientId } });
  const intake = await db.controlledIntake.create({ data: { channel: 'EMAIL', sourceId: randomUUID(), sourceOccurredAt: new Date(),
    acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'lead-trash-synthetic-v1', payloadHash: 'a'.repeat(64),
    leadId: lead.id, subjectType: 'PERSONA', firstName: 'Readiness', lastName: 'Sintetica',
    classificationState: 'VERIFIED', effectiveCategory: 'consulenza', need: 'Synthetic lifecycle scope', operatorId: ownerId } });
  const offer = await db.commercialOffer.create({ data: { leadId: lead.id, clientId: context.clientId, title: 'Synthetic readiness offer',
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, createdById: ownerId } });
  const catalog = await db.serviceCatalogRevision.findFirstOrThrow({ where: { status: 'PUBLISHED' } });
  const revision = await db.practiceOfferRevision.create({ data: { controlledIntakeId: intake.id, commercialOfferId: offer.id,
    ...context, revision: 1, serviceRevisionId: catalog.id, scope: 'Synthetic scope', inclusions: [], exclusions: [], deliverables: [],
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, requiredInitialAmount: 0, currency: 'EUR',
    validUntil: new Date(Date.now() + 86_400_000), startupConditions: 'Synthetic conditions',
    payloadHash: randomUUID().replaceAll('-', '').repeat(2), proposedById: ownerId } });
  const practice = await db.practiceReadiness.create({ data: { controlledIntakeId: intake.id, commercialOfferId: offer.id,
    ...context, offerSnapshotHash: revision.payloadHash, offerRevision: 1, acceptedOfferRevisionId: revision.id,
    serviceRevisionId: catalog.id, requiredInitialAmount: 0 } });
  return { lead, intake, offer, revision, practice };
}
