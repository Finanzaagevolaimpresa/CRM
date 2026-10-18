import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticSession } from '../selective-sharing/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { confirmRecordUpdate, previewRecordUpdate, readRecordUpdateSetup } from '../../src/lib/record-updates';
import { listRecordUpdates, readRecordUpdate } from '../../src/lib/record-update-delivery';
import type { UpdateCommand } from '../../src/lib/record-update-input';
import { readRecordUpdateEmailPrefill } from '../../src/lib/record-update-email-queue';
import { saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const reader = await db.user.create({ data: { id: 'record-update-recovery-reader', role: 'admin',
    name: 'Synthetic selected reader', email: 'record-update-recovery-reader@invalid.test', passwordHash: owner.passwordHash } });
  const actor = await syntheticSession(db, owner), recipient = await syntheticSession(db, reader);
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  const proof = { key, sessionToken: actor.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: owner.id, sessionToken: actor.token }) };
  async function command(id: string, operation: UpdateCommand['operation'], mode: UpdateCommand['mode'] = 'CRM') {
    const setup = await readRecordUpdateSetup(db, actor.session, 'LEAD', id);
    assert.equal(setup.patch.kind, 'LEAD');
    const input: UpdateCommand = { commandId: randomUUID(), kind: 'LEAD', recordId: id, operation, mode,
      expectedVersion: setup.expectedVersion, ruleVersion: setup.rule?.version ?? 0,
      selection: { people: [reader.id], groups: [] }, events: ['NEXT_ACTION'], persistent: false, expiresAt: null,
      patch: operation === 'UPDATE' ? { ...setup.patch, nextActionNote: 'SYNTHETIC_PRIVATE_UPDATE_BODY' } : null };
    const preview = await previewRecordUpdate(db, actor.session, input);
    await confirmRecordUpdate(db, actor.session, input, preview.digest, proof);
  }
  const results: Record<string, { id: string; leadId: string }> = {};
  for (const mode of ['READ', 'REVOKED', 'AVAILABLE']) {
    const lead = await db.lead.create({ data: { firstName: 'SYNTHETIC_UPDATE_RECOVERY', lastName: mode,
      assignedToId: reader.id, notes: 'SYNTHETIC_PRIVATE_NOTES' } });
    await command(lead.id, mode === 'READ' ? 'UPDATE' : 'RULE');
    if (mode !== 'READ') await db.lead.update({ where: { id: lead.id }, data: { nextActionNote: 'SYNTHETIC_PRIVATE_UPDATE_BODY' } });
    const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { recipientId: reader.id, event: { recordId: lead.id } } });
    if (mode === 'READ') assert.ok((await readRecordUpdate(db, recipient.session, work.id, true))?.readAt);
    if (mode === 'REVOKED') {
      await command(lead.id, 'REVOKE');
      assert.equal(await readRecordUpdate(db, recipient.session, work.id), null);
    }
    results[mode] = { id: work.id, leadId: lead.id };
  }
  const visible = await listRecordUpdates(db, recipient.session, 100, false);
  assert.equal(visible.length, 2);
  assert.equal(visible.filter(row => row.readAt).length, 1);
  // Synthetic personal draft preparation; the transport channel remains disabled.
  await db.ordinaryEmailAuthority.update({ where: { id: 'ordinary-email' }, data: { enabled: true, revision: { increment: 1 } } });
  const binding = await db.ordinaryEmailAuthority.findUniqueOrThrow({ where: { id: 'ordinary-email' } });
  const box = await db.communicationMailbox.findUniqueOrThrow({ where: { id: binding.mailboxId } });
  const emails: Record<string, { id: string; leadId: string }> = {};
  for (const state of ['AVAILABLE', 'REVOKED', 'UNSAVED']) {
    const lead = await db.lead.create({ data: { firstName: 'SYNTHETIC_EMAIL_UPDATE', lastName: state, assignedToId: reader.id } });
    await command(lead.id, 'RULE', 'EMAIL_DRAFT');
    await db.lead.update({ where: { id: lead.id }, data: { nextActionNote: 'SYNTHETIC PRIVATE NEXT ACTION' } });
    const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { event: { recordId: lead.id } } });
    const source = await readRecordUpdateEmailPrefill(db, actor.session, work.id);
    if (state !== 'UNSAVED') {
      const recipientSelection = emptyCommunicationRecipientSelection(); recipientSelection.to.userIds = [reader.id];
      await saveApprovedMessageDraft(db, actor.session, { messageId: work.id, expectedRevision: 0, context: source.context,
        mailboxId: box.id, replyTo: box.address, to: [], cc: [], bcc: [], recipientSelection,
        subject: source.subject, body: 'SYNTHETIC EMAIL UPDATE HISTORY', attachmentVersionIds: [], contextFileIds: [], classification: 'ORDINARY',
        updateSource: { deliveryId: work.id, sourceHash: source.sourceHash } });
    }
    if (state === 'REVOKED') await command(lead.id, 'REVOKE');
    emails[state] = { id: work.id, leadId: lead.id };
  }
  assert.equal((await db.ordinaryEmailChannel.findFirstOrThrow()).enabled, false);
  writeFileSync(process.env.R05_UPDATES_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true, noProvider: true,
    readerEmail: reader.email, otherEmail: 'context-recovery-other@invalid.test', ownerEmail: owner.email, records: results, emails }, null, 2) + '\n');
  console.log('RECORD_UPDATES_SYNTHETIC_RESTART_HISTORY_READY');
}
void main().finally(() => db.$disconnect());
