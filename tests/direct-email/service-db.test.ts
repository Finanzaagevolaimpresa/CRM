import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox } from '../../src/lib/approved-communications';
import { previewDirectEmailTest, sendApprovedDirectEmailTest } from '../../src/lib/direct-email-test-service';
import { DIRECT_TEST_FROM, DirectTestError, type DirectTestConfig, type DirectTestOutcome } from '../../src/lib/direct-email-test';

const enabled = process.env.DIRECT_EMAIL_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(async () => { await db.$disconnect(); });
const failure = (code: string) => (error: unknown) => error instanceof DirectTestError && error.code === code;
async function user(role: RoleCode = 'admin') {
  const row = await db.user.create({ data: { name: 'Synthetic direct email', email: `direct-${randomUUID()}@example.test`,
    role, active: true, passwordHash: 'synthetic-unusable-hash' } });
  const session = await db.internalSession.create({ data: { userId: row.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { userId: row.id, sessionId: session.id, role, active: true, permissionOverrides: [], expiresAt: Math.floor(session.expiresAt.getTime() / 1000) };
}
async function fixture(result: DirectTestOutcome = 'ACCEPTED') {
  const admin = await user();
  const before = await db.communicationMailbox.findUniqueOrThrow({ where: { address: DIRECT_TEST_FROM } });
  const box = await configureCommunicationMailbox(db, admin, { mailboxId: before.id, expectedRevision: before.revision,
    kind: 'MAILBOX', canonicalMailboxId: null, providerReference: 'SYNTHETIC_PROVIDER', responsibleUserId: admin.userId,
    canSend: true, canReceive: true, restricted: false, configurationReference: 'SYNTHETIC_CONFIG' });
  await qualifyCommunicationMailbox(db, admin, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_PROOF' });
  await qualifyCommunicationMailbox(db, admin, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  const settings: DirectTestConfig = { reference: `SYNTHETIC_${randomUUID()}`, recipient: 'controlled@example.test', host: 'smtp.example.test',
    password: 'synthetic-unusable-password', approvalKey: randomBytes(32).toString('hex') };
  let calls = 0;
  const runtime = { config: () => settings, send: async (_config: DirectTestConfig, id: string) => {
    calls++;
    // Independent connection sees the durable reservation before transport starts.
    const row = await db.auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal((row.after as { outcome: string }).outcome, 'RESERVED');
    return result;
  } };
  const preview = await previewDirectEmailTest(db, admin, runtime);
  assert.ok(preview.token);
  const input = { token: preview.token, exactApproval: true };
  return { admin, box, settings, runtime, input, calls: () => calls };
}

test('preview is read-only; exact approval and enforced admission precede any durable attempt', { skip: !enabled }, async () => {
  const f = await fixture(), before = await db.auditLog.count({ where: { entityType: 'DirectEmailTest' } });
  await previewDirectEmailTest(db, f.admin, f.runtime);
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, false, f.runtime), failure('DENIED'));
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, { ...f.input, exactApproval: false }, true, f.runtime), failure('DENIED'));
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, { ...f.runtime, config: () => null }), failure('DISABLED'));
  assert.equal(f.calls(), 0);
  assert.equal(await db.auditLog.count({ where: { entityType: 'DirectEmailTest' } }), before);
});

for (const outcome of ['ACCEPTED', 'NOT_SENT', 'UNCERTAIN'] as const) {
  test(`${outcome}: committed reservation, concurrent submissions and later replay never repeat transport`, { skip: !enabled }, async () => {
    const f = await fixture(outcome);
    const results = await Promise.all(Array.from({ length: 3 }, () => sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime)));
    assert.ok(results.every(value => value === outcome || value === 'UNCERTAIN'));
    assert.equal(await sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), outcome);
    const replay = await previewDirectEmailTest(db, f.admin, f.runtime);
    assert.equal(replay.token, null); assert.equal(replay.outcome, outcome); assert.equal(f.calls(), 1);
    const audits = await db.auditLog.findMany({ where: { actorId: f.admin.userId, entityType: 'DirectEmailTest' } });
    assert.equal(audits.length, 2);
    const serialized = JSON.stringify(audits);
    for (const privateValue of [f.settings.password, f.settings.approvalKey, f.settings.recipient]) assert.ok(!serialized.includes(privateValue));
  });
}

test('fresh role, session revocation, suspension and mailbox disablement deny a stale open page', { skip: !enabled }, async () => {
  const f = await fixture();
  const outsider = await user('commerciale');
  await assert.rejects(previewDirectEmailTest(db, outsider, f.runtime), failure('DENIED'));
  await db.user.update({ where: { id: f.admin.userId }, data: { role: 'consulente' } });
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), failure('DENIED'));
  await db.user.update({ where: { id: f.admin.userId }, data: { role: 'admin' } });
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } });
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), failure('DENIED'));
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: null } });
  await db.user.update({ where: { id: f.admin.userId }, data: { active: false } });
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), failure('DENIED'));
  await db.user.update({ where: { id: f.admin.userId }, data: { active: true } });
  await qualifyCommunicationMailbox(db, f.admin, { mailboxId: f.box.id, expectedRevision: f.box.revision, action: 'DISABLE' });
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), failure('SENDER_NOT_READY'));
  assert.equal(f.calls(), 0);
  assert.equal(await db.auditLog.count({ where: { actorId: f.admin.userId, entityType: 'DirectEmailTest' } }), 0);
});

test('two independently approved administrators share the campaign reservation', { skip: !enabled }, async () => {
  const f = await fixture(), other = await user();
  const otherPreview = await previewDirectEmailTest(db, other, f.runtime);
  assert.ok(otherPreview.token);
  const outcomes = await Promise.all([
    sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime),
    sendApprovedDirectEmailTest(db, other, { token: otherPreview.token, exactApproval: true }, true, f.runtime),
  ]);
  assert.ok(outcomes.every(value => value === 'ACCEPTED' || value === 'UNCERTAIN'));
  assert.equal(f.calls(), 1);
  assert.equal((await previewDirectEmailTest(db, other, f.runtime)).outcome, 'ACCEPTED');
});

test('recipient, configuration, live session and qualified mailbox revision are bound to the exact preview', { skip: !enabled }, async () => {
  const f = await fixture();
  for (const change of [{ recipient: 'other@example.test' }, { host: 'other.example.test' }, { password: 'other-synthetic-password' }]) {
    await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, { ...f.runtime, config: () => ({ ...f.settings, ...change }) }), failure('STALE'));
  }
  const other = await user();
  await assert.rejects(sendApprovedDirectEmailTest(db, other, f.input, true, f.runtime), failure('STALE'));
  const changed = await qualifyCommunicationMailbox(db, f.admin, { mailboxId: f.box.id, expectedRevision: f.box.revision, action: 'DISABLE' });
  await qualifyCommunicationMailbox(db, f.admin, { mailboxId: f.box.id, expectedRevision: changed.revision, action: 'TEST', testReference: 'SYNTHETIC_NEW_PROOF' });
  await qualifyCommunicationMailbox(db, f.admin, { mailboxId: f.box.id, expectedRevision: changed.revision, action: 'ENABLE' });
  await assert.rejects(sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), failure('STALE'));
  assert.equal(f.calls(), 0);
});

test('a revocation committed between reservation and final send prevents transport and leaves a non-retryable attempt', { skip: !enabled }, async () => {
  const f = await fixture(); let transactions = 0;
  const instrumented = { $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
    const result = await db.$transaction(work, options);
    if (++transactions === 1) await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: new Date() } });
    return result;
  } } as unknown as PrismaClient;
  assert.equal(await sendApprovedDirectEmailTest(instrumented, f.admin, f.input, true, f.runtime), 'UNCERTAIN');
  assert.equal(f.calls(), 0);
  await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { revokedAt: null } });
  assert.equal(await sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), 'UNCERTAIN');
  assert.equal(f.calls(), 0);
});

test('a crash or failed result commit after transport preserves reservation and cannot duplicate an email', { skip: !enabled }, async () => {
  const f = await fixture();
  const broken = db.$extends({ query: { auditLog: { async create({ args, query }) {
    if (args.data.event === 'direct_email_test_result') throw new Error('SYNTHETIC_RESULT_FAILURE');
    return query(args);
  } } } }) as unknown as PrismaClient;
  assert.equal(await sendApprovedDirectEmailTest(broken, f.admin, f.input, true, f.runtime), 'UNCERTAIN');
  assert.equal(await sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime), 'UNCERTAIN');
  assert.equal(f.calls(), 1);
  assert.equal(await db.auditLog.count({ where: { actorId: f.admin.userId, entityType: 'DirectEmailTest' } }), 1);
});

test('a failed reservation never contacts transport; a changed configuration cannot relabel a previous receipt', { skip: !enabled }, async () => {
  const f = await fixture();
  const broken = db.$extends({ query: { auditLog: { async create() { throw new Error('SYNTHETIC_RESERVATION_FAILURE'); } } } }) as unknown as PrismaClient;
  await assert.rejects(sendApprovedDirectEmailTest(broken, f.admin, f.input, true, f.runtime), /SYNTHETIC_RESERVATION_FAILURE/);
  assert.equal(f.calls(), 0);
  await sendApprovedDirectEmailTest(db, f.admin, f.input, true, f.runtime);
  await assert.rejects(previewDirectEmailTest(db, f.admin, { config: () => ({ ...f.settings, recipient: 'changed@example.test' }) }), failure('STALE'));
  assert.equal(f.calls(), 1);
});
