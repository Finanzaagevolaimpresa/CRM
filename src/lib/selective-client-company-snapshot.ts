import { canonicalSha256 } from './canonical-json';
import { z } from 'zod';
import { maxClientCompanyChoices, parseClientCompanyChoices, projectSelectedClientCompanies } from './selective-client-company-policy';

export type ClientCompanySnapshot = { companyId: string; companyEpoch: number; stateHash: string };
export const clientCompanySnapshotSchema = z.object({
  companyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  companyEpoch: z.number().int().positive().safe(), stateHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const positiveGeneration = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);

/** companyEpoch must be
 * loaded from a persistent monotone generation under the same transaction
 * locks as context/selection. No fallback epoch is manufactured here. The
 * DB integration must bump it even for a change followed by restoration.
 * A content digest alone does not prove that such an ABA change never happened. */
export function snapshotSelectedClientCompanies(clientId: string,
  records: readonly Record<string, unknown>[], input: unknown): ClientCompanySnapshot[] {
  const choices = parseClientCompanyChoices(input);
  // The existing closed projection validates identity, current client, deleted
  // state and selected scalar values. It never includes unchosen company names.
  projectSelectedClientCompanies(clientId, records, choices);
  return choices.map(choice => {
    const row = records.find(record => record.id === choice.companyId)!;
    if (!positiveGeneration(row.companyEpoch)) throw new Error('COMPANY_GENERATION_DENIED');
    return {
      companyId: choice.companyId, companyEpoch: row.companyEpoch,
      stateHash: canonicalSha256({ clientId, companyId: choice.companyId,
        companyEpoch: row.companyEpoch, fields: choice.fields.map(key => ({ key, value: row[key] })) }),
    };
  });
}

/** Call only after separately verifying signature, recipient, authority,
 * session, current selection/revision and expiry under their transaction locks.
 * This function grants no access by itself and accepts no historical V1/V2
 * payload by silently defaulting missing snapshots to an empty selection. */
export function currentClientCompanySnapshotsMatch(clientId: string,
  records: readonly Record<string, unknown>[], input: unknown, approved: unknown): boolean {
  try {
    const current = snapshotSelectedClientCompanies(clientId, records, input);
    if (!Array.isArray(approved) || approved.length > maxClientCompanyChoices
      || approved.length !== current.length) return false;
    const seen = new Set<string>();
    return approved.every(snapshot => {
      if (!object(snapshot) || Object.keys(snapshot).length !== 3
        || !Object.hasOwn(snapshot, 'companyId') || !Object.hasOwn(snapshot, 'companyEpoch')
        || !Object.hasOwn(snapshot, 'stateHash') || typeof snapshot.companyId !== 'string'
        || seen.has(snapshot.companyId) || !positiveGeneration(snapshot.companyEpoch)
        || typeof snapshot.stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.stateHash)) return false;
      seen.add(snapshot.companyId);
      const value = current.find(row => row.companyId === snapshot.companyId);
      return value !== undefined && value.companyEpoch === snapshot.companyEpoch && value.stateHash === snapshot.stateHash;
    });
  } catch { return false; }
}
