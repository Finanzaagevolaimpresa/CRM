import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { maxClientPersonChoices, parseClientPersonChoices, projectSelectedClientPeople } from './selective-client-person-policy';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const generation = z.number().int().positive().max(2147483647);
export const clientPersonSnapshotSchema = z.object({
  membershipId: identifier, companyId: identifier, personId: identifier,
  companyEpoch: generation, membershipEpoch: generation, personEpoch: generation,
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ClientPersonSnapshot = z.infer<typeof clientPersonSnapshotSchema>;

/** All three generations must come from persistent ledgers under current row
 * locks. A restored value or reused row ID never restores a prior approval. */
export function snapshotSelectedClientPeople(clientId: string, records: readonly Record<string, unknown>[], input: unknown): ClientPersonSnapshot[] {
  const choices = parseClientPersonChoices(input);
  projectSelectedClientPeople(clientId, records, choices);
  return choices.map(choice => {
    const row = records.find(record => record.membershipId === choice.membershipId)!;
    const identity = { clientId, membershipId: choice.membershipId, companyId: choice.companyId, personId: choice.personId,
      companyEpoch: generation.parse(row.companyEpoch), membershipEpoch: generation.parse(row.membershipEpoch), personEpoch: generation.parse(row.personEpoch) };
    return clientPersonSnapshotSchema.parse({ membershipId: identity.membershipId, companyId: identity.companyId,
      personId: identity.personId, companyEpoch: identity.companyEpoch,
      membershipEpoch: identity.membershipEpoch, personEpoch: identity.personEpoch,
      stateHash: canonicalSha256({ ...identity, fields: choice.fields.map(key => ({ key, value: row[key] })) }) });
  });
}

export function currentClientPersonSnapshotsMatch(clientId: string, records: readonly Record<string, unknown>[], input: unknown, approved: unknown): boolean {
  try {
    const current = snapshotSelectedClientPeople(clientId, records, input);
    const snapshots = z.array(clientPersonSnapshotSchema).max(maxClientPersonChoices).parse(approved);
    if (snapshots.length !== current.length || new Set(snapshots.map(row => row.membershipId)).size !== snapshots.length) return false;
    return snapshots.every(snapshot => {
      const value = current.find(row => row.membershipId === snapshot.membershipId);
      return value !== undefined && canonicalSha256(value) === canonicalSha256(snapshot);
    });
  } catch { return false; }
}
