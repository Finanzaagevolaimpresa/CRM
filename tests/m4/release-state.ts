import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft, submitApprovedMessage,
  approveExactMessage, prepareManualMessage, recordManualMessageEvidence, acquireManualReply } from '../../src/lib/approved-communications';
import { randomUUID } from 'node:crypto';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertSyntheticCatalogDatabase(db);
  const user = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } }); assert.equal(user.role, 'admin');
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) } });
  const actor = { userId: user.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime() / 1000), role: 'admin' as const, active: true, permissionOverrides: [] };
  const client = await db.client.create({ data: { type: 'societa', displayName: 'M4 synthetic return history' } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, title: 'M4 synthetic history', practiceType: 'test', targetEntity: 'synthetic', createdById: user.id } });
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, actor, { mailboxId: before.id, expectedRevision: before.revision, kind: 'MAILBOX', canonicalMailboxId: null,
    providerReference: 'SYNTHETIC_RETURN', responsibleUserId: user.id, canSend: true, canReceive: true, restricted: false, configurationReference: 'SYNTHETIC_RETURN_CONFIG' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_RETURN_TEST' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  const saved = await saveApprovedMessageDraft(db, actor, { messageId: randomUUID(), expectedRevision: 0, context: { kind: 'TECHNICAL', id: practice.id },
    mailboxId: box.id, replyTo: box.address, to: ['synthetic@invalid.test'], cc: [], bcc: [], subject: 'Synthetic history only', body: 'No real email was sent.', attachmentVersionIds: [], classification: 'ORDINARY' });
  const binding = { messageId: saved.id, expectedRevision: 1, snapshotHash: saved.snapshotHash };
  await submitApprovedMessage(db, actor, binding); await approveExactMessage(db, actor, binding);
  const attempt = await prepareManualMessage(db, actor, { ...binding, requestId: randomUUID() });
  await recordManualMessageEvidence(db, actor, { messageId: saved.id, attemptId: attempt.attemptId, reconciliation: false,
    evidence: { method: 'MANUAL_DECLARATION', outcome: 'SENT', occurredAt: new Date().toISOString(), reference: 'SYNTHETIC_RETURN_MANUAL_DECLARATION' } });
  await acquireManualReply(db, actor, { mailboxId: box.id, externalMessageId: '<synthetic-return@invalid.test>', inReplyTo: `<fai-${saved.id}-v1@crm.finanzaagevolaimpresa.it>`,
    sender: 'synthetic@invalid.test', subject: 'Synthetic acquired reply', body: 'No real provider contact.', receivedAt: new Date().toISOString(), evidenceReference: 'SYNTHETIC_REPLY' });
  await db.internalSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE' } });
  console.log('M4_SYNTHETIC_RETURN_HISTORY_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
