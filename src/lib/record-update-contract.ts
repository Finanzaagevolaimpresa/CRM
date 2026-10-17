import { createHash } from 'node:crypto';
import { communicationRecipientGroups } from './communication-recipient-groups';

import { recordUpdateKinds, recordUpdateEvents, recordUpdateModes, recordUpdateRecipientLimit, type RecordUpdateKind, type RecordUpdateEvent, type RecordUpdateMode } from './record-update-labels';
export * from './record-update-labels';
export type UpdateDirectoryPerson = {
  id: string; name: string; email: string; role: string; active: boolean; deleted: boolean;
  // A server-observed revision, never supplied by the recipient-selection form.
  revision: string;
};
export type UpdateSelection = { people: string[]; groups: string[] };
export type ResolvedUpdateSelection = {
  selection: UpdateSelection;
  people: UpdateDirectoryPerson[];
  directoryBinding: string;
};
export class RecordUpdateError extends Error {
  constructor(public readonly code: 'INVALID' | 'DIRECTORY_CHANGED' | 'EMPTY_GROUP' | 'TOO_MANY' | 'STALE' | 'DENIED') {
    super(code);
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordUpdateError('INVALID');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RecordUpdateError('INVALID');
}
function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new RecordUpdateError('INVALID');
  return [...new Set(value as string[])].sort();
}
export function parseUpdateSelection(value: unknown): UpdateSelection {
  const input = object(value); exactKeys(input, ['people', 'groups']);
  const people = ids(input.people, recordUpdateRecipientLimit);
  const groups = ids(input.groups, Object.keys(communicationRecipientGroups).length);
  if ((!people.length && !groups.length) || groups.some(group => !Object.hasOwn(communicationRecipientGroups, group))) throw new RecordUpdateError('INVALID');
  return { people, groups };
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function resolveUpdateSelection(input: unknown, directory: readonly UpdateDirectoryPerson[]): ResolvedUpdateSelection {
  const selection = parseUpdateSelection(input);
  const byId = new Map(directory.map(person => [person.id, person]));
  if (byId.size !== directory.length) throw new RecordUpdateError('INVALID');
  const selected = new Set(selection.people);
  const groups = selection.groups.map(id => {
    const group = communicationRecipientGroups[id as keyof typeof communicationRecipientGroups];
    const members = directory.filter(person => person.active && !person.deleted && (group.roles as readonly string[]).includes(person.role)).map(person => person.id).sort();
    if (!members.length) throw new RecordUpdateError('EMPTY_GROUP');
    for (const member of members) selected.add(member);
    // Include every current directory generation for group selection. A user
    // joining and later leaving a group must not restore an older decision.
    return { id, members, membershipEpoch: hash(directory.map(person => ({ id: person.id,
      revision: person.revision, role: person.role, active: person.active, deleted: person.deleted })).sort((a, b) => a.id.localeCompare(b.id))) };
  });
  if (selected.size > recordUpdateRecipientLimit) throw new RecordUpdateError('TOO_MANY');
  const people = [...selected].sort().map(id => {
    const person = byId.get(id);
    if (!person?.active || person.deleted || !person.email.trim() || !person.revision) throw new RecordUpdateError('DIRECTORY_CHANGED');
    return person;
  });
  return { selection, people, directoryBinding: hash({ selection, groups, people: people.map(person => ({
    id: person.id, name: person.name, email: person.email, role: person.role, revision: person.revision,
  })) }) };
}

// This projection contains no free text, identifiers, recipient list, attachments,
// financial fields or private notes. The context label is resolved after access.
export type RecordUpdateSummary = { event: RecordUpdateEvent; changed: string[] };
const permittedChanges: Record<RecordUpdateEvent, readonly string[]> = {
  STATE_CHANGED: ['status', 'progress'], RECORD_CHANGED: ['displayName', 'type', 'profile'],
  COMMUNICATION: ['communication'], NEXT_ACTION: ['nextAction', 'nextActionDate'], DEADLINE: ['dueDate'],
};
export function recordUpdateSummary(event: RecordUpdateEvent, changed: readonly string[]): RecordUpdateSummary {
  if (!recordUpdateEvents.includes(event) || !changed.length || changed.some(key => !permittedChanges[event].includes(key))) throw new RecordUpdateError('INVALID');
  return { event, changed: [...new Set(changed)].sort() };
}
export function parseRecordUpdateSummary(value: unknown): RecordUpdateSummary {
  const input = object(value); exactKeys(input, ['event', 'changed']);
  if (typeof input.event !== 'string' || !Array.isArray(input.changed) || input.changed.some(key => typeof key !== 'string')) throw new RecordUpdateError('INVALID');
  return recordUpdateSummary(input.event as RecordUpdateEvent, input.changed as string[]);
}
export function updateChannels(mode: RecordUpdateMode) {
  if (!recordUpdateModes.includes(mode)) throw new RecordUpdateError('INVALID');
  return { crm: mode !== 'EMAIL_DRAFT', emailDraft: mode !== 'CRM', sendApproved: false as const };
}
export type UpdateAdmission = {
  available: boolean; reason: 'AVAILABLE' | 'NO_CURRENT_ACCESS' | 'ACCOUNT_UNAVAILABLE';
  canGrantAccess: false;
};
export function updateAdmission(person: UpdateDirectoryPerson, hasCurrentAccess: boolean): UpdateAdmission {
  return { available: person.active && !person.deleted && hasCurrentAccess,
    reason: !person.active || person.deleted ? 'ACCOUNT_UNAVAILABLE' : hasCurrentAccess ? 'AVAILABLE' : 'NO_CURRENT_ACCESS', canGrantAccess: false };
}
export type UpdatePreviewBinding = {
  actorId: string; sessionId: string; kind: RecordUpdateKind; recordId: string;
  recordVersion: string; scopeEpoch: string; directoryBinding: string;
  recipientAccessBinding: string; patchDigest: string;
  selection: UpdateSelection; events: RecordUpdateEvent[]; mode: RecordUpdateMode;
  persistent: boolean; ruleVersion: number; commandId: string;
};
export function updatePreviewDigest(input: UpdatePreviewBinding): string {
  if (!recordUpdateKinds.includes(input.kind) || !recordUpdateModes.includes(input.mode)
    || !input.events.length || input.events.some(event => !recordUpdateEvents.includes(event))
    || !Number.isSafeInteger(input.ruleVersion) || input.ruleVersion < 0
    || ![input.actorId, input.sessionId, input.recordId, input.recordVersion, input.scopeEpoch, input.directoryBinding, input.recipientAccessBinding, input.patchDigest, input.commandId].every(value => typeof value === 'string' && value.length > 0)
    || typeof input.persistent !== 'boolean') throw new RecordUpdateError('INVALID');
  // Explicit fields avoid hashing caller extras or deriving authority from JSON.
  return hash({ protocol: 'FAI_RECORD_UPDATE_PREVIEW_V1', actorId: input.actorId, sessionId: input.sessionId,
    kind: input.kind, recordId: input.recordId, recordVersion: input.recordVersion, scopeEpoch: input.scopeEpoch,
    directoryBinding: input.directoryBinding, recipientAccessBinding: input.recipientAccessBinding, patchDigest: input.patchDigest,
    selection: parseUpdateSelection(input.selection), events: [...new Set(input.events)].sort(), mode: input.mode,
    persistent: input.persistent, ruleVersion: input.ruleVersion, commandId: input.commandId });
}
export function assertUpdatePreview(expected: string, fresh: UpdatePreviewBinding) {
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== updatePreviewDigest(fresh)) throw new RecordUpdateError('STALE');
}
