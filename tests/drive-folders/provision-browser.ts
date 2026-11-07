import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';

const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.FOLDER_BROWSER_CONFIRMED, '1'); assert.equal(await db.user.count(), 0);
  const password = process.env.FOLDER_BROWSER_PASSWORD!, out = process.env.FOLDER_EVIDENCE!;
  assert.ok(password?.length >= 24 && out);
  const passwordHash = await bcrypt.hash(password, 10), admin = await syntheticAuthority(db, passwordHash);
  const people = { admin, commercial: await syntheticPerson(db, 'Synthetic commercial', 'commerciale', passwordHash),
    technical: await syntheticPerson(db, 'Synthetic technical', 'consulente', passwordHash),
    outsider: await syntheticPerson(db, 'Synthetic outsider', 'commerciale', passwordHash),
    disabled: await syntheticPerson(db, 'Synthetic disabled section', 'commerciale', passwordHash) };
  for (const [name, person] of Object.entries(people)) {
    if (!['admin', 'disabled'].includes(name)) await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'drive_folders.read', allowed: true } });
  }
  const client = await db.client.create({ data: { displayName: 'Synthetic folder client Alpha', type: 'societa', salesOwnerId: people.commercial.user.id } });
  const empty = await db.client.create({ data: { displayName: 'Synthetic new client Beta', type: 'persona_fisica', salesOwnerId: people.commercial.user.id } });
  await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Converted', status: 'vinto', clientId: empty.id } });
  await db.$transaction(async tx => { for (const person of Object.values(people)) await revokeAllInternalSessions(tx, person.user.id, 'INTERNAL_GLOBAL', admin.user.id); });
  await assertRegistryActivationReady(db);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'fixture.json'), JSON.stringify({ synthetic: true, clientId: client.id, emptyClientId: empty.id,
    people: Object.fromEntries(Object.entries(people).map(([name, person]) => [name, { id: person.user.id, email: person.user.email, name: person.user.name }])) }));
  console.log('FOLDER_BROWSER_READY: isolated synthetic identities, no provider or Google calls');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
