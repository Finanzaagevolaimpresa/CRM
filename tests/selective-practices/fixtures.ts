import { randomUUID } from 'node:crypto';
import type { PrismaClient, RoleCode } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { confirmPracticeSharing, previewPracticeSharing } from '../../src/lib/selective-practice-access';

export type PracticePerson = Awaited<ReturnType<typeof syntheticPerson>>;
export function practiceProof(person: PracticePerson, nowSeconds?: number) {
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({
    key, userId: person.user.id, sessionToken: person.token, nowSeconds,
  }) };
}
export async function selectivePracticeFixture(db: PrismaClient, admin: PracticePerson, role: RoleCode = 'admin', passwordHash?: string) {
  const reader = await syntheticPerson(db, 'Destinatario pratica sintetico', role, passwordHash);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico ' + randomUUID(),
    salesOwnerId: reader.user.id, consultantId: reader.user.id, notes: 'CLIENTE_PRIVATO_' + randomUUID() } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto sintetico ' + randomUUID() } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica sintetica ' + randomUUID(), practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    technicalOwnerId: reader.user.id, commercialOwnerId: reader.user.id, createdById: admin.user.id,
    dueDate: new Date('2026-12-01T12:00:00Z'), clientVisibleStatus: 'Stato sintetico',
    internalNotes: 'NOTA_PRIVATA_SINTETICA_' + randomUUID() } });
  const other = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Altra pratica sintetica ' + randomUUID(), practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    technicalOwnerId: reader.user.id, createdById: admin.user.id } });
  const input = { practiceId: practice.id, recipientId: reader.user.id, revision: 0, commandId: randomUUID(),
    fields: ['title','status'], expiresAt: null as string | null };
  return { admin, reader, client, project, practice, other, input };
}
export async function grantPractice(db: PrismaClient, admin: PracticePerson, input: unknown) {
  const preview = await previewPracticeSharing(db, admin.session, input);
  const receipt = await confirmPracticeSharing(db, admin.session, input, preview.token, practiceProof(admin));
  return { preview, receipt };
}
