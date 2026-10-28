import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { technicalFixture, technicalTarget } from '../technical-assignments/fixtures';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem } from '../../src/lib/technical-private-item-service';
import type { TechnicalPrivateItemCommand } from '../../src/lib/technical-private-item-contract';

const db = new PrismaClient();
try {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.TECHNICAL_PRIVATE_ITEM_DB_TESTS, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations"`.then(rows => Number(rows[0].count)), 69);
  const admin = await syntheticAuthority(db);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
  const fixture = await technicalFixture(db, admin);
  const target = technicalTarget(fixture);
  for (const kind of ['Task', 'ChecklistItem'] as const) {
    const context = await loadTechnicalPrivateItemCreationContext(db, admin.session, target);
    const common = { target, commandId: randomUUID(), itemId: randomUUID(), expectedContextSha256: context.contextSha256 };
    const command: TechnicalPrivateItemCommand = kind === 'Task'
      ? { ...common, kind, values: { title: 'Attività storica sintetica', description: null, priority: 'media', dueAt: null } }
      : { ...common, kind, values: { title: 'Checklist storica sintetica', notes: null } };
    const proof = leadProof(admin);
    const preview = await previewPrivateTechnicalItem(db, admin.session, proof, command);
    await confirmPrivateTechnicalItem(db, admin.session, proof, command, preview.token, true);
  }
  console.log('SQL69_POPULATED_PRIVATE_OBSERVER_FIXTURE_READY');
} finally {
  await db.$disconnect();
}
