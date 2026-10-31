import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { lifecycleReadinessFixture, lifecyclePrivateDocumentFixture } from '../admin-lifecycle/fixtures';
import { readPersonalAcquiredDocument } from '../../src/lib/technical-document-acquired-access';
import { listAccessiblePracticeReadiness } from '../../src/lib/practice-readiness';
async function main() {
const db = new PrismaClient();
try {
  if (process.env.APP_ENV !== 'test' || !process.env.LOCAL_DOCUMENT_STORAGE_ROOT) throw Error('Isolated fixture context required');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  if (process.argv[2] === 'verify') {
    const state = JSON.parse(readFileSync(process.argv[3], 'utf8')) as { actorId: string; documentId: string; bytesHex: string; practiceId: string };
    const user = await db.user.findUniqueOrThrow({ where: { id: state.actorId } });
    const { session } = await syntheticSession(db, user);
    assert.equal((await readPersonalAcquiredDocument(db, session, state.documentId)).bytes.toString('hex'), state.bytesHex);
    const practice = (await listAccessiblePracticeReadiness(db, session)).find(v => v.id === state.practiceId);
    assert(practice); assert.equal(practice.administrativeFormalizationCorrection, null);
    assert.equal(practice.prerequisites.missing.includes('incarico_formalizzato'), false);
    console.log(JSON.stringify({ originalBytesPreserved: true, originalFormalizationReadable: true, administrativeCorrectionInvented: false }));
  } else {
    const admin = await syntheticAuthority(db), practice = await lifecycleReadinessFixture(db, admin.session), document = await lifecyclePrivateDocumentFixture(db, admin);
    console.log(JSON.stringify({ actorId: admin.user.id, practiceId: practice.practice.id, documentId: document.receipt.documentId, bytesHex: document.bytes.toString('hex') }));
  }
} finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
