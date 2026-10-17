import type { CommunicationReply, Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { inboundMessageSchema } from './ordinary-email-inbound-contract';
import { hasPermission, type PermissionSession } from './permission-evaluator';

// Unclassified incoming bytes can contain financial or sensitive material even
// when the sender gave them an innocuous filename. No name-based relaxation.
export function canReadOrdinaryAttachments(actor: PermissionSession) {
  return hasPermission(actor, 'document.download') && hasPermission(actor, 'document.sensitive.read')
    && hasPermission(actor, 'contract.read') && hasPermission(actor, 'payment.read');
}

function denied(): never { throw new Error('ORDINARY_EMAIL_ATTACHMENT_UNAVAILABLE'); }

/** Only call after native context/document admission. The linked projection,
 * private original and conflict lock must describe the same immutable item. */
export async function loadAdmittedOrdinaryMime(tx: Prisma.TransactionClient, reply: CommunicationReply) {
  if ((await filterAdmittedOrdinaryReplies(tx, [reply])).length !== 1) denied();
  const identity = reply.externalMessageId.match(/^ordinary-inbound:([a-f0-9-]{36})$/);
  if (!identity || reply.evidenceReference !== `ORDINARY_INBOUND_${identity[1].replaceAll('-', '')}`) denied();
  const [item] = await tx.$queryRaw<Array<{ payload: unknown; payloadHash: string }>>`SELECT i."payload",i."payloadHash"
    FROM "OrdinaryEmailInboundItem" i JOIN "OrdinaryEmailInboundLink" l ON l."itemId"=i."id"
    JOIN "OrdinaryEmailInboundStream" s ON s."id"=i."streamId"
    WHERE i."id"=${identity[1]}::uuid AND l."replyId"=${reply.id}::uuid
      AND s."mailboxId"=${reply.canonicalMailboxId}::uuid FOR SHARE OF i`;
  const payload = inboundMessageSchema.safeParse(item?.payload);
  if (!item || !payload.success || !payload.data.mime || canonicalSha256(payload.data) !== item.payloadHash) denied();
  const content = { externalMessageId: reply.externalMessageId, canonicalMailboxId: reply.canonicalMailboxId,
    inReplyTo: payload.data.inReplyTo, sender: payload.data.sender, subject: payload.data.subject,
    body: payload.data.body, receivedAt: payload.data.receivedAt };
  if (canonicalSha256(content) !== reply.contentHash || reply.inReplyTo !== content.inReplyTo
    || reply.sender !== content.sender || reply.subject !== content.subject || reply.body !== content.body
    || reply.receivedAt.toISOString() !== content.receivedAt) denied();
  return { payload: payload.data, payloadHash: item.payloadHash };
}

/** No private content, excluded count or attachment metadata before admission. */
export async function readAdmittedOrdinaryAttachmentMetadata(tx: Prisma.TransactionClient,
  replies: CommunicationReply[], actor: PermissionSession) {
  const result = new Map<string, Array<{ ordinal: number; filename: string; bytes: number; sha256: string; payloadHash: string }>>();
  if (!canReadOrdinaryAttachments(actor)) return result;
  for (const reply of replies) {
    if (!/^ordinary-inbound:[a-f0-9-]{36}$/.test(reply.externalMessageId)) continue;
    // The pre-MIME text-only candidate remains readable and has no attachments.
    const [row] = await tx.$queryRaw<Array<{ hasMime: boolean }>>`SELECT i."payload" ? 'mime' AS "hasMime"
      FROM "OrdinaryEmailInboundItem" i JOIN "OrdinaryEmailInboundLink" l ON l."itemId"=i."id"
      WHERE l."replyId"=${reply.id}::uuid`;
    if (!row?.hasMime) continue;
    const { payload, payloadHash } = await loadAdmittedOrdinaryMime(tx, reply);
    result.set(reply.id, payload.mime!.attachments.map(file => ({ ordinal: file.ordinal,
      filename: file.filename ?? `allegato-${file.ordinal + 1}`, bytes: file.bytes, sha256: file.sha256, payloadHash })));
  }
  return result;
}

/** Called only after native context/document admission. Conflicting intake is
 * quarantined even when the original had already been linked. The intake writer
 * takes the same item lock, so a fresh request cannot reuse a stale projection. */
export async function filterAdmittedOrdinaryReplies(tx: Prisma.TransactionClient, replies: CommunicationReply[]) {
  const candidates = replies.filter(row => {
    const identity = row.externalMessageId.match(/^ordinary-inbound:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
    return identity && row.evidenceReference === `ORDINARY_INBOUND_${identity[1].replaceAll('-','')}`;
  });
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
