import { Prisma, type PrismaClient, type RoleCode } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { assertNoSelectiveClientMutation } from './selective-client-scope';
import { assertNoSelectiveProjectMutation } from './selective-project-scope';
import { authorizeManualAssignment } from './manual-assignment-guard';
import { appendResponsibilityDecision } from './responsibility';
import { withSerializableTransaction } from './serializable';
import { projectHandoffInput, projectHandoffPreview, projectHandoffReceipt, ProjectHandoffError,
  handoffProof, verifyHandoffProof, type ProjectHandoffInput } from './project-handoff-contract';

type Tx = Prisma.TransactionClient;
const event = 'project_practice_prepared';
const commercialRoles: readonly RoleCode[] = ['admin', 'direzione', 'commerciale'];
const technicalRoles: readonly RoleCode[] = ['admin', 'direzione', 'consulente', 'backoffice'];
function deny(): never { throw new ProjectHandoffError('DENIED'); }
async function context(tx: Tx, claimed: AuthSession, projectId: string, write: boolean, credentials?: UpdateCredentials) {
  const auth = await updateActor(tx, claimed, credentials);
  if (auth.actor.role !== 'admin' || !['project.read', 'project.write', 'technical.read', 'technical.write'].every(permission =>
    recordUpdatePermission(auth.actor, permission as 'project.read' | 'project.write' | 'technical.read' | 'technical.write'))) deny();
  const scope = await recordUpdateContext(tx, 'PROJECT', projectId, write);
  if (!scope.canRead(auth.actor)) deny();
  await assertNoSelectiveClientMutation(tx, auth.actor.id, scope.clientId);
  await assertNoSelectiveProjectMutation(tx, auth.actor.id, projectId);
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const client = await tx.client.findUniqueOrThrow({ where: { id: project.clientId } });
  // Include archived and trashed practices: this shortcut never silently replaces one.
  const serviceIds = (await tx.clientService.findMany({ where: { projectId }, select: { id: true } })).map(row => row.id);
  const practices = await tx.technicalPractice.findMany({ where: { OR: [{ projectId }, { clientServiceId: { in: serviceIds } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, clientId: true, title: true, status: true, deletedAt: true, clientServiceId: true } });
  if (practices.some(row => row.clientId !== client.id)) deny();
  const people = await tx.user.findMany({ where: { active: true, deletedAt: null, role: { in: [...new Set([...commercialRoles, ...technicalRoles])] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, role: true, recordUpdateEpoch: true } });
  const expectedHash = canonicalSha256({ scope: scope.scopeDigest, projectVersion: project.updatedAt.toISOString(), clientVersion: client.updatedAt.toISOString(),
    commercialOwnerId: client.salesOwnerId, technicalOwnerId: project.consultantId,
    people: people.map(p => [p.id, p.role, p.recordUpdateEpoch]) });
  await auth.finish();
  return { auth, project, client, practices, people, expectedHash };
}
export async function readProjectHandoff(db: PrismaClient, claimed: AuthSession, projectId: string) {
  return withSerializableTransaction(db, async tx => {
    const c = await context(tx, claimed, projectId, false);
    return { projectId, projectTitle: c.project.title, clientName: c.client.displayName, expectedHash: c.expectedHash,
      practices: c.practices.map(p => ({ id: p.id, title: p.title, status: p.status, available: !p.deletedAt && p.status !== 'archiviata' })),
      commercialPeople: c.people.filter(p => commercialRoles.includes(p.role)).map(p => ({ id: p.id, name: p.name })),
      technicalPeople: c.people.filter(p => technicalRoles.includes(p.role)).map(p => ({ id: p.id, name: p.name })),
      commercialOwnerId: c.people.some(p => p.id === c.client.salesOwnerId && commercialRoles.includes(p.role)) ? c.client.salesOwnerId : null,
      technicalOwnerId: c.people.some(p => p.id === c.project.consultantId && technicalRoles.includes(p.role)) ? c.project.consultantId : null };
  });
}
async function proposal(tx: Tx, claimed: AuthSession, input: ProjectHandoffInput, key: PrivilegedStepUpKey, credentials?: UpdateCredentials) {
  if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) deny();
  const c = await context(tx, claimed, input.projectId, Boolean(credentials), credentials);
  if (c.practices.length) throw new ProjectHandoffError('EXISTS');
  if (c.expectedHash !== input.expectedHash) throw new ProjectHandoffError('STALE');
  for (const [id, roles] of [[input.commercialOwnerId, commercialRoles], [input.technicalOwnerId, technicalRoles]] as const)
    if (id && !c.people.some(person => person.id === id && roles.includes(person.role))) deny();
  const digest = canonicalSha256({ input, actorId: c.auth.actor.id, sessionId: c.auth.registry.id, expectedHash: c.expectedHash });
  return { ...c, digest };
}
export async function previewProjectHandoff(db: PrismaClient, claimed: AuthSession, raw: unknown, key: PrivilegedStepUpKey) {
  const input = projectHandoffInput.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const c = await proposal(tx, claimed, input, key), now = await c.auth.finish();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const proof = handoffProof(key, { digest: c.digest, expiresAt });
    return { digest: c.digest, expiresAt, proof, projectTitle: c.project.title, clientName: c.client.displayName,
      commercialName: c.people.find(p => p.id === input.commercialOwnerId)?.name ?? null,
      technicalName: c.people.find(p => p.id === input.technicalOwnerId)?.name ?? null };
  });
}
async function receipt(tx: Tx, claimed: AuthSession, commandId: string, projectId: string, fingerprint?: string) {
  const row = await tx.auditLog.findUnique({ where: { id: commandId } });
  if (!row) return null;
  const r = projectHandoffReceipt.parse(row.after);
  if (row.event !== event || row.entityType !== 'Project' || row.entityId !== projectId || row.actorId !== claimed.userId
    || r.sessionId !== claimed.sessionId || r.projectId !== projectId || (fingerprint && r.fingerprint !== fingerprint)) deny();
  const practice = await tx.technicalPractice.findUnique({ where: { id: r.technicalPracticeId } });
  if (!practice || practice.deletedAt || practice.status === 'archiviata' || practice.projectId !== projectId || practice.clientId !== r.clientId) deny();
  return { confirmed: true as const, practiceId: practice.id };
}
export async function confirmProjectHandoff(db: PrismaClient, claimed: AuthSession, raw: unknown, rawPreview: unknown, credentials: UpdateCredentials) {
  const input = projectHandoffInput.parse(raw), preview = projectHandoffPreview.parse(rawPreview);
  const fingerprint = canonicalSha256({ input, preview });
  return withSerializableTransaction(db, async tx => {
    // Replays are admitted only after a fresh actor, context and step-up check.
    const c = await context(tx, claimed, input.projectId, true, credentials);
    const prior = await receipt(tx, claimed, input.commandId, input.projectId, fingerprint);
    if (prior) { await c.auth.finish(); return prior; }
    const p = await proposal(tx, claimed, input, credentials.key, credentials);
    const now = await p.auth.finish();
    if (!verifyHandoffProof(credentials.key, { digest: preview.digest, expiresAt: preview.expiresAt }, preview.proof)) deny();
    if (preview.digest !== p.digest) throw new ProjectHandoffError('STALE');
    if (Date.parse(preview.expiresAt) <= now.getTime() || Date.parse(preview.expiresAt) > now.getTime() + 10 * 60_000) throw new ProjectHandoffError('EXPIRED');
    await authorizeManualAssignment(tx, claimed, [{ userId: input.commercialOwnerId, roles: commercialRoles }, { userId: input.technicalOwnerId, roles: technicalRoles }]);
    // Initial preparation only: readiness, paid service start, presentation and
    // personal access assignments remain their existing distinct operations.
    const practice = await tx.technicalPractice.create({ data: { clientId: p.client.id, projectId: input.projectId,
      title: input.title, practiceType: input.practiceType, targetEntity: input.targetEntity, status: 'da_progettare',
      commercialOwnerId: input.commercialOwnerId, technicalOwnerId: input.technicalOwnerId, createdById: claimed.userId } });
    const decision = await appendResponsibilityDecision(tx, { kind: 'TechnicalPractice', id: practice.id, actorId: claimed.userId,
      allowed: Boolean(input.commercialOwnerId || input.technicalOwnerId), departmentCode: input.technicalOwnerId ? 'ufficio_tecnico' : null,
      reason: 'Preparazione dal progetto: responsabilità iniziale, nessuna presa in carico o avvio del servizio',
      state: { clientId: practice.clientId, projectId: practice.projectId, clientServiceId: null,
        commercialOwnerId: practice.commercialOwnerId, technicalOwnerId: practice.technicalOwnerId } });
    const after = projectHandoffReceipt.parse({ type: 'PROJECT_PRACTICE_PREPARATION_V1', version: 1,
      sessionId: p.auth.registry.id, clientId: p.client.id, projectId: input.projectId,
      technicalPracticeId: practice.id, decisionId: decision.id, fingerprint });
    const saved = await tx.auditLog.create({ data: { id: input.commandId, actorId: claimed.userId, event, entityType: 'Project', entityId: input.projectId, after } });
    if (canonicalSha256(projectHandoffReceipt.parse(saved.after)) !== canonicalSha256(after)) deny();
    await p.auth.finish();
    return { confirmed: true as const, practiceId: practice.id };
  });
}
export async function readProjectHandoffReceipt(db: PrismaClient, claimed: AuthSession, projectId: string, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => {
    const c = await context(tx, claimed, projectId, false);
    const found = await receipt(tx, claimed, commandId, projectId);
    await c.auth.finish();
    return found ?? { confirmed: false as const };
  });
}
