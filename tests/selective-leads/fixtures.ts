import { randomUUID } from 'node:crypto';
import type { PrismaClient, RoleCode } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { leadFixture } from '../lead-lifecycle/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { previewLeadSharing, confirmLeadSharing } from '../../src/lib/selective-lead-access';

export type Person = Awaited<ReturnType<typeof syntheticPerson>>;
export const leadKey = () => ({ version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! });
export function leadProof(person: Person, nowSeconds?: number) {
  const key = leadKey();
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: person.user.id, sessionToken: person.token, nowSeconds }) };
}
export async function selectiveLeadFixture(db: PrismaClient, admin: Person, role: RoleCode = 'admin', passwordHash?: string) {
  const reader = await syntheticPerson(db, 'Destinatario lead sintetico', role, passwordHash);
  const row = await leadFixture(db, reader.user.id);
  const other = await db.lead.create({ data: { firstName: 'Altro', lastName: 'Lead', companyName: 'ALTRO_LEAD_' + randomUUID(), assignedToId: reader.user.id } });
  const input = { leadId: row.lead.id, recipientId: reader.user.id, revision: 0, commandId: randomUUID(), fields: ['companyName', 'status'], expiresAt: null as string | null };
  return { ...row, admin, reader, other, input };
}
export async function grantLead(db: PrismaClient, admin: Person, input: unknown) {
  const preview = await previewLeadSharing(db, admin.session, input);
  const receipt = await confirmLeadSharing(db, admin.session, input, preview.token, leadProof(admin));
  return { preview, receipt };
}
