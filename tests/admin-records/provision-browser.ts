import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
async function main() {
assert.equal(process.env.CI, 'true'); assert.equal(process.env.ADMIN_RECORD_DB_TESTS, '1');
const db = new PrismaClient();
try {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const hash = await bcrypt.hash(process.env.ADMIN_RECORD_BROWSER_PASSWORD!, 12);
  const admin = await syntheticAuthority(db, hash), technician = await syntheticPerson(db, 'Tecnico sintetico', 'consulente', hash);
  await db.selectiveClientAuthority.create({ data: { userId: admin.user.id, enabled: true } });
  for (const person of [admin, technician]) await db.$transaction(tx => revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id));
  await assertRegistryActivationReady(db);
  const client = await db.client.create({ data: { displayName: 'Cliente sintetico Admin browser', type: 'societa' } });
  const projects = [];
  for (let index = 0; index < 5; index++) projects.push(await db.project.create({ data: { clientId: client.id, title: `Progetto sintetico Admin ${index}`, priority: 'media', requestedAmount: '100.25' } }));
  writeFileSync(join(process.env.ADMIN_RECORD_EVIDENCE!, 'fixture.json'), JSON.stringify({ adminEmail: admin.user.email, technicianEmail: technician.user.email,
    clientId: client.id, projects: projects.map(row => ({ id: row.id, title: row.title })) }));
} finally { await db.$disconnect(); }

}
void main().catch(() => { console.error('ADMIN_BROWSER_PROVISION_FAILED'); process.exitCode = 1; });
