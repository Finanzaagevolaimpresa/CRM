import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { mapSerializableConflict } from './serializable';
import { adminRecordCatalogue, adminRecordPolicy, adminFieldLabels, type AdminField, type AdminRecordForm, type AdminRecordPolicy } from './admin-record-catalogue';
import { isFinancialDocument, type FinancialDocumentMetadata } from './financial-privacy-policy';
import type { Permission } from './permissions';
import { isSensitiveDocument } from './access-control';
import { canAccessFinancialDocument } from './financial-document-access';
import { ordinaryDocumentVisibilityAllows } from './technical-document-visibility';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { loadTechnicalPrivateItemRecord } from './technical-private-item-persistence';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { admitsTechnicalAssignmentManager } from './technical-assignment-permissions';
import { createHash } from 'node:crypto';
import { readPrivateDocumentBounded } from './storage';
import { assertAdminEngagementDossierLifecycle, EngagementDossierError } from './engagement-dossier';

type Tx = Prisma.TransactionClient;
async function withSerializableTransaction<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await operation(tx);
    // Surface deferred integrity failures inside the callback. An adapter must
    // never turn a rejected COMMIT into an apparently successful receipt.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}
type Row = Record<string, unknown> & { id: string };
type Delegate = {
  findUnique(args: { where: { id: string } }): Promise<Row | null>;
  findMany(args: object): Promise<Row[]>;
  count(args: object): Promise<number>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
};
export class AdminRecordError extends Error {
  constructor(readonly code: 'DENIED' | 'INVALID' | 'STALE' | 'HISTORY' | 'DEPENDENCIES' | 'CONTEXT' | 'CLOSED') { super(`ADMIN_RECORD_${code}`); }
}
function fail(code: AdminRecordError['code']): never { throw new AdminRecordError(code); }
async function dossierLifecycleContext(tx: Tx, session: AuthSession, id: string) {
  try { await assertAdminEngagementDossierLifecycle(tx, session, id); }
  catch (error) { if (error instanceof EngagementDossierError) fail('DENIED'); throw error; }
}
const models = Prisma.dmmf.datamodel.models;
function metadata(model: string) { const value = models.find(item => item.name === model); if (!value) fail('INVALID'); return value; }
// Callers never supply a delegate or table. All public entry points first
// resolve the closed catalogue; relationship probes come from generated schema.
function delegate(tx: Tx, model: string): Delegate {
  metadata(model);
  return (tx as unknown as Record<string, Delegate>)[model[0].toLowerCase() + model.slice(1)];
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const adminRecordVersion = (value: unknown) => canonicalSha256(JSON.parse(JSON.stringify(value)));
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const archives: Record<string, { status: string; draft: string }> = {
  PreAnalysis: { status: 'archiviata', draft: 'raccolta_dati' }, Dossier: { status: 'archiviato', draft: 'bozza_consulente' },
  AiOutput: { status: 'archived', draft: 'needs_review' },
  ClientDossier: { status: 'archiviata', draft: 'bozza' },
};
export const adminRecordCommand = z.object({ commandId: z.string().uuid(), model: z.string().min(1).max(80), id: identifier,
  operation: z.enum(['CREATE', 'UPDATE', 'TRASH', 'RESTORE', 'RECTIFY']), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(2000), values: z.record(z.string(), z.string().max(100_000)),
  paymentCorrection: z.object({ evidenceVersionId: identifier, effectiveAt: z.string().datetime({ offset: true }), confirmed: z.literal(true) }).strict().optional(),
}).strict();
export type AdminRecordCommand = z.infer<typeof adminRecordCommand>;

export function parseAdminRecordValues(policy: AdminRecordPolicy, values: Record<string, string>, creating: boolean) {
  if (Object.keys(values).some(key => !policy.fields.includes(key))) fail('INVALID');
  const result: Record<string, unknown> = {};
  for (const name of policy.fields) {
    if (!Object.hasOwn(values, name)) fail('INVALID');
    const field = metadata(policy.model).fields.find(item => item.name === name);
    if (!field || field.kind === 'object' || field.isList || field.isId) fail('INVALID');
    const value = values[name].trim();
    if (value === '') {
      if (policy.model === 'AiAgent' && ['description', 'operationalScope', 'expectedOutput', 'toneStyle'].includes(name)) { result[name] = ''; continue; }
      if (!field.isRequired) { result[name] = null; continue; }
      if (creating && field.hasDefaultValue) continue;
      fail('INVALID');
    }
    if (field.kind === 'enum') {
      const options = Prisma.dmmf.datamodel.enums.find(item => item.name === field.type)?.values.map(item => item.name) ?? [];
      if (!options.includes(value)) fail('INVALID'); result[name] = value;
    } else if (field.type === 'DateTime') {
      if (!z.string().datetime({ offset: true }).safeParse(value).success) fail('INVALID');
      result[name] = new Date(value);
    } else if (field.type === 'Boolean') {
      if (!['true', 'false'].includes(value)) fail('INVALID'); result[name] = value === 'true';
    } else if (field.type === 'Int' || field.type === 'Decimal') {
      const signed = ['ebitda', 'netProfit', 'equity', 'estimatedCashflow'].includes(name);
      if (!(field.type === 'Int' ? /^\d{1,10}$/ : signed ? /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/ : /^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/).test(value)) fail('INVALID');
      if (field.type === 'Int' && Number(value) > 2147483647) fail('INVALID');
      if (['ownershipPercent', 'expectedBenefitPercent', 'dataCompleteness'].includes(name) && Number(value) > 100) fail('INVALID');
      result[name] = field.type === 'Int' ? Number(value) : new Prisma.Decimal(value).toString();
    } else if (field.type === 'Json') {
      try { result[name] = JSON.parse(value); } catch { fail('INVALID'); }
    } else if (field.type === 'String') {
      if (value.length > (/notes|description|summary|content|text|conditions|documents|rationale|issues|findings/i.test(name) ? 50_000 : 5000)) fail('INVALID');
      if (['email', 'pec'].includes(name) && !z.string().email().safeParse(value).success) fail('INVALID');
      if (name.endsWith('Id') && !identifier.safeParse(value).success) fail('INVALID');
      if (name === 'officialSourceUrl' && !/^https?:\/\//.test(value)) fail('INVALID');
      result[name] = value;
    } else fail('INVALID');
  }
  if (['Contract', 'Payment', 'CommercialOffer'].includes(policy.model)) {
    const cents = (value: unknown) => new Prisma.Decimal(String(value)).mul(100);
    if (!cents(result.taxableAmount).plus(cents(result.vatAmount)).equals(cents(result.totalAmount))) fail('INVALID');
  }
  if (policy.model === 'Project' && result.status === 'archiviato') fail('HISTORY');
  if (['Project', 'ProjectExpense'].includes(policy.model) && result.priority && !['bassa', 'media', 'alta', 'urgente'].includes(String(result.priority))) fail('INVALID');
  if (policy.model === 'Client' && !['attivo', 'sospeso', 'archiviato'].includes(String(result.status))) fail('INVALID');
  if (policy.model === 'Contract' && creating && result.status === 'firmato') fail('HISTORY');
  if (policy.model === 'Payment' && creating) { result.status ??= 'da_incassare'; if (result.status !== 'da_incassare') fail('HISTORY'); }
  if (policy.model === 'PracticeCommunication' && (result.type === 'cliente' || result.channel !== 'nota_interna')) fail('HISTORY');
  if (policy.model === 'AiAgent' && !z.array(z.string().min(1).max(2000)).max(100).safeParse(result.requiredDataChecklist).success) fail('INVALID');
  if (creating && archives[policy.model] && result.status !== archives[policy.model].draft) fail('HISTORY');
  if (policy.model === 'CommercialLeadSlaPolicyVersion' && (!['STAGED', 'ACTIVE'].includes(String(result.status))
    || !Number.isSafeInteger(result.responseTargetSeconds) || Number(result.responseTargetSeconds) < 60 || Number(result.responseTargetSeconds) > 2_592_000)) fail('INVALID');
  return result;
}

async function auth(tx: Tx, session: AuthSession, policy: AdminRecordPolicy, proof?: UpdateCredentials) {
  const current = await updateActor(tx, session, proof);
  if (current.actor.role !== 'admin' || !recordUpdatePermission(current.actor, policy.permission)
    || !recordUpdatePermission(current.actor, readPermission(policy))) fail('DENIED');
  return current;
}
const readPermission = (policy: AdminRecordPolicy): Permission => policy.permission === 'document.upload' ? 'document.download'
  : policy.permission.replace(/\.write$/, '.read') as Permission;
async function lock(tx: Tx, model: string, id: string) {
  metadata(model);
  const identity = model === 'CommercialLeadSlaPolicyVersion' ? Prisma.sql`${id}::uuid` : Prisma.sql`${id}`;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"' + model + '"')} WHERE id=${identity} FOR UPDATE`);
}
const label = (row: Row) => String(row.title ?? row.displayName ?? row.name ?? row.contractNumber ?? row.internalMeasureName ?? row.description
  ?? ([row.firstName, row.lastName].filter(Boolean).join(' ') || row.id));
const relationTargets: Record<string, string> = { leadId: 'Lead', clientId: 'Client', promoterClientId: 'Client', companyId: 'Company', personId: 'Person',
  projectId: 'Project', incorporationSubjectId: 'IncorporationSubject', clientServiceId: 'ClientService', serviceCatalogId: 'ServiceCatalog',
  contractId: 'Contract', paymentId: 'Payment', documentId: 'Document', technicalPracticeId: 'TechnicalPractice',
  grantAssessmentId: 'GrantAssessment', preAnalysisId: 'PreAnalysis', assignedToId: 'User' };
const relation = (model: string, field: string) => metadata(model).fields.find(item => item.kind === 'object'
  && item.relationFromFields?.length === 1 && item.relationFromFields[0] === field)
  ?? (relationTargets[field] ? { type: relationTargets[field] } : undefined);
function admittedRow(actor: Awaited<ReturnType<typeof updateActor>>['actor'], row: Row) {
  const excluded = new Set<string>([...(actor.selectiveClientIds ?? []), ...(actor.selectiveProjectIds ?? []), ...(actor.selectiveLeadIds ?? []),
    ...(actor.selectivePracticeIds ?? []), ...(actor.selectiveDocumentIds ?? []), ...(actor.selectiveClientCompanyIds ?? []), ...(actor.selectiveClientPersonIds ?? []),
    ...(actor.selectiveServiceIds ?? []), ...(actor.selectiveContractIds ?? []), ...(actor.technicalTaskIds ?? []), ...(actor.technicalChecklistIds ?? [])]);
  return !excluded.has(row.id) && !['leadId', 'clientId', 'companyId', 'projectId', 'clientServiceId', 'contractId', 'paymentId', 'documentId', 'technicalPracticeId', 'personId']
    .some(key => typeof row[key] === 'string' && excluded.has(row[key] as string));
}

type Actor = Awaited<ReturnType<typeof updateActor>>['actor'];
const privateFields: Record<string, string[]> = {
  Task: ['title', 'description', 'priority', 'dueAt', 'status'],
  DocumentChecklistItem: ['title', 'notes', 'status', 'active'],
};
async function admitPrivateItem(tx: Tx, actor: Actor, model: string, row: Row) {
  const [authority] = await tx.$queryRaw<Array<{ userId: string; enabled: boolean }>>`
    SELECT "userId",enabled FROM "TechnicalAssignmentAuthority" WHERE id='technical-assignment' FOR SHARE`;
  if (!authority?.enabled || authority.userId !== actor.id || !recordUpdatePermission(actor, 'service.write')) fail('DENIED');
  const key = await loadActivePrivilegedStepUpKey(tx);
  if (!key || !await lockRegisteredPrivilegedStepUpKey(tx, key)) fail('DENIED');
  const origin = await tx.technicalPrivateItemOrigin.findUnique({ where: { kind_itemId: {
    kind: model === 'Task' ? 'Task' : 'ChecklistItem', itemId: row.id } }, select: { commandId: true } });
  const saved = origin ? await loadTechnicalPrivateItemRecord(tx, { key }, origin.commandId) : null;
  if (!saved || !admitsTechnicalAssignmentManager(actor, saved.command.target.kind)) fail('DENIED');
  const context = await lockTechnicalAssignmentContext(tx, saved.command.target);
  if (!context?.operational || context.clientId !== saved.origin.clientId || context.projectId !== saved.origin.projectId
    || context.clientServiceId !== saved.origin.serviceId) fail('CONTEXT');
  return saved.command.target;
}
/** Walk ordinary parent links before exposing or changing a child. A child
 * without clientId must not bypass an exclusion on its project or document. */
async function assertContextVisible(tx: Tx, actor: Actor, model: string, row: Row, seen = new Set<string>()) {
  const key = `${model}:${row.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!admittedRow(actor, row)) fail('DENIED');
  const policy = adminRecordCatalogue.find(item => item.model === model);
  if (policy && !recordUpdatePermission(actor, readPermission(policy))) fail('DENIED');
  if (privateFields[model] && row.technicalPrivate === true) await admitPrivateItem(tx, actor, model, row);
  if (model === 'Document') {
    if (!ordinaryDocumentVisibilityAllows(row.visibilityLevel)
      || !await canAccessFinancialDocument(tx, actor, row as FinancialDocumentMetadata & { id: string })
      || (isSensitiveDocument(row as unknown as Parameters<typeof isSensitiveDocument>[0]) && !recordUpdatePermission(actor, 'document.sensitive.read'))) fail('DENIED');
  }
  for (const name of Object.keys(relationTargets).filter(name => name !== 'assignedToId')) {
    if (!row[name] || !metadata(model).fields.some(field => field.name === name)) continue;
    const targetModel = relation(model, name)?.type;
    if (!targetModel || targetModel === model) continue;
    const target = await delegate(tx, targetModel).findUnique({ where: { id: String(row[name]) } });
    if (!target) fail('CONTEXT');
    await assertContextVisible(tx, actor, targetModel, target, seen);
  }
  if (model === 'Person') {
    const links = await tx.companyPerson.findMany({ where: { personId: row.id }, select: { companyId: true } });
    for (const link of links) {
      const company = await tx.company.findUnique({ where: { id: link.companyId } });
      if (!company) fail('CONTEXT');
      await assertContextVisible(tx, actor, 'Company', company, seen);
    }
  }
  if (model === 'Deadline') {
    if (!['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService'].includes(String(row.entityType))) fail('CONTEXT');
    const parent = await delegate(tx, String(row.entityType)).findUnique({ where: { id: String(row.entityId) } });
    if (!parent) fail('CONTEXT');
    await assertContextVisible(tx, actor, String(row.entityType), parent, seen);
  }
}
async function linkedRows(tx: Tx, model: string, row: Row, actor: Actor) {
  const links = new Map<string, Row>();
  for (const name of adminRecordPolicy(model).fields) {
    const field = relation(model, name);
    // Only operational links, never provenance, approvals, private paths or keys.
    if (!field || !row[name]) continue;
    await lock(tx, field.type, String(row[name]));
    const target = await delegate(tx, field.type).findUnique({ where: { id: String(row[name]) } });
    if (!target || target.deletedAt || target.active === false) fail('CONTEXT');
    if (field.type !== 'User') await assertContextVisible(tx, actor, field.type, target);
    links.set(field.type, target);
  }
  return links;
}
async function validateContext(tx: Tx, policy: AdminRecordPolicy, before: Row | null, after: Row, actor: Actor) {
  await assertContextVisible(tx, actor, policy.model, after);
  const links = await linkedRows(tx, policy.model, after, actor);
  const clientIds = [after.clientId, after.promoterClientId, ...[...links.values()].map(row => row.clientId)].filter(Boolean);
  if (new Set(clientIds).size > 1) fail('CONTEXT');
  const projects = [after.projectId, ...[...links.values()].map(row => row.projectId)].filter(Boolean);
  if (new Set(projects).size > 1) fail('CONTEXT');
  const companyIds = [after.companyId, ...[...links.values()].map(row => row.companyId)].filter(Boolean);
  if (new Set(companyIds).size > 1) fail('CONTEXT');
  if (policy.model === 'CommercialOffer' && !after.leadId && !after.clientId) fail('CONTEXT');
  if (after.documentId) {
    const document = links.get('Document');
    if (document && ((Object.hasOwn(after, 'clientId') && document.clientId !== after.clientId)
      || (Object.hasOwn(after, 'projectId') && document.projectId && document.projectId !== after.projectId))) fail('CONTEXT');
  }
  if (policy.model === 'Deadline') {
    const targetPolicy = adminRecordCatalogue.find(item => ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService'].includes(item.model) && item.model === after.entityType);
    if (!targetPolicy || !after.entityId) fail('CONTEXT');
    await lock(tx, targetPolicy.model, String(after.entityId));
    const target = await delegate(tx, targetPolicy.model).findUnique({ where: { id: String(after.entityId) } });
    if (!target || target.deletedAt || target.technicalPrivate === true) fail('CONTEXT');
    await assertContextVisible(tx, actor, targetPolicy.model, target);
  }
  if (before && ['Client', 'Company', 'Project', 'TechnicalPractice', 'ClientService', 'GrantAssessment', 'Document'].includes(policy.model)
    && ['clientId', 'companyId', 'projectId', 'clientServiceId'].some(key => before[key] !== after[key])) {
    // Reparenting a graph is a separate explicit operation. Never silently move
    // a parent while retaining contradictory children, grants or signed context.
    for (const dependent of models) for (const field of dependent.fields.filter(item => item.kind !== 'object'
      && relation(dependent.name, item.name)?.type === policy.model)) {
      if (await delegate(tx, dependent.name).count({ where: { [field.name]: before.id } })) fail('DEPENDENCIES');
    }
    if (await tx.deadline.count({ where: { entityType: policy.model, entityId: before.id } })) fail('DEPENDENCIES');
  }
  if (policy.model === 'CompanyPerson' && await tx.companyPerson.count({ where: { companyId: String(after.companyId),
    personId: String(after.personId), id: { not: after.id } } })) fail('CONTEXT');
}

async function assertEditable(tx: Tx, policy: AdminRecordPolicy, before: Row, changed: string[]) {
  if (['DocumentExtraction', 'VisuraAnalysis'].includes(policy.model) && changed.includes('documentId')) fail('HISTORY');
  if (before.technicalPrivate === true && privateFields[policy.model]
    && changed.some(name => !privateFields[policy.model].includes(name))) fail('HISTORY');
  if (archives[policy.model] && changed.every(key => key === 'status')) return;
  if (policy.model === 'CommercialLeadSlaPolicyVersion') fail('HISTORY');
  if (policy.model === 'CommercialOffer' && changed.some(key => !['notes', 'followUpAt', 'followUpNote', 'outcomeNote'].includes(key))
    && (before.status !== 'bozza' || await tx.practiceOfferRevision.count({ where: { commercialOfferId: before.id } }))) fail('HISTORY');
  if (policy.model === 'PreAnalysis' && (before.reviewedById || before.approvedById || before.approvedAt || !['da_avviare', 'raccolta_dati', 'bozza_generata'].includes(String(before.status)))) fail('HISTORY');
  if (policy.model === 'Dossier' && (before.reviewedById || before.approvedById || before.approvedAt || !['bozza_ai', 'bozza_consulente'].includes(String(before.status)))) fail('HISTORY');
  if (policy.model === 'ClientDossier' && (before.currentVersionId || before.approvedVersionId || before.reviewedById || before.reviewedAt || before.status !== 'bozza')) fail('HISTORY');
  if (policy.model === 'AiOutput' && (before.reviewedById || before.reviewedAt || before.approvedById || before.approvedAt || !['needs_review', 'flagged'].includes(String(before.status)))) fail('HISTORY');
  if (policy.model === 'PracticeCommunication' && !['bozza', 'da_revisionare'].includes(String(before.status))) fail('HISTORY');
  if (policy.model === 'Contract' && changed.some(key => !['notes', 'status'].includes(key)) && (before.signedAt || before.signedDocumentId || before.status === 'firmato'
    || await tx.payment.count({ where: { contractId: before.id, OR: [{ collectedAt: { not: null } }, { status: { in: ['parziale', 'incassato', 'stornato', 'rimborsato'] } }] } }))) fail('HISTORY');
  if (policy.model === 'Payment' && changed.some(key => !['method', 'dueDate', 'status', 'notes'].includes(key))
    && (before.collectedAt || before.accountingDocumentId || !['da_incassare', 'scaduto'].includes(String(before.status))
      || await tx.clientService.count({ where: { paymentId: before.id } }))) fail('HISTORY');
}
async function paymentStatuses(tx: Tx, row: Row | null) {
  if (!row) return ['da_incassare'];
  const current = String(row.status);
  if (['da_incassare', 'scaduto'].includes(current) && !row.collectedAt && !row.accountingDocumentId)
    return ['da_incassare', 'scaduto', 'stornato'];
  if (['incassato', 'parziale'].includes(current) && row.collectedAt && row.accountingDocumentId)
    return [current, 'stornato', 'rimborsato'];
  if (['stornato', 'rimborsato'].includes(current)) {
    const prior = await tx.adminRecordRevision.findFirst({ where: { model: 'Payment', recordId: row.id, operation: 'UPDATE',
      after: { path: ['status'], equals: current }, NOT: { before: { path: ['status'], equals: current } } }, orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }] });
    const origin = prior?.before as Row | undefined, recorded = prior?.after as Row | undefined;
    const preserved = ['clientId', 'contractId', 'taxableAmount', 'vatAmount', 'totalAmount', 'collectedAt', 'accountingDocumentId'];
    if (origin && recorded && preserved.every(key => adminRecordVersion(recorded[key] ?? null) === adminRecordVersion(row[key] ?? null)))
      return [current, String(origin.status)];
  }
  return [current];
}
/** A declaration of an evidenced administrative correction, never a new bank
 * movement or a replacement of the original collection receipt. */
async function correctPaymentStatus(tx: Tx, actor: Actor, command: AdminRecordCommand, before: Row, nextStatus: string, now: Date) {
  const correction = command.paymentCorrection;
  if (!correction || !recordUpdatePermission(actor, 'document.download') || !(await paymentStatuses(tx, before)).includes(nextStatus)) fail('HISTORY');
  const effectiveAt = new Date(correction.effectiveAt);
  if (effectiveAt > now || (before.collectedAt && effectiveAt < new Date(String(before.collectedAt)))) fail('INVALID');
  const initial = await tx.documentVersion.findUnique({ where: { id: correction.evidenceVersionId } });
  if (!initial) fail('CONTEXT');
  await lock(tx, 'Document', initial.documentId); await lock(tx, 'DocumentVersion', initial.id);
  const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: initial.id } });
  const document = await tx.document.findUniqueOrThrow({ where: { id: version.documentId } });
  await assertContextVisible(tx, actor, 'Document', document);
  const contract = await tx.contract.findUnique({ where: { id: String(before.contractId) } });
  if (!contract || document.deletedAt || document.status !== 'verificato' || document.clientId !== before.clientId
    || (document.projectId && document.projectId !== contract.projectId) || (document.validUntil && document.validUntil <= now)
    || !/^[a-f0-9]{64}$/.test(version.checksum ?? '')) fail('CONTEXT');
  if (document.clientServiceId) {
    const context = await tx.clientService.findUnique({ where: { id: document.clientServiceId } });
    if (!context || context.deletedAt || context.clientId !== before.clientId || context.contractId !== before.contractId) fail('CONTEXT');
  }
  let bytes: Buffer;
  try { bytes = await readPrivateDocumentBounded(version.storagePath, 50 * 1024 * 1024); } catch { fail('CONTEXT'); }
  if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== version.checksum) fail('CONTEXT');
  await tx.$queryRaw`SELECT id FROM "ClientService" WHERE "paymentId"=${before.id} ORDER BY id FOR UPDATE`;
  const services = await tx.clientService.findMany({ where: { paymentId: before.id }, orderBy: { id: 'asc' } });
  if (services.length && !recordUpdatePermission(actor, 'service.write')) fail('DENIED');
  for (const service of services) {
    await assertContextVisible(tx, actor, 'ClientService', service);
    if (service.clientId !== before.clientId || service.contractId !== before.contractId) fail('CONTEXT');
    const status = nextStatus === 'incassato' ? (new Prisma.Decimal(String(before.totalAmount)).equals(contract.totalAmount) ? 'incassato' : 'parziale') : nextStatus;
    await tx.clientService.update({ where: { id: service.id }, data: { paymentStatus: status as typeof service.paymentStatus, recordUpdateEpoch: { increment: 1 } } });
    await tx.auditLog.create({ data: { actorId: actor.id, entityType: 'ClientService', entityId: service.id, event: 'admin_payment_status_alignment',
      after: { commandId: command.commandId, paymentId: before.id, previousStatus: service.paymentStatus, status } } });
  }
  await tx.auditLog.create({ data: { id: `payment-correction:${command.commandId}`, actorId: actor.id, entityType: 'Payment', entityId: before.id,
    event: 'admin_payment_status_correction', after: { commandId: command.commandId, previousStatus: String(before.status), status: nextStatus,
      effectiveAt: effectiveAt.toISOString(), evidenceVersionId: version.id, evidenceSha256: version.checksum, evidenceBytes: bytes.length,
      linkedServices: services.map(service => service.id), declaration: 'ADMINISTRATIVE_CORRECTION_NO_FUNDS_TRANSFER' } } });
}
async function archiveRestoreStatus(tx: Tx, model: string, row: Row): Promise<string | null> {
  const archive = archives[model]; if (!archive || row.status !== archive.status) return null;
  const previous = await tx.adminRecordRevision.findFirst({ where: { model, recordId: row.id, operation: 'UPDATE',
    after: { path: ['status'], equals: archive.status }, NOT: { before: { path: ['status'], equals: archive.status } } },
    orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }] });
  if (!previous?.before || !previous.after) return null;
  const unchanged = (value: unknown) => Object.fromEntries(Object.entries(value as Row).filter(([key]) => !['status', 'updatedAt'].includes(key)));
  if (adminRecordVersion(unchanged(row)) !== adminRecordVersion(unchanged(previous.after))) return null;
  return String((previous.before as Row).status);
}
async function readDeleted(tx: Tx, model: string, id: string) {
  const latest = await tx.adminRecordRevision.findFirst({ where: { model, recordId: id, operation: { not: 'CLOSE' } }, orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }, { commandId: 'desc' }] });
  return latest?.operation === 'TRASH' && latest.after === null ? latest : null;
}

export async function saveAdminRecord(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const command = adminRecordCommand.parse(raw), policy = adminRecordPolicy(command.model);
  const requestHash = adminRecordVersion({ command, actor: session.userId, sessionId: session.sessionId });
  if (!proof) fail('DENIED');
  return withSerializableTransaction(db, async tx => {
    const current = await auth(tx, session, policy, proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-record:${command.commandId}`},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: command.commandId } });
    if (previous) {
      if (previous.operation === 'CLOSE') fail('CLOSED');
      if (previous.actorId !== current.actor.id || previous.sessionId !== current.registry.id || previous.requestHash !== requestHash) fail('STALE');
      await current.finish();
      return { commandId: previous.commandId, model: policy.model, id: previous.recordId, replayed: true };
    }
    await lock(tx, policy.model, command.id);
    const records = delegate(tx, policy.model), before = await records.findUnique({ where: { id: command.id } });
    const removed = !before && command.operation === 'RESTORE' ? await readDeleted(tx, policy.model, command.id) : null;
    if (before) await assertContextVisible(tx, current.actor, policy.model, before);
    if (policy.model === 'ClientDossier' && before?.practiceReadinessId) await dossierLifecycleContext(tx, session, command.id);
    if (removed) await assertContextVisible(tx, current.actor, policy.model, removed.before as unknown as Row);
    if (adminRecordVersion(removed ? removed.before : before) !== command.expectedVersion) fail('STALE');
    let after: Row | null = before;
    if (command.operation === 'CREATE' || command.operation === 'UPDATE') {
      if (command.operation === 'CREATE' ? !policy.create || before !== null : !before || Boolean(before.deletedAt)) fail('DENIED');
      const values = parseAdminRecordValues(policy, command.values, command.operation === 'CREATE');
      const changed = Object.keys(values).filter(key => adminRecordVersion(before?.[key] ?? null) !== adminRecordVersion(values[key]));
      if (before) await assertEditable(tx, policy, before, changed);
      if (command.paymentCorrection && (policy.model !== 'Payment' || !before || !changed.includes('status'))) fail('INVALID');
      if (policy.model === 'Payment' && before && changed.includes('status'))
        await correctPaymentStatus(tx, current.actor, command, before, String(values.status), await current.finish());
      if (before && archives[policy.model] && changed.includes('status')) {
        if (changed.some(key => key !== 'status') || (values.status !== archives[policy.model].status
          && values.status !== await archiveRestoreStatus(tx, policy.model, before))) fail('HISTORY');
      }
      if (policy.model === 'ClientDossier' && before && changed.includes('status')) {
        const archived = values.status === 'archiviata', now = await current.finish();
        values.archivedAt = archived ? now : null; values.archivedById = archived ? current.actor.id : null;
        // A later restoration must not silently revive an unused delivery.
        if (archived) {
          await tx.$queryRaw`SELECT id FROM "EngagementDossierDeliveryAuthorization" WHERE "dossierId"=${before.id} ORDER BY id FOR UPDATE`;
          const pending = await tx.engagementDossierDeliveryAuthorization.findMany({ where: { dossierId: before.id, revokedAt: null, receipt: null }, select: { id: true } });
          await tx.engagementDossierDeliveryAuthorization.updateMany({ where: { id: { in: pending.map(row => row.id) } }, data: { revokedAt: now } });
          for (const authorization of pending) await tx.auditLog.create({ data: { actorId: current.actor.id, entityType: 'EngagementDossierDeliveryAuthorization', entityId: authorization.id,
            event: 'admin_dossier_delivery_revoked_on_archive', after: { commandId: command.commandId, dossierId: before.id } } });
        }
      }
      if (policy.model === 'ClientDossier' && changed.some(name => name !== 'status')) values.updatedById = current.actor.id;
      if (policy.model === 'Dossier' && changed.some(name => name !== 'status')) values.modifiedById = current.actor.id;
      if (policy.model === 'AiAgent' && before) {
        values.configVersion = Number(before.configVersion) + 1;
        values.promptVersion = `v${values.configVersion}`;
      }
      if (policy.model === 'PracticeCommunication' && before && values.technicalPracticeId !== before.technicalPracticeId) {
        const practice = await tx.technicalPractice.findUnique({ where: { id: String(values.technicalPracticeId) } });
        if (!practice || practice.deletedAt || practice.status === 'archiviata') fail('CONTEXT');
        await assertContextVisible(tx, current.actor, 'TechnicalPractice', practice);
        for (const name of ['clientId', 'projectId', 'clientServiceId', 'commercialOwnerId', 'technicalOwnerId'] as const) values[name] = practice[name];
      }
      if (policy.model === 'Contract' && before && changed.includes('status')) {
        const signed = Boolean(before.signedAt || before.signedDocumentId || before.status === 'firmato');
        if (values.status === 'firmato') {
          const prior = await tx.adminRecordRevision.findFirst({ where: { model: 'Contract', recordId: before.id, operation: 'UPDATE',
            before: { path: ['status'], equals: 'firmato' }, after: { path: ['status'], equals: 'archiviato' } }, orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }] });
          const source = prior?.before as Row | undefined;
          if (before.status !== 'archiviato' || !before.signedAt || !before.signedDocumentId || !source
            || source.signedDocumentId !== before.signedDocumentId || String(source.signedAt) !== (before.signedAt as Date).toISOString()) fail('HISTORY');
        } else if (signed && !['archiviato', 'annullato', 'non_firmato'].includes(String(values.status))) fail('HISTORY');
      }
      if (policy.model === 'Document' && before && isFinancialDocument(before as FinancialDocumentMetadata)
        && !isFinancialDocument({ ...before, ...values } as FinancialDocumentMetadata)) fail('HISTORY');
      if (policy.model === 'Document' && values.status === 'archiviato' && before?.status !== 'archiviato') fail('INVALID');
      if (!admittedRow(current.actor, { ...(before ?? { id: command.id }), ...values })) fail('DENIED');
      if (Object.hasOwn(values, 'assignedToId') && values.assignedToId !== before?.assignedToId
        && !recordUpdatePermission(current.actor, 'service.assign')) fail('DENIED');
      if (policy.model === 'TechnicalPractice' && values.status !== before?.status && !recordUpdatePermission(current.actor, 'technical.status')) fail('DENIED');
      if (policy.model === 'Task' && values.status !== before?.status && (values.status === 'completata' || before?.status === 'completata')
        && !recordUpdatePermission(current.actor, 'service.close')) fail('DENIED');
      if (policy.model === 'Task' && typeof values.type === 'string' && /^(percorso|promemoria|reminder):/i.test(values.type)
        && values.type !== before?.type) fail('HISTORY');
      await validateContext(tx, policy, before, { ...(before ?? { id: command.id }), ...values }, current.actor);
      if (policy.model === 'Task' && values.status) values.completedAt = values.status === 'completata' ? before?.completedAt ?? await current.finish() : null;
      if (command.operation === 'CREATE') {
        if (metadata(policy.model).fields.some(field => field.name === 'createdById')) values.createdById = current.actor.id;
        if (policy.model === 'Dossier') values.status = 'bozza_consulente';
        if (policy.model === 'PreAnalysis') values.status = 'raccolta_dati';
        if (policy.model === 'CommercialLeadSlaPolicyVersion') {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-record:sla-policy',0))::text`;
          const previous = await tx.commercialLeadSlaPolicyVersion.findMany({ where: { policyCode: 'COMMERCIAL_FIRST_RESPONSE' }, orderBy: { version: 'desc' } });
          values.version = (previous[0]?.version ?? 0) + 1;
          if (values.status === 'ACTIVE') {
            const active = previous.filter(row => row.status === 'ACTIVE'); if (active.length !== 1) fail('DENIED');
            await tx.commercialLeadSlaPolicyVersion.update({ where: { id: active[0].id }, data: { status: 'RETIRED', updatedAt: await current.finish() } });
            await tx.auditLog.create({ data: { actorId: current.actor.id, entityType: 'CommercialLeadSlaPolicyVersion', entityId: active[0].id,
              event: 'admin_sla_policy_replaced', after: { commandId: command.commandId, replacementId: command.id, previousVersion: active[0].version } } });
          }
        }
        after = await records.create({ data: { id: command.id, ...values } });
      } else after = await records.update({ where: { id: command.id }, data: values });
      // Read through a separate SELECT before recording success. The persisted
      // row, not the optimistic mutation result, is the journal's source.
      const persisted = (await records.findMany({ where: { id: command.id }, take: 1 }))[0];
      if (!persisted || Object.entries(values).some(([key, value]) => adminRecordVersion(persisted[key] ?? null) !== adminRecordVersion(value))) fail('STALE');
      after = persisted;
      if (policy.model === 'AiAgent') {
        const next = await tx.aiAgent.findUniqueOrThrow({ where: { id: command.id } });
        await tx.aiAgentConfigVersion.create({ data: { agentId: next.id, version: next.configVersion, code: next.code,
          name: next.name, description: next.description, operationalScope: next.operationalScope, systemPrompt: next.systemPrompt,
          requiredDataChecklist: next.requiredDataChecklist as Prisma.InputJsonValue, expectedOutput: next.expectedOutput, toneStyle: next.toneStyle,
          active: next.active, provider: next.provider, model: next.futureModel, promptVersion: next.promptVersion,
          inputSchema: next.inputSchema === null ? Prisma.JsonNull : next.inputSchema,
          outputSchema: next.outputSchema === null ? Prisma.JsonNull : next.outputSchema, createdById: current.actor.id } });
      }
    } else if (command.operation === 'TRASH') {
      if (!policy.trash || !before || before.deletedAt) fail('DENIED');
      if (policy.trash === 'soft') after = await records.update({ where: { id: command.id }, data: { deletedAt: await current.finish() } });
      else {
        // Only allowlisted ordinary leaf records may be removed; their complete
        // snapshot is atomically retained for restoration with the same identity.
        for (const dependent of models) for (const field of dependent.fields.filter(item => item.kind !== 'object'
          && relation(dependent.name, item.name)?.type === policy.model)) {
          if (await delegate(tx, dependent.name).count({ where: { [field.name]: before.id } })) fail('DEPENDENCIES');
        }
        await records.delete({ where: { id: command.id } }); after = null;
      }
    } else if (command.operation === 'RESTORE') {
      if (!policy.trash || (policy.trash === 'soft' ? !before?.deletedAt : !removed || before)) fail('DENIED');
      if (policy.trash === 'soft') {
        await validateContext(tx, policy, before, before!, current.actor);
        const data: Record<string, unknown> = { deletedAt: null };
        if (policy.model === 'PracticeCommunication' && before!.status === 'archiviata') {
          // Legacy archives retain these original facts. Reopening restores
          // their demonstrated state, or an unapproved draft; it creates none.
          if (Boolean(before!.reviewedById) !== Boolean(before!.reviewedAt)) fail('HISTORY');
          data.status = before!.usedAt ? 'usata_inviata' : before!.reviewedAt ? 'approvata' : 'bozza';
        }
        after = await records.update({ where: { id: command.id }, data });
      } else {
        const data = removed!.before as unknown as Row;
        await validateContext(tx, policy, null, data, current.actor);
        after = await records.create({ data });
      }
    } else if (!before) fail('DENIED'); // RECTIFY is an annotation, not a forged event.
    const now = await current.finish();
    const beforeSnapshot = before ? plain(before) : null, afterSnapshot = after ? plain(after) : null;
    const beforeHash = adminRecordVersion(beforeSnapshot), afterHash = adminRecordVersion(afterSnapshot);
    await tx.adminRecordRevision.create({ data: { commandId: command.commandId, actorId: current.actor.id, sessionId: current.registry.id,
      model: policy.model, recordId: command.id, operation: command.operation, requestHash,
      beforeHash, afterHash,
      before: beforeSnapshot ?? Prisma.JsonNull, after: afterSnapshot ?? Prisma.JsonNull,
      reason: command.reason, createdAt: now } });
    await tx.auditLog.create({ data: { id: `admin-record:${command.commandId}`, actorId: current.actor.id,
      event: 'admin_record_changed', entityType: policy.model, entityId: command.id,
      after: { action: command.operation, commandId: command.commandId, beforeHash,
        afterHash, changedPaths: Object.keys(command.values).sort() } } });
    await current.finish();
    return { commandId: command.commandId, model: policy.model, id: command.id, replayed: false };
  });
}

export async function readAdminRecordReceipt(db: PrismaClient, session: AuthSession, commandId: string) {
  z.string().uuid().parse(commandId);
  return withSerializableTransaction(db, async tx => {
    const current = await updateActor(tx, session);
    if (current.actor.role !== 'admin') fail('DENIED');
    const row = await tx.adminRecordRevision.findUnique({ where: { commandId } });
    if (!row) { await current.finish(); return null; }
    const policy = adminRecordPolicy(row.model);
    if (row.actorId !== current.actor.id || !recordUpdatePermission(current.actor, policy.permission)
      || !recordUpdatePermission(current.actor, readPermission(policy))) fail('DENIED');
    if (row.before) await assertContextVisible(tx, current.actor, row.model, row.before as unknown as Row);
    if (row.after) await assertContextVisible(tx, current.actor, row.model, row.after as unknown as Row);
    await current.finish();
    return { commandId, model: row.model, id: row.recordId, replayed: true, closed: row.operation === 'CLOSE' };
  });
}

export async function closeAdminRecordAttempt(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ commandId: z.string().uuid(), model: z.string(), id: identifier }).strict().parse(raw);
  const policy = adminRecordPolicy(input.model);
  return withSerializableTransaction(db, async tx => {
    const current = await auth(tx, session, policy);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-record:${input.commandId}`},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous) {
      if (previous.actorId !== current.actor.id || previous.model !== input.model || previous.recordId !== input.id) fail('DENIED');
      await current.finish();
      return { ...input, replayed: true, closed: previous.operation === 'CLOSE' };
    }
    const row = await delegate(tx, input.model).findUnique({ where: { id: input.id } });
    if (row) await assertContextVisible(tx, current.actor, input.model, row);
    await tx.adminRecordRevision.create({ data: { commandId: input.commandId, actorId: current.actor.id, sessionId: current.registry.id,
      model: input.model, recordId: input.id, operation: 'CLOSE', requestHash: adminRecordVersion(input),
      beforeHash: adminRecordVersion(null), afterHash: adminRecordVersion(null), before: Prisma.JsonNull, after: Prisma.JsonNull,
      reason: 'Tentativo riconciliato e chiuso senza modifica operativa.' } });
    await tx.auditLog.create({ data: { id: `admin-record:${input.commandId}`, actorId: current.actor.id,
      event: 'admin_record_attempt_closed', entityType: input.model, entityId: input.id, after: { commandId: input.commandId } } });
    await current.finish();
    return { ...input, replayed: false, closed: true };
  });
}

const referenceModels = ['Lead', 'Client', 'Company', 'Person', 'Project', 'TechnicalPractice', 'ClientService', 'Contract', 'Payment', 'Document', 'DocumentVersion', 'ServiceCatalog', 'GrantAssessment', 'PreAnalysis', 'IncorporationSubject', 'User'];
const deadlineModels = ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService'];
async function referenceRows(tx: Tx, actor: Actor, model: string, query = '', page = 1) {
  if (![...referenceModels, ...deadlineModels].includes(model)) fail('INVALID');
  if (model === 'DocumentVersion') {
    if (!recordUpdatePermission(actor, 'document.download')) fail('DENIED');
    const rows = await tx.$queryRaw<Array<{ id: string; documentId: string; title: string; version: number }>>`
      SELECT v.id, v."documentId", d.title, v.version FROM "DocumentVersion" v JOIN "Document" d ON d.id=v."documentId"
      WHERE d."deletedAt" IS NULL AND d.status='verificato' AND
        (${query}='' OR v.id=${query} OR d.id=${query} OR d.title ILIKE ${'%' + query + '%'})
      ORDER BY v.id LIMIT 51 OFFSET ${(page - 1) * 50}`;
    const options: NonNullable<AdminField['options']> = [];
    for (const row of rows.slice(0, 50)) {
      try { await assertContextVisible(tx, actor, 'DocumentVersion', row); }
      catch (error) { if (error instanceof AdminRecordError && ['DENIED', 'CONTEXT'].includes(error.code)) continue; throw error; }
      options.push({ value: row.id, label: `${row.title} · versione ${row.version}`, group: model });
    }
    return { options, hasNext: rows.length > 50 };
  }
  const fields = metadata(model).fields;
  const names = fields.filter(field => ['title', 'name', 'displayName', 'firstName', 'lastName', 'email', 'contractNumber', 'code'].includes(field.name));
  const rows = await delegate(tx, model).findMany({ take: 51, skip: (page - 1) * 50, orderBy: { id: 'asc' },
    where: { ...(fields.some(field => field.name === 'deletedAt') ? { deletedAt: null } : {}),
      ...(fields.some(field => field.name === 'technicalPrivate') ? { technicalPrivate: false } : {}),
      ...(fields.some(field => field.name === 'active') ? { active: true } : {}),
      ...(query ? { OR: [{ id: query }, ...names.map(field => ({ [field.name]: { contains: query, mode: 'insensitive' } }))] } : {}) },
    ...(model === 'User' ? { select: { id: true, name: true, email: true, active: true } } : {}) });
  const options: NonNullable<AdminField['options']> = [];
  for (const row of rows.slice(0, 50)) {
    try { if (model !== 'User') await assertContextVisible(tx, actor, model, row); }
    catch (error) { if (error instanceof AdminRecordError && ['DENIED', 'CONTEXT'].includes(error.code)) continue; throw error; }
    options.push({ value: row.id, label: label(row) + (model === 'User' ? ` · ${row.email}` : ''), group: model });
  }
  return { options, hasNext: rows.length > 50 };
}
export async function searchAdminRecordReferences(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ model: z.string().max(80), field: z.string().max(80), query: z.string().trim().max(200),
    page: z.number().int().min(1).max(10000), entityType: z.string().max(80).optional() }).strict().parse(raw);
  const policy = adminRecordPolicy(input.model);
  const paymentEvidence = input.model === 'Payment' && input.field === 'administrativeEvidenceVersionId';
  if (!paymentEvidence && !policy.fields.includes(input.field)) fail('INVALID');
  const target = paymentEvidence ? 'DocumentVersion' : input.model === 'Deadline' && input.field === 'entityId' && deadlineModels.includes(input.entityType ?? '')
    ? input.entityType : relation(input.model, input.field)?.type;
  if (!target || ![...referenceModels, ...deadlineModels].includes(target)) fail('INVALID');
  return withSerializableTransaction(db, async tx => {
    const current = await auth(tx, session, policy);
    const result = await referenceRows(tx, current.actor, target, input.query, input.page);
    await current.finish(); return result;
  });
}
async function fields(tx: Tx, policy: AdminRecordPolicy, row: Row | null, actor: Awaited<ReturnType<typeof updateActor>>['actor']) {
  const values: Record<string, string> = {}, result: AdminField[] = [];
  let editable = [...policy.fields];
  if (row) {
    if (['DocumentExtraction', 'VisuraAnalysis'].includes(policy.model)) editable = editable.filter(name => name !== 'documentId');
    if (row.technicalPrivate === true && privateFields[policy.model]) editable = privateFields[policy.model];
    if ((policy.model === 'PreAnalysis' && (row.reviewedById || row.approvedById || row.approvedAt || !['da_avviare', 'raccolta_dati', 'bozza_generata'].includes(String(row.status))))
      || (policy.model === 'Dossier' && (row.reviewedById || row.approvedById || row.approvedAt || !['bozza_ai', 'bozza_consulente'].includes(String(row.status))))
      || (policy.model === 'ClientDossier' && (row.currentVersionId || row.approvedVersionId || row.reviewedById || row.reviewedAt || row.status !== 'bozza'))
      || (policy.model === 'AiOutput' && (row.reviewedById || row.reviewedAt || row.approvedById || row.approvedAt || !['needs_review', 'flagged'].includes(String(row.status))))
      || (policy.model === 'PracticeCommunication' && !['bozza', 'da_revisionare'].includes(String(row.status)))
      || policy.model === 'CommercialLeadSlaPolicyVersion') editable = [];
    if (policy.model === 'Contract' && (row.signedAt || row.signedDocumentId || row.status === 'firmato'
      || await tx.payment.count({ where: { contractId: row.id, OR: [{ collectedAt: { not: null } }, { status: { in: ['parziale', 'incassato', 'stornato', 'rimborsato'] } }] } }))) editable = ['notes', 'status'];
    if (policy.model === 'Payment' && (row.collectedAt || row.accountingDocumentId || !['da_incassare', 'scaduto'].includes(String(row.status))
      || await tx.clientService.count({ where: { paymentId: row.id } }))) editable = ['method', 'dueDate', 'status', 'notes'];
    if (policy.model === 'CommercialOffer' && (row.status !== 'bozza' || await tx.practiceOfferRevision.count({ where: { commercialOfferId: row.id } }))) editable = ['notes', 'followUpAt', 'followUpNote', 'outcomeNote'];
    if (archives[policy.model] && !editable.includes('status')) editable.push('status');
  }
  for (const name of policy.fields) {
    const field = metadata(policy.model).fields.find(item => item.name === name)!;
    if (!field || field.kind === 'object') fail('INVALID');
    const related = relation(policy.model, name);
    const initial = !row && name === 'status' && archives[policy.model] ? archives[policy.model].draft
      : row?.[name] ?? (field.hasDefaultValue && typeof field.default !== 'object' ? field.default : null);
    values[name] = initial == null ? '' : initial instanceof Date ? initial.toISOString() : field.type === 'Json' ? JSON.stringify(initial, null, 2) : String(initial);
    const descriptor: AdminField = { name, label: adminFieldLabels[name] ?? name.replace(/([A-Z])/g, ' $1').toLowerCase(),
      required: field.isRequired && !field.hasDefaultValue, readOnly: !editable.includes(name),
      type: field.type === 'DateTime' ? 'date' : field.type === 'Boolean' ? 'boolean' : ['Decimal', 'Int'].includes(field.type) ? 'number'
        : field.type === 'Json' ? 'json' : /notes|description|summary|content|conditions|rationale|issues|findings|documents|text/i.test(name) ? 'longtext' : 'text' };
    if (related) {
      if (!referenceModels.includes(related.type)) fail('INVALID');
      const found = await referenceRows(tx, actor, related.type);
      descriptor.type = 'select'; descriptor.reference = true; descriptor.options = found.options;
      if (initial && !descriptor.options.some(option => option.value === String(initial))) {
        const current = await delegate(tx, related.type).findUnique({ where: { id: String(initial) } });
        descriptor.options.push({ value: String(initial), label: current ? label(current) + (related.type === 'User' ? ` · ${current.email}` : '') + ' · collegamento attuale' : 'Collegamento attuale non disponibile · ' + String(initial) });
      }
      descriptor.help = 'Cerca per nome, email o identificativo e sfoglia i risultati. Il collegamento scelto resta conservato durante la ricerca.';
    } else if (policy.model === 'Deadline' && name === 'entityType') {
      descriptor.type = 'select'; descriptor.options = ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService']
        .map(model => ({ value: model, label: adminRecordPolicy(model).label }));
    } else if (policy.model === 'Deadline' && name === 'entityId') {
      descriptor.type = 'select'; descriptor.reference = true; descriptor.dependsOn = 'entityType'; descriptor.options = [];
      for (const model of deadlineModels) descriptor.options.push(...(await referenceRows(tx, actor, model)).options);
      if (initial && !descriptor.options.some(option => option.value === String(initial)))
        descriptor.options.push({ value: String(initial), label: 'Collegamento attuale · ' + String(initial), group: String(row?.entityType) });
    } else if (name === 'status' && archives[policy.model]) {
      const archive = archives[policy.model], restored = row ? await archiveRestoreStatus(tx, policy.model, row) : null;
      descriptor.type = 'select'; descriptor.options = [...new Set(row ? [String(row.status), archive.status, ...(restored ? [restored] : [])] : [archive.draft])]
        .map(value => ({ value, label: value === archive.status ? 'Archivia conservando le evidenze' : restored === value ? 'Ripristina lo stato precedente · ' + value.replaceAll('_', ' ') : value.replaceAll('_', ' ') }));
      descriptor.help = 'L’archiviazione conserva contenuto, autori e approvazioni. Il ripristino è ammesso solo allo stato registrato prima dell’archiviazione, senza altre modifiche.';
    } else if (policy.model === 'Payment' && name === 'status') {
      descriptor.type = 'select'; descriptor.options = (await paymentStatuses(tx, row)).map(value => ({ value, label: value.replaceAll('_', ' ') }));
      descriptor.help = 'Il cambio di stato è una dichiarazione amministrativa documentata. Gli incassi si registrano dal percorso dedicato. Il ripristino recupera solo lo stato precedente registrato.';
    } else if (field.kind === 'enum') {
      descriptor.type = 'select'; descriptor.options = Prisma.dmmf.datamodel.enums.find(item => item.name === field.type)!.values
        .filter(item => (policy.model !== 'Project' || item.name !== 'archiviato')
          && (policy.model !== 'Document' || name !== 'status' || item.name !== 'archiviato' || row?.status === 'archiviato')).map(item => ({ value: item.name, label: item.name.replaceAll('_', ' ') }));
      if (policy.model === 'Document' && name === 'status') descriptor.help = 'Lo stato descrive la verifica del documento. Per sospendere l’accesso usa «Sposta nel cestino recuperabile», poi «Ripristina» quando necessario.';
    } else if (name === 'priority') {
      descriptor.type = 'select'; descriptor.options = ['bassa', 'media', 'alta', 'urgente'].map(value => ({ value, label: value }));
    } else if (policy.model === 'Client' && name === 'status') {
      descriptor.type = 'select'; descriptor.options = ['attivo', 'sospeso', 'archiviato'].map(value => ({ value, label: value }));
    } else if (policy.model === 'CommercialLeadSlaPolicyVersion' && name === 'status') {
      descriptor.type = 'select'; descriptor.options = (row ? ['STAGED', 'ACTIVE', 'RETIRED'] : ['STAGED', 'ACTIVE']).map(value => ({ value,
        label: value === 'STAGED' ? 'Preparata per la valutazione' : value === 'RETIRED' ? 'Storica' : row ? 'Attiva' : 'Sostituisci la politica attiva' }));
    }
    result.push(descriptor);
  }
  return { values, fields: result };
}
export async function loadAdminRecord(db: PrismaClient, session: AuthSession, model: string, id: string, creating = false, revisionId?: string): Promise<AdminRecordForm> {
  const policy = adminRecordPolicy(model); identifier.parse(id);
  if (revisionId) z.string().uuid().parse(revisionId);
  return withSerializableTransaction(db, async tx => {
    const current = await auth(tx, session, policy);
    const existing = await delegate(tx, model).findUnique({ where: { id } });
    const removed = !existing && !creating ? await readDeleted(tx, model, id) : null;
    const row = existing ?? (removed?.before as unknown as Row | undefined) ?? null;
    if (creating ? !policy.create || Boolean(row) : !row) fail('DENIED');
    if (row) await assertContextVisible(tx, current.actor, model, row);
    if (model === 'ClientDossier' && row?.practiceReadinessId) await dossierLifecycleContext(tx, session, id);
    const privateTarget = row?.technicalPrivate === true && privateFields[model] ? await admitPrivateItem(tx, current.actor, model, row) : null;
    const history = await tx.adminRecordRevision.findMany({ where: { model, recordId: id, operation: { not: 'CLOSE' } }, orderBy: [{ createdAt: 'desc' }, { transactionId: 'desc' }, { commandId: 'desc' }], take: 100,
      select: { commandId: true, operation: true, createdAt: true, reason: true, actor: { select: { name: true, email: true } } } });
    const memberships = model === 'Person' ? await tx.companyPerson.findMany({ where: { personId: id } }) : [];
    const companies = await tx.company.findMany({ where: { id: { in: memberships.map(item => item.companyId) } }, select: { id: true, name: true, clientId: true } });
    const relationships = memberships.flatMap(link => {
      const company = companies.find(item => item.id === link.companyId);
      return company && admittedRow(current.actor, company) ? [{ label: `${company.name} · ${link.role}`, href: `/companies/${company.id}` }] : [];
    });
    if (memberships.length !== relationships.length) fail('DENIED');
    let draftRow = row;
    if (revisionId) {
      if (creating || !row || row.deletedAt || removed) fail('DENIED');
      const revision = await tx.adminRecordRevision.findUnique({ where: { commandId: revisionId } });
      if (!revision || revision.model !== model || revision.recordId !== id || !revision.before || !['UPDATE', 'RESTORE'].includes(revision.operation)) fail('DENIED');
      await assertContextVisible(tx, current.actor, model, revision.before as unknown as Row);
      // Only the ordinary editable fields become a draft. Current identity,
      // version and provenance remain authoritative until an explicit save.
      draftRow = { ...row, ...Object.fromEntries(policy.fields.map(field => [field, (revision.before as Record<string, unknown>)[field]])) };
    }
    const form = await fields(tx, policy, draftRow, current.actor);
    await current.finish();
    return { model, id, version: adminRecordVersion(row), label: creating ? `Nuovo · ${policy.label}` : label(row!),
      ...form, create: creating, trash: Boolean(policy.trash), deleted: Boolean(row?.deletedAt || removed),
      paymentCorrection: model === 'Payment' && !creating,
      guidance: privateTarget ? 'Elemento tecnico privato: puoi correggere il contenuto, archiviare e ripristinare entro la tua autorità personale. Origine e collegamenti restano conservati. I cambi di stato e lifecycle invalidano i perimetri precedenti: dopo il ripristino verifica e conferma di nuovo gli incarichi necessari.' : policy.guidance ?? null,
      href: privateTarget ? privateTarget.kind === 'Project' ? `/projects/${privateTarget.targetId}/assignments` : `/technical-office/practices/${privateTarget.targetId}/assignments` : policy.href.replace('{id}', id), relationships, restoringRevision: revisionId ?? null,
      history: history.map(item => ({ id: item.commandId, action: item.operation, at: item.createdAt.toISOString(), reason: item.reason,
        actor: `${item.actor.name} · ${item.actor.email}`, canRestore: !creating && !row?.deletedAt && !removed && ['UPDATE', 'RESTORE'].includes(item.operation) })) };
  });
}
export async function listAdminRecords(db: PrismaClient, session: AuthSession, model: string, query = '', page = 1, trash = false) {
  const policy = adminRecordPolicy(model);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || query.length > 200) fail('INVALID');
  return withSerializableTransaction(db, async tx => {
    const current = await auth(tx, session, policy);
    const search = metadata(model).fields.filter(field => ['title', 'name', 'displayName', 'firstName', 'lastName', 'contractNumber', 'code'].includes(field.name));
    const where = { ...(query ? { OR: [{ id: query }, ...search.map(field => ({ [field.name]: { contains: query, mode: 'insensitive' } }))] } : {}),
      ...(policy.trash === 'soft' ? { deletedAt: trash ? { not: null } : null } : {}) };
    let rows: Row[];
    if (trash && policy.trash === 'leaf') {
      const snapshots = await tx.$queryRaw<Array<{ before: Row }>>`SELECT latest.before FROM (
        SELECT DISTINCT ON ("recordId") "recordId", operation, before FROM "AdminRecordRevision"
        WHERE model=${model} AND operation <> 'CLOSE' ORDER BY "recordId", "createdAt" DESC, "transactionId" DESC, "commandId" DESC
      ) latest WHERE operation='TRASH' AND (${query}='' OR "recordId"=${query} OR latest.before::text ILIKE ${'%' + query + '%'})
      ORDER BY "recordId" LIMIT 51 OFFSET ${(page - 1) * 50}`;
      rows = snapshots.map(snapshot => ({ ...snapshot.before, deletedAt: true }));
    } else rows = trash && !policy.trash ? [] : await delegate(tx, model).findMany({ where, take: 51, skip: (page - 1) * 50, orderBy: { id: 'asc' } });
    const visible = [];
    for (const row of rows.slice(0, 50)) {
      try { await assertContextVisible(tx, current.actor, model, row); }
      catch (error) { if (error instanceof AdminRecordError && ['DENIED', 'CONTEXT'].includes(error.code)) continue; throw error; }
      visible.push({ id: row.id, label: label(row), deleted: Boolean(row.deletedAt), status: String(row.status ?? ''),
        dueAt: row.dueAt instanceof Date ? row.dueAt.toISOString() : row.dueDate instanceof Date ? row.dueDate.toISOString() : null });
    }
    await current.finish();
    return { rows: visible, hasNext: rows.length > 50 };
  });
}
