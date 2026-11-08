import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticSession } from '../selective-sharing/fixtures';
import { sharedFixture, sharedInput, shareAssignment } from '../shared-operational/fixtures';
import { saveSharedOperationalUpdate } from '../../src/lib/shared-operational-updates';
import { readRecordUpdate } from '../../src/lib/record-update-delivery';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const authority = await db.technicalAssignmentAuthority.findUniqueOrThrow({ where: { id: 'technical-assignment' } });
  const user = await db.user.findUniqueOrThrow({ where: { id: authority.userId } });
  const admin = { user, ...await syntheticSession(db, user) };
  const f = await sharedFixture(db, admin, user.passwordHash);
  const target = { kind: 'PRACTICE' as const, id: f.practice.id };
  for (const person of [f.tech, f.second]) await shareAssignment(db, admin, target, person);
  const first = await saveSharedOperationalUpdate(db, f.tech.session, await sharedInput(db, f.tech, target,
    { text: 'SYNTHETIC_SHARED_ORIGINAL', state: 'in_progettazione' }));
  const correction = await saveSharedOperationalUpdate(db, f.tech.session, await sharedInput(db, f.tech, target,
    { text: 'SYNTHETIC_SHARED_CORRECTION', correctionOfId: first.updateId }));
  const updates = [first.updateId, correction.updateId];
  const deliveries = await db.recordUpdateDelivery.findMany({ where: { eventId: { in: updates } }, orderBy: { id: 'asc' } });
  const notice = deliveries.find(row => row.eventId === correction.eventId && row.recipientId === f.sales.user.id)!;
  assert(notice); assert((await readRecordUpdate(db, f.sales.session, notice.id, true))?.readAt);
  writeFileSync(process.env.R05_SHARED_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true, noProvider: true,
    updates, deliveryIds: deliveries.map(row => row.id), readNoticeId: notice.id, adminEmail: user.email,
    techId: f.tech.user.id, secondId: f.second.user.id, techEmail: f.tech.user.email, secondEmail: f.second.user.email,
    salesEmail: f.sales.user.email, otherEmail: f.otherSales.user.email, strangerEmail: f.stranger.user.email,
    clientId: f.client.id, projectId: f.project.id, practiceId: f.practice.id, companyId: f.company.id,
    contractId: f.contract.id, paymentId: f.payment.id }, null, 2) + '\n');
  console.log('SHARED_OPERATIONAL_RECOVERY_HISTORY_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
