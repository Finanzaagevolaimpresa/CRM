import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { loadOrdinaryReplyCandidateContext } from './approved-communications';
import { approvedMessageHash, approvedMessageSnapshotSchema } from './approved-communication-contract';
import type { readPrivateDocumentBounded } from './storage';
import { assertInboundSource, consumeInboundReceipt, inboundDenied as deny, inboundDescriptorSchema, inboundMessageSchema,
  type InboundBinding, type InboundPosition, type InboundSource } from './ordinary-email-inbound-contract';

type Tx = Prisma.TransactionClient;
type Db = Pick<PrismaClient, '$transaction'>;
type Stream = InboundBinding & { descriptorHash: string; enabled: boolean; cursor: string | null; cursorVersion: number };
const uuid = z.string().uuid();
const ref = (kind: string, id: string) => `inbound_${kind}_uuid_${uuid.parse(id).replaceAll('-','').toLowerCase()}`;
async function clock(tx: Tx) { return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now; }

/** Admission is independent of a human session. It grants intake only; neither
 * mailbox responsibility nor this stream grants access to any CRM context. */
async function stream(tx: Tx, id: string, key: PrivilegedStepUpKey, source: InboundSource) {
  source.assertKey(key);
  if (!await lockRegisteredPrivilegedStepUpKey(tx,key)) deny();
  const [hint] = await tx.$queryRaw<Array<{ mailboxId: string }>>`SELECT "mailboxId" FROM "OrdinaryEmailInboundStream" WHERE "id"=${uuid.parse(id)}::uuid`;
  if (!hint) deny();
  const before = await tx.communicationMailbox.findUnique({ where: { id: hint.mailboxId } });
  if (!before?.responsibleUserId) deny();
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${before.responsibleUserId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "CommunicationMailbox" WHERE "id"=${hint.mailboxId}::uuid FOR SHARE`;
  const box = await tx.communicationMailbox.findUnique({ where: { id: hint.mailboxId } });
  const owner = await tx.user.findUnique({ where: { id: before.responsibleUserId } });
  const [row] = await tx.$queryRaw<Stream[]>`SELECT * FROM "OrdinaryEmailInboundStream" WHERE "id"=${id}::uuid FOR UPDATE`;
  if (!row || !row.enabled || !box || !owner?.active || owner.deletedAt || box.responsibleUserId !== owner.id
    || box.kind !== 'MAILBOX' || box.canonicalMailboxId || box.address !== 'comunicazioni@finanzaagevolaimpresa.it'
    || box.providerReference !== 'register_it' || box.configurationReference !== 'M4_COMUNICAZIONI_REGISTER_IT'
    || !box.canReceive || !box.enabled || box.testedRevision !== box.revision || box.configuredRevision !== box.revision
    || row.mailboxRevision !== box.revision || row.descriptorHash !== canonicalSha256(row.descriptor)) deny();
  const binding: InboundBinding = { id: row.id, mailboxId: row.mailboxId, mailboxRevision: row.mailboxRevision,
    revision: row.revision, descriptor: inboundDescriptorSchema.parse(row.descriptor),
    qualificationReference: row.qualificationReference, validUntil: row.validUntil };
  source.assertBinding(binding);
  if (binding.validUntil <= await clock(tx)) deny();
  return { binding, position: { version: row.cursorVersion, cursor: row.cursor } satisfies InboundPosition };
}

/** A single bounded read, then one CAS transaction. No automatic retry,
 * acknowledgement, deletion, scheduling or real connector. Lost commit requires
 * rereading the current cursor; the source must retain the original messages. */
export async function receiveStoredOrdinaryEmail(db: Db, streamId: string, key: PrivilegedStepUpKey, source: InboundSource) {
  assertInboundSource(source);
  const prepared = await db.$transaction(tx => stream(tx,streamId,key,source), { timeout: 30_000 });
  const receipt = await source.read(prepared.binding,prepared.position);
  return db.$transaction(async tx => {
    const current = await stream(tx,streamId,key,source);
    if (canonicalSha256(current.position) !== canonicalSha256(prepared.position)) deny();
    const now = await clock(tx), { batch, deadline } = consumeInboundReceipt(receipt,current.binding,current.position,now);
    if (batch.items.some(item => Date.parse(item.message.receivedAt) > now.getTime()+60_000)) deny();
    const batchId = randomUUID(), batchHash = canonicalSha256(batch), counts = { insertedCount: 0, duplicateCount: 0, conflictCount: 0 };
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundBatch" ("id","streamId","streamRevision","fromVersion","fromCursorHash","nextCursorHash","batchHash")
      VALUES (${batchId}::uuid,${streamId}::uuid,${current.binding.revision},${current.position.version},
        ${canonicalSha256(batch.fromCursor)},${canonicalSha256(batch.nextCursor)},${batchHash})`;
    for (const item of batch.items) {
      const payloadHash = canonicalSha256(item.message);
      const [prior] = await tx.$queryRaw<Array<{ id: string; payloadHash: string }>>`SELECT "id","payloadHash" FROM "OrdinaryEmailInboundItem"
        WHERE "streamId"=${streamId}::uuid AND "providerId"=${item.providerId} FOR UPDATE`;
      if (!prior) {
        await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundItem" ("id","streamId","batchId","providerId","payload","payloadHash")
          VALUES (${randomUUID()}::uuid,${streamId}::uuid,${batchId}::uuid,${item.providerId},${JSON.stringify(item.message)}::jsonb,${payloadHash})`;
        counts.insertedCount++;
      } else if (prior.payloadHash === payloadHash) counts.duplicateCount++;
      else {
        await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundConflict" ("id","itemId","batchId","observedHash")
          VALUES (${randomUUID()}::uuid,${prior.id}::uuid,${batchId}::uuid,${payloadHash}) ON CONFLICT ("itemId","observedHash") DO NOTHING`;
        counts.conflictCount++;
      }
    }
    const changed = await tx.$executeRaw`UPDATE "OrdinaryEmailInboundStream" SET "cursor"=${batch.nextCursor},"cursorVersion"="cursorVersion"+1
      WHERE "id"=${streamId}::uuid AND "revision"=${current.binding.revision} AND "cursorVersion"=${current.position.version}
        AND "cursor" IS NOT DISTINCT FROM ${current.position.cursor}`;
    if (changed !== 1) deny();
    await tx.auditLog.create({ data: { actorId: null, entityType: 'OrdinaryEmailInboundStream', entityId: streamId,
      event: 'ordinary_email_inbound_batch', after: { action: 'receive', batchId: ref('batch',batchId),
        streamId: ref('stream',streamId), streamVersion: current.binding.revision, fromVersion: current.position.version,
        nextVersion: current.position.version+1, evidenceHash: batchHash, ...counts } } });
    source.assertBinding(current.binding);
    const finalClock = await clock(tx);
    if (finalClock.getTime() >= deadline || finalClock >= current.binding.validUntil) deny();
    return { batchId, cursorVersion: current.position.version+1, ...counts };
  }, { timeout: 30_000 });
}

type Item = { id: string; streamId: string; payload: unknown; payloadHash: string; mailboxId: string };
/** Derived reference only: the caller cannot choose a project or message ID.
 * Intake stays private until a current, legitimate reader admits its context.
 * This does not approve sending and requires no per-message step-up. */
export async function associateStoredOrdinaryReply(db: Db, claimed: AuthSession, itemId: string,
  runtime: { readDocument?: typeof readPrivateDocumentBounded } = {}) {
  uuid.parse(itemId);
  return db.$transaction(async tx => {
    const [item] = await tx.$queryRaw<Item[]>`SELECT i.*,s."mailboxId" FROM "OrdinaryEmailInboundItem" i
      JOIN "OrdinaryEmailInboundStream" s ON s."id"=i."streamId" WHERE i."id"=${itemId}::uuid`;
    if (!item) deny();
    const payload = inboundMessageSchema.parse(item.payload);
    if (canonicalSha256(payload) !== item.payloadHash) deny();
    const reference = payload.inReplyTo?.match(/^<fai-smtp-([a-f0-9-]{36})-v([1-9][0-9]*)@crm\.finanzaagevolaimpresa\.it>$/);
    if (!reference || !uuid.safeParse(reference[1]).success || !Number.isSafeInteger(Number(reference[2])) || Number(reference[2])>2_147_483_647) deny();
    const state = await loadOrdinaryReplyCandidateContext(tx,claimed,reference[1],runtime);
    if (state.box.id !== item.mailboxId) deny();
    const sent = await tx.communicationVersion.findUnique({ where: { messageId_revision: { messageId: reference[1], revision: Number(reference[2]) } } });
    const snapshot = approvedMessageSnapshotSchema.safeParse(sent?.snapshot);
    if (!sent || !snapshot.success || sent.snapshotHash !== approvedMessageHash(snapshot.data)
      || snapshot.data.messageId !== state.row.id || snapshot.data.mailboxId !== item.mailboxId
      || ![...snapshot.data.to,...snapshot.data.cc,...snapshot.data.bcc].some(address => address.toLowerCase()===payload.sender.toLowerCase())) deny();
    const accepted = await tx.$queryRaw<Array<{ id: string }>>`SELECT a."id" FROM "OrdinaryEmailAttempt" a
      JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId" JOIN "OrdinaryEmailOutcome" o ON o."attemptId"=a."id"
      WHERE a."messageId"=${state.row.id}::uuid AND d."versionId"=${sent.id}::uuid AND a."state"='ACCEPTED' AND o."outcome"='ACCEPTED'`;
    if (accepted.length !== 1) deny();
    await tx.$queryRaw`SELECT "id" FROM "OrdinaryEmailInboundItem" WHERE "id"=${itemId}::uuid FOR UPDATE`;
    const [conflicts] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM "OrdinaryEmailInboundConflict" WHERE "itemId"=${itemId}::uuid) AS present`;
    if (conflicts.present) deny();
    const [existing] = await tx.$queryRaw<Array<{ replyId: string }>>`SELECT "replyId" FROM "OrdinaryEmailInboundLink" WHERE "itemId"=${itemId}::uuid`;
    let replyId = existing?.replyId;
    if (!replyId) {
      const externalMessageId = `ordinary-inbound:${itemId}`;
      const content = { ...payload, externalMessageId, canonicalMailboxId: item.mailboxId };
      const reply = await tx.communicationReply.create({ data: { ...content, receivedAt: new Date(payload.receivedAt),
        contentHash: canonicalSha256(content), evidenceReference: `ORDINARY_INBOUND_${itemId.replaceAll('-','')}`,
        acquiredById: state.current.userId, linkedById: state.current.userId, messageId: state.row.id } });
      replyId = reply.id;
      await tx.$executeRaw`INSERT INTO "OrdinaryEmailInboundLink" ("itemId","replyId","actorId") VALUES (${itemId}::uuid,${replyId}::uuid,${state.current.userId})`;
      const evidence = { itemId: ref('item',itemId), replyId: ref('reply',replyId), evidenceHash: item.payloadHash, method: 'AUTHENTICATED_INBOUND' };
      await tx.communicationEvent.create({ data: { messageId: state.row.id, replyId, actorId: state.current.userId,
        event: 'ORDINARY_REPLY_LINKED', evidence } });
      await tx.auditLog.create({ data: { actorId: state.current.userId, entityType: 'CommunicationReply', entityId: replyId,
        event: 'ordinary_email_inbound_linked', after: { action: 'link', ...evidence } } });
    }
    if ((await clock(tx)).getTime() >= state.accessUntil) deny();
    return { replyId };
  }, { timeout: 30_000 });
}
