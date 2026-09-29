import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prepareServiceCatalogV2 } from '../../src/lib/service-catalog-v2-persistence';

/** Valid synthetic readiness with no project/service and different client/lead owners. */
export async function readinessCommunicationFixture(db: PrismaClient, clientOwnerId: string, leadOwnerId: string) {
  await prepareServiceCatalogV2(db);
  const catalog = await db.serviceCatalogRevision.findFirstOrThrow({ where: { serviceCatalog: { code: 'dossier_preanalisi' }, status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'M4 shared client', consultantId: clientOwnerId } });
  const lead = await db.lead.create({ data: { firstName: 'Test', lastName: 'M4 lead', clientId: client.id, assignedToId: leadOwnerId } });
  const intake = await db.controlledIntake.create({ data: { channel: 'EMAIL', sourceId: randomUUID(), sourceOccurredAt: new Date(),
    acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'm4-synthetic-v1', payloadHash: randomBytes(32).toString('hex'), leadId: lead.id,
    subjectType: 'PERSONA', firstName: 'Test', lastName: 'M4 lead', classificationState: 'VERIFIED', effectiveCategory: 'consulenza',
    need: 'Synthetic communication assignment test', operatorId: leadOwnerId } });
  const offer = await db.commercialOffer.create({ data: { leadId: lead.id, clientId: client.id, title: 'M4 synthetic offer',
    taxableAmount: '100.00', vatAmount: '22.00', totalAmount: '122.00', status: 'accettata', acceptedAt: new Date(),
    validUntil: new Date(Date.now() + 86_400_000), createdById: leadOwnerId } });
  const revision = await db.practiceOfferRevision.create({ data: { controlledIntakeId: intake.id, commercialOfferId: offer.id,
    revision: 1, serviceRevisionId: catalog.id, clientId: client.id, scope: 'Synthetic standalone communication context',
    inclusions: [], exclusions: [], deliverables: [], taxableAmount: '100.00', vatAmount: '22.00', totalAmount: '122.00',
    requiredInitialAmount: '50.00', currency: 'EUR', validUntil: offer.validUntil!, startupConditions: 'Synthetic conditions',
    payloadHash: randomBytes(32).toString('hex'), proposedById: leadOwnerId } });
  await db.practiceOfferAcceptance.create({ data: { offerRevisionId: revision.id, acceptedAt: new Date(), acceptedById: leadOwnerId,
    evidenceHash: randomBytes(32).toString('hex') } });
  const practice = await db.practiceReadiness.create({ data: { controlledIntakeId: intake.id, commercialOfferId: offer.id,
    offerSnapshotHash: revision.payloadHash, offerRevision: 1, acceptedOfferRevisionId: revision.id, serviceRevisionId: catalog.id,
    clientId: client.id, requiredInitialAmount: '50.00' } });
  return { client, lead, intake, practice, context: { kind: 'READINESS' as const, id: practice.id } };
}
