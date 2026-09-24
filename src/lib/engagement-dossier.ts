import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type Client, type Project, type ClientService, type EngagementDossierDeliveryAuthorization, type EngagementDossierDeliveryReceipt } from '@prisma/client';
import { z } from 'zod';
import { canViewChecklistItem, canViewClientContext, canViewDocument } from './access-control';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { loadClientReadScope } from './client-read-perimeter';
import { lockAuthoritativeInternalSession } from './internal-session-registry';

export class EngagementDossierError extends Error {
  constructor(readonly code: 'DENIED' | 'CONFLICT' | 'NOT_READY' | 'INVALID') { super(code); }
}

type Db = Pick<PrismaClient, '$transaction'>;
type Runtime = { now?: () => Date; failAudit?: boolean };
const identifier = z.string().trim().min(1).max(128);
const uuid = z.string().uuid();
const contentInput = z.string().trim().min(1).max(200_000);
function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new EngagementDossierError('INVALID');
  return parsed.data;
}
const recipientSchema = z.object({ kind: z.enum(['CLIENT', 'ADVISOR', 'INSTITUTION']), name: z.string().trim().min(1).max(200), address: z.string().trim().min(1).max(320), synthetic: z.boolean().default(false) });

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function engagementDossierHash(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex'); }
function fresh(claimed: AuthSession, now: Date) { if (!claimed.active || !Number.isInteger(claimed.expiresAt) || claimed.expiresAt * 1000 <= now.getTime()) throw new EngagementDossierError('DENIED'); }

function deliveryRecipients(authorization: EngagementDossierDeliveryAuthorization, versions: Array<{ id: string; contentHash: string }>) {
  const parsed = z.array(recipientSchema).min(1).max(20).safeParse(authorization.recipients);
  const version = versions.find((row) => row.id === authorization.versionId);
  if (!parsed.success || !version || version.contentHash !== authorization.versionHash
    || engagementDossierHash(parsed.data) !== authorization.recipientsHash
    || engagementDossierHash({ dossierId: authorization.dossierId, versionId: authorization.versionId, versionHash: authorization.versionHash, recipientsHash: authorization.recipientsHash }) !== authorization.idempotencyHash) throw new EngagementDossierError('DENIED');
  return parsed.data;
}

const storedDeliveryEvidence = z.object({
  reference: z.string().min(1).max(500), deliveredAt: z.string().datetime({ offset: true }),
  synthetic: z.boolean(), note: z.string().max(2000).optional(),
}).strict();

function assertDeliveryReceiptIntegrity(receipt: EngagementDossierDeliveryReceipt) {
  if (!z.enum(['DELIVERED', 'FAILED']).safeParse(receipt.outcome).success
    || !storedDeliveryEvidence.safeParse(receipt.evidence).success
    || engagementDossierHash(receipt.evidence) !== receipt.evidenceHash
    || engagementDossierHash({ authorizationId: receipt.authorizationId, outcome: receipt.outcome, evidenceHash: receipt.evidenceHash }) !== receipt.idempotencyHash) throw new EngagementDossierError('DENIED');
}

async function actor(tx: Prisma.TransactionClient, claimed: AuthSession, permission: 'dossier.read' | 'dossier.write' | 'dossier.approve', now: Date) {
  fresh(claimed, now);
  if (!claimed.sessionId || !uuid.safeParse(claimed.sessionId).success) throw new EngagementDossierError('DENIED');
  const user = await lockAuthoritativeInternalSession(tx, { sessionId: claimed.sessionId, userId: claimed.userId });
  if (!user || !user.live || user.revokedAt || !user.active || user.deletedAt) throw new EngagementDossierError('DENIED');
  const current = { ...claimed, clientReadScope: await loadClientReadScope(tx, claimed.userId), role: user.role, active: user.active, permissionOverrides: [...user.permissionOverrides] } satisfies AuthSession;
  if (!hasPermission(current, permission)) throw new EngagementDossierError('DENIED');
  return current;
}

const materialSnapshotSchema = z.array(z.object({
  checklistItemId: identifier, evidenceId: uuid, status: z.string(),
  documentId: identifier.nullable(), documentVersionId: identifier.nullable(), checksum: z.string().nullable(),
}));
type MaterialContext = { practiceId: string; client: Client; project: Project; service: ClientService };

async function assertMaterialAccess(tx: Prisma.TransactionClient, current: AuthSession, context: MaterialContext, snapshot: unknown) {
  const parsed = materialSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new EngagementDossierError('DENIED');
  const { client, project, service } = context;
  const hydratedProject = { ...project, client };
  const hydratedService = { ...service, client, project: hydratedProject };
  for (const row of parsed.data) {
    const [evidence, item, version] = await Promise.all([
      tx.practiceMaterialEvidence.findUnique({ where: { id: row.evidenceId } }),
      tx.documentChecklistItem.findFirst({ where: { id: row.checklistItemId, deletedAt: null } }),
      row.documentVersionId ? tx.documentVersion.findUnique({ where: { id: row.documentVersionId } }) : null,
    ]);
    if (!evidence || evidence.practiceId !== context.practiceId || evidence.checklistItemId !== row.checklistItemId
      || evidence.status !== row.status || evidence.documentId !== row.documentId
      || evidence.documentVersionId !== row.documentVersionId || evidence.documentChecksum !== row.checksum
      || !item || item.clientId !== client.id || item.projectId !== project.id
      || !canViewChecklistItem(current, { ...item, client, project: hydratedProject, clientService: item.clientServiceId === service.id ? hydratedService : null })
      || (row.documentVersionId && !version) || (row.documentId && version && version.documentId !== row.documentId)
      || (row.checksum && version?.checksum && row.checksum !== version.checksum)) throw new EngagementDossierError('DENIED');
    const documentIds = [...new Set([item.documentId, row.documentId, version?.documentId].filter((id): id is string => Boolean(id)))];
    for (const documentId of documentIds) {
      const document = await tx.document.findFirst({ where: { id: documentId, deletedAt: null } });
      if (!document || document.clientId !== client.id || !canViewDocument(current, {
        ...document, client, project: document.projectId === project.id ? hydratedProject : null,
        clientService: document.clientServiceId === service.id ? hydratedService : null,
      }, hasPermission(current, 'document.sensitive.read'))) throw new EngagementDossierError('DENIED');
    }
  }
}

async function scope(tx: Prisma.TransactionClient, current: AuthSession, dossierId: string) {
  const dossier = await tx.clientDossier.findUnique({ where: { id: dossierId } });
  if (!dossier || dossier.status === 'archiviata' || !dossier.practiceReadinessId || !dossier.preAnalysisId) throw new EngagementDossierError('DENIED');
  const [client, project, service] = await Promise.all([
    tx.client.findFirst({ where: { id: dossier.clientId, deletedAt: null } }),
    dossier.projectId ? tx.project.findFirst({ where: { id: dossier.projectId, deletedAt: null } }) : null,
    dossier.clientServiceId ? tx.clientService.findFirst({ where: { id: dossier.clientServiceId, deletedAt: null } }) : null,
  ]);
  if (!client || !project || !service) throw new EngagementDossierError('DENIED');
  const hydratedProject = { ...project, client };
  const hydratedService = { ...service, client, project: hydratedProject };
  if (!canViewClientContext(current, { clientId: dossier.clientId, client, project: hydratedProject, clientService: hydratedService })) throw new EngagementDossierError('DENIED');
  const [practice, preAnalysis, serviceRevision, versions] = await Promise.all([
    tx.practiceReadiness.findUnique({ where: { id: dossier.practiceReadinessId } }),
    tx.preAnalysis.findUnique({ where: { id: dossier.preAnalysisId } }),
    dossier.serviceRevisionId ? tx.serviceCatalogRevision.findUnique({ where: { id: dossier.serviceRevisionId } }) : null,
    tx.engagementDossierVersion.findMany({ where: { dossierId }, orderBy: { version: 'desc' } }),
  ]);
  if (!practice?.startedAt || practice.clientId !== client.id || practice.projectId !== project.id
    || practice.clientServiceId !== service.id || practice.serviceRevisionId !== dossier.serviceRevisionId
    || !serviceRevision || serviceRevision.serviceCatalogId !== service.serviceCatalogId
    || !preAnalysis || preAnalysis.clientId !== client.id || preAnalysis.projectId !== project.id
    || (preAnalysis.companyId && project.companyId && preAnalysis.companyId !== project.companyId)
    || !versions.some((version) => version.id === dossier.currentVersionId)
    || (dossier.approvedVersionId && !versions.some((version) => version.id === dossier.approvedVersionId))) throw new EngagementDossierError('DENIED');
  if (preAnalysis.companyId && !(await tx.company.findFirst({ where: { id: preAnalysis.companyId, clientId: client.id, deletedAt: null } }))) throw new EngagementDossierError('DENIED');
  const checkedSnapshots = new Set<string>();
  for (const version of versions) {
    const { dossierId: boundDossierId, version: number, title, content, practiceReadinessId, acceptedOfferRevisionId, serviceRevisionId, preAnalysisId, materialSnapshot } = version;
    if (practiceReadinessId !== practice.id || acceptedOfferRevisionId !== practice.acceptedOfferRevisionId
      || serviceRevisionId !== practice.serviceRevisionId || preAnalysisId !== preAnalysis.id
      || version.contentHash !== engagementDossierHash(versionPayload({ dossierId: boundDossierId, version: number, title, content, practiceReadinessId, acceptedOfferRevisionId, serviceRevisionId, preAnalysisId, materialSnapshot }))) throw new EngagementDossierError('DENIED');
    const snapshotHash = engagementDossierHash(materialSnapshot);
    if (!checkedSnapshots.has(snapshotHash)) {
      await assertMaterialAccess(tx, current, { practiceId: practice.id, client, project, service }, materialSnapshot);
      checkedSnapshots.add(snapshotHash);
    }
  }
  return { dossier, client, project: hydratedProject, service: hydratedService, versions };
}

async function readContext(tx: Prisma.TransactionClient, current: AuthSession, dossierId: string) {
  const context = await scope(tx, current, dossierId);
  const [reviews, authorizations] = await Promise.all([
    tx.engagementDossierReview.findMany({ where: { dossierId }, orderBy: { decidedAt: 'desc' } }),
    tx.engagementDossierDeliveryAuthorization.findMany({ where: { dossierId }, orderBy: { authorizedAt: 'desc' } }),
  ]);
  const receipts = await tx.engagementDossierDeliveryReceipt.findMany({ where: { authorizationId: { in: authorizations.map((row) => row.id) } } });
  if (reviews.some((review) => !context.versions.some((version) => version.id === review.versionId && version.contentHash === review.versionHash))) throw new EngagementDossierError('DENIED');
  receipts.forEach(assertDeliveryReceiptIntegrity);
  return { dossier: context.dossier, clientId: context.client.id, client: context.client, project: context.project, clientService: context.service,
    engagementHistory: { versions: context.versions, reviews, authorizations: authorizations.map((authorization) => ({ ...authorization, recipients: deliveryRecipients(authorization, context.versions) })), receipts } };
}

export async function getEngagementDossierReadAccess(db: Db, claimed: AuthSession, dossierId: string, runtime: Runtime = {}) {
  try {
    return await db.$transaction(async (tx) => {
      const current = await actor(tx, claimed, 'dossier.read', runtime.now?.() ?? new Date());
      return readContext(tx, current, dossierId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof EngagementDossierError) return null;
    throw error;
  }
}

export async function getVisibleEngagementDossierIds(db: Db, claimed: AuthSession, dossierIds: string[], runtime: Runtime = {}) {
  if (!dossierIds.length) return new Set<string>();
  try {
    const ids = await db.$transaction(async (tx) => {
      // One canonical actor lock/connection for the entire list, not one
      // competing interactive transaction per row on the same session.
      const current = await actor(tx, claimed, 'dossier.read', runtime.now?.() ?? new Date());
      const visible: string[] = [];
      for (const dossierId of new Set(dossierIds)) {
        try { await readContext(tx, current, dossierId); visible.push(dossierId); }
        catch (error) { if (!(error instanceof EngagementDossierError)) throw error; }
      }
      return visible;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return new Set(ids);
  } catch (error) {
    if (error instanceof EngagementDossierError) return new Set<string>();
    throw error;
  }
}

async function audit(tx: Prisma.TransactionClient, runtime: Runtime, actorId: string, event: string, dossierId: string, after: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { actorId, event, entityType: 'ClientDossier', entityId: dossierId, after } });
  if (runtime.failAudit) throw new EngagementDossierError('CONFLICT');
}

function versionPayload(input: { dossierId: string; version: number; title: string; content: string; practiceReadinessId: string; acceptedOfferRevisionId: string; serviceRevisionId: string; preAnalysisId: string; materialSnapshot: unknown }) {
  return { ...input, materialSnapshot: input.materialSnapshot };
}

export async function createEngagementDossier(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parseInput(z.object({ practiceReadinessId: uuid, preAnalysisId: identifier, title: z.string().trim().min(1).max(200), content: contentInput }), raw);
  const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => {
    const current = await actor(tx, claimed, 'dossier.write', now);
    await tx.$queryRaw`SELECT id FROM "PracticeReadiness" WHERE id=${input.practiceReadinessId}::uuid FOR UPDATE`;
    const practice = await tx.practiceReadiness.findUnique({ where: { id: input.practiceReadinessId }, include: { materials: { where: { successor: null }, orderBy: { checklistItemId: 'asc' } } } });
    if (!practice?.startedAt || !practice.clientServiceId) throw new EngagementDossierError('NOT_READY');
    const [preAnalysis, client, project, service] = await Promise.all([
      tx.preAnalysis.findUnique({ where: { id: input.preAnalysisId } }),
      tx.client.findFirst({ where: { id: practice.clientId, deletedAt: null } }),
      practice.projectId ? tx.project.findFirst({ where: { id: practice.projectId, deletedAt: null } }) : null,
      tx.clientService.findFirst({ where: { id: practice.clientServiceId, deletedAt: null } }),
    ]);
    if (!preAnalysis || preAnalysis.clientId !== practice.clientId || preAnalysis.projectId !== practice.projectId || !client || !project || !service || service.clientId !== practice.clientId || service.projectId !== practice.projectId || service.serviceCatalogId !== (await tx.serviceCatalogRevision.findUnique({ where: { id: practice.serviceRevisionId }, select: { serviceCatalogId: true } }))?.serviceCatalogId) throw new EngagementDossierError('DENIED');
    if (preAnalysis.companyId && ((project.companyId && preAnalysis.companyId !== project.companyId) || !(await tx.company.findFirst({ where: { id: preAnalysis.companyId, clientId: client.id, deletedAt: null } })))) throw new EngagementDossierError('DENIED');
    if (!canViewClientContext(current, { clientId: client.id, client, project: { ...project, client }, clientService: { ...service, client, project: { ...project, client } } })) throw new EngagementDossierError('DENIED');
    if (await tx.clientDossier.findUnique({ where: { practiceReadinessId: practice.id } })) throw new EngagementDossierError('CONFLICT');
    const materialSnapshot = practice.materials.map((row) => ({ checklistItemId: row.checklistItemId, evidenceId: row.id, status: row.status, documentId: row.documentId, documentVersionId: row.documentVersionId, checksum: row.documentChecksum }));
    await assertMaterialAccess(tx, current, { practiceId: practice.id, client, project, service }, materialSnapshot);
    const dossier = await tx.clientDossier.create({ data: { clientId: practice.clientId, projectId: practice.projectId, clientServiceId: practice.clientServiceId, practiceReadinessId: practice.id, preAnalysisId: preAnalysis.id, serviceRevisionId: practice.serviceRevisionId, type: 'dossier_cliente', title: input.title, content: input.content, createdById: current.userId, updatedById: current.userId } });
    const payload = versionPayload({ dossierId: dossier.id, version: 1, title: input.title, content: input.content, practiceReadinessId: practice.id, acceptedOfferRevisionId: practice.acceptedOfferRevisionId, serviceRevisionId: practice.serviceRevisionId, preAnalysisId: preAnalysis.id, materialSnapshot });
    const version = await tx.engagementDossierVersion.create({ data: { ...payload, contentHash: engagementDossierHash(payload), materialSnapshot: materialSnapshot as Prisma.InputJsonValue, createdById: current.userId } });
    await tx.clientDossier.update({ where: { id: dossier.id }, data: { currentVersionId: version.id } });
    await audit(tx, runtime, current.userId, 'engagement_dossier_create', dossier.id, { versionId: version.id, version: 1, contentHash: version.contentHash, practiceReadinessId: practice.id });
    return { dossier: { ...dossier, currentVersionId: version.id }, version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function reviseEngagementDossier(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parseInput(z.object({ dossierId: identifier, expectedVersionId: uuid, title: z.string().trim().min(1).max(200), content: contentInput }), raw);
  const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => {
    const current = await actor(tx, claimed, 'dossier.write', now); await tx.$queryRaw`SELECT id FROM "ClientDossier" WHERE id=${input.dossierId} FOR UPDATE`;
    const { dossier } = await scope(tx, current, input.dossierId);
    if (dossier.currentVersionId !== input.expectedVersionId || !dossier.practiceReadinessId || !dossier.preAnalysisId || !dossier.serviceRevisionId) throw new EngagementDossierError('CONFLICT');
    const previous = await tx.engagementDossierVersion.findUnique({ where: { id: input.expectedVersionId } }); if (!previous || previous.dossierId !== dossier.id) throw new EngagementDossierError('CONFLICT');
    if (previous.title === input.title && previous.content === input.content) return previous;
    const payload = versionPayload({ dossierId: dossier.id, version: previous.version + 1, title: input.title, content: input.content, practiceReadinessId: previous.practiceReadinessId, acceptedOfferRevisionId: previous.acceptedOfferRevisionId, serviceRevisionId: previous.serviceRevisionId, preAnalysisId: previous.preAnalysisId, materialSnapshot: previous.materialSnapshot });
    const version = await tx.engagementDossierVersion.create({ data: { ...payload, contentHash: engagementDossierHash(payload), materialSnapshot: previous.materialSnapshot as Prisma.InputJsonValue, createdById: current.userId } });
    await tx.clientDossier.update({ where: { id: dossier.id }, data: { title: input.title, content: input.content, currentVersionId: version.id, approvedVersionId: null, status: 'bozza', reviewedById: null, reviewedAt: null, updatedById: current.userId } });
    await audit(tx, runtime, current.userId, 'engagement_dossier_version_create', dossier.id, { previousVersionId: previous.id, versionId: version.id, version: version.version, contentHash: version.contentHash }); return version;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function reviewEngagementDossierVersion(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parseInput(z.object({ dossierId: identifier, versionId: uuid, versionHash: z.string().length(64), decision: z.enum(['REQUEST_CHANGES', 'APPROVED']), note: z.string().trim().min(1).max(2000) }), raw); const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => {
    const current = await actor(tx, claimed, 'dossier.approve', now); await tx.$queryRaw`SELECT id FROM "ClientDossier" WHERE id=${input.dossierId} FOR UPDATE`; const { dossier } = await scope(tx, current, input.dossierId);
    if (dossier.currentVersionId !== input.versionId) throw new EngagementDossierError('CONFLICT'); const version = await tx.engagementDossierVersion.findUnique({ where: { id: input.versionId } });
    if (!version || version.dossierId !== dossier.id || version.contentHash !== input.versionHash || version.createdById === current.userId) throw new EngagementDossierError('DENIED');
    const priorReviews = await tx.engagementDossierReview.findMany({ where: { versionId: version.id } });
    const existing = priorReviews.find((review) => review.decision === input.decision);
    if (existing) { if (existing.note === input.note && existing.versionHash === input.versionHash) return existing; throw new EngagementDossierError('CONFLICT'); }
    if (priorReviews.length > 0) throw new EngagementDossierError('CONFLICT');
    const review = await tx.engagementDossierReview.create({ data: { dossierId: dossier.id, versionId: version.id, versionHash: version.contentHash, decision: input.decision, note: input.note, decidedById: current.userId } });
    await tx.clientDossier.update({ where: { id: dossier.id }, data: input.decision === 'APPROVED' ? { approvedVersionId: version.id, status: 'revisionata', reviewedById: current.userId, reviewedAt: now, updatedById: current.userId } : { approvedVersionId: null, status: 'bozza', reviewedById: current.userId, reviewedAt: now, updatedById: current.userId } });
    await audit(tx, runtime, current.userId, input.decision === 'APPROVED' ? 'engagement_dossier_version_approve' : 'engagement_dossier_changes_requested', dossier.id, { versionId: version.id, versionHash: version.contentHash, decision: input.decision }); return review;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function exportApprovedEngagementDossier(db: Db, claimed: AuthSession, raw: unknown, artifact: Uint8Array | string, runtime: Runtime = {}) {
  const input = parseInput(z.object({ dossierId: identifier, versionId: uuid, format: z.enum(['markdown', 'docx']) }), raw); const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => { const current = await actor(tx, claimed, 'dossier.read', now); const { dossier } = await scope(tx, current, input.dossierId); if (dossier.approvedVersionId !== input.versionId) throw new EngagementDossierError('NOT_READY'); const version = await tx.engagementDossierVersion.findUnique({ where: { id: input.versionId } }); if (!version || version.dossierId !== dossier.id) throw new EngagementDossierError('DENIED'); const artifactHash = createHash('sha256').update(artifact).digest('hex'); const record = await tx.engagementDossierExport.create({ data: { dossierId: dossier.id, versionId: version.id, versionHash: version.contentHash, format: input.format, artifactHash, exportedById: current.userId } }); await audit(tx, runtime, current.userId, 'engagement_dossier_export', dossier.id, { exportId: record.id, versionId: version.id, versionHash: version.contentHash, format: input.format, artifactHash }); return { version, record }; }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function authorizeEngagementDossierDelivery(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parseInput(z.object({ dossierId: identifier, versionId: uuid, versionHash: z.string().length(64), recipients: z.array(recipientSchema).min(1).max(20) }), raw); const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => { const current = await actor(tx, claimed, 'dossier.approve', now); await tx.$queryRaw`SELECT id FROM "ClientDossier" WHERE id=${input.dossierId} FOR UPDATE`; const { dossier } = await scope(tx, current, input.dossierId); if (dossier.approvedVersionId !== input.versionId) throw new EngagementDossierError('NOT_READY'); const version = await tx.engagementDossierVersion.findUnique({ where: { id: input.versionId } }); if (!version || version.dossierId !== dossier.id || version.contentHash !== input.versionHash) throw new EngagementDossierError('CONFLICT'); const recipients = [...input.recipients].sort((a,b) => `${a.kind}:${a.address}`.localeCompare(`${b.kind}:${b.address}`)); const recipientsHash = engagementDossierHash(recipients); const idempotencyHash = engagementDossierHash({ dossierId: dossier.id, versionId: version.id, versionHash: version.contentHash, recipientsHash }); const existing = await tx.engagementDossierDeliveryAuthorization.findUnique({ where: { idempotencyHash } }); if (existing) { if (existing.revokedAt) throw new EngagementDossierError('DENIED'); return existing; } const authorization = await tx.engagementDossierDeliveryAuthorization.create({ data: { dossierId: dossier.id, versionId: version.id, versionHash: version.contentHash, recipients: recipients as Prisma.InputJsonValue, recipientsHash, idempotencyHash, authorizedById: current.userId } }); await audit(tx, runtime, current.userId, 'engagement_dossier_delivery_authorize', dossier.id, { authorizationId: authorization.id, versionId: version.id, versionHash: version.contentHash, recipientsHash }); return authorization; }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function recordEngagementDossierDelivery(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parseInput(z.object({ authorizationId: uuid, outcome: z.enum(['DELIVERED', 'FAILED']), evidence: z.object({ reference: z.string().trim().min(1).max(500), deliveredAt: z.union([z.date(), z.string().datetime({ offset: true }).transform((value) => new Date(value))]), synthetic: z.boolean().default(false), note: z.string().trim().max(2000).optional() }) }), raw); const now = runtime.now?.() ?? new Date();
  return db.$transaction(async (tx) => { const current = await actor(tx, claimed, 'dossier.write', now); await tx.$queryRaw`SELECT id FROM "EngagementDossierDeliveryAuthorization" WHERE id=${input.authorizationId}::uuid FOR UPDATE`; const authorization = await tx.engagementDossierDeliveryAuthorization.findUnique({ where: { id: input.authorizationId } }); if (!authorization || authorization.revokedAt) throw new EngagementDossierError('DENIED'); const { dossier, versions } = await scope(tx, current, authorization.dossierId); deliveryRecipients(authorization, versions); if (dossier.approvedVersionId !== authorization.versionId) throw new EngagementDossierError('CONFLICT'); const evidence = { reference: input.evidence.reference, deliveredAt: input.evidence.deliveredAt.toISOString(), synthetic: input.evidence.synthetic, ...(input.evidence.note !== undefined ? { note: input.evidence.note } : {}) }; const evidenceHash = engagementDossierHash(evidence); const idempotencyHash = engagementDossierHash({ authorizationId: authorization.id, outcome: input.outcome, evidenceHash }); const prior = await tx.engagementDossierDeliveryReceipt.findUnique({ where: { authorizationId: authorization.id } }); if (prior) { assertDeliveryReceiptIntegrity(prior); if (prior.idempotencyHash === idempotencyHash) return prior; throw new EngagementDossierError('CONFLICT'); } const receipt = await tx.engagementDossierDeliveryReceipt.create({ data: { authorizationId: authorization.id, outcome: input.outcome, evidence: evidence as Prisma.InputJsonValue, evidenceHash, idempotencyHash, recordedById: current.userId } }); await audit(tx, runtime, current.userId, 'engagement_dossier_delivery_record', dossier.id, { receiptId: receipt.id, authorizationId: authorization.id, versionId: authorization.versionId, outcome: input.outcome, evidenceHash }); return receipt; }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
