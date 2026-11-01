import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localPathFromStoragePath } from '../src/lib/storage';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { readAdminTechnicalDisclosure, saveAdminTechnicalDisclosure } from '../src/lib/admin-technical-disclosure';
import { leadProof, type Person } from './selective-leads/fixtures';

export async function classifySyntheticTechnicalVersion(db: PrismaClient, admin: Person, versionId: string, historicalFixture = false) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  if (historicalFixture) {
    const [schema] = await db.$queryRaw<Array<{ present: boolean; migrations: bigint }>>`SELECT to_regclass('public."AdminRecordRevision"') IS NOT NULL AS present,
      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL) AS migrations`;
    if (!schema.present && schema.migrations < 72n) return null;
  }
  const before = await readAdminTechnicalDisclosure(db, admin.session, versionId);
  const command = { commandId: randomUUID(), id: versionId, expectedVersion: before.version,
    expectedSource: before.sourceSha256, classification: 'TECHNICAL_CONTENT' as const,
    assertions: { noPayments: true, noSignedCustomerContracts: true, noFreeOrInternalNotes: true, reviewedExactVersion: true },
    reason: 'Verifica contenuto tecnico della sola fixture sintetica', confirmed: true };
  await saveAdminTechnicalDisclosure(db, admin.session, command, leadProof(admin));
  return command;
}

export async function ensureSyntheticTechnicalBytes(db: PrismaClient, storagePath: string, bytes: Buffer) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const target = localPathFromStoragePath(storagePath);
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.deepEqual(await readFile(target), bytes, 'An existing fixture file must match exactly');
  }
}
