import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { technicalFixture } from '../technical-assignments/fixtures';
import { confirmRecordUpdate, previewRecordUpdate, readRecordUpdateSetup } from '../../src/lib/record-updates';
import { readRecordUpdate } from '../../src/lib/record-update-delivery';
import type { UpdateCommand } from '../../src/lib/record-update-input';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const [ledger] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(ledger.count, 70n);
  const admin = await syntheticAuthority(db), f = await technicalFixture(db, admin);
  const reader = await syntheticPerson(db, 'SQL71 synthetic recipient', 'admin');
  const recipient = await syntheticSession(db, reader.user);
  await db.task.create({ data: { title: 'SQL71 existing deadline', description: 'SYNTHETIC_PRIVATE_TASK',
    clientId: f.client.id, projectId: f.project.id, dueAt: new Date(Date.now() + 86_400_000), assignedToId: f.techA.user.id } });
  await db.documentChecklistItem.create({ data: { title: 'SQL71 existing checklist', clientId: f.client.id } });
  for (const state of ['READ', 'AVAILABLE', 'REVOKED']) {
    const lead = await db.lead.create({ data: { firstName: 'SQL71 synthetic history', lastName: state, assignedToId: reader.user.id } });
    async function command(operation: 'RULE' | 'REVOKE') {
      const setup = await readRecordUpdateSetup(db, admin.session, 'LEAD', lead.id);
      const input: UpdateCommand = { commandId: randomUUID(), kind: 'LEAD', recordId: lead.id, operation, mode: 'CRM',
        expectedVersion: setup.expectedVersion, ruleVersion: setup.rule?.version ?? 0, selection: { people: [reader.user.id], groups: [] },
        events: ['NEXT_ACTION'], persistent: false, expiresAt: null, patch: null };
      const preview = await previewRecordUpdate(db, admin.session, input);
      await confirmRecordUpdate(db, admin.session, input, preview.digest, leadProof(admin));
    }
    await command('RULE');
    await db.lead.update({ where: { id: lead.id }, data: { nextActionNote: 'SQL71 synthetic retained next action' } });
    const work = await db.recordUpdateDelivery.findFirstOrThrow({ where: { recipientId: reader.user.id, event: { recordId: lead.id } } });
    if (state === 'READ') assert((await readRecordUpdate(db, recipient.session, work.id, true))?.readAt);
    if (state === 'REVOKED') { await command('REVOKE'); assert.equal(await readRecordUpdate(db, recipient.session, work.id), null); }
  }
  assert.equal(await db.recordUpdateDelivery.count(), 3);
  assert.equal(await db.recordUpdateDelivery.count({ where: { readAt: { not: null } } }), 1);
  assert.equal(await db.recordUpdateCommand.count(), 4);
  console.log('SQL71_SYNTHETIC_PRIOR_TASKS_DOCUMENTS_UPDATE_HISTORY_READY');
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('SQL71_PRIOR_HISTORY_FAILED'); process.exitCode = 1; });
