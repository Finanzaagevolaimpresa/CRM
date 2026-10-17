import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { approvedMessageHash, approvedMessageSnapshotSchema, type ApprovedMessageSnapshot } from '../../src/lib/approved-communication-contract';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

// Historical source evidence is synthetic. These fixtures never contact SMTP,
// IMAP or a production database and do not purport to be a real send/receipt.
export async function storedNoticeMessage(db: PrismaClient, input: {
  leadId: string; authorId: string; classification?: 'ORDINARY' | 'COMPLAINT' | 'SENSITIVE';
  mailboxAddress?: string; attachments?: ApprovedMessageSnapshot['attachments'];
  omitVersion?: boolean; invalidHash?: boolean;
}) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const mailbox = await db.communicationMailbox.findUniqueOrThrow({ where: { address: input.mailboxAddress ?? 'comunicazioni@finanzaagevolaimpresa.it' } });
  const message = await db.approvedCommunication.create({ data: { contextKind: 'LEAD', leadId: input.leadId,
    currentRevision: 1, mailboxId: mailbox.id, createdById: input.authorId } });
  const snapshot = approvedMessageSnapshotSchema.parse({
    schema: 'fai.approved-email.v2', messageId: message.id, revision: 1, context: { kind: 'LEAD', id: input.leadId }, clientId: null,
    channel: 'EMAIL_MANUAL', mailboxId: mailbox.id, mailboxRevision: mailbox.revision,
    from: mailbox.address, replyTo: mailbox.address, to: ['recipient@invalid.test'], cc: [], bcc: [],
    subject: 'PRIVATE SYNTHETIC SUBJECT', body: 'PRIVATE SYNTHETIC BODY', attachments: input.attachments ?? [],
    classification: input.classification ?? 'ORDINARY', recipientSelection: emptyCommunicationRecipientSelection(),
    externalRecipients: { to: ['recipient@invalid.test'], cc: [], bcc: [] },
    recipientEvidenceHash: canonicalSha256({ synthetic: 'recipients' }), contextEvidenceHash: canonicalSha256({ synthetic: 'context' }),
  });
  if (!input.omitVersion) await db.communicationVersion.create({ data: { messageId: message.id, revision: 1,
    snapshot: snapshot as Prisma.InputJsonValue, snapshotHash: input.invalidHash ? 'f'.repeat(64) : approvedMessageHash(snapshot), createdById: input.authorId } });
  return { message, mailbox };
}

export async function linkedOrdinaryNoticeReply(db: PrismaClient, messageId: string, mailboxId: string, actorId: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const streamId = randomUUID(), batchId = randomUUID(), itemId = randomUUID();
  const descriptor = { synthetic: true, generation: streamId };
  const payload = { externalMessageId: '<synthetic@invalid.test>', sender: 'synthetic@invalid.test',
    subject: 'PRIVATE REPLY SUBJECT', body: 'PRIVATE REPLY BODY', inReplyTo: null, receivedAt: new Date().toISOString() };
  const reply = await db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundStream"
      ("id","mailboxId","mailboxRevision","descriptor","descriptorHash","qualificationReference","validUntil")
      VALUES (${streamId}::uuid,${mailboxId}::uuid,1,${JSON.stringify(descriptor)}::jsonb,
      ${canonicalSha256(descriptor)},'SYNTHETIC_ONLY',clock_timestamp()+interval '1 hour')`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundBatch"
      ("id","streamId","streamRevision","fromVersion","fromCursorHash","nextCursorHash","batchHash")
      VALUES (${batchId}::uuid,${streamId}::uuid,1,0,${canonicalSha256(null)},${canonicalSha256('1')},${canonicalSha256(payload)})`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundItem" ("id","streamId","batchId","providerId","payload","payloadHash")
      VALUES (${itemId}::uuid,${streamId}::uuid,${batchId}::uuid,'synthetic-1',${JSON.stringify(payload)}::jsonb,${canonicalSha256(payload)})`;
    const row = await tx.communicationReply.create({ data: { messageId, canonicalMailboxId: mailboxId,
      externalMessageId: 'ordinary-inbound:' + itemId, contentHash: canonicalSha256({ ...payload,
        externalMessageId: 'ordinary-inbound:' + itemId, canonicalMailboxId: mailboxId }),
      sender: payload.sender, subject: payload.subject, body: payload.body, inReplyTo: payload.inReplyTo,
      receivedAt: new Date(payload.receivedAt), evidenceReference: 'ORDINARY_INBOUND_' + itemId.replaceAll('-', ''),
      acquiredById: actorId, linkedById: actorId } });
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundLink" ("itemId","replyId","actorId")
      VALUES (${itemId}::uuid,${row.id}::uuid,${actorId})`;
    return row;
  });
  return { reply, conflict: () => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "OrdinaryEmailInboundItem" WHERE "id"=${itemId}::uuid FOR UPDATE`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundConflict" ("id","itemId","batchId","observedHash")
      VALUES (${randomUUID()}::uuid,${itemId}::uuid,${batchId}::uuid,${canonicalSha256('conflicting synthetic reply')})`;
  }) };
}
