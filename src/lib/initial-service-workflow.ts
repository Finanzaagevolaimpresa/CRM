import { randomUUID, createHash } from 'node:crypto';
import { Prisma, type ClientDossier, type Client, type Project, type ClientService, type EngagementDossierVersion } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { loadClientReadScope } from './client-read-perimeter';
import { canViewClient, canViewClientContext, canViewDocument } from './access-control';
import { redactAuditPayload } from './data-classification';
import { readPrivateDocumentBounded } from './storage';
import { canonicalSha256 } from './canonical-json';
import { assessInitialServiceReviews, initialServicePlanSchema, initialServicePlanHash, initialServiceStages, initialServiceReviewSchema,
  initialServiceCodes, InitialServiceError, INITIAL_SERVICE_PROTOCOL, INITIAL_SERVICES, INITIAL_SERVICE_DISCLAIMER,
  type InitialServicePlan, type InitialServiceCode, type InitialServiceReview } from './initial-service-contract';

type Tx = Prisma.TransactionClient;
export type InitialServiceContext = { dossier: ClientDossier; client: Client; project: Project; service: ClientService; versions: EngagementDossierVersion[] };
export type InitialServiceRuntime = { readDocument?: typeof readPrivateDocumentBounded; failAudit?: boolean };
const PLAN = 'm5_initial_service_plan', REVIEW = 'm5_initial_service_review';
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
function denied(): never { throw new InitialServiceError('DENIED'); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new InitialServiceError('INVALID'); return parsed.data;
}
// Typed identifiers only: preserve UUIDs through the unchanged N04 redactor.
function identifiers(value: unknown, decode = false): unknown {
  if (Array.isArray(value)) return value.map(item => identifiers(item, decode));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, identifiers(item, decode)]));
  if (typeof value !== 'string') return value;
  if (!decode && z.string().uuid().safeParse(value).success) return 'svc_uuid_' + value.replaceAll('-', '');
  if (decode && /^svc_uuid_[a-f0-9]{32}$/i.test(value)) {
    const hex = value.slice(9); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  return value;
}
function stored(raw: unknown) {
  const receipt = redactAuditPayload(identifiers(raw)) as Record<string, unknown>;
  return { ...receipt, hash: canonicalSha256(receipt) };
}
function restored(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) denied();
  const { hash: checksum, ...receipt } = raw as Record<string, unknown>;
  if (checksum !== canonicalSha256(receipt)) denied();
  return identifiers(receipt, true) as Record<string, unknown>;
}
function planReceipt(plan: InitialServicePlan) {
  return { type: INITIAL_SERVICE_PROTOCOL, workflowId: plan.workflowId, caseId: plan.caseId, serviceId: plan.serviceId,
    serviceCode: plan.serviceCode, definitionVersion: plan.definitionVersion, outputKind: plan.outputKind, enabled: plan.numericAnalysis,
    source: plan.supportingAgents, version: plan.planVersion, responsibleUserId: plan.responsibleUserId,
    overrides: plan.humanReviewerIds.map(userId => ({ userId })) };
}
function readPlan(value: Record<string, unknown>) {
  return parse(initialServicePlanSchema, { protocol: value.type, workflowId: value.workflowId, caseId: value.caseId, serviceId: value.serviceId,
    serviceCode: value.serviceCode, definitionVersion: value.definitionVersion, outputKind: value.outputKind, numericAnalysis: value.enabled,
    supportingAgents: value.source, planVersion: value.version, responsibleUserId: value.responsibleUserId,
    humanReviewerIds: parse(z.array(z.object({ userId: id })), value.overrides).map(item => item.userId) });
}
async function append(tx: Tx, current: AuthSession, dossierId: string, event: string, value: unknown, runtime: InitialServiceRuntime) {
  const after = stored(value);
  const row = await tx.auditLog.create({ data: { actorId: current.userId, event, entityType: 'ClientDossier', entityId: dossierId, after: after as Prisma.InputJsonValue } });
  if (runtime.failAudit || canonicalSha256(row.after) !== canonicalSha256(after)) throw new InitialServiceError('CONFLICT');
  return row;
}
function liveVersion(context: InitialServiceContext) {
  const version = context.versions.find(row => row.id === context.dossier.currentVersionId);
  if (!version) denied(); return version;
}
async function codeFor(tx: Tx, context: InitialServiceContext): Promise<InitialServiceCode | null> {
  const catalog = await tx.serviceCatalog.findUnique({ where: { id: context.service.serviceCatalogId } });
  return catalog && initialServiceCodes.includes(catalog.code as InitialServiceCode) ? catalog.code as InitialServiceCode : null;
}
type SavedReview = { review: InitialServiceReview; documentVersionId: string | null; sessionId: string };
export async function readInitialServiceState(tx: Tx, context: InitialServiceContext) {
  const code = await codeFor(tx, context);
  const rows = await tx.auditLog.findMany({ where: { entityType: 'ClientDossier', entityId: context.dossier.id, event: { in: [PLAN, REVIEW] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!code) { if (rows.length) denied(); return null; }
  const plans = rows.filter(row => row.event === PLAN).map(row => readPlan(restored(row.after))).sort((a,b) => a.planVersion - b.planVersion);
  plans.forEach((plan, index) => {
    if (plan.caseId !== context.dossier.id || plan.serviceId !== context.service.id || plan.serviceCode !== code
      || plan.planVersion !== index + 1 || (index && plan.workflowId !== plans[0].workflowId)) denied();
  });
  const plan = plans.at(-1) ?? null, version = liveVersion(context);
  const allReviews: SavedReview[] = rows.filter(row => row.event === REVIEW).map(row => {
    const data = restored(row.after);
    const review = parse(initialServiceReviewSchema, { stage: data.stageCode, decision: data.decisionCode, versionId: data.versionId,
      versionHash: data.versionHash, planHash: data.planHash, actorId: data.actorId, recordedAt: data.recordedAt, source: data.mode,
      reference: data.referenceCode, artifactHash: data.artifactHash, note: data.reason, agentId: data.agentId, agentVersionReference: data.agentVersion });
    if (review.actorId !== row.actorId || !context.versions.some(v => v.id === review.versionId && v.contentHash === review.versionHash)
      || !plans.some(p => initialServicePlanHash(p) === review.planHash)) denied();
    return { review, documentVersionId: parse(id.nullable(), data.documentVersionId), sessionId: parse(z.string().uuid(), data.sessionId) };
  });
  const active = plan ? allReviews.filter(row => row.review.versionId === version.id && row.review.planHash === initialServicePlanHash(plan)) : [];
  // Stage order is explicit; timestamps can be identical within one millisecond.
  if (plan) active.sort((a,b) => initialServiceStages(plan).stages.indexOf(a.review.stage) - initialServiceStages(plan).stages.indexOf(b.review.stage));
  let assessment = plan ? assessInitialServiceReviews(plan, active.map(row => row.review), version) : null;
  // A new assignment plan cannot clear a change request on the same dossier version.
  // Keep the original receipt and require a new content version to resume reviews.
  if (assessment && allReviews.some(row => row.review.versionId === version.id && row.review.decision === 'REQUEST_CHANGES')) {
    assessment = { ...assessment, ready: false, blocked: 'CHANGES_REQUIRED', nextStage: null };
  }
  return { code, definition: INITIAL_SERVICES[code], plan, planHash: plan ? initialServicePlanHash(plan) : null,
    version, active, allReviews, assessment };
}
// A client consultation grant alone never opens work. The latest admin plan
// explicitly assigns a human reviewer to this exact dossier and service.
export async function hasInitialServiceReviewAssignment(tx: Tx, current: AuthSession, context: InitialServiceContext) {
  if (!hasPermission(current, 'dossier.approve') || !canViewClient(current, context.client)) return false;
  const state = await readInitialServiceState(tx, context);
  return state?.plan?.humanReviewerIds.includes(current.userId) === true;
}
async function livePerson(tx: Tx, context: InitialServiceContext, userId: string, approve: boolean) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
  const row = await tx.user.findUnique({ where: { id: userId }, include: { permissionOverrides: true } });
  if (!row?.active || row.deletedAt || !hasPermission(row, approve ? 'dossier.approve' : 'dossier.write')) denied();
  const current = { userId, role: row.role, active: row.active, permissionOverrides: row.permissionOverrides,
    expiresAt: Math.floor(Date.now() / 1000) + 60, clientReadScope: await loadClientReadScope(tx, userId) } satisfies AuthSession;
  if (approve ? !canViewClient(current, context.client) || !hasPermission(current, 'dossier.read')
    : !canViewClientContext(current, { clientId: context.client.id, client: context.client, project: { ...context.project, client: context.client },
      clientService: { ...context.service, client: context.client, project: { ...context.project, client: context.client } } })) denied();
  return current;
}
export async function configureInitialService(tx: Tx, current: AuthSession, context: InitialServiceContext, raw: unknown, runtime: InitialServiceRuntime = {}) {
  if (current.role !== 'admin') denied();
  const input = parse(z.object({ expectedPlanHash: hash.nullable(), expectedVersionId: z.string().uuid(), responsibleUserId: id,
    humanReviewerIds: z.array(id).min(1).max(2), outputKind: z.enum(['REPORT', 'BUSINESS_PLAN', 'APPLICATION']),
    numericAnalysis: z.boolean(), supportingAgents: z.array(z.enum(['A05', 'A06', 'A07', 'A09', 'A10', 'A11'])).max(6) }).strict(), raw);
  const state = await readInitialServiceState(tx, context);
  if (!state || context.dossier.approvedVersionId || state.version.id !== input.expectedVersionId || state.planHash !== input.expectedPlanHash) throw new InitialServiceError('CONFLICT');
  const { expectedPlanHash: _expectedPlanHash, expectedVersionId: _expectedVersionId, ...configuration } = input;
  void _expectedPlanHash; void _expectedVersionId;
  const plan = parse(initialServicePlanSchema, { ...configuration,
    protocol: INITIAL_SERVICE_PROTOCOL, workflowId: state.plan?.workflowId ?? randomUUID(), caseId: context.dossier.id, serviceId: context.service.id,
    serviceCode: state.code, definitionVersion: 1, planVersion: (state.plan?.planVersion ?? 0) + 1 });
  if (new Set(plan.humanReviewerIds).size !== plan.humanReviewerIds.length || plan.humanReviewerIds.includes(plan.responsibleUserId!)
    || plan.humanReviewerIds.includes(state.version.createdById) || plan.humanReviewerIds.length !== initialServiceStages(plan).humanReviewersRequired) denied();
  if (state.plan && ((state.plan.numericAnalysis && !plan.numericAnalysis)
    || (state.plan.outputKind !== 'REPORT' && plan.outputKind !== state.plan.outputKind)
    || state.plan.supportingAgents.some(agent => !plan.supportingAgents.includes(agent)))) denied();
  await livePerson(tx, context, plan.responsibleUserId!, false);
  for (const userId of plan.humanReviewerIds) await livePerson(tx, context, userId, true);
  await append(tx, current, context.dossier.id, PLAN, planReceipt(plan), runtime);
  await readInitialServiceState(tx, context);
  return plan;
}
async function reviewDocument(tx: Tx, current: AuthSession, context: InitialServiceContext, versionId: string, runtime: InitialServiceRuntime) {
  const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
  const doc = version && await tx.document.findUnique({ where: { id: version.documentId } });
  if (!version || !doc || doc.deletedAt || doc.clientId !== context.client.id || (doc.projectId && doc.projectId !== context.project.id)
    || (doc.clientServiceId && doc.clientServiceId !== context.service.id) || ['respinto','scaduto','archiviato'].includes(doc.status)
    || (doc.validUntil && doc.validUntil.getTime() <= Date.now()) || !hasPermission(current, 'document.download')
    || !canViewDocument(current, { ...doc, client: context.client,
      project: doc.projectId ? { ...context.project, client: context.client } : null,
      clientService: doc.clientServiceId ? { ...context.service, client: context.client, project: { ...context.project, client: context.client } } : null },
      hasPermission(current, 'document.sensitive.read'))) denied();
  let bytes: Buffer;
  try { bytes = await (runtime.readDocument ?? readPrivateDocumentBounded)(version.storagePath, 10 * 1024 * 1024); }
  catch { return denied(); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!version.checksum || digest !== version.checksum) denied(); return digest;
}
export async function recordInitialServiceReview(tx: Tx, current: AuthSession, context: InitialServiceContext, raw: unknown, runtime: InitialServiceRuntime = {}) {
  const input = parse(z.object({ expectedPlanHash: hash, expectedVersionId: z.string().uuid(), stage: initialServiceReviewSchema.shape.stage,
    decision: initialServiceReviewSchema.shape.decision, note: z.string().trim().min(10).max(4000),
    reference: initialServiceReviewSchema.shape.reference, agentVersionReference: initialServiceReviewSchema.shape.agentVersionReference,
    documentVersionId: id.nullable() }).strict(), raw);
  const state = await readInitialServiceState(tx, context);
  if (!state?.plan || state.planHash !== input.expectedPlanHash || state.version.id !== input.expectedVersionId || !state.assessment
    || state.assessment.nextStage !== input.stage || context.dossier.approvedVersionId) throw new InitialServiceError('CONFLICT');
  const human = input.stage.startsWith('HUMAN_'), na = input.stage === 'Q02' && input.decision === 'NOT_APPLICABLE';
  const assignedId = human ? state.plan.humanReviewerIds[input.stage === 'HUMAN_1' ? 0 : 1] : state.plan.responsibleUserId;
  if (!assignedId || current.userId !== assignedId) denied();
  await livePerson(tx, context, current.userId, human);
  const policy = initialServiceStages(state.plan);
  const artifactHash = human || na ? state.version.contentHash
    : input.documentVersionId ? await reviewDocument(tx, current, context, input.documentVersionId, runtime) : denied();
  const review = parse(initialServiceReviewSchema, { stage: input.stage, decision: input.decision, versionId: state.version.id,
    versionHash: state.version.contentHash, planHash: state.planHash, actorId: current.userId, recordedAt: new Date().toISOString(),
    source: human || na ? 'AUTHENTICATED_HUMAN' : 'MANUAL_WORK_ATTESTATION', reference: input.reference,
    artifactHash, note: input.note, agentId: human || na ? null : input.stage === 'PRODUCER' ? policy.producer : input.stage,
    agentVersionReference: human || na ? null : input.agentVersionReference });
  assessInitialServiceReviews(state.plan, [...state.active.map(row => row.review), review], state.version);
  await append(tx, current, context.dossier.id, REVIEW, { stageCode: review.stage, decisionCode: review.decision,
    versionId: review.versionId, versionHash: review.versionHash, planHash: review.planHash, actorId: review.actorId,
    recordedAt: review.recordedAt, mode: review.source, referenceCode: review.reference, artifactHash: review.artifactHash,
    reason: review.note, agentId: review.agentId, agentVersion: review.agentVersionReference,
    sessionId: current.sessionId, documentVersionId: human || na ? null : input.documentVersionId }, runtime);
  await readInitialServiceState(tx, context);
  return review;
}

export async function initialServiceChoices(tx: Tx, current: AuthSession, context: InitialServiceContext) {
  const users = current.role === 'admin' ? await tx.user.findMany({ where: { active: true, deletedAt: null },
    select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: 200 }) : [];
  const documents = hasPermission(current, 'document.download') ? await tx.document.findMany({
    where: { clientId: context.client.id, deletedAt: null, OR: [{ projectId: null }, { projectId: context.project.id }] },
    orderBy: { createdAt: 'desc' }, take: 100 }) : [];
  const visible = documents.filter(doc => (!doc.clientServiceId || doc.clientServiceId === context.service.id) && canViewDocument(current,
    { ...doc, client: context.client, project: doc.projectId ? { ...context.project, client: context.client } : null,
      clientService: doc.clientServiceId ? { ...context.service, client: context.client, project: { ...context.project, client: context.client } } : null },
    hasPermission(current, 'document.sensitive.read')));
  const versions = await tx.documentVersion.findMany({ where: { documentId: { in: visible.map(doc => doc.id) } },
    orderBy: [{ documentId: 'asc' }, { version: 'desc' }], take: 200 });
  return { users, documents: versions.map(version => ({ id: version.id, label: visible.find(doc => doc.id === version.documentId)!.title + ' · v' + version.version })) };
}
export async function assertInitialServiceReady(tx: Tx, current: AuthSession, context: InitialServiceContext, runtime: InitialServiceRuntime = {}, requireAdmin = false) {
  const state = await readInitialServiceState(tx, context);
  if (!state) return;
  if (requireAdmin && current.role !== 'admin') denied();
  if (!state.plan || !state.assessment?.ready) throw new InitialServiceError('REVIEW_REQUIRED');
  const content = state.version.content;
  if (!content.includes(INITIAL_SERVICE_DISCLAIMER) || !state.definition.sections.every(section => content.includes('## ' + section))
    || !['Cliente:', 'Servizio:', 'Data:', 'Revisione:', '## Fonti ed evidenze', '## Limiti', '## Prossimo passo'].every(label => content.includes(label))) throw new InitialServiceError('INVALID');
  for (const entry of state.active) {
    const row = entry.review;
    const person = await livePerson(tx, context, row.actorId, row.stage.startsWith('HUMAN_'));
    const session = await tx.internalSession.findUnique({ where: { id: entry.sessionId } });
    // A historical human judgment does not expire with its login cookie. Current
    // account permissions and scope are rechecked above; the original session is provenance.
    if (!session || session.userId !== row.actorId) denied();
    if (entry.documentVersionId && await reviewDocument(tx, person, context, entry.documentVersionId, runtime) !== row.artifactHash) denied();
  }
}
