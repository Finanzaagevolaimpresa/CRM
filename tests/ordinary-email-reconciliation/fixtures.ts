import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { configureCommunicationMailbox, qualifyCommunicationMailbox, saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { createPrivilegedStepUpToken, privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { rotatePrivilegedStepUpKeyVersion, PRIVILEGED_STEP_UP_KEY_PURPOSE } from '../../src/lib/application-key-registry';
import { previewStoredOrdinaryEmail, reserveStoredOrdinaryEmail, takeStoredOrdinaryEmailAttempt } from '../../src/lib/ordinary-email-store-candidate';
import { prepareOrdinaryEmail, type OrdinaryChannel } from '../../src/lib/ordinary-email-candidate';
import { approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { canonicalSha256 } from '../../src/lib/canonical-json';

export const db = new PrismaClient();
export const key = { version: 1, secret: 'synthetic-recovery-store-key-000000000000000000' };
export const bytes = Buffer.from('SYNTHETIC RECOVERY ATTACHMENT'), checksum = createHash('sha256').update(bytes).digest('hex');
export const runtime = { key, readDocument: async () => bytes };
export const sessionCookies = new Map<string, string>();
export async function person() {
  const user = await db.user.create({ data: { email: `ordinary-${randomUUID()}@invalid.test`, name: 'Synthetic ordinary authority',
    role: 'admin', passwordHash: 'synthetic-unusable-hash', active: true } });
  const cookie = createRegistrySessionToken();
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: Buffer.from(await digestRegistrySessionToken(cookie.bytes)), expiresAt: new Date(Date.now()+3_600_000) } });
  sessionCookies.set(session.id, cookie.token);
  return { userId: user.id, sessionId: session.id, expiresAt: Math.floor(session.expiresAt.getTime()/1000),
    role: 'admin', active: true, permissionOverrides: [] } satisfies AuthSession;
}
export async function fixture() {
  const actor = await person();
  const latest = await db.applicationKeyVersion.findFirst({ where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE }, orderBy: { version: 'desc' } });
  key.version = (latest?.version ?? 0) + 1;
  await db.$transaction(tx => rotatePrivilegedStepUpKeyVersion(tx, { version: key.version,
    keyDigest: privilegedStepUpKeyDigest(key.secret), actorUserId: actor.userId }));
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic ordinary client' } });
  const project = await db.project.create({ data: { clientId: client.id, title: 'Synthetic ordinary project' } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, title: 'Synthetic ordinary practice',
    practiceType: 'test', targetEntity: 'Synthetic', createdById: actor.userId, technicalOwnerId: actor.userId } });
  const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id, title: 'Synthetic document', type: 'documento_operativo',
    fileName: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: bytes.length, storagePath: 'synthetic/ordinary.txt', checksum,
    uploadedById: actor.userId, status: 'verificato' } });
  const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum, storagePath: doc.storagePath } });
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, actor, { mailboxId: before.id, expectedRevision: before.revision, kind: 'MAILBOX',
    canonicalMailboxId: null, providerReference: 'register_it', responsibleUserId: actor.userId, canSend: true, canReceive: true,
    restricted: false, configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_ONLY' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled") VALUES ('ordinary-email',${actor.userId},${box.id}::uuid,true)
    ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference","enabled")
    VALUES (${box.id}::uuid,${box.revision},'SYNTHETIC_ORDINARY_ONLY',true) ON CONFLICT ("mailboxId") DO UPDATE
    SET "mailboxRevision"=EXCLUDED."mailboxRevision","enabled"=true,"revision"="OrdinaryEmailChannel"."revision"+1,
      "qualificationReference"=EXCLUDED."qualificationReference"`;
  const context = { kind: 'TECHNICAL' as const, id: practice.id };
  const input = { messageId: randomUUID(), expectedRevision: 0, context, mailboxId: box.id, replyTo: box.address,
    to: ['recipient@invalid.test'], cc: [], bcc: ['private@invalid.test'], subject: 'Synthetic stored decision', body: 'SYNTHETIC_PRIVATE_BODY',
    attachmentVersionIds: [version.id], classification: 'ORDINARY' };
  const saved = await saveApprovedMessageDraft(db, actor, input, runtime);
  const credentials = { sessionToken: sessionCookies.get(actor.sessionId)!, stepUpToken: undefined as string | undefined };
  credentials.stepUpToken = createPrivilegedStepUpToken({ key, userId: actor.userId, sessionToken: credentials.sessionToken });
  return { actor, client, project, practice, box, doc, version, input, saved, credentials };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) => previewStoredOrdinaryEmail(db, f.actor, f.saved.id, runtime);
export async function reserve(f: Fixture, token?: string, store = db) {
  return reserveStoredOrdinaryEmail(store, f.actor, { messageId: f.saved.id, requestId: randomUUID(), previewToken: token ?? (await preview(f)).token }, f.credentials, runtime);
}
export async function request(f: Fixture, attemptId: string) {
  const [row] = await db.$queryRaw<Array<{ decision: { preparedAt: string }; channelRevision: number }>>`
    SELECT d."decision",c."revision" AS "channelRevision" FROM "OrdinaryEmailAttempt" a JOIN "OrdinaryEmailDecision" d ON d."id"=a."decisionId"
    JOIN "OrdinaryEmailChannel" c ON c."mailboxId"=${f.box.id}::uuid WHERE a."id"=${attemptId}::uuid`;
  const version = await db.communicationVersion.findUniqueOrThrow({ where: { messageId_revision: { messageId: f.saved.id, revision: 1 } } });
  const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: f.box.id, mailboxRevision: f.box.revision,
    address: 'comunicazioni@finanzaagevolaimpresa.it', providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
    channelRevision: row.channelRevision, qualificationReference: 'SYNTHETIC_ORDINARY_ONLY' };
  const prepared = prepareOrdinaryEmail(approvedMessageSnapshotSchema.parse(version.snapshot), channel,
    new Map([[f.version.id,bytes]]), new Date(row.decision.preparedAt));
  return { attemptId, intentHash: prepared.intentHash, mimeHash: prepared.mimeHash, envelopeHash: canonicalSha256(prepared.envelope), channel };
}
export async function claimed(f: Fixture) {
  const reserved = await reserve(f), input = await request(f, reserved.attemptId);
  return { reserved, input, lease: await takeStoredOrdinaryEmailAttempt(db, f.actor, input, runtime) };
}
