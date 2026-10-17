import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { loadOrdinaryReplyCandidateContext } from './approved-communications';
import { canReadOrdinaryAttachments, loadAdmittedOrdinaryMime } from './ordinary-email-inbound-reader';
import { decodeStoredOrdinaryAttachment } from './ordinary-email-inbound-mime';
import { sanitizeFileName, type readPrivateDocumentBounded } from './storage';

const requestSchema = z.object({ replyId: z.string().uuid(), ordinal: z.number().int().min(0).max(31),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), attachmentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export class OrdinaryAttachmentUnavailable extends Error {
  constructor() { super('ORDINARY_EMAIL_ATTACHMENT_UNAVAILABLE'); }
}

/** Native explicit download, not an intake route. All bytes remain behind the
 * session, context, document and conflict locks until minimized audit and the
 * final database-clock check commit. Failure never returns partial content. */
export async function readStoredOrdinaryAttachment(db: Pick<PrismaClient, '$transaction'>, claimed: AuthSession,
  input: unknown, runtime: { readDocument?: typeof readPrivateDocumentBounded } = {}) {
  try {
    const request = requestSchema.parse(input);
    return await db.$transaction(async tx => {
      const reply = await tx.communicationReply.findUnique({ where: { id: request.replyId } });
      if (!reply?.messageId) throw new OrdinaryAttachmentUnavailable();
      const parent = await loadOrdinaryReplyCandidateContext(tx, claimed, reply.messageId, runtime);
      if (!canReadOrdinaryAttachments(parent.current)) throw new OrdinaryAttachmentUnavailable();
      const { payload, payloadHash } = await loadAdmittedOrdinaryMime(tx, reply);
      if (payloadHash !== request.payloadHash) throw new OrdinaryAttachmentUnavailable();
      const decoded = await decodeStoredOrdinaryAttachment(payload, request.ordinal, request.attachmentHash);
      await tx.auditLog.create({ data: { actorId: parent.current.userId, entityType: 'CommunicationReply', entityId: reply.id,
        event: 'ordinary_email_attachment_download', after: { action: 'download',
          replyId: `inbound_reply_uuid_${reply.id.replaceAll('-', '')}`, evidenceHash: payloadHash,
          fileHash: decoded.manifest.sha256, sizeBytes: decoded.bytes.length } } });
      const [finished] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (finished.now.getTime() >= parent.accessUntil) throw new OrdinaryAttachmentUnavailable();
      return { bytes: decoded.bytes, filename: sanitizeFileName(decoded.manifest.filename ?? `allegato-${request.ordinal + 1}.bin`) };
    }, { timeout: 30_000 });
  } catch { throw new OrdinaryAttachmentUnavailable(); }
}
