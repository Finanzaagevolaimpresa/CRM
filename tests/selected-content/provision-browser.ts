import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { contextFixture, contextPerson } from '../admin-email/fixture';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { previewInternalCommunication, confirmInternalCommunication } from '../../src/lib/internal-communications';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { randomUUID } from 'node:crypto';
const db = new PrismaClient();
async function main() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.SELECTED_CONTENT_BROWSER_CONFIRMED, '1');
  assert.equal(await db.user.count(), 0);
  const password = process.env.SELECTED_CONTENT_BROWSER_PASSWORD!, out = process.env.SELECTED_CONTENT_EVIDENCE!;
  assert.ok(password?.length >= 24 && out);
  const f = await contextFixture(db), second = await contextPerson(db, 'commerciale'), direction = await contextPerson(db, 'direzione'),
    technical = await contextPerson(db, 'consulente'), backoffice = await contextPerson(db, 'backoffice'), unselected = await contextPerson(db, 'revisore');
  const people = { admin: f.owner, commercial: f.member, second, direction, technical, backoffice, unselected, otherAdmin: f.outsider };
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [label, p] of Object.entries(people)) {
    await db.user.update({ where: { id: p.user.id }, data: { name: 'Synthetic ' + label, passwordHash } });
    if (label === 'direction') await db.userPermissionOverride.create({ data: { userId: p.user.id, permission: 'technical.write', allowed: true } });
    if (p.user.role !== 'admin') await db.userPermissionOverride.createMany({ data: ['video.read','communications.internal.read'].map(permission => ({ userId: p.user.id, permission, allowed: true })) });
  }
  const input = { id: randomUUID(), expectedVersion: 0, title: 'Synthetic six participant conversation',
    selection: { userIds: [f.member, second, direction, technical, backoffice].map(p => p.user.id), groups: [] } };
  const preview = await previewInternalCommunication(db, f.owner.actor, input, f.credentials);
  await confirmInternalCommunication(db, f.owner.actor, input, preview.evidenceHash, f.credentials);
  await db.$transaction(async tx => { for (const p of Object.values(people)) await revokeAllInternalSessions(tx, p.user.id, 'INTERNAL_GLOBAL', f.owner.user.id); });
  await assertRegistryActivationReady(db);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'fixture.json'), JSON.stringify({ synthetic: true, threadId: input.id, mailboxId: f.box.id,
    mailboxAddress: f.box.address, people: Object.fromEntries(Object.entries(people).map(([name, p]) => [name, { id: p.user.id, email: p.user.email, name: 'Synthetic ' + name }])) }));
  console.log('SELECTED_CONTENT_SYNTHETIC_BROWSER_READY; no provider configured or contacted');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
