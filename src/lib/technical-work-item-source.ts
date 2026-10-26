import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { isFinancialDocument } from './financial-privacy-policy';
import { canAccessFinancialDocument } from './financial-document-access';
import type { lockTechnicalAssignmentContext } from './technical-assignment-context';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import { TechnicalAssignmentError, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { lockTechnicalWorkItemGeneration, type TechnicalWorkItemIdentity } from './technical-work-item-generation';
import { technicalItemMatchesParent, type TechnicalWorkItemParent } from './technical-work-item-context';
import { technicalWorkItemGrants } from './technical-work-item-grant';
import { matchesTechnicalWorkItemOption, technicalWorkItemCatalogueQuery, technicalWorkItemCandidateLimit,
  technicalWorkItemPageSize, type TechnicalWorkItemCatalogueQuery, type TechnicalWorkItemOption } from './technical-work-item-catalog';

type Tx = Prisma.TransactionClient;
type Context = NonNullable<Awaited<ReturnType<typeof lockTechnicalAssignmentContext>>>;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
function denied(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }

/** Parent locks must precede this function. Existing nullable links constrain
 * the explicit choice; the loader never adds a relationship or a permission. */
export async function lockTechnicalWorkItemSource(tx: Tx, state: TechnicalAssignmentTransaction,
  context: Context, reference: TechnicalWorkItemIdentity, documents: TechnicalAssignmentSelection['documents'], write = false) {
  id.parse(reference.itemId);
  if (!['Task', 'ChecklistItem'].includes(reference.kind) || !context.operational || !state.recipient) denied();
  const project = context.projectId ? await tx.project.findUnique({ where: { id: context.projectId }, select: { companyId: true } }) : null;
  const companyId = project?.companyId ?? null;
  let companyGeneration: number | null = null;
  if (companyId) {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${companyId} FOR SHARE`;
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { clientId: true, deletedAt: true } });
    const versions = await tx.$queryRaw<Array<{ generation: number }>>`SELECT generation FROM "SelectiveCompanyGeneration" WHERE "companyId"=${companyId} FOR SHARE`;
    if (!company || company.clientId !== context.clientId || company.deletedAt || versions.length !== 1
      || !Number.isSafeInteger(versions[0].generation) || versions[0].generation < 1) denied();
    companyGeneration = versions[0].generation;
  }
  const table = reference.kind === 'Task' ? 'Task' : 'DocumentChecklistItem';
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id=${reference.itemId}
    ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const task = reference.kind === 'Task' ? await tx.task.findUnique({ where: { id: reference.itemId } }) : null;
  const checklist = reference.kind === 'ChecklistItem' ? await tx.documentChecklistItem.findUnique({ where: { id: reference.itemId } }) : null;
  const row = task ?? checklist;
  if (!row || !row.clientId || row.deletedAt || (checklist && !checklist.active)
    || isFinancialDocument({ title: row.title, type: task?.type })) denied();
  const epoch = await lockTechnicalWorkItemGeneration(tx, { kind: reference.kind, itemId: reference.itemId }, write ? 'write' : 'read');
  const parent: TechnicalWorkItemParent = { target: { kind: context.kind, targetId: context.targetId },
    clientId: context.clientId, projectId: context.projectId, serviceId: context.clientServiceId,
    companyId, contextSha256: context.contextSha256, operational: context.operational };
  const item = { id: row.id, kind: reference.kind, clientId: row.clientId, projectId: row.projectId,
    serviceId: row.clientServiceId, companyId: task?.companyId ?? null,
    active: true, financialRestricted: false, scopeGeneration: epoch.scopeGeneration };
  if (!technicalItemMatchesParent(parent, item)) denied();
  let documentEpoch: number | null = null;
  if (checklist?.documentId) {
    // A checklist link does not grant document access. The same exact version
    // must be separately selected and checked by assertTechnicalAssignmentDocuments.
    if (!documents.some(document => document.documentId === checklist.documentId)) denied();
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${checklist.documentId} FOR SHARE`;
    const document = await tx.document.findUnique({ where: { id: checklist.documentId } });
    if (!document || document.deletedAt || !await canAccessFinancialDocument(tx, state.recipient, document)) denied();
    documentEpoch = document.selectiveEpoch;
  }
  const scopeSha256 = canonicalSha256({ protocol: 'TECHNICAL_ITEM_SCOPE_V1', parent, item,
    companyGeneration, documentId: checklist?.documentId ?? null, documentEpoch });
  const values: Record<string, string | null> = task ? { title: task.title, description: task.description,
    status: task.status, priority: task.priority, dueAt: task.dueAt?.toISOString() ?? null }
    : { title: checklist!.title, notes: checklist!.notes, status: checklist!.status };
  return { parent, item, epoch, scopeSha256, values };
}

/** Preview/confirmation check the exact content generation as well as scope.
 * Active work may advance content generations, but never its retained scope. */
export async function assertTechnicalWorkItemChoices(tx: Tx, state: TechnicalAssignmentTransaction,
  context: Context, selection: TechnicalAssignmentSelection) {
  const choices = technicalWorkItemGrants.parse(selection.workItems ?? []);
  const snapshots = [];
  for (const choice of [...choices].sort((a, b) => `${a.kind}:${a.itemId}`.localeCompare(`${b.kind}:${b.itemId}`))) {
    const source = await lockTechnicalWorkItemSource(tx, state, context, choice, selection.documents);
    if (source.epoch.generation !== choice.generation || source.epoch.scopeGeneration !== choice.scopeGeneration
      || source.scopeSha256 !== choice.scopeSha256) stale();
    snapshots.push({ ...choice, fields: choice.readableFields.map(key => ({ key, value: source.values[key],
      editable: choice.editableFields.some(field => field === key) })) });
  }
  return snapshots;
}

/** Bounded current Admin catalogue, not a grant. Each actual choice is reread
 * under locks in preview and in the personal confirmation transaction. */
export async function listTechnicalWorkItemOptions(tx: Tx, state: TechnicalAssignmentTransaction,
  context: Context, documents: TechnicalAssignmentSelection['documents'], rawQuery: TechnicalWorkItemCatalogueQuery = technicalWorkItemCatalogueQuery.parse({})) {
  const query = technicalWorkItemCatalogueQuery.parse(rawQuery);
  // The safety ceiling covers the complete source set independently of query or
  // page. No partial list or continuation is returned above the ceiling.
  const tasks = await tx.task.findMany({ where: { clientId: context.clientId, deletedAt: null }, orderBy: { id: 'asc' }, take: technicalWorkItemCandidateLimit + 1, select: { id: true } });
  const checks = await tx.documentChecklistItem.findMany({ where: { clientId: context.clientId, deletedAt: null, active: true }, orderBy: { id: 'asc' }, take: technicalWorkItemCandidateLimit + 1, select: { id: true } });
  if (tasks.length + checks.length > technicalWorkItemCandidateLimit) throw new TechnicalAssignmentError('UNAVAILABLE');
  const options: TechnicalWorkItemOption[] = [];
  const candidates: TechnicalWorkItemIdentity[] = [...checks.map(row => ({ kind: 'ChecklistItem' as const, itemId: row.id })),
    ...tasks.map(row => ({ kind: 'Task' as const, itemId: row.id }))];
  let admitted = 0;
  for (const reference of candidates) {
    try {
      const source = await lockTechnicalWorkItemSource(tx, state, context, reference, documents);
      const option = { ...reference, generation: source.epoch.generation, scopeGeneration: source.epoch.scopeGeneration,
        scopeSha256: source.scopeSha256, title: source.values.title! };
      if (!matchesTechnicalWorkItemOption(option, query)) continue;
      if (admitted++ < (query.page - 1) * technicalWorkItemPageSize) continue;
      options.push(option);
      if (options.length > technicalWorkItemPageSize) break;
    } catch (error) { if (!(error instanceof TechnicalAssignmentError && error.code === 'DENIED')) throw error; }
  }
  return { options: options.slice(0, technicalWorkItemPageSize), query, hasNext: options.length > technicalWorkItemPageSize };
}
