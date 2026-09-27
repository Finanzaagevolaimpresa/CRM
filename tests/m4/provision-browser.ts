import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.M4_BROWSER_CONFIRMED, '1');
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
    databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV }), true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.user.count(), 0);
  const password = process.env.M4_BROWSER_PASSWORD!, evidence = process.env.M4_BROWSER_EVIDENCE!, root = process.env.LOCAL_DOCUMENT_STORAGE_ROOT!;
  assert.ok(password?.length >= 24 && evidence && root && (process.env.PRIVILEGED_STEP_UP_SECRET?.length ?? 0) >= 32);
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await db.user.create({ data: { email: 'm4-browser-admin@invalid.test', name: 'M4 Browser Admin', role: 'admin', passwordHash, active: true } });
  const operator = await db.user.create({ data: { email: 'm4-browser-operator@invalid.test', name: 'M4 Browser Operator', role: 'consulente', passwordHash, active: true } });
  await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version: 1, status: 'ACTIVE', activatedAt: new Date(), keyDigest: privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!) } });
  const client = await db.client.create({ data: { type: 'societa', displayName: 'M4 Browser Synthetic Client', consultantId: operator.id } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, title: 'M4 Browser Synthetic', practiceType: 'test', targetEntity: 'Synthetic', technicalOwnerId: operator.id, createdById: admin.id } });
  const material = Buffer.from('Synthetic actual M4 bytes for Chromium package qualification.');
  mkdirSync(join(root, client.id), { recursive: true });
  const storagePath = `${client.id}/m4-synthetic.txt`;
  writeFileSync(join(root, storagePath), material, { flag: 'wx', mode: 0o600 });
  const document = await db.document.create({ data: { clientId: client.id, type: 'documento_operativo', title: 'M4 synthetic material', fileName: 'm4-synthetic.txt', mimeType: 'text/plain',
    storagePath, sizeBytes: material.length, checksum: createHash('sha256').update(material).digest('hex'), uploadedById: admin.id, status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath, checksum: document.checksum } });
  const box = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'assistenza@finanzaagevolaimpresa.it' } });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, adminId: admin.id, operatorId: operator.id, practiceId: practice.id, mailboxId: box.id, versionId: version.id, documentHash: document.checksum }));
  console.log('M4_SYNTHETIC_BROWSER_READY');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
