import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { loadAdminRecord, saveAdminRecord, closeAdminRecordAttempt, readAdminRecordReceipt } from '../../src/lib/admin-records';
import { adminHistoryFixture } from '../admin-records/history-fixture';
import { readAdminOperationalState, saveAdminOperationalState, reconcileAdminOperationalState } from '../../src/lib/admin-operational-lifecycle';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE);
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const admin = await syntheticPerson(db, 'Synthetic Admin correction author', 'admin', owner.passwordHash);
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  const proof = { key, sessionToken: admin.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: admin.user.id,
    sessionToken: admin.token, role: 'admin' }) };
  const client = await db.client.create({ data: { displayName: 'SYNTHETIC_ADMIN_BEFORE', type: 'persona_fisica' } });
  const commandIds: string[] = [];
  for (const operation of ['UPDATE', 'TRASH', 'RESTORE'] as const) {
    const form = await loadAdminRecord(db, admin.session, 'Client', client.id);
    const command = { commandId: randomUUID(), model: 'Client', id: client.id, operation, expectedVersion: form.version,
      reason: 'Synthetic Admin restart preservation', values: operation === 'UPDATE' ? { ...form.values, displayName: 'SYNTHETIC_ADMIN_PRESERVED' } : {} };
    await saveAdminRecord(db, admin.session, command, proof);
    assert.equal((await saveAdminRecord(db, admin.session, command, proof)).replayed, true);
    commandIds.push(command.commandId);
  }
  const closedId = randomUUID();
  assert.equal((await closeAdminRecordAttempt(db, admin.session, { commandId: closedId, model: 'Client', id: client.id })).closed, true);
  assert.equal((await readAdminRecordReceipt(db, admin.session, closedId))?.closed, true);
  const persisted = await db.client.findUniqueOrThrow({ where: { id: client.id } });
  assert.equal(persisted.displayName, 'SYNTHETIC_ADMIN_PRESERVED'); assert.equal(persisted.deletedAt, null);
  assert.equal(await db.adminRecordRevision.count({ where: { actorId: admin.user.id } }), 4);
  const lifecycle=await adminHistoryFixture(db,admin.user.id),lifecycleCommands:string[]=[];
  for(const state of ['BLOCKED','ACTIVE','ARCHIVED'] as const){
    const form=await readAdminOperationalState(db,admin.session,'ControlledIntake',lifecycle.intake.id);
    const command={commandId:randomUUID(),model:'ControlledIntake' as const,id:lifecycle.intake.id,state,
      expectedVersion:form.expectedVersion,reason:'Synthetic operational restart preservation',confirmed:true};
    await saveAdminOperationalState(db,admin.session,command,proof);lifecycleCommands.push(command.commandId);
  }
  const lifecycleClosedId=randomUUID();
  assert.equal((await reconcileAdminOperationalState(db,admin.session,{commandId:lifecycleClosedId,model:'ControlledIntake',
    id:lifecycle.intake.id,close:true})).status,'CLOSED');
  writeFileSync(process.env.R05_ADMIN_RECORD_RECOVERY_FIXTURE, JSON.stringify({ synthetic: true, noSend: true,
    adminEmail: admin.user.email, clientId: client.id, title: persisted.displayName, commandIds, closedId,
    lifecycleIntakeId:lifecycle.intake.id,lifecycleCommands,lifecycleClosedId }, null, 2) + '\n');
  console.log('SCHEMA73_ADMIN_RECORD_RESTART_STATES_READY');
}
void main().finally(() => db.$disconnect()).catch(() => { console.error('SCHEMA73_ADMIN_RECORD_RESTART_FIXTURE_FAILED'); process.exitCode = 1; });
