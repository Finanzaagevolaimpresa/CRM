import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { CurrentTechnicalAssignmentAdmission, TechnicalAssignmentSelection } from './technical-assignment-contract';
import { technicalWorkItemContext, type TechnicalWorkItemParent, type TechnicalWorkItemRowContext,
  type TechnicalWorkItemContextLink } from './technical-work-item-context';
import { projectTechnicalWorkItem, technicalWorkItemPatch, type TechnicalWorkItemSelection } from './technical-work-item-contract';
import { createTechnicalWorkItemPreview, readTechnicalWorkItemPreview, technicalWorkItemCommand,
  technicalWorkItemRequestDigest, type TechnicalWorkItemAdmission } from './technical-work-item-command';

// The persistence service must load these facts under ordered
// locks and verify retained decisions/journals. Never construct them from a form.
export interface LockedTechnicalWorkItemSnapshot {
  current: CurrentTechnicalAssignmentAdmission;
  assignment: TechnicalAssignmentSelection;
  parent: TechnicalWorkItemParent;
  item: TechnicalWorkItemRowContext;
  link: TechnicalWorkItemContextLink;
  selection: TechnicalWorkItemSelection;
  admission: TechnicalWorkItemAdmission;
  row: { id: string; version: number; values: Readonly<Record<string, unknown>> };
}
function plan(snapshot: LockedTechnicalWorkItemSnapshot, raw: unknown, now: Date) {
  try {
    if (!Number.isFinite(now.getTime())) return null;
    const command = technicalWorkItemCommand.parse(raw);
    const { current, assignment, parent, item, link, selection, admission, row } = snapshot;
    const context = technicalWorkItemContext(parent, item, link);
    if (!context || row.id !== item.id || row.version !== admission.itemVersion
      || admission.itemId !== context.itemId || admission.kind !== context.kind
      || admission.bindingId !== link.bindingId || admission.bindingRevision !== link.revision
      || admission.contextSha256 !== context.contextSha256
      || canonicalJson(admission.target) !== canonicalJson(context.target)
      || admission.actorId !== current.userId || admission.actorEpoch !== current.currentRecipientEpoch
      || admission.assignmentRevision !== current.currentRevision
      || parent.contextSha256 !== current.currentContextSha256
      || admission.selectionSha256 !== canonicalSha256(selection)) return null;
    const binding = { kind: context.kind, itemId: context.itemId, target: context.target,
      contextSha256: context.contextSha256, active: item.active, archived: !parent.operational,
      financialRestricted: item.financialRestricted };
    const projection = projectTechnicalWorkItem(current, assignment, selection, binding, row.values, now);
    const patch = technicalWorkItemPatch(current, assignment, selection, binding, command.patch, now);
    if (!projection || !patch) return null;
    const before = Object.fromEntries(Object.keys(patch).map(field => [field, projection[field]]));
    if (Object.keys(patch).some(field => !Object.hasOwn(projection, field))
      || canonicalJson(before) === canonicalJson(patch)) return null;
    return { command: { ...command, patch }, before, after: patch };
  } catch { return null; }
}

/** The preview shows only the explicitly edited readable fields. It neither
 * writes nor exposes the whole item/parent row, even to an assigned technician. */
export function previewTechnicalWorkItemChange(key: PrivilegedStepUpKey, snapshot: LockedTechnicalWorkItemSnapshot,
  raw: unknown, now: Date) {
  try {
    const value = plan(snapshot, raw, now);
    if (!value) return null;
    return { ...value, token: createTechnicalWorkItemPreview(key, value.command, snapshot.admission, now.getTime()) };
  } catch { return null; }
}

/** Call with newly locked facts after confirmation, then recheck at the final DB
 * clock before committing change, receipt and audit atomically. This pure plan
 * is not an execution result and cannot represent a state or document change. */
export function confirmTechnicalWorkItemChange(key: PrivilegedStepUpKey, snapshot: LockedTechnicalWorkItemSnapshot,
  raw: unknown, token: string, confirmed: boolean, now: Date) {
  if (confirmed !== true) return null;
  const value = plan(snapshot, raw, now);
  if (!value || canonicalJson(value.command) !== canonicalJson(raw)) return null;
  const signed = readTechnicalWorkItemPreview(key, token, snapshot.admission, now.getTime());
  if (!signed || canonicalJson(signed) !== canonicalJson(value.command)) return null;
  return { ...value, requestDigest: technicalWorkItemRequestDigest(snapshot.admission.target, value.command),
    previousItemVersion: snapshot.admission.itemVersion, itemVersion: snapshot.admission.itemVersion + 1 };
}
