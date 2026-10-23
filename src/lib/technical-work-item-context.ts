import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { technicalTargetReference } from './technical-assignment-display';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const parentSchema = z.object({ target: technicalTargetReference, clientId: id,
  projectId: id.nullable(), serviceId: id.nullable(), companyId: id.nullable(),
  contextSha256: z.string().regex(/^[a-f0-9]{64}$/), operational: z.boolean() }).strict();
const itemSchema = z.object({ id, kind: z.enum(['ChecklistItem', 'Task']), clientId: id,
  projectId: id.nullable(), serviceId: id.nullable(), companyId: id.nullable(),
  financialRestricted: z.boolean(), active: z.boolean() }).strict();
const linkSchema = z.object({ bindingId: z.string().uuid(), target: technicalTargetReference,
  itemId: id, kind: z.enum(['ChecklistItem', 'Task']), revision: z.number().int().positive().max(2_147_483_647),
  retainedPersonalDecision: z.boolean() }).strict();
export type TechnicalWorkItemParent = z.infer<typeof parentSchema>;
export type TechnicalWorkItemRowContext = z.infer<typeof itemSchema>;
export type TechnicalWorkItemContextLink = z.infer<typeof linkSchema>;

/** Preparation for a retained explicit link, not a parent-based grant.
 * The future transaction must load and verify the personal decision and lock all
 * parent/item rows before constructing these inputs. Never parse form JSON into
 * trusted retainedPersonalDecision/operational/financialRestricted facts. */
export function technicalWorkItemContext(parent: TechnicalWorkItemParent, item: TechnicalWorkItemRowContext,
  link: TechnicalWorkItemContextLink) {
  if (!parentSchema.safeParse(parent).success || !itemSchema.safeParse(item).success
    || !linkSchema.safeParse(link).success || !link.retainedPersonalDecision || !parent.operational
    || !item.active || item.financialRestricted || item.id !== link.itemId || item.kind !== link.kind
    || parent.target.kind !== link.target.kind || parent.target.targetId !== link.target.targetId
    || item.clientId !== parent.clientId) return null;
  if (parent.target.kind === 'Project' && parent.projectId !== parent.target.targetId) return null;
  // Existing secondary links constrain the association. A nullable source link
  // is never filled in or inferred here: the explicit retained target remains
  // mandatory, including two practices under the same client/project/service.
  if ((item.projectId !== null && item.projectId !== parent.projectId)
    || (item.serviceId !== null && item.serviceId !== parent.serviceId)
    || (item.companyId !== null && item.companyId !== parent.companyId)) return null;
  return { bindingId: link.bindingId, kind: item.kind, itemId: item.id, target: parent.target,
    contextSha256: canonicalSha256({ protocol: 'TECHNICAL_WORK_ITEM_CONTEXT_V1',
      bindingId: link.bindingId, bindingRevision: link.revision, kind: item.kind, itemId: item.id,
      target: parent.target, parentContextSha256: parent.contextSha256, clientId: item.clientId,
      projectId: item.projectId, serviceId: item.serviceId, companyId: item.companyId }) };
}
