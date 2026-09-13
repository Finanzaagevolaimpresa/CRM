import { Prisma, type PrismaClient } from '@prisma/client';
import { canEditProject } from './access-control';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { manualPreAnalysisFields } from './preanalysis-policy';

export class ManualPreAnalysisError extends Error {
  constructor(readonly code: 'DENIED' | 'CONFLICT') { super(code); }
}

type Db = Pick<PrismaClient, '$transaction'>;
type Narratives = Partial<Record<(typeof manualPreAnalysisFields)[number], string | null>>;
type Runtime = { nowSeconds?: () => number };

function requireFreshClaim(claimed: AuthSession, runtime: Runtime) {
  const nowSeconds = runtime.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claimed.expiresAt) || claimed.expiresAt <= nowSeconds) throw new ManualPreAnalysisError('DENIED');
}

async function currentActor(tx: Prisma.TransactionClient, claimed: AuthSession) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${claimed.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "UserPermissionOverride" WHERE "userId" = ${claimed.userId} FOR UPDATE`;
  if (claimed.sessionId) await tx.$queryRaw`SELECT id FROM "InternalSession" WHERE id = ${claimed.sessionId}::uuid FOR UPDATE`;
  const user = await tx.user.findFirst({
    where: { id: claimed.userId, active: true, deletedAt: null },
    include: { permissionOverrides: { select: { permission: true, allowed: true } } },
  });
  if (!user) throw new ManualPreAnalysisError('DENIED');
  if (claimed.sessionId) {
    const session = await tx.internalSession.findFirst({ where: { id: claimed.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (!session) throw new ManualPreAnalysisError('DENIED');
  }
  const actor = { userId: user.id, role: user.role, active: user.active, permissionOverrides: user.permissionOverrides, expiresAt: claimed.expiresAt, sessionId: claimed.sessionId } satisfies AuthSession;
  if (!hasPermission(actor, 'dossier.read') || !hasPermission(actor, 'project.write')) throw new ManualPreAnalysisError('DENIED');
  return actor;
}

async function writableContext(tx: Prisma.TransactionClient, actor: AuthSession, clientId: string, projectId: string, companyId?: string | null) {
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  const [client, project] = await Promise.all([
    tx.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }),
    tx.project.findFirst({ where: { id: projectId, clientId, deletedAt: null } }),
  ]);
  if (!client || !project) throw new ManualPreAnalysisError('DENIED');
  const companyIds = [...new Set([companyId, project.companyId].filter((id): id is string => Boolean(id)))];
  if (companyIds.length) await tx.$queryRaw`SELECT id FROM "Company" WHERE id IN (${Prisma.join(companyIds)}) FOR UPDATE`;
  const companies = companyIds.length ? await tx.company.findMany({ where: { id: { in: companyIds }, clientId, deletedAt: null }, select: { id: true } }) : [];
  const validCompanyIds = new Set(companies.map((company) => company.id));
  if ((companyId && !validCompanyIds.has(companyId)) || (project.companyId && !validCompanyIds.has(project.companyId)) || (companyId && project.companyId && project.companyId !== companyId) || !canEditProject(actor, { ...project, client })) {
    throw new ManualPreAnalysisError('DENIED');
  }
  return { client, project };
}

function values(input: Narratives) {
  return Object.fromEntries(manualPreAnalysisFields.map((field) => [field, input[field] ?? null])) as Record<(typeof manualPreAnalysisFields)[number], string | null>;
}

export function createManualPreAnalysisRecord(db: Db, actor: AuthSession, input: Narratives & { clientId: string; projectId: string; companyId?: string }, runtime: Runtime = {}) {
  return db.$transaction(async (tx) => {
    requireFreshClaim(actor, runtime);
    const current = await currentActor(tx, actor);
    await writableContext(tx, current, input.clientId, input.projectId, input.companyId);
    requireFreshClaim(actor, runtime);
    const narratives = values(input);
    const record = await tx.preAnalysis.create({ data: { clientId: input.clientId, projectId: input.projectId, companyId: input.companyId, ...narratives } });
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'preanalysis_create', entityType: 'PreAnalysis', entityId: record.id, after: { recordId: record.id, changedFields: manualPreAnalysisFields.filter((field) => Boolean(record[field])) } } });
    return record;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function updateManualPreAnalysisRecord(db: Db, actor: AuthSession, input: Narratives & { id: string; version: Date }, runtime: Runtime = {}) {
  return db.$transaction(async (tx) => {
    requireFreshClaim(actor, runtime);
    const current = await currentActor(tx, actor);
    await tx.$queryRaw`SELECT id FROM "PreAnalysis" WHERE id = ${input.id} FOR UPDATE`;
    const before = await tx.preAnalysis.findUnique({ where: { id: input.id } });
    if (!before) throw new ManualPreAnalysisError('DENIED');
    await writableContext(tx, current, before.clientId, before.projectId, before.companyId);
    const editable = (before.status === 'da_avviare' || before.status === 'raccolta_dati') && !before.aiRunId && !before.reviewedById && !before.approvedById && !before.approvedAt;
    if (!editable || before.updatedAt.getTime() !== input.version.getTime()) throw new ManualPreAnalysisError('CONFLICT');
    requireFreshClaim(actor, runtime);
    const narratives = values(input);
    const changedFields = manualPreAnalysisFields.filter((field) => before[field] !== narratives[field]);
    if (!changedFields.length) return { record: before, changed: false as const };
    const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1));
    const cas = await tx.preAnalysis.updateMany({ where: { id: before.id, updatedAt: before.updatedAt }, data: { ...narratives, updatedAt } });
    if (cas.count !== 1) throw new ManualPreAnalysisError('CONFLICT');
    const record = await tx.preAnalysis.findUniqueOrThrow({ where: { id: before.id } });
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'preanalysis_manual_update', entityType: 'PreAnalysis', entityId: record.id, after: { recordId: record.id, changedFields } } });
    return { record, changed: true as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
