import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { chromium } from '@playwright/test';
import { playableWebm } from '../private-videos/synthetic-video';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticSession } from '../selective-sharing/fixtures';
import { createPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';
import { uploadVideo, readVideoSetup, previewVideo, confirmVideo, readVideoBytes } from '../../src/lib/video-library';
import type { VideoCommand } from '../../src/lib/video-input';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  process.env.PRIVILEGED_ACCESS_MODE = 'enforced';
  const owner = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const publisher = await db.user.create({ data: { name: 'Synthetic video recovery publisher', email: 'video-recovery-publisher@invalid.test',
    role: 'admin', passwordHash: owner.passwordHash } });
  const reader = await db.user.create({ data: { name: 'Synthetic video recovery reader', email: 'video-recovery-reader@invalid.test',
    role: 'commerciale', passwordHash: owner.passwordHash } });
  const revoked = await db.user.create({ data: { name: 'Synthetic video recovery revoked', email: 'video-recovery-revoked@invalid.test',
    role: 'commerciale', passwordHash: owner.passwordHash } });
  const actor = await syntheticSession(db, publisher), recipient = await syntheticSession(db, reader);
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
  const proof = { key, sessionToken: actor.token, stepUpToken: createPrivilegedStepUpToken({ key, userId: publisher.id, sessionToken: actor.token }) };
  const browser = await chromium.launch();
  let bytes: Buffer;
  try { const page = await browser.newPage(); bytes = await playableWebm(page); } finally { await browser.close(); }
  const records: Record<string, string> = {};
  for (const mode of ['PUBLISHED', 'ARCHIVED', 'RESTORED', 'REVOKED']) {
    const id = randomUUID(); await uploadVideo(db, actor.session, id, new File([new Uint8Array(bytes)], 'recovery.webm', { type: 'video/webm' }), proof);
    async function command(operation: VideoCommand['operation']) {
      const setup = await readVideoSetup(db, actor.session, id);
      const common = { commandId: randomUUID(), videoId: id, expectedVersion: setup.version };
      const input: VideoCommand = operation === 'PUBLISH' || operation === 'SAVE_DRAFT'
        ? { ...common, operation, details: { ...setup.details, title: 'SYNTHETIC_VIDEO_RECOVERY ' + mode,
            selection: { people: [mode === 'REVOKED' ? revoked.id : reader.id], areas: [] }, downloadAllowed: true } }
        : { ...common, operation };
      const p = await previewVideo(db, actor.session, input);
      await confirmVideo(db, actor.session, input, p.digest, proof);
    }
    await command('PUBLISH');
    if (mode === 'ARCHIVED' || mode === 'RESTORED') await command('ARCHIVE');
    if (mode === 'RESTORED') await command('RESTORE_DRAFT');
    records[mode] = id;
  }
  await db.userPermissionOverride.create({ data: { userId: revoked.id, permission: 'video.read', allowed: false } });
  // A regained role/permission must not resurrect the old audience.
  await db.userPermissionOverride.deleteMany({ where: { userId: revoked.id, permission: 'video.read' } });
  await db.videoAsset.create({ data: { id: randomUUID(), ownerId: publisher.id, ownerEpoch: publisher.recordUpdateEpoch,
    fileName: 'synthetic-incomplete.webm', mimeType: 'video/webm', sizeBytes: 512, sha256: '0'.repeat(64) } });
  assert.equal((await readVideoBytes(db, recipient.session, records.PUBLISHED)).bytes.length, bytes.length);
  writeFileSync(process.env.R05_VIDEO_RECOVERY_FIXTURE!, JSON.stringify({ synthetic: true, noProvider: true,
    readerEmail: reader.email, revokedEmail: revoked.email, otherEmail: 'context-recovery-other@invalid.test',
    records, sizeBytes: bytes.length }, null, 2) + '\n');
  console.log('PRIVATE_VIDEOS_SYNTHETIC_RESTART_HISTORY_READY');
}
void main().finally(() => db.$disconnect());
