import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';

import { communicationRecipientGroups } from './communication-recipient-groups';
export { communicationRecipientGroups } from './communication-recipient-groups';
const userId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const group = z.enum(['commerciali', 'tecnico', 'amministrazione', 'direzione', 'revisori']);
const bucket = z.object({ userIds: z.array(userId).max(20), groups: z.array(group).max(5) }).strict();
export const communicationRecipientSelectionSchema = z.object({ to: bucket, cc: bucket, bcc: bucket }).strict();
export type CommunicationRecipientSelection = z.infer<typeof communicationRecipientSelectionSchema>;
export const emptyCommunicationRecipientSelection = (): CommunicationRecipientSelection => ({
  to: { userIds: [], groups: [] }, cc: { userIds: [], groups: [] }, bcc: { userIds: [], groups: [] },
});
export type CommunicationDirectoryPerson = {
  id: string; name: string; email: string; role: string; active: boolean; deletedAt: Date | null;
};
const address = z.string().trim().max(254).email().transform(value => {
  const at = value.lastIndexOf('@');
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
});
const buckets = ['to', 'cc', 'bcc'] as const;
function invalid(): never { throw new Error('COMMUNICATION_RECIPIENT_SELECTION_INVALID'); }

/** Pure resolver over an authoritative, complete directory snapshot. The caller
 * must lock group membership and users in the same transaction as the draft,
 * preview/approval and DATA guard. This function grants no record access. */
export function resolveCommunicationRecipients(raw: unknown, directory: readonly CommunicationDirectoryPerson[],
  external: { to: string[]; cc: string[]; bcc: string[] }, internalParticipantIds?: readonly string[]) {
  const selection = communicationRecipientSelectionSchema.parse(raw);
  const available = directory.filter(person => person.active && !person.deletedAt);
  if (new Set(directory.map(person => person.id)).size !== directory.length) invalid();
  const result = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  const people = { to: [] as CommunicationDirectoryPerson[], cc: [] as CommunicationDirectoryPerson[], bcc: [] as CommunicationDirectoryPerson[] };
  const evidence: unknown[] = [];
  const memberIds = internalParticipantIds ? new Set(internalParticipantIds) : null;
  for (const key of buckets) {
    const selected = selection[key];
    if (new Set(selected.userIds).size !== selected.userIds.length || new Set(selected.groups).size !== selected.groups.length) invalid();
    const ids = new Set(selected.userIds);
    for (const name of selected.groups.slice().sort()) {
      const roles: readonly string[] = communicationRecipientGroups[name].roles;
      const members = available.filter(person => roles.includes(person.role)).sort((a, b) => a.id.localeCompare(b.id));
      if (!members.length) invalid();
      evidence.push({ bucket: key, group: name, members: members.map(person => ({ id: person.id, name: person.name, email: address.parse(person.email), role: person.role })) });
      members.forEach(person => ids.add(person.id));
    }
    for (const id of [...ids].sort()) {
      const person = available.find(item => item.id === id);
      if (!person || (memberIds && !memberIds.has(id))) invalid();
      const normalized = { ...person, email: address.parse(person.email) };
      people[key].push(normalized);
      evidence.push({ bucket: key, userId: id, name: person.name, email: normalized.email, role: person.role });
    }
    if (memberIds && external[key].length) invalid();
    result[key] = [...external[key].map(value => address.parse(value)), ...people[key].map(person => person.email)];
  }
  const all = buckets.flatMap(key => result[key]);
  if (!result.to.length || all.length > 20 || new Set(all.map(value => value.toLowerCase())).size !== all.length) invalid();
  return { selection, recipients: result, people, evidenceHash: canonicalSha256(evidence) };
}
