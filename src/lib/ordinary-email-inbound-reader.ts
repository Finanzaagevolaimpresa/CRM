import type { CommunicationReply, Prisma } from '@prisma/client';

/** Called only after native context/document admission. Conflicting intake is
 * quarantined even when the original had already been linked. The intake writer
 * takes the same item lock, so a fresh request cannot reuse a stale projection. */
export async function filterAdmittedOrdinaryReplies(tx: Prisma.TransactionClient, replies: CommunicationReply[]) {
  const candidates = replies.filter(row => row.evidenceReference.startsWith('ORDINARY_INBOUND_'));
  if (!candidates.length) return replies;
  const [tables] = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM
    (VALUES (to_regclass('public."OrdinaryEmailInboundItem"')),(to_regclass('public."OrdinaryEmailInboundConflict"')),
      (to_regclass('public."OrdinaryEmailInboundStream"')),(to_regclass('public."OrdinaryEmailInboundBatch"')),
      (to_regclass('public."OrdinaryEmailInboundLink"'))) AS candidate(relation) WHERE relation IS NOT NULL`;
  if (tables.count !== 5) throw new Error('ORDINARY_EMAIL_INBOUND_UNAVAILABLE');
  const hidden = new Set<string>();
  for (const reply of candidates.sort((a,b) => a.id.localeCompare(b.id))) {
    const [link] = await tx.$queryRaw<Array<{ id: string }>>`SELECT i."id" FROM "OrdinaryEmailInboundItem" i
      JOIN "OrdinaryEmailInboundLink" l ON l."itemId"=i."id" WHERE l."replyId"=${reply.id}::uuid FOR SHARE OF i`;
    if (!link) throw new Error('ORDINARY_EMAIL_INBOUND_UNAVAILABLE');
    const [conflict] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM "OrdinaryEmailInboundConflict" WHERE "itemId"=${link.id}::uuid) AS present`;
    if (conflict.present) hidden.add(reply.id);
  }
  return replies.filter(row => !hidden.has(row.id));
}
