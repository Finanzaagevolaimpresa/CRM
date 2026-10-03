import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthSession } from './auth';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { ContractSignatureError, canRecordContractSignature, contractCanRecordSignature, contractSignatureSchema, isSignatureDocument, signatureCalendarDay } from './contract-signature-policy';
import { contractSignatureDeclarationEvent, contractSignatureDeclarationSchema, orderedSignatureDeclarations } from './contract-signature-policy';

type Db = Pick<PrismaClient, '$transaction'>;
/** A declaration never updates Contract.signedAt/status or satisfies readiness. */
export async function declareContractSignature(db: Db, claimed: AuthSession, raw: unknown) {
  const input = contractSignatureDeclarationSchema.parse(raw);
  if (input.signedOn > signatureCalendarDay()) throw new ContractSignatureError('INVALID_DATE');
  return db.$transaction(async tx => {
    const actor = await freshActor(tx, claimed);
    const initial = await tx.contract.findUnique({ where: { id: input.contractId } });
    if (!initial) throw new ContractSignatureError('DENIED');
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${initial.clientId} FOR UPDATE`;
    const client = await tx.client.findFirst({ where: { id: initial.clientId, deletedAt: null } });
    if (initial.projectId) await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId} FOR UPDATE`;
    const project = initial.projectId ? await tx.project.findFirst({ where: { id: initial.projectId, deletedAt: null } }) : null;
    await tx.$queryRaw`SELECT id FROM "Contract" WHERE id=${initial.id} FOR UPDATE`;
    const contract = await tx.contract.findUnique({ where: { id: initial.id } });
    if (!client || !contract || contract.clientId !== initial.clientId || contract.projectId !== initial.projectId
      || (contract.projectId && !project) || !canRecordContractSignature(actor, client, project)) throw new ContractSignatureError('DENIED');
    const history = orderedSignatureDeclarations(await tx.auditLog.findMany({ where: { entityType: 'Contract', entityId: contract.id, event: contractSignatureDeclarationEvent } }));
    const previous = history[0]?.row;
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ actorId: actor.userId, ...input })).digest('hex');
    if (history[0]?.evidence.requestFingerprint === requestFingerprint) {
      await unexpired(tx, actor);
      return { contractId: contract.id, clientId: contract.clientId, declarationId: previous!.id, reconciled: true };
    }
    if (contract.updatedAt.toISOString() !== input.expectedVersion || (previous?.id ?? null) !== input.expectedDeclarationId) throw new ContractSignatureError('STALE');
    if (!contractCanRecordSignature(contract.status) || contract.signedAt || contract.signedDocumentId) throw new ContractSignatureError('CLOSED');
    await unexpired(tx, actor);
    const declaration = await tx.auditLog.create({ data: { actorId: actor.userId, entityType: 'Contract', entityId: contract.id,
      event: contractSignatureDeclarationEvent, before: { previousDeclarationId: previous?.id ?? null },
      after: { version: 1, evidenceKind: 'DECLARED_NOT_VERIFIED', sequence: (history[0]?.evidence.sequence ?? 0) + 1,
        previousDeclarationId: previous?.id ?? null, signedOn: input.signedOn, source: input.source, requestFingerprint } } });
    await unexpired(tx, actor);
    return { contractId: contract.id, clientId: contract.clientId, declarationId: declaration.id, reconciled: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
async function freshActor(tx: Prisma.TransactionClient, claimed: AuthSession): Promise<AuthSession> {
  if (!claimed.active || !Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= Date.now()) throw new ContractSignatureError('DENIED');
  if (claimed.sessionId) {
    const current = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId });
    if (!current?.active || current.deletedAt || current.revokedAt || !current.live) throw new ContractSignatureError('DENIED');
    return { ...claimed, role: current.role, permissionOverrides: [...current.permissionOverrides], clientReadScope: [] };
  }
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${claimed.userId} FOR UPDATE`;
  const current = await tx.user.findUnique({ where: { id: claimed.userId }, include: { permissionOverrides: true } });
  if (!current?.active || current.deletedAt) throw new ContractSignatureError('DENIED');
  return { ...claimed, role: current.role, permissionOverrides: current.permissionOverrides, clientReadScope: [] };
}
async function unexpired(tx: Prisma.TransactionClient, actor: AuthSession) {
  if (actor.expiresAt * 1000 <= Date.now()) throw new ContractSignatureError('DENIED');
  if (actor.sessionId) {
    const [row] = await tx.$queryRaw<Array<{ live: boolean }>>`SELECT "expiresAt">clock_timestamp() AND "revokedAt" IS NULL AS live FROM "InternalSession" WHERE id=${actor.sessionId}::uuid AND "userId"=${actor.userId}`;
    if (!row?.live) throw new ContractSignatureError('DENIED');
  }
}
export async function recordContractSignature(db: Db, claimed: AuthSession, raw: unknown) {
  const input = contractSignatureSchema.parse(raw);
  if (input.signedOn > signatureCalendarDay()) throw new ContractSignatureError('INVALID_DATE');
  return db.$transaction(async tx => {
    const actor = await freshActor(tx, claimed);
    const initial = await tx.contract.findUnique({ where: { id: input.contractId } });
    if (!initial) throw new ContractSignatureError('DENIED');
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${initial.clientId} FOR UPDATE`;
    const client = await tx.client.findFirst({ where: { id: initial.clientId, deletedAt: null } });
    if (initial.projectId) await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId} FOR UPDATE`;
    const project = initial.projectId ? await tx.project.findFirst({ where: { id: initial.projectId, deletedAt: null } }) : null;
    await tx.$queryRaw`SELECT id FROM "Contract" WHERE id=${initial.id} FOR UPDATE`;
    const contract = await tx.contract.findUnique({ where: { id: initial.id } });
    if (!client || !contract || contract.clientId !== initial.clientId || contract.projectId !== initial.projectId
      || (contract.projectId && !project) || !canRecordContractSignature(actor, client, project)) throw new ContractSignatureError('DENIED');
    if (contract.updatedAt.toISOString() !== input.expectedVersion) throw new ContractSignatureError('STALE');
    if (!contractCanRecordSignature(contract.status) || contract.signedAt || contract.signedDocumentId) throw new ContractSignatureError('CLOSED');
    const candidate = await tx.documentVersion.findUnique({ where: { id: input.signedDocumentVersionId } });
    if (!candidate) throw new ContractSignatureError('DOCUMENT_CHANGED');
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${candidate.documentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${candidate.id} FOR UPDATE`;
    const document = await tx.document.findUnique({ where: { id: candidate.documentId } });
    const version = await tx.documentVersion.findUnique({ where: { id: candidate.id } });
    const latest = await tx.documentVersion.findFirst({ where: { documentId: candidate.documentId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!document || !version || latest?.id !== version.id || !isSignatureDocument(actor, contract, client, project, document, version)) throw new ContractSignatureError('DOCUMENT_CHANGED');
    await unexpired(tx, actor);
    const signedAt = new Date(`${input.signedOn}T00:00:00.000Z`);
    await tx.contract.update({ where: { id: contract.id }, data: { status: 'firmato', signedAt, signedDocumentId: document.id } });
    await tx.auditLog.create({ data: { actorId: actor.userId, entityType: 'Contract', entityId: contract.id, event: 'contract_signature_recorded',
      before: { status: contract.status }, after: { status: 'firmato', signedOn: input.signedOn, signedDocumentId: document.id,
        signedDocumentVersionId: version.id, documentChecksum: version.checksum, attestation: 'EXISTING_SIGNED_DOCUMENT' } } });
    await unexpired(tx, actor);
    return { contractId: contract.id, clientId: contract.clientId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
