import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox } from '../../src/lib/approved-communications';
import { previewDirectEmailTest, sendApprovedDirectEmailTest } from '../../src/lib/direct-email-test-service';
import { DIRECT_TEST_FROM, DirectTestError, signDirectTestPreview, verifyDirectTestPreview, type DirectTestConfig, type DirectTestOutcome, type DirectTestTransportControl } from '../../src/lib/direct-email-test';

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

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function withFinalMailboxBarrier(mailboxId: string, holdMs: number) {
  let transactions = 0, sawBlocked = false;
  const connection = { $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
    if (++transactions !== 2) return db.$transaction(work, options);
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "CommunicationMailbox" WHERE id=${mailboxId} FOR UPDATE`;
      locked(); await released;
    }, { timeout: 15_000 });
    await acquired;
    const name = 'direct-expiry-' + randomUUID();
    const running = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('application_name', ${name}, true)`;
      return work(tx);
    }, options);
    try {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock') AS blocked`;
        if (rows[0].blocked) { sawBlocked = true; break; }
        await pause(20);
      }
      assert.ok(sawBlocked, 'Real PostgreSQL lock contention must be observed');
      await pause(holdMs);
    } finally { release(); await blocker; }
    return running;
  } } as unknown as PrismaClient;
  return { connection, blocked: () => sawBlocked };
}

for (const expiry of ['preview', 'database-session', 'claimed-session'] as const) {
  test(`final PostgreSQL lock wait cannot outlive ${expiry}; reservation remains and SMTP is never called`, { skip: !enabled }, async () => {
    const f = await fixture(), expiresAt = Date.now() + 2000;
    if (expiry === 'preview') f.input.token = signDirectTestPreview(f.settings, { ...verifyDirectTestPreview(f.settings, f.input.token), expiresAt });
    if (expiry === 'database-session') await db.internalSession.update({ where: { id: f.admin.sessionId }, data: { expiresAt: new Date(expiresAt) } });
    if (expiry === 'claimed-session') f.admin.expiresAt = Math.ceil(expiresAt / 1000);
    const barrier = withFinalMailboxBarrier(f.box.id, 3100);
    assert.equal(await sendApprovedDirectEmailTest(barrier.connection, f.admin, f.input, true, f.runtime), 'UNCERTAIN');
    assert.ok(barrier.blocked()); assert.equal(f.calls(), 0);
    const attempts = await db.auditLog.findMany({ where: { actorId: f.admin.userId, entityType: 'DirectEmailTest' } });
    assert.equal(attempts.length, 1); assert.equal(attempts[0].event, 'direct_email_test_reserved');
  });
}

test('exhausted shared lock/transport budget never starts SMTP and retains the reservation', { skip: !enabled }, async () => {
  const f = await fixture(), barrier = withFinalMailboxBarrier(f.box.id, 400);
  assert.equal(await sendApprovedDirectEmailTest(barrier.connection, f.admin, f.input, true, { ...f.runtime, transportWindowMs: 200 }), 'UNCERTAIN');
  assert.ok(barrier.blocked()); assert.equal(f.calls(), 0);
  assert.equal(await db.auditLog.count({ where: { actorId: f.admin.userId, event: 'direct_email_test_reserved' } }), 1);
});

test('slow transport aborts while PostgreSQL still holds authority locks; revocation commits only afterwards', { skip: !enabled }, async () => {
  const f = await fixture(), barrier = withFinalMailboxBarrier(f.box.id, 300);
  let transportLive = false, stopped = false, revoked = false, calls = 0;
  let revocation: Promise<unknown> | undefined;
  const send = async (_config: DirectTestConfig, id: string, control: DirectTestTransportControl): Promise<DirectTestOutcome> => {
    calls++; transportLive = true;
    assert.ok(await db.auditLog.findUnique({ where: { id } }));
    revocation = db.user.update({ where: { id: f.admin.userId }, data: { active: false } }).then(() => {
      assert.equal(transportLive, false, 'Authority cannot change while transport is live');
      assert.ok(stopped); revoked = true;
    });
    await pause(100); assert.equal(revoked, false);
    await new Promise<void>(resolve => {
      if (control.signal.aborted) return resolve();
      control.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    transportLive = false; stopped = true;
    return 'NOT_SENT';
  };
  assert.equal(await sendApprovedDirectEmailTest(barrier.connection, f.admin, f.input, true, { ...f.runtime, send, transportWindowMs: 1500 }), 'NOT_SENT');
  await revocation;
  assert.ok(barrier.blocked()); assert.ok(revoked); assert.ok(stopped); assert.equal(calls, 1);
  const attempts = await db.auditLog.findMany({ where: { actorId: f.admin.userId, entityType: 'DirectEmailTest' } });
  assert.equal(attempts.length, 2);
});
