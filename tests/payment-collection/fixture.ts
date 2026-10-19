import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { registrationFixture } from '../service-registration/fixture';
import { syntheticSession } from '../selective-sharing/fixtures';
import { clientProof } from '../selective-clients/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';

export async function collectionKey(db: PrismaClient) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const version = Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), keyDigest = privilegedStepUpKeyDigest(process.env.PRIVILEGED_STEP_UP_SECRET!);
  const current = await db.applicationKeyVersion.findUnique({ where: { purpose_version: { purpose: 'PRIVILEGED_STEP_UP', version } } });
  if (current) { assert.equal(current.status, 'ACTIVE'); assert.equal(current.keyDigest, keyDigest); }
  else await db.applicationKeyVersion.create({ data: { purpose: 'PRIVILEGED_STEP_UP', version, keyDigest, status: 'ACTIVE', activatedAt: new Date() } });
}
export async function collectionFixture(db: PrismaClient, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const f = await registrationFixture(db, passwordHash);
  await db.payment.update({ where: { id: f.payment.id }, data: { status: 'da_incassare', collectedAt: null, accountingDocumentId: null } });
  const person = { user: f.admin, ...await syntheticSession(db, f.admin) };
  const command = { commandId: randomUUID(), clientId: f.client.id, paymentId: f.payment.id,
    documentVersionId: f.documents[1].version.id, collectedAt: new Date(Date.now() - 60_000).toISOString(), confirmed: true as const };
  return { ...f, session: person.session, person, proof: clientProof(person), command, registrationCommand: f.command };
}
