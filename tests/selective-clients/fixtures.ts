import { randomUUID } from 'node:crypto';
import type { PrismaClient, RoleCode } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { confirmClientSharing, previewClientSharing } from '../../src/lib/selective-client-access';

export type ClientPerson = Awaited<ReturnType<typeof syntheticPerson>>;
export function clientProof(person: ClientPerson, nowSeconds?: number) {
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({
    key, userId: person.user.id, sessionToken: person.token, nowSeconds,
  }) };
}
export async function selectiveClientFixture(db: PrismaClient, admin: ClientPerson, role: RoleCode = 'admin', passwordHash?: string) {
  const reader = await syntheticPerson(db, 'Destinatario cliente sintetico', role, passwordHash);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico ' + randomUUID(),
    salesOwnerId: reader.user.id, consultantId: reader.user.id, notes: 'NOTA_PRIVATA_SINTETICA_' + randomUUID() } });
  const other = await db.client.create({ data: { type: 'societa', displayName: 'Altro cliente sintetico ' + randomUUID(),
    salesOwnerId: reader.user.id, consultantId: reader.user.id } });
  const company = await db.company.create({ data: { clientId: client.id, name: 'AZIENDA_SINTETICA_ESCLUSA_' + randomUUID(), vatNumber: 'SYNTHETIC_VAT' } });
  const project = await db.project.create({ data: { clientId: client.id, companyId: company.id, title: 'PROGETTO_SINTETICO_ESCLUSO_' + randomUUID() } });
  const lead = await db.lead.create({ data: { firstName: 'Sintetico', lastName: 'Cliente', clientId: client.id, assignedToId: reader.user.id } });
  const input = { clientId: client.id, recipientId: reader.user.id, revision: 0, commandId: randomUUID(),
    fields: ['displayName', 'status'], expiresAt: null as string | null };
  return { admin, reader, client, other, company, project, lead, input };
}
export async function grantClient(db: PrismaClient, admin: ClientPerson, input: unknown) {
  const preview = await previewClientSharing(db, admin.session, input);
  const receipt = await confirmClientSharing(db, admin.session, input, preview.token, clientProof(admin));
  return { preview, receipt };
}
