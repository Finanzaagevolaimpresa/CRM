import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const epoch = z.number().int().positive().max(2_147_483_647);
const common = { id, recordUpdateEpoch: epoch, deletedAt: z.date().nullable(), status: z.string().min(1).max(80) };
const lead = z.object({ ...common, assignedToId: id.nullable(), clientId: id.nullable() }).strict();
const client = z.object({ ...common, salesOwnerId: id.nullable() }).strict();
const snapshot = z.object({
  kind: z.enum(['Lead', 'Client']), targetId: id, lead: lead.nullable(), client: client.nullable(),
}).strict();
export type CommercialAdminRequestSnapshot = z.infer<typeof snapshot>;

/** Internal identity/lifecycle fingerprint, never a grant or requester DTO.
 * Read these facts from locked canonical rows. Names, contact information,
 * ordinary edit timestamps, notes and financial fields do not belong here.
 * DB epochs retain ownership/lifecycle A→B→A changes even if IDs match again.
 */
export function commercialAdminRequestContext(raw: unknown) {
  const parsed = snapshot.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data, l = s.lead, c = s.client;
  const workable = (row: NonNullable<typeof l> | NonNullable<typeof c>) =>
    row.deletedAt === null && !['archiviato', 'archiviata', 'sospeso'].includes(row.status);
  if (s.kind === 'Lead') {
    if (!l || l.id !== s.targetId || !workable(l)
      || (l.clientId === null ? c !== null : !c || c.id !== l.clientId || !workable(c))) return null;
    // A converted lead cannot be used to make a request about another owner's
    // client. The client route still uses its own canonical commercial owner.
    if (!l.assignedToId || (c && c.salesOwnerId !== l.assignedToId)) return null;
  } else if (l || !c || c.id !== s.targetId || !workable(c) || !c.salesOwnerId) return null;
  const root = s.kind === 'Lead' ? l! : c!;
  return {
    subject: { kind: s.kind, targetId: s.targetId },
    commercialOwnerId: s.kind === 'Lead' ? l!.assignedToId! : c!.salesOwnerId!,
    clientId: c?.id ?? null, accessRevision: root.recordUpdateEpoch,
    contextSha256: canonicalSha256({ protocol: 'ADMIN_REQUEST_COMMERCIAL_CONTEXT_V1',
      kind: s.kind, targetId: s.targetId,
      lead: l ? [l.id, l.recordUpdateEpoch, l.assignedToId, l.clientId] : null,
      client: c ? [c.id, c.recordUpdateEpoch, c.salesOwnerId] : null }),
  };
}
