import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canEditLead, canViewClient, canViewCommercialOffer } from './access-control';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { maybeEnrollManualCommercialLead } from './commercial-lead-inbox';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { engagementFeatureEnabled } from './internal-engagement-mode';
import { hasPermission } from './permission-evaluator';
import { FAI_SERVICE_CATALOG_V2 } from './service-catalog-v2';
import { assertSyntheticCatalogDatabase, catalogRevisionIsSelectable } from './service-catalog-v2-persistence';

export const CONTROLLED_INTAKE_VERSION = 'controlled-intake-v1' as const;
export const controlledIntakeChannels = ['WPFORMS_1265', 'WPFORMS_1098', 'WPFORMS_1485', 'EMAIL'] as const;
export const controlledSubjectTypes = ['PERSONA', 'IMPRESA', 'PROFESSIONISTA', 'SOGGETTO_DA_COSTITUIRE', 'ASSOCIAZIONE', 'COOPERATIVA', 'ENTE'] as const;
const nullableText = (max: number) => z.preprocess(
  (value) => value === null ? undefined : value,
  z.string().trim().max(max).optional(),
).transform((value) => value || null);
export const controlledIntakeSchema = z.object({
  channel: z.enum(controlledIntakeChannels), sourceId: z.string().trim().min(1).max(120), sourceOccurredAt: z.string().datetime(),
  subjectType: z.enum(controlledSubjectTypes), firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), subjectName: nullableText(200),
  email: z.preprocess((value) => value === null ? undefined : value, z.string().trim().email().optional().or(z.literal(''))).transform((value) => value || null), phone: nullableText(80),
  serviceCode: nullableText(80), digitalProjectType: nullableText(80),
  effectiveCategory: z.string().trim().min(1).max(120), need: z.string().trim().min(1).max(2000), objective: nullableText(2000), functions: nullableText(2000),
  indicativeBudget: z.preprocess((value) => value === '' ? null : value, z.coerce.number().finite().nonnegative().nullable()), timing: nullableText(2000), declaredMaterials: nullableText(2000),
  engagementReference: nullableText(2000), commercialOfferId: nullableText(128), contractId: nullableText(128), administrativeRequest: nullableText(2000),
}).superRefine((value, context) => {
  if (value.channel === 'WPFORMS_1098' && (!value.digitalProjectType || !value.objective || !value.functions)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Brief digitale incompleto.' });
  if (value.channel === 'WPFORMS_1485' && !value.administrativeRequest) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Richiesta amministrativa obbligatoria.' });
  if (value.commercialOfferId && value.contractId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Un solo riferimento verificato è ammesso.' });
  if (value.channel !== 'WPFORMS_1485' && (value.commercialOfferId || value.contractId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Il riferimento verificato è ammesso solo per WPForms 1485.' });
});
export type ControlledIntakeInput = z.infer<typeof controlledIntakeSchema>;
export const controlledDuplicateDecisionSchema = z.object({
  intakeId: z.string().uuid(),
  candidateLeadId: z.string().trim().min(1).max(128),
  outcome: z.enum(['KEEP_DISTINCT', 'LINK_RELATED']),
  expectedVersion: z.coerce.number().int().positive(),
});
export const authenticated1265LinkSchema = z.object({
  projectionLedgerId: z.string().uuid(),
  effectiveCategory: z.string().trim().min(1).max(120),
  need: z.string().trim().min(1).max(2000),
  subjectType: z.enum(controlledSubjectTypes),
  serviceCode: nullableText(80),
  digitalProjectType: nullableText(80),
});
export class ControlledIntakeError extends Error { constructor(readonly code: 'DISABLED' | 'DENIED' | 'CONFLICT' | 'CATALOG_INVALID') { super(code); } }
type Db = Pick<PrismaClient, '$transaction' | '$queryRaw' | 'controlledIntake'>;

async function currentActor(tx: Prisma.TransactionClient, claimed: AuthSession) {
  const session = claimed.sessionId ? await lockAuthoritativeInternalSession(tx, { sessionId: claimed.sessionId, userId: claimed.userId }) : null;
  if (!session || session.revokedAt || !session.live || !session.active || session.deletedAt || !hasPermission({ role: session.role, active: session.active, permissionOverrides: session.permissionOverrides }, 'lead.write')) throw new ControlledIntakeError('DENIED');
  return session;
}

function requireEnabled() {
  if (!engagementFeatureEnabled(process.env.CONTROLLED_INTAKE_MODE)) throw new ControlledIntakeError('DISABLED');
}
async function assertControlledIntakeDatabase(db: Db) {
  requireEnabled();
  if (process.env.CONTROLLED_INTAKE_MODE === 'synthetic') await assertSyntheticCatalogDatabase(db);
}

async function selectableRevision(tx: Prisma.TransactionClient, serviceCode: string | null, digitalProjectType: string | null, now: Date) {
  if (!serviceCode) {
    if (digitalProjectType) throw new ControlledIntakeError('CATALOG_INVALID');
    return null;
  }
  const definition = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === serviceCode);
  if (!definition) throw new ControlledIntakeError('CATALOG_INVALID');
  const revision = await tx.serviceCatalogRevision.findFirst({
    where: { serviceCatalog: { code: definition.code } },
    include: { serviceCatalog: { select: { active: true, code: true } } },
    orderBy: { version: 'desc' },
  });
  const validDigitalType = definition.code === 'progetti_digitali'
    ? definition.detail.digitalProjectTypes?.some(({ code }) => code === digitalProjectType)
    : !digitalProjectType;
  if (!revision || !catalogRevisionIsSelectable(definition, revision, now) || !validDigitalType) {
    throw new ControlledIntakeError('CATALOG_INVALID');
  }
  return revision;
}

export async function createControlledIntake(db: Db, claimed: AuthSession, raw: unknown, faultAfterLead = false) {
  requireEnabled();
  // Registration cannot establish ownership, including crafted server-action payloads.
  if (raw && typeof raw === 'object' && ['assignedToId', 'salesOwnerId', 'consultantId', 'commercialOwnerId', 'technicalOwnerId', 'departmentId']
    .some(key => Object.prototype.hasOwnProperty.call(raw, key))) throw new ControlledIntakeError('DENIED');
  const input = controlledIntakeSchema.parse(raw); await assertControlledIntakeDatabase(db);
  const payloadHash = canonicalSha256(input);
  const run = () => db.$transaction(async (tx) => {
    const actor = await currentActor(tx, claimed);
    const existing = await tx.controlledIntake.findUnique({ where: { channel_sourceId: { channel: input.channel, sourceId: input.sourceId } }, include: { duplicateCandidates: true, duplicateDecision: true } });
    if (existing) {
      const lead = await tx.lead.findUnique({ where: { id: existing.leadId } });
      if (!lead || lead.deletedAt) throw new ControlledIntakeError('DENIED');
      const canEdit = canEditLead(actor, lead);
      const ownQueuedReceipt = lead.assignedToId === null && existing.operatorId === actor.userId;
      if (!canEdit && !ownQueuedReceipt) throw new ControlledIntakeError('DENIED');
      if (existing.payloadHash !== payloadHash) throw new ControlledIntakeError('CONFLICT');
      // A creator may acknowledge an identical queued submission, not read its current dossier.
      if (!canEdit) return { id: existing.id, leadId: existing.leadId, queued: true as const };
      const candidateLeads = await tx.lead.findMany({ where: { id: { in: existing.duplicateCandidates.map(({ leadId }) => leadId) }, deletedAt: null } });
      const visibleIds = new Set(candidateLeads.filter((candidate) => canEditLead(actor, candidate)).map(({ id }) => id));
      return { ...existing, duplicateCandidates: existing.duplicateCandidates.filter(({ leadId }) => visibleIds.has(leadId)), duplicateDecision: existing.duplicateDecision && visibleIds.has(existing.duplicateDecision.candidateLeadId) ? existing.duplicateDecision : null };
    }
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp()::timestamptz(3) AS now`)[0]?.now ?? new Date(0);
    const revision = await selectableRevision(tx, input.serviceCode, input.digitalProjectType, now);
    const candidates = input.email ? (await tx.lead.findMany({ where: { email: { equals: input.email, mode: 'insensitive' }, deletedAt: null }, take: 20 })).filter((lead) => canEditLead(actor, lead)) : [];
    let commercialOfferId: string | null = null; let contractId: string | null = null;
    if (input.commercialOfferId) {
      const offer = await tx.commercialOffer.findFirst({ where: { id: input.commercialOfferId, deletedAt: null } });
      const offerLead = offer?.leadId ? await tx.lead.findUnique({ where: { id: offer.leadId } }) : null;
      const offerClient = offer?.clientId ? await tx.client.findUnique({ where: { id: offer.clientId } }) : null;
      if (!offer || !canViewCommercialOffer(actor, { ...offer, lead: offerLead, client: offerClient })) throw new ControlledIntakeError('DENIED');
      const clientLead = offerClient?.leadId ? await tx.lead.findUnique({ where: { id: offerClient.leadId } }) : null;
      const relatedEmail = offerLead?.email ?? clientLead?.email;
      if (!input.email || relatedEmail?.toLowerCase() !== input.email.toLowerCase()) throw new ControlledIntakeError('CATALOG_INVALID');
      commercialOfferId = offer.id;
    }
    if (input.contractId) {
      const contract = await tx.contract.findUnique({ where: { id: input.contractId } });
      const client = contract ? await tx.client.findUnique({ where: { id: contract.clientId } }) : null;
      if (!contract || !client || !canViewClient(actor, client)) throw new ControlledIntakeError('DENIED');
      const clientLead = client.leadId ? await tx.lead.findUnique({ where: { id: client.leadId } }) : null;
      if (!input.email || clientLead?.email?.toLowerCase() !== input.email.toLowerCase()) throw new ControlledIntakeError('CATALOG_INVALID');
      contractId = contract.id;
    }
    const receiptId = randomUUID(); await tx.websiteLeadReceipt.create({ data: { id: receiptId, namespace: CONTROLLED_INTAKE_VERSION, keyDigest: canonicalSha256({ channel: input.channel, sourceId: input.sourceId }), payloadHash, status: 'completed', completedAt: now } });
    const lead = await tx.lead.create({ data: { firstName: input.firstName, lastName: input.lastName, companyName: input.subjectName, phone: input.phone, email: input.email, source: `INTAKE:${input.channel}:${input.sourceId}`, leadSource: input.channel === 'WPFORMS_1265' ? 'sito' : 'manuale', interest: input.serviceCode, declaredInvestment: input.indicativeBudget, status: 'nuovo', priority: 'media', commercialStatus: input.effectiveCategory, assignedToId: null, notes: null } });
    const record = await tx.controlledIntake.create({ data: { channel: input.channel, sourceId: input.sourceId, sourceOccurredAt: new Date(input.sourceOccurredAt), acquisitionMode: input.channel === 'WPFORMS_1265' ? 'MANUAL_CONTINUITY' : 'MANUAL_CONTROLLED', mappingVersion: 'service-mapping-2026-09-13-v2', payloadHash, leadId: lead.id, websiteLeadReceiptId: receiptId, subjectType: input.subjectType, subjectName: input.subjectName, firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, classificationState: revision ? 'VERIFIED' : 'TO_CLASSIFY', effectiveCategory: input.effectiveCategory, serviceCatalogId: revision?.serviceCatalogId, serviceRevisionId: revision?.id, digitalProjectType: input.digitalProjectType, need: input.need, objective: input.objective, functions: input.functions, indicativeBudget: input.indicativeBudget, timing: input.timing, declaredMaterials: input.declaredMaterials, declaredEngagementReference: input.engagementReference, commercialOfferId, contractId, administrativeState: input.channel === 'WPFORMS_1485' ? commercialOfferId || contractId ? 'VERIFIED' : 'TO_RECONCILE' : 'NOT_APPLICABLE', administrativeRequest: input.administrativeRequest, operatorId: actor.userId, duplicateCandidates: { create: candidates.map(({ id }) => ({ leadId: id })) } }, include: { duplicateCandidates: true, duplicateDecision: true } });
    if (faultAfterLead) throw new Error('CONTROLLED_INTAKE_SYNTHETIC_FAULT');
    const inbox = await maybeEnrollManualCommercialLead(tx, { leadId: lead.id, actor: { userId: actor.userId, sessionId: claimed.sessionId! } });
    if (inbox) await tx.controlledIntake.update({ where: { id: record.id }, data: { status: 'ENROLLED' } });
    await tx.auditLog.create({ data: { actorId: actor.userId, event: 'controlled_intake_recorded', entityType: 'ControlledIntake', entityId: record.id, after: { channel: input.channel, payloadHash, leadId: lead.id, inboxItemId: inbox?.id ?? null, candidateCount: candidates.length } } });
    if (!canEditLead(actor, lead)) return { id: record.id, leadId: lead.id, queued: true as const };
    return { ...record, status: inbox ? 'ENROLLED' : record.status };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  for (let attempt = 1; attempt <= 3; attempt += 1) { try { return await run(); } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002') && attempt < 3) continue; throw error; } }
  throw new ControlledIntakeError('CONFLICT');
}

export async function decideControlledIntakeDuplicate(db: Db, claimed: AuthSession, raw: unknown) {
  requireEnabled();
  const input = controlledDuplicateDecisionSchema.parse(raw);
  await assertControlledIntakeDatabase(db);
  try {
    return await db.$transaction(async (tx) => {
      const actor = await currentActor(tx, claimed);
      const intake = await tx.controlledIntake.findUnique({ where: { id: input.intakeId } });
      if (!intake || intake.version !== input.expectedVersion) throw new ControlledIntakeError('CONFLICT');
      const [sourceLead, candidate, candidateLink] = await Promise.all([
        tx.lead.findUnique({ where: { id: intake.leadId } }),
        tx.lead.findUnique({ where: { id: input.candidateLeadId } }),
        tx.controlledIntakeDuplicateCandidate.findUnique({ where: { intakeId_leadId: { intakeId: intake.id, leadId: input.candidateLeadId } } }),
      ]);
      if (!sourceLead || sourceLead.deletedAt || !candidate || candidate.deletedAt || !candidateLink
        || !canEditLead(actor, sourceLead) || !canEditLead(actor, candidate)) {
        throw new ControlledIntakeError('DENIED');
      }
      const claimedVersion = await tx.controlledIntake.updateMany({
        where: { id: intake.id, version: input.expectedVersion, duplicateDecision: { is: null } },
        data: { version: { increment: 1 } },
      });
      if (claimedVersion.count !== 1) throw new ControlledIntakeError('CONFLICT');
      const decisionHash = canonicalSha256({ ...input, actorUserId: actor.userId });
      const decision = await tx.controlledIntakeDuplicateDecision.create({ data: {
        intakeId: intake.id, candidateLeadId: candidate.id, outcome: input.outcome,
        actorUserId: actor.userId, actorSessionId: claimed.sessionId!, expectedVersion: input.expectedVersion, decisionHash,
      } });
      await tx.auditLog.create({ data: {
        actorId: actor.userId, event: 'controlled_intake_duplicate_decided',
        entityType: 'ControlledIntake', entityId: intake.id,
        after: { candidateLeadId: candidate.id, outcome: input.outcome, decisionHash },
      } });
      return decision;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
      throw new ControlledIntakeError('CONFLICT');
    }
    throw error;
  }
}

/** Links only an already-projected, authenticated WPForms 1265 event. */
export async function linkAuthenticated1265Projection(db: Db, claimed: AuthSession, raw: unknown) {
  requireEnabled();
  const input = authenticated1265LinkSchema.parse(raw);
  await assertControlledIntakeDatabase(db);
  return db.$transaction(async (tx) => {
    const actor = await currentActor(tx, claimed);
    const projection = await tx.leadProjectionLedger.findUnique({
      where: { id: input.projectionLedgerId },
      include: { inboxEvent: true, commercialInboxItem: true, lead: true },
    });
    if (!projection?.lead || !projection.commercialInboxItem
      || projection.commercialInboxItem.originKind !== 'BUSINESS_PROJECTION_N13'
      || projection.commercialInboxItem.formCode !== '1265'
      || projection.commercialInboxItem.projectionLedgerId !== projection.id
      || projection.lead.deletedAt
      || !canEditLead(actor, projection.lead)) throw new ControlledIntakeError('DENIED');
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp()::timestamptz(3) AS now`)[0]?.now ?? new Date(0);
    const revision = await selectableRevision(tx, input.serviceCode, input.digitalProjectType, now);
    const sourceId = projection.inboxEvent.eventId;
    const payloadHash = canonicalSha256({ ...input, sourceRecordHash: projection.sourceRecordHash });
    const existing = await tx.controlledIntake.findUnique({ where: { channel_sourceId: { channel: 'WPFORMS_1265', sourceId } } });
    if (existing) {
      if (existing.payloadHash !== payloadHash || existing.leadId !== projection.lead.id) throw new ControlledIntakeError('CONFLICT');
      return existing;
    }
    const record = await tx.controlledIntake.create({ data: {
      channel: 'WPFORMS_1265', sourceId,
      sourceOccurredAt: projection.commercialInboxItem.sourceOccurredAt,
      acquisitionMode: 'AUTHENTICATED_AUTOMATIC', mappingVersion: 'service-mapping-2026-09-13-v2', payloadHash,
      leadId: projection.lead.id, sourceProjectionLedgerId: projection.id,
      subjectType: input.subjectType, subjectName: projection.lead.companyName,
      firstName: projection.lead.firstName, lastName: projection.lead.lastName,
      email: projection.lead.email, phone: projection.lead.phone,
      classificationState: revision ? 'VERIFIED' : 'TO_CLASSIFY', effectiveCategory: input.effectiveCategory,
      serviceCatalogId: revision?.serviceCatalogId, serviceRevisionId: revision?.id,
      digitalProjectType: input.digitalProjectType, need: input.need,
      operatorId: actor.userId, status: 'ENROLLED',
    } });
    await tx.auditLog.create({ data: {
      actorId: actor.userId, event: 'controlled_intake_authenticated_1265_linked',
      entityType: 'ControlledIntake', entityId: record.id,
      after: { projectionLedgerId: projection.id, leadId: projection.lead.id, serviceRevisionId: revision?.id ?? null },
    } });
    return record;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
