import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.RECORD_PROFILES_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.RECORD_PROFILES_BROWSER_PASSWORD!, evidence = process.env.RECORD_PROFILES_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await db.user.create({ data: { name: 'Profiles Browser Admin', email: 'profiles-admin@example.test', role: 'admin', active: true, passwordHash } });
  const owner = await db.user.create({ data: { name: 'Profiles Browser Owner', email: 'profiles-owner@example.test', role: 'consulente', active: true, passwordHash } });
  await db.user.create({ data: { name: 'Profiles Browser Outsider', email: 'profiles-outsider@example.test', role: 'consulente', active: true, passwordHash } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Profiles Browser Client', consultantId: owner.id } });
  const lead = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Browser', assignedToId: admin.id, clientId: client.id } });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, clientId: client.id, leadId: lead.id, ownerId: owner.id }));
}
main().finally(() => db.$disconnect()).catch(() => { console.error('SYNTHETIC_PROFILE_FIXTURE_FAILED'); process.exitCode = 1; });
