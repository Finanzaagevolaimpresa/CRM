import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { rotatePrivilegedStepUpKeyVersion } from '../../src/lib/application-key-registry';
import { privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import type { AuthSession } from '../../src/lib/auth';
import { ordinaryTransportQualificationReference } from '../../src/lib/ordinary-email-transport-binding';

export async function nativeEmailFixture(db: PrismaClient) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
    destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
    sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV }), true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const password = process.env.ORDINARY_EMAIL_BROWSER_PASSWORD!, secret = process.env.PRIVILEGED_STEP_UP_SECRET!;
  const storage = process.env.LOCAL_DOCUMENT_STORAGE_ROOT!;
  assert.ok(password.length >= 32 && secret.length >= 32 && path.isAbsolute(storage));
  assert.equal(process.env.APP_ORIGIN, 'http://127.0.0.1:3036');
  const passwordHash = await bcrypt.hash(password, 10);
  const person = () => db.user.create({ data: { email: `native-email-${randomUUID()}@invalid.test`, name: 'Synthetic ordinary operator', role: 'admin', passwordHash, active: true } });
  const user = await person(), other = await person(), cookie = createRegistrySessionToken();
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: Buffer.from(await digestRegistrySessionToken(cookie.bytes)), expiresAt: new Date(Date.now() + 3_600_000) } });
  const actor = { userId: user.id, sessionId: session.id, role: 'admin', active: true, permissionOverrides: [], expiresAt: Math.floor(session.expiresAt.getTime() / 1000) } satisfies AuthSession;
  const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret };
  assert.equal(key.version, 10000);
  const registered = await db.applicationKeyVersion.findFirst({ where: { purpose: 'PRIVILEGED_STEP_UP', status: 'ACTIVE' } });
  if (registered) {
    assert.equal(registered.version, key.version);
    assert.deepEqual(Buffer.from(registered.keyDigest), Buffer.from(privilegedStepUpKeyDigest(secret)));
  } else await db.$transaction(tx => rotatePrivilegedStepUpKeyVersion(tx, { version: key.version, keyDigest: privilegedStepUpKeyDigest(secret), actorUserId: user.id }));
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente email sintetico' } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Progetto email sintetico' } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica email sintetica', practiceType: 'test', targetEntity: 'Synthetic', createdById: user.id, technicalOwnerId: user.id } });
  const bytes = Buffer.from('ONLY SYNTHETIC NATIVE BROWSER MATERIAL'), checksum = createHash('sha256').update(bytes).digest('hex');
  const storagePath = `ordinary-browser/${randomUUID()}.txt`;
  await mkdir(path.join(storage, 'ordinary-browser'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(storage, storagePath), bytes, { flag: 'wx', mode: 0o600 });
  const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, title: 'Allegato sintetico', type: 'documento_operativo',
    fileName: 'allegato-sintetico.txt', mimeType: 'text/plain', sizeBytes: bytes.length, storagePath, checksum, uploadedById: user.id, status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum, storagePath } });
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, actor, { mailboxId: before.id, expectedRevision: before.revision, kind: 'MAILBOX', canonicalMailboxId: null,
    providerReference: 'register_it', responsibleUserId: user.id, canSend: true, canReceive: true, restricted: false, configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_NATIVE_UI_ONLY' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled") VALUES ('ordinary-email',${user.id},${box.id}::uuid,true)
    ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference","enabled")
    VALUES (${box.id}::uuid,${box.revision},'SYNTHETIC_NATIVE_UI_ONLY',true) ON CONFLICT ("mailboxId") DO UPDATE
    SET "mailboxRevision"=EXCLUDED."mailboxRevision","enabled"=true,"revision"="OrdinaryEmailChannel"."revision"+1,"qualificationReference"=EXCLUDED."qualificationReference"`;
  const input = { messageId: randomUUID(), expectedRevision: 0, context: { kind: 'TECHNICAL' as const, id: practice.id }, mailboxId: box.id, replyTo: box.address,
    to: ['destinatario@invalid.test'], cc: ['copia@invalid.test'], bcc: ['riservato@invalid.test'], subject: 'Anteprima email sintetica',
    body: 'TESTO SINTETICO ESATTO. Nessun invio reale.', attachmentVersionIds: [version.id], classification: 'ORDINARY' };
  const saved = await saveApprovedMessageDraft(db, actor, input);
  return { user, other, actor, key, cookie: cookie.token, client, project, practice, doc, version, input, saved, box };
}

export async function qualifyNativeTransport(db: PrismaClient, f: Awaited<ReturnType<typeof nativeEmailFixture>>) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.ORDINARY_EMAIL_BROWSER_CONFIRMED, '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.ok(process.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD && process.env.DIRECT_EMAIL_TEST_SMTP_PASSWORD.length >= 32);
  const [row] = await db.$queryRaw<Array<{ revision: number }>>`SELECT "revision" FROM "OrdinaryEmailChannel" WHERE "mailboxId"=${f.box.id}::uuid`;
  const revision = row.revision + 1;
  const qualification = ordinaryTransportQualificationReference({ purpose: 'ORDINARY_SMTP', mailboxId: f.box.id,
    mailboxRevision: f.box.revision, address: 'comunicazioni@finanzaagevolaimpresa.it', providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
    channelRevision: revision, qualificationReference: 'SYNTHETIC_PREPARATION_ONLY' }, f.key, process.env);
  await db.$executeRaw`UPDATE "OrdinaryEmailChannel" SET "revision"=${revision},"qualificationReference"=${qualification}
    WHERE "mailboxId"=${f.box.id}::uuid`;
}
