import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { declareContractSignature } from '../../src/lib/contract-signature';

export async function activitiesFixture(db: PrismaClient, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const person = await syntheticPerson(db, 'Admin attività sintetiche', 'admin', passwordHash);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente attività sintetiche', consultantId: person.user.id } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: `ACT-${randomUUID()}`,
    serviceName: 'Servizio sintetico da completare', serviceDescription: null,
    taxableAmount: 100, vatAmount: 22, totalAmount: 122, notes: 'NOTA_PRIVATA_DA_NON_COPIARE_IN_AUDIT' } });
  const payment = await db.payment.create({ data: { clientId: client.id, contractId: contract.id, taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  const declared = await declareContractSignature(db, person.session, { contractId: contract.id,
    expectedVersion: contract.updatedAt.toISOString(), expectedDeclarationId: null,
    signedOn: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), source: 'Dichiarazione soltanto sintetica', confirmed: true });
  const command = { commandId: randomUUID(), clientId: client.id, contractId: contract.id,
    activities: 'Analisi sintetica dei requisiti.\nPreparazione dei documenti concordati.', confirmed: true as const };
  return { person, client, contract, payment, declared, command, session: person.session };
}
