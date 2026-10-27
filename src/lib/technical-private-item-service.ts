import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { hasPermission } from './permission-evaluator';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { technicalAssignmentClock, TechnicalAssignmentError, withTechnicalAssignmentManagementRead,
  withTechnicalPrivateItemDecision, type TechnicalAssignmentPersonalProof, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalPrivateItemAdmission, technicalPrivateItemCommand, technicalPrivateItemRequestDigest,
  type TechnicalPrivateItemCommand } from './technical-private-item-contract';
import { previewTechnicalPrivateItemCreation } from './technical-private-item-proof';
import { prepareTechnicalPrivateItemRecord } from './technical-private-item-journal';
import { loadTechnicalPrivateItemRecord, persistTechnicalPrivateItem } from './technical-private-item-persistence';

type Tx = Prisma.TransactionClient;
function deny(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }

async function lockedTarget(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, write: boolean) {
  if (state.recipient || !hasPermission(state.current, 'service.write')
    || state.current.permissionOverrides.some(p => p.permission === 'service.write' && !p.allowed)) deny();
  const context = await lockTechnicalAssignmentContext(tx, target, { writeTarget: write });
  if (!context || !context.operational || hasSelectiveClientContext(state.current, context)
    || hasSelectiveContext(state.current, context)
    || (target.kind === 'TechnicalPractice' && isSelectivePractice(state.current, target.targetId))) deny();
  const project = context.projectId ? await tx.project.findUnique({ where: { id: context.projectId }, select: { companyId: true } }) : null;
  const companyId = project?.companyId ?? null;
  let companyGeneration: number | null = null;
  if (companyId) {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${companyId} FOR SHARE`;
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { clientId: true, deletedAt: true } });
    const generations = await tx.$queryRaw<Array<{ generation: number }>>`SELECT generation FROM "SelectiveCompanyGeneration" WHERE "companyId"=${companyId} FOR SHARE`;
    if (!company || company.deletedAt || company.clientId !== context.clientId || generations.length !== 1
      || !Number.isSafeInteger(generations[0].generation) || generations[0].generation < 1) deny();
    companyGeneration = generations[0].generation;
  }
  const parent = { clientId: context.clientId, projectId: context.projectId, serviceId: context.clientServiceId, companyId };
  return { parent, contextSha256: canonicalSha256({ protocol: 'TECHNICAL_PRIVATE_ITEM_CONTEXT_V1',
    contextSha256: context.contextSha256, parent, companyGeneration }) };
}
function admission(state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, locked: Awaited<ReturnType<typeof lockedTarget>>) {
  if (!state.personalProofExpiresAt) deny();
  return technicalPrivateItemAdmission.parse({ authorityId: state.authority.id, authorityUserId: state.authority.userId,
    authorityRevision: state.authority.revision, authorityEnabled: state.authority.enabled,
    actorId: state.current.userId, actorEpoch: state.actor.recordUpdateEpoch, role: state.current.role,
    managerAllowed: true, serviceWriteAllowed: true, sessionId: state.current.sessionId,
    sessionExpiresAt: Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime()),
    personalProofExpiresAt: state.personalProofExpiresAt, keyVersion: state.key.version,
    target, targetOperational: true, ...locked });
}

/** GET context only: no item, origin, receipt, notification or grant is created. */
export async function loadTechnicalPrivateItemCreationContext(db: PrismaClient, claimed: AuthSession, rawTarget: unknown) {
  const target = technicalTargetReference.parse(rawTarget);
  return withTechnicalAssignmentManagementRead(db, claimed, target.kind, null, async (tx, state) => {
    const locked = await lockedTarget(tx, state, target, false);
    return { target, contextSha256: locked.contextSha256 };
  });
}

/** A personal POST preview; the existing step-up must remain current at confirm. */
export async function previewPrivateTechnicalItem(db: PrismaClient, claimed: AuthSession,
  proof: TechnicalAssignmentPersonalProof, raw: unknown) {
  const command = technicalPrivateItemCommand.parse(raw);
  return withTechnicalPrivateItemDecision(db, claimed, command.target.kind, proof, async (tx, state) => {
    const locked = await lockedTarget(tx, state, command.target, false);
    return previewTechnicalPrivateItemCreation(state.key, command, admission(state, command.target, locked),
      (await technicalAssignmentClock(tx)).getTime());
  });
}

async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference,
  commandId: string, command?: TechnicalPrivateItemCommand) {
  const saved = await loadTechnicalPrivateItemRecord(tx, state, commandId);
  if (!saved) return null;
  if (saved.receipt.actorId !== state.current.userId || saved.receipt.sessionId !== state.current.sessionId
    || saved.receipt.authorityRevision !== state.authority.revision || saved.admission.actorEpoch !== state.actor.recordUpdateEpoch
    || canonicalJson(saved.command.target) !== canonicalJson(target)
    || (command && saved.receipt.requestDigest !== technicalPrivateItemRequestDigest(command))) stale();
  return saved.receipt;
}

export async function confirmPrivateTechnicalItem(db: PrismaClient, claimed: AuthSession,
  proof: TechnicalAssignmentPersonalProof, raw: unknown, token: string, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 48_000) deny();
  const command = technicalPrivateItemCommand.parse(raw);
  if (canonicalJson(raw) !== canonicalJson(command)) stale();
  return withTechnicalPrivateItemDecision(db, claimed, command.target.kind, proof, async (tx, state) => {
    const locked = await lockedTarget(tx, state, command.target, true);
    const previous = await outcome(tx, state, command.target, command.commandId, command);
    if (previous) return previous;
    const current = admission(state, command.target, locked);
    const record = prepareTechnicalPrivateItemRecord(state.key, command, current, token, confirmed, await technicalAssignmentClock(tx));
    if (!record) stale();
    const receipt = await persistTechnicalPrivateItem(tx, state, record);
    // Clock, session, authority and personal proof are rechecked before commit
    // by the shared transaction. Expired command previews also roll back.
    if (!prepareTechnicalPrivateItemRecord(state.key, command, current, token, confirmed, await technicalAssignmentClock(tx))) stale();
    return receipt;
  });
}

export async function readPrivateTechnicalItemOutcome(db: PrismaClient, claimed: AuthSession, rawTarget: unknown, commandId: string) {
  const target = technicalTargetReference.parse(rawTarget);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentManagementRead(db, claimed, target.kind, null, async (tx, state) => {
    await lockedTarget(tx, state, target, false);
    const receipt = await outcome(tx, state, target, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  });
}
