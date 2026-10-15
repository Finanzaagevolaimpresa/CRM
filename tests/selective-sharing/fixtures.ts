import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { createInternalSession } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import type { AuthSession } from '../../src/lib/auth';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export async function syntheticPerson(db: PrismaClient, name: string, role: RoleCode = 'admin', passwordHash = 'synthetic-not-for-login') {
  const user = await db.user.create({ data: { name, role, passwordHash, email: `${randomUUID()}@selective.invalid.test` } });
  const token = createRegistrySessionToken(), digest = await digestRegistrySessionToken(token.bytes);
  const row = await db.$transaction(tx => createInternalSession(tx, { userId: user.id, tokenDigest: digest }));
  const session: AuthSession = { userId: user.id, sessionId: row.id, expiresAt: Math.floor(row.expiresAt.getTime() / 1000), role, active: true, permissionOverrides: [] };
  return { user, session, token: token.token };
}
export async function syntheticAuthority(db: PrismaClient, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const admin = await syntheticPerson(db, 'Autorità sintetica', 'admin', passwordHash);
  await db.selectiveAccessAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION),
    keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!), status: 'ACTIVE', activatedAt: new Date() } });
  return admin;
}
export async function syntheticSharingCase(db: PrismaClient, admin: Awaited<ReturnType<typeof syntheticPerson>>, passwordHash?: string) {
  const reader = await syntheticPerson(db, 'Destinatario sintetico', 'admin', passwordHash);
  const otherAdmin = await syntheticPerson(db, 'Altro amministratore sintetico', 'admin', passwordHash);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico condiviso', consultantId: reader.user.id, salesOwnerId: reader.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, consultantId: reader.user.id, title: 'Progetto sintetico selettivo', description: 'DESCRIZIONE_ESCLUSA_SINTETICA', scenarioA: 'NOTA_PRIVATA_ESCLUSA_SINTETICA', totalInvestment: 180000, requestedAmount: 90000 } });
  const otherProject = await db.project.create({ data: { clientId: client.id, title: 'Altro fascicolo invariato', scenarioA: 'ALTRO_FASCICOLO' } });
  const documents = [];
  for (let index = 1; index <= 3; index++) {
    const bytes = Buffer.from(`CONTENUTO_SINTETICO_DOCUMENTO_${index}`), checksum = createHash('sha256').update(bytes).digest('hex');
    const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, title: `Documento sintetico ${index}`, fileName: `sintetico-${index}.txt`,
      type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro', serviceArea: 'progetto_investimento', sizeBytes: bytes.length, storagePath: `selective/${randomUUID()}.txt`, checksum, uploadedById: admin.user.id } });
    const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, storagePath: doc.storagePath, checksum } });
    documents.push({ doc, version, bytes });
  }
  const input = { projectId: project.id, recipientId: reader.user.id, revision: 0, fields: ['title', 'totalInvestment'], documents: documents.slice(0, 2).map((doc, index) => ({ versionId: doc.version.id, download: index === 1 })), expiresAt: null };
  return { admin, reader, otherAdmin, client, project, otherProject, documents, input };
}
