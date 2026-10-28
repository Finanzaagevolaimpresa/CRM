import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { previewRecordReminder } from '../../src/lib/record-reminder-preview';
import { confirmRecordReminder } from '../../src/lib/record-reminder-confirmation';
import { cancelRecordReminder } from '../../src/lib/record-reminder-revocation';
import { readRecordReminderNotice } from '../../src/lib/record-reminder-delivery';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_REMINDER_RECOVERY_FIXTURE);
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  // Dedicated actors keep other recovery scenarios' deliberate revocations
  // separate. The registered application key is the same exact candidate key.
  const admin = await syntheticPerson(db, 'Synthetic reminder author', 'admin', owner.passwordHash);
  const reader = await syntheticPerson(db, 'Synthetic reminder commercial', 'commerciale', owner.passwordHash);
  const other = await syntheticPerson(db, 'Synthetic unrelated commercial', 'commerciale', owner.passwordHash);
  const client = await db.client.create({ data: { type: 'persona_fisica', displayName: 'SYNTHETIC_REMINDER_RESTART',
    salesOwnerId: reader.user.id, consultantId: reader.user.id } });
  const beforeMail = await db.approvedCommunication.count();
  const proof = leadProof(admin), records: Record<string, { commandId: string; deliveryId: string; taskId: string; remindAt: string }> = {};
  for (const state of ['SCHEDULED', 'AVAILABLE', 'READ', 'CANCELED', 'SUPPRESSED']) {
    const task = await db.task.create({ data: { clientId: client.id, title: 'SYNTHETIC_TASK_TITLE_PRIVATE',
      description: 'SYNTHETIC_TASK_NOTE_PRIVATE', createdById: admin.user.id, assignedToId: reader.user.id,
      dueAt: new Date(Date.now() + 172_800_000) } });
    const remindAt = new Date(Date.now() + (['SCHEDULED', 'CANCELED'].includes(state) ? 86_400_000 : 15_000)).toISOString();
    const command = { commandId: randomUUID(), kind: 'CLIENT', recordId: client.id, taskId: task.id,
      remindAt, selection: { people: [reader.user.id, other.user.id], groups: [] }, mode: 'CRM' };
    const preview = await previewRecordReminder(db, admin.session, proof, command);
    assert.deepEqual(preview.prepared.recipients.map(row => row.id), [reader.user.id]);
    await confirmRecordReminder(db, admin.session, proof, command, preview.signed, true);
    const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { commandId: command.commandId } });
    records[state] = { commandId: command.commandId, deliveryId: work.id, taskId: task.id, remindAt };
    if (state === 'CANCELED') await cancelRecordReminder(db, admin.session, proof,
      { commandId: randomUUID(), reminderCommandId: command.commandId }, true);
    if (state === 'SUPPRESSED') await db.task.update({ where: { id: task.id }, data: { dueAt: new Date(Date.now() + 259_200_000) } });
  }
  const availableAt = Math.max(...['AVAILABLE', 'READ', 'SUPPRESSED'].map(state => Date.parse(records[state].remindAt)));
  while (Date.now() <= availableAt + 50) await pause(250);
  const recipient = await syntheticSession(db, reader.user);
  assert((await readRecordReminderNotice(db, recipient.session, proof.key, records.READ.deliveryId, true))?.readAt);
  assert((await readRecordReminderNotice(db, recipient.session, proof.key, records.AVAILABLE.deliveryId)));
  for (const state of ['SCHEDULED', 'CANCELED', 'SUPPRESSED'])
    assert.equal(await readRecordReminderNotice(db, recipient.session, proof.key, records[state].deliveryId), null);
  assert.equal(await db.approvedCommunication.count(), beforeMail);
  writeFileSync(process.env.R05_REMINDER_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, noSend: true,
    authorEmail: admin.user.email, readerEmail: reader.user.email, otherEmail: other.user.email, records }, null, 2) + '\n');
  console.log('SQL71_REMINDER_RESTART_STATES_READY');
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('SQL71_REMINDER_RESTART_FIXTURE_FAILED'); process.exitCode = 1; });
