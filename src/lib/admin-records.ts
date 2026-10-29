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

type Tx = Prisma.TransactionClient;
async function withSerializableTransaction<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
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
export const adminRecordCommand = z.object({ commandId: z.string().uuid(), model: z.string().min(1).max(80), id: identifier,
  operation: z.enum(['CREATE', 'UPDATE', 'TRASH', 'RESTORE', 'RECTIFY']), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(2000), values: z.record(z.string(), z.string().max(100_000)),
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
      result[name] = field.type === 'Int' ? Number(value) : value;
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
/** Walk ordinary parent links before exposing or changing a child. A child
 * without clientId must not bypass an exclusion on its project or document. */
async function assertContextVisible(tx: Tx, actor: Actor, model: string, row: Row, seen = new Set<string>()) {
  const key = `${model}:${row.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!admittedRow(actor, row)) fail('DENIED');
  const policy = adminRecordCatalogue.find(item => item.model === model);
  if (policy && !recordUpdatePermission(actor, readPermission(policy))) fail('DENIED');
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
  if (policy.model === 'CommercialOffer' && !after.leadId && !after.clientId) fail('CONTEXT');
  if (after.documentId) {
    const document = links.get('Document');
    if (document && (document.clientId !== after.clientId || (document.projectId && document.projectId !== after.projectId))) fail('CONTEXT');
  }
  if (policy.model === 'Deadline') {
    const targetPolicy = adminRecordCatalogue.find(item => ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService'].includes(item.model) && item.model === after.entityType);
    if (!targetPolicy || !after.entityId) fail('CONTEXT');
    await lock(tx, targetPolicy.model, String(after.entityId));
    const target = await delegate(tx, targetPolicy.model).findUnique({ where: { id: String(after.entityId) } });
    if (!target || target.deletedAt) fail('CONTEXT');
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
  if (policy.model === 'CommercialLeadSlaPolicyVersion') fail('HISTORY');
  if (policy.model === 'CommercialOffer' && changed.some(key => !['notes', 'followUpAt', 'followUpNote', 'outcomeNote'].includes(key))
    && (before.status !== 'bozza' || await tx.practiceOfferRevision.count({ where: { commercialOfferId: before.id } }))) fail('HISTORY');
  if (policy.model === 'PreAnalysis' && !['da_avviare', 'raccolta_dati', 'bozza_generata'].includes(String(before.status))) fail('HISTORY');
  if (policy.model === 'Dossier' && !['bozza_ai', 'bozza_consulente'].includes(String(before.status))) fail('HISTORY');
  if (policy.model === 'ClientDossier' && (before.currentVersionId || before.approvedVersionId || before.status !== 'bozza')) fail('HISTORY');
  if (policy.model === 'AiOutput' && !['needs_review', 'flagged'].includes(String(before.status))) fail('HISTORY');
  if (policy.model === 'PracticeCommunication' && !['bozza', 'da_revisionare'].includes(String(before.status))) fail('HISTORY');
  if (policy.model === 'Contract' && changed.some(key => !['notes', 'status'].includes(key)) && (before.signedAt || before.signedDocumentId || before.status === 'firmato'
    || await tx.payment.count({ where: { contractId: before.id, OR: [{ collectedAt: { not: null } }, { status: { in: ['parziale', 'incassato', 'stornato', 'rimborsato'] } }] } }))) fail('HISTORY');
  if (policy.model === 'Payment' && changed.some(key => !['method', 'dueDate', 'notes'].includes(key))
    && (before.collectedAt || before.accountingDocumentId || !['da_incassare', 'scaduto'].includes(String(before.status))
      || await tx.clientService.count({ where: { paymentId: before.id } }))) fail('HISTORY');
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
    if (removed) await assertContextVisible(tx, current.actor, policy.model, removed.before as unknown as Row);
    if (adminRecordVersion(removed ? removed.before : before) !== command.expectedVersion) fail('STALE');
    let after: Row | null = before;
    if (command.operation === 'CREATE' || command.operation === 'UPDATE') {
      if (command.operation === 'CREATE' ? !policy.create || before !== null : !before || Boolean(before.deletedAt)) fail('DENIED');
      const values = parseAdminRecordValues(policy, command.values, command.operation === 'CREATE');
      const changed = Object.keys(values).filter(key => adminRecordVersion(before?.[key] ?? null) !== adminRecordVersion(values[key]));
      if (before) await assertEditable(tx, policy, before, changed);
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
    } else if (command.operation === 'TRASH') {
      if (!policy.trash || !before || before.deletedAt) fail('DENIED');
      if (policy.model === 'PracticeCommunication') await assertEditable(tx, policy, before, []);
      if (policy.trash === 'soft') after = await records.update({ where: { id: command.id }, data: { deletedAt: await current.finish() } });
      else {
        // Only allowlisted ordinary leaf records may be removed; their complete
        // snapshot is atomically retained for restoration with the same identity.
        await records.delete({ where: { id: command.id } }); after = null;
      }
    } else if (command.operation === 'RESTORE') {
      if (!policy.trash || (policy.trash === 'soft' ? !before?.deletedAt : !removed || before)) fail('DENIED');
      if (policy.trash === 'soft') {
        await validateContext(tx, policy, before, before!, current.actor);
        after = await records.update({ where: { id: command.id }, data: { deletedAt: null } });
      } else {
        const data = removed!.before as unknown as Row;
        await validateContext(tx, policy, null, data, current.actor);
        after = await records.create({ data });
      }
    } else if (!before) fail('DENIED'); // RECTIFY is an annotation, not a forged event.
    const now = await current.finish();
    await tx.adminRecordRevision.create({ data: { commandId: command.commandId, actorId: current.actor.id, sessionId: current.registry.id,
      model: policy.model, recordId: command.id, operation: command.operation, requestHash,
      beforeHash: adminRecordVersion(before), afterHash: adminRecordVersion(after),
      before: before ? plain(before) : Prisma.JsonNull, after: after ? plain(after) : Prisma.JsonNull,
      reason: command.reason, createdAt: now } });
    await tx.auditLog.create({ data: { id: `admin-record:${command.commandId}`, actorId: current.actor.id,
      event: 'admin_record_changed', entityType: policy.model, entityId: command.id,
      after: { action: command.operation, commandId: command.commandId, beforeHash: adminRecordVersion(before),
        afterHash: adminRecordVersion(after), changedPaths: Object.keys(command.values).sort() } } });
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

async function fields(tx: Tx, policy: AdminRecordPolicy, row: Row | null, actor: Awaited<ReturnType<typeof updateActor>>['actor']) {
  const values: Record<string, string> = {}, result: AdminField[] = [];
  let editable = [...policy.fields];
  if (row) {
    if ((policy.model === 'PreAnalysis' && !['da_avviare', 'raccolta_dati', 'bozza_generata'].includes(String(row.status)))
      || (policy.model === 'Dossier' && !['bozza_ai', 'bozza_consulente'].includes(String(row.status)))
      || (policy.model === 'ClientDossier' && (row.currentVersionId || row.approvedVersionId || row.status !== 'bozza'))
      || (policy.model === 'AiOutput' && !['needs_review', 'flagged'].includes(String(row.status)))
      || (policy.model === 'PracticeCommunication' && !['bozza', 'da_revisionare'].includes(String(row.status)))
      || policy.model === 'CommercialLeadSlaPolicyVersion') editable = [];
    if (policy.model === 'Contract' && (row.signedAt || row.signedDocumentId || row.status === 'firmato'
      || await tx.payment.count({ where: { contractId: row.id, OR: [{ collectedAt: { not: null } }, { status: { in: ['parziale', 'incassato', 'stornato', 'rimborsato'] } }] } }))) editable = ['notes', 'status'];
    if (policy.model === 'Payment' && (row.collectedAt || row.accountingDocumentId || !['da_incassare', 'scaduto'].includes(String(row.status))
      || await tx.clientService.count({ where: { paymentId: row.id } }))) editable = ['method', 'dueDate', 'notes'];
    if (policy.model === 'CommercialOffer' && (row.status !== 'bozza' || await tx.practiceOfferRevision.count({ where: { commercialOfferId: row.id } }))) editable = ['notes', 'followUpAt', 'followUpNote', 'outcomeNote'];
  }
  for (const name of policy.fields) {
    const field = metadata(policy.model).fields.find(item => item.name === name)!;
    if (!field || field.kind === 'object') fail('INVALID');
    const related = relation(policy.model, name);
    const initial = row?.[name] ?? (field.hasDefaultValue && typeof field.default !== 'object' ? field.default : null);
    values[name] = initial == null ? '' : initial instanceof Date ? initial.toISOString() : field.type === 'Json' ? JSON.stringify(initial, null, 2) : String(initial);
    const descriptor: AdminField = { name, label: adminFieldLabels[name] ?? name.replace(/([A-Z])/g, ' $1').toLowerCase(),
      required: field.isRequired && !field.hasDefaultValue, readOnly: !editable.includes(name),
      type: field.type === 'DateTime' ? 'date' : field.type === 'Boolean' ? 'boolean' : ['Decimal', 'Int'].includes(field.type) ? 'number'
        : field.type === 'Json' ? 'json' : /notes|description|summary|content|conditions|rationale|issues|findings|documents|text/i.test(name) ? 'longtext' : 'text' };
    if (related) {
      const allowed = ['Lead', 'Client', 'Company', 'Person', 'Project', 'TechnicalPractice', 'ClientService', 'Contract', 'Payment', 'Document', 'ServiceCatalog', 'GrantAssessment', 'PreAnalysis', 'IncorporationSubject', 'User'];
      if (!allowed.includes(related.type)) fail('INVALID');
      const rows = await delegate(tx, related.type).findMany({ take: 1001, orderBy: { id: 'asc' },
        where: { ...(metadata(related.type).fields.some(item => item.name === 'deletedAt') ? { deletedAt: null } : {}) },
        ...(related.type === 'User' ? { select: { id: true, name: true, email: true, active: true } } : {}) });
      descriptor.type = 'select';
      descriptor.options = [];
      for (const item of rows.slice(0, 1000)) {
        try { if (related.type !== 'User') await assertContextVisible(tx, actor, related.type, item); }
        catch (error) { if (error instanceof AdminRecordError && ['DENIED', 'CONTEXT'].includes(error.code)) continue; throw error; }
        if (item.active === false) continue;
        descriptor.options.push({ value: item.id, label: label(item) + (related.type === 'User' ? ` · ${item.email}` : '') });
      }
      if (initial && !descriptor.options.some(option => option.value === String(initial)))
        descriptor.options.push({ value: String(initial), label: 'Collegamento attuale non operativo · ' + String(initial) });
      if (rows.length > 1000) descriptor.help = 'Sono mostrati i primi 1000 record. Il collegamento attuale resta disponibile; selezioni ulteriori richiedono il contesto specifico.';
    } else if (policy.model === 'Deadline' && name === 'entityType') {
      descriptor.type = 'select'; descriptor.options = ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService']
        .map(model => ({ value: model, label: adminRecordPolicy(model).label }));
    } else if (policy.model === 'Deadline' && name === 'entityId') {
      descriptor.type = 'select'; descriptor.dependsOn = 'entityType'; descriptor.options = [];
      for (const model of ['Client', 'Project', 'TechnicalPractice', 'Task', 'ClientService']) {
        const parents = await delegate(tx, model).findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, take: 1001 });
        for (const parent of parents.slice(0, 1000)) {
          try { await assertContextVisible(tx, actor, model, parent); }
          catch (error) { if (error instanceof AdminRecordError && ['DENIED', 'CONTEXT'].includes(error.code)) continue; throw error; }
          descriptor.options.push({ value: parent.id, label: label(parent), group: model });
        }
        if (parents.length > 1000) descriptor.help = 'Elenco limitato ai primi 1000 record per tipo. Usa il contesto specifico per ulteriori collegamenti.';
      }
    } else if (field.kind === 'enum') {
      descriptor.type = 'select'; descriptor.options = Prisma.dmmf.datamodel.enums.find(item => item.name === field.type)!.values
        .filter(item => policy.model !== 'Project' || item.name !== 'archiviato').map(item => ({ value: item.name, label: item.name.replaceAll('_', ' ') }));
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
      guidance: policy.guidance ?? null, href: policy.href.replace('{id}', id), relationships, restoringRevision: revisionId ?? null,
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
