import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { revokeAllInternalSessions, assertRegistryActivationReady } from '../../src/lib/internal-session-registry';
import { initialServiceCodes } from '../../src/lib/initial-service-contract';
import { syntheticUser, syntheticCase } from './fixtures';
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.M5_BROWSER_CONFIRMED, '1');
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
    databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV }), true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.user.count(), 0);
  const password = process.env.M5_BROWSER_PASSWORD!, root = process.env.M5_EVIDENCE!;
  assert.ok(password?.length >= 24 && root && process.env.LOCAL_DOCUMENT_STORAGE_ROOT && (process.env.PRIVILEGED_STEP_UP_SECRET?.length ?? 0) >= 32);
  const passwordHash = await bcrypt.hash(password, 10);
  const actors: Record<'admin' | 'operator' | 'human1' | 'human2', AuthSession> & { sales?: AuthSession; collaborator?: AuthSession } = { admin: await syntheticUser(db, 'admin', 'Admin M5', passwordHash), operator: await syntheticUser(db, 'consulente', 'Responsabile M5', passwordHash),
    human1: await syntheticUser(db, 'revisore', 'Revisore M5', passwordHash), human2: await syntheticUser(db, 'revisore', 'Revisore due M5', passwordHash) };
  if (process.env.R23_MANUAL_EVIDENCE) {
    actors.sales = await syntheticUser(db, 'commerciale', 'Commerciale dimostrativo M5', passwordHash);
    actors.collaborator = await syntheticUser(db, 'collaboratore_limitato', 'Collaboratore dimostrativo M5', passwordHash);
  }
  for (const [role, actor] of Object.entries(actors)) if (actor) await db.user.update({ where: { id: actor.userId }, data: { email: 'm5-browser-' + role + '@invalid.test' } });
  await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) } });
  const cases = [];
  for (const code of initialServiceCodes) {
    const f = await syntheticCase(db, code, actors);
    if (actors.sales && actors.collaborator) {
      await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: actors.sales.userId } });
      await db.clientReadGrant.create({ data: { userId: actors.collaborator.userId, clientId: f.client.id, active: true,
        createdById: actors.admin.userId, updatedById: actors.admin.userId } });
    }
    cases.push({ code, clientId: f.client.id, serviceId: f.service.id, dossierId: f.dossier.id, documentVersionId: f.documentVersion.id, versionId: f.version.id });
  }
  // Fixture actors needed live sessions for the real readiness transitions. End
  // those synthetic sessions before boot; the unchanged M1 guard must still pass.
  await db.$transaction(async tx => {
    for (const actor of Object.values(actors)) if (actor) await revokeAllInternalSessions(tx, actor.userId, 'INTERNAL_GLOBAL', actors.admin.userId);
  });
  await assertRegistryActivationReady(db);
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'browser-fixture.json'), JSON.stringify({ synthetic: true,
    adminId: actors.admin.userId, operatorId: actors.operator.userId, human1Id: actors.human1.userId, cases }));
  console.log('M5_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
