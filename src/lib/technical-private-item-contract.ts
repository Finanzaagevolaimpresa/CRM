import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { isFinancialDocument } from './financial-privacy-policy';
import { technicalTargetReference } from './technical-assignment-display';
import type { TechnicalWorkItemParent } from './technical-work-item-context';

// Private creation retains its exact target separately from assignment.
// Existing assignment/update protocols still require explicit current grants.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(2_147_483_647);
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000);
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().max(5000).nullable();
const dueAt = z.string().datetime({ offset: true }).nullable()
  .transform(value => value === null ? null : new Date(value).toISOString());
const identity = { commandId: z.string().uuid(), itemId: z.string().uuid(),
  target: technicalTargetReference, expectedContextSha256: hash };
export const technicalPrivateItemCommand = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('Task'), values: z.object({
    title, description: text, priority: z.enum(['bassa', 'media', 'alta', 'urgente']), dueAt,
  }).strict() }).strict(),
  z.object({ ...identity, kind: z.literal('ChecklistItem'), values: z.object({ title, notes: text }).strict() }).strict(),
]).refine(value => !isFinancialDocument({ title: value.values.title }), 'Financial content is outside technical creation');
export type TechnicalPrivateItemCommand = z.infer<typeof technicalPrivateItemCommand>;

const parentLinks = { clientId: id, projectId: id.nullable(), serviceId: id.nullable(), companyId: id.nullable() };
export const technicalPrivateItemAdmission = z.object({
  authorityId: z.literal('technical-assignment'), authorityUserId: id,
  authorityRevision: epoch, authorityEnabled: z.literal(true),
  actorId: id, actorEpoch: epoch, role: z.literal('admin'),
  managerAllowed: z.literal(true), serviceWriteAllowed: z.literal(true),
  sessionId: z.string().uuid(), sessionExpiresAt: instant, personalProofExpiresAt: instant,
  keyVersion: epoch, target: technicalTargetReference, contextSha256: hash,
  targetOperational: z.literal(true), parent: z.object(parentLinks).strict(),
}).strict().refine(value => value.actorId === value.authorityUserId
  && (value.target.kind !== 'Project' || value.parent.projectId === value.target.targetId),
'Personal authority and canonical target are required');
export type TechnicalPrivateItemAdmission = z.infer<typeof technicalPrivateItemAdmission>;

/** These facts must come from current registered sessions, personal step-up and
 * locked canonical rows; parsing an untrusted form never establishes admission. */
export function admitsTechnicalPrivateItemCreation(raw: unknown, current: unknown, now: number) {
  const command = technicalPrivateItemCommand.safeParse(raw), admission = technicalPrivateItemAdmission.safeParse(current);
  return command.success && admission.success && instant.safeParse(now).success
    && admission.data.sessionExpiresAt > now && admission.data.personalProofExpiresAt > now
    && command.data.expectedContextSha256 === admission.data.contextSha256
    && canonicalJson(command.data.target) === canonicalJson(admission.data.target);
}
export function technicalPrivateItemRequestDigest(raw: TechnicalPrivateItemCommand) {
  return canonicalSha256({ protocol: 'TECHNICAL_PRIVATE_ITEM_REQUEST_V1', command: technicalPrivateItemCommand.parse(raw) });
}

/** Initial values are fixed by the server, not selectable state transitions.
 * The private origin/command/audit still have to commit atomically with this row. */
export function technicalPrivateItemInitialRow(raw: TechnicalPrivateItemCommand, current: TechnicalPrivateItemAdmission, now: number) {
  const command = technicalPrivateItemCommand.parse(raw), admission = technicalPrivateItemAdmission.parse(current);
  if (!admitsTechnicalPrivateItemCreation(command, admission, now)) return null;
  const common = { id: command.itemId, clientId: admission.parent.clientId, projectId: admission.parent.projectId,
    clientServiceId: admission.parent.serviceId, createdById: admission.actorId, technicalPrivate: true as const };
  return command.kind === 'Task'
    ? { ...common, ...command.values, companyId: admission.parent.companyId, status: 'aperta' as const,
      assignedToId: null, completedAt: null, type: null }
    : { ...common, ...command.values, status: 'da_richiedere' as const, documentId: null,
      active: true, updatedById: admission.actorId };
}

export const technicalPrivateItemOrigin = z.object({
  protocol: z.literal('TECHNICAL_PRIVATE_ITEM_ORIGIN_V1'), commandId: z.string().uuid(),
  kind: z.enum(['Task', 'ChecklistItem']), itemId: z.string().uuid(), target: technicalTargetReference,
  ...parentLinks, actorId: id, createdAt: z.string().datetime(),
}).strict();
export type TechnicalPrivateItemOrigin = z.infer<typeof technicalPrivateItemOrigin>;

/** A permanent exclusion/target constraint, never a recipient permission.
 * Only an explicit null from a successful DB lookup means a historical item.
 * An unavailable query must throw; it must never become null. */
export function admitsTechnicalPrivateItemOrigin(raw: unknown,
  reference: { kind: 'Task' | 'ChecklistItem'; itemId: string }, parent: TechnicalWorkItemParent) {
  if (!parent.operational || !technicalTargetReference.safeParse(parent.target).success
    || !z.object(parentLinks).safeParse({ clientId: parent.clientId, projectId: parent.projectId,
      serviceId: parent.serviceId, companyId: parent.companyId }).success
    || !hash.safeParse(parent.contextSha256).success
    || (parent.target.kind === 'Project' && parent.projectId !== parent.target.targetId)
    || !['Task', 'ChecklistItem'].includes(reference.kind) || !id.safeParse(reference.itemId).success) return false;
  if (raw === null) return true;
  const parsed = technicalPrivateItemOrigin.safeParse(raw);
  if (!parsed.success) return false;
  const origin = parsed.data;
  return origin.kind === reference.kind && origin.itemId === reference.itemId
    && canonicalJson(origin.target) === canonicalJson(parent.target)
    && origin.clientId === parent.clientId && origin.projectId === parent.projectId
    && origin.serviceId === parent.serviceId && origin.companyId === parent.companyId;
}
