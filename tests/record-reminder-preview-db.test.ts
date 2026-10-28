import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { leadProof, type Person } from './selective-leads/fixtures';
import { technicalFixture, technicalTarget, assignTechnical, revokeTechnical } from './technical-assignments/fixtures';
import { readTechnicalAssignmentManagement } from '../src/lib/technical-assignment-management';
import { loadTechnicalPrivateItemCreationContext, previewPrivateTechnicalItem, confirmPrivateTechnicalItem } from '../src/lib/technical-private-item-service';
import type { TechnicalPrivateItemCommand } from '../src/lib/technical-private-item-contract';
import type { TechnicalWorkItemGrant } from '../src/lib/technical-work-item-grant';
import { previewRecordReminder } from '../src/lib/record-reminder-preview';
import { assertRecordReminderPreview } from '../src/lib/record-reminder-contract';
import { confirmRecordReminder, readRecordReminderReceipt } from '../src/lib/record-reminder-confirmation';
import { readRecordReminderNotice } from '../src/lib/record-reminder-delivery';
import { cancelRecordReminder, readRecordReminderCancellation } from '../src/lib/record-reminder-revocation';
import { listSelectedRecordNotices, readSelectedRecordNotice } from '../src/lib/record-reminder-notifications';
import { readRecordUpdateSetup, previewRecordUpdate, confirmRecordUpdate } from '../src/lib/record-updates';
import type { UpdateCommand } from '../src/lib/record-update-input';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.RECORD_REMINDER_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
let admin: Person;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.CI, 'true'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticAuthority(db);
  assert.deepEqual(await db.$queryRaw`SELECT id FROM "TechnicalAssignmentAuthority"`, []);
  await db.$executeRaw`INSERT INTO "TechnicalAssignmentAuthority"(id,"userId",revision,enabled) VALUES('technical-assignment',${admin.user.id},1,true)`;
});
after(async () => db.$disconnect());
const future = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();

async function fixture(privateTask = false) {
  const f = await technicalFixture(db, admin, undefined, 'consulente'), target = technicalTarget(f);
  let taskId: string;
  if (privateTask) {
    const context = await loadTechnicalPrivateItemCreationContext(db, admin.session, target);
    const command: TechnicalPrivateItemCommand = { commandId: randomUUID(), itemId: randomUUID(), target,
      expectedContextSha256: context.contextSha256, kind: 'Task', values: { title: 'PRIVATE_TITLE_NOT_IN_PREVIEW',
        description: 'PRIVATE_DESCRIPTION_NOT_IN_PREVIEW', priority: 'media', dueAt: future(1440) } };
    // Preserve the same personal confirmation throughout this UI-equivalent
    // fixture. Reissuing it can change its signed expiry across a second.
    const proof = leadProof(admin);
    const preview = await previewPrivateTechnicalItem(db, admin.session, proof, command);
    await confirmPrivateTechnicalItem(db, admin.session, proof, command, preview.token, true);
    taskId = command.itemId;
  } else taskId = (await db.task.create({ data: { clientId: f.client.id, projectId: f.project.id,
    title: 'PRIVATE_TITLE_NOT_IN_PREVIEW', description: 'PRIVATE_DESCRIPTION_NOT_IN_PREVIEW',
    assignedToId: f.techA.user.id, createdById: admin.user.id, dueAt: new Date(future(1440)) } })).id;
  return { ...f, target, taskId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function grant(f: Fixture, person: Person, dueAt = true, expiresAt?: string, withDocument = false) {
  const setup = await readTechnicalAssignmentManagement(db, admin.session, f.target, person.user.id);
  const option = setup.workItemOptions.find(row => row.kind === 'Task' && row.itemId === f.taskId); assert(option);
  const item: TechnicalWorkItemGrant = { kind: 'Task', itemId: f.taskId, generation: option.generation,
    scopeGeneration: option.scopeGeneration, scopeSha256: option.scopeSha256,
    readableFields: dueAt ? ['dueAt'] : ['status'], editableFields: [] };
  return assignTechnical(db, admin, f.target, person, { workItems: [item], expiresAt,
    documents: withDocument ? [{ fileId: f.documents[0].version.id, allowDownload: false }] : [] });
}
function input(f: Fixture, recipients: Person[] = [f.techA, f.techB, f.salesA, f.salesB]) {
  return { commandId: randomUUID(), kind: 'PRACTICE', recordId: f.practice.id, taskId: f.taskId,
    remindAt: future(10), selection: { people: recipients.map(person => person.user.id), groups: [] }, mode: 'CRM' };
}
const preview = (raw: unknown, actor = admin) => previewRecordReminder(db, actor.session, leadProof(actor), raw);
async function counts() {
  const [scheduled] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "RecordUpdateReminder"`;
  const [canceled] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "RecordUpdateReminderCancellation"`;
  return { tasks: await db.task.count(), origins: await db.technicalPrivateItemOrigin.count(),
    commands: await db.recordUpdateCommand.count(), events: await db.recordUpdateEvent.count(),
    deliveries: await db.recordUpdateDelivery.count(), audits: await db.auditLog.count(),
    grants: await db.technicalAssignment.count(), mail: await db.approvedCommunication.count(),
    reminders: Number(scheduled.count), cancellations: Number(canceled.count) };
}

const confirm = (raw: unknown, token: Awaited<ReturnType<typeof preview>>['signed'], client = db, actor = admin) =>
  confirmRecordReminder(client, actor.session, leadProof(actor), raw, token, true);
function assertOneScheduled(before: Awaited<ReturnType<typeof counts>>, after: Awaited<ReturnType<typeof counts>>, recipients = 1) {
  assert.deepEqual(after, { ...before, commands: before.commands + 1, events: before.events + 1,
    deliveries: before.deliveries + recipients, audits: before.audits + 1, reminders: before.reminders + 1 });
}

test('current two-technician deadline preview is read-only and does not widen either commercial scope', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const before = await counts(), result = await preview(input(f));
  assert(result.prepared.recipients.some(row => row.id === f.techA.user.id));
  assert(result.prepared.recipients.some(row => row.id === f.techB.user.id));
  // PR212's commercial progress projection does not grant the technical Task
  // deadline. Client-only reminders below exercise positive commercial access.
  assert(!result.prepared.recipients.some(row => row.id === f.salesA.user.id));
  assert(result.prepared.excluded.some(row => row.id === f.salesA.user.id && row.reason === 'NO_CURRENT_ACCESS'));
  assert(!result.prepared.recipients.some(row => row.id === f.salesB.user.id));
  assert.deepEqual(await counts(), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE|PRIVATE_DESCRIPTION|SCENARIO_PRIVATO|NOTA_INTERNA|CONTRATTO_PRIVATO|PAGAMENTO_PRIVATO/);
});

test('legacy technical ownership cannot replace a selected deadline field', options, async () => {
  const f = await fixture(); await grant(f, f.techA, false); await grant(f, f.techB);
  const result = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
  assert(result.prepared.excluded.some(row => row.id === f.techA.user.id && row.reason === 'NO_CURRENT_ACCESS'));
});

test('a private task needs the distinct personal manager and separately assigned technical deadline', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  const result = await preview(input(f));
  assert.deepEqual(result.prepared.recipients.map(row => row.id).sort(), [f.techA.user.id, f.techB.user.id].sort());
  const otherAdmin = await syntheticPerson(db, 'Other synthetic Admin', 'admin');
  for (const actor of [otherAdmin, f.techA, f.salesA]) await assert.rejects(preview(input(f), actor));
  await assert.rejects(preview({ ...input(f), recordId: f.otherPractice.id }));
});

test('a completed revocation removes that recipient even from an already open selection', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const raw = input(f, [f.techA, f.techB]), old = await preview(raw);
  await revokeTechnical(db, admin, f.target, f.techA);
  const current = await preview(raw);
  assert.deepEqual(current.prepared.recipients.map(row => row.id), [f.techB.user.id]);
  assert.throws(() => assertRecordReminderPreview(old.prepared.digest, current.prepared), /STALE/);
});

test('revoking and restoring an assignment cannot reuse the preceding preview', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), old = await preview(raw);
  await revokeTechnical(db, admin, f.target, f.techA); await grant(f, f.techA);
  const current = await preview(raw);
  assert.throws(() => assertRecordReminderPreview(old.prepared.digest, current.prepared), /STALE/);
});

test('a changed and restored Task deadline retains its new generation', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), old = await preview(raw), task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  await db.task.update({ where: { id: f.taskId }, data: { dueAt: new Date(future(2880)) } });
  await db.task.update({ where: { id: f.taskId }, data: { dueAt: task.dueAt } });
  const current = await preview(raw);
  assert(current.prepared.source.generation > old.prepared.source.generation);
  assert.throws(() => assertRecordReminderPreview(old.prepared.digest, current.prepared), /STALE/);
});

test('source completion, trash and a different parent are denied rather than repaired', options, async () => {
  for (const change of ['complete', 'trash', 'parent']) {
    const f = await fixture(); await grant(f, f.techA);
    if (change === 'complete') await db.task.update({ where: { id: f.taskId }, data: { status: 'completata' } });
    else if (change === 'trash') await db.project.update({ where: { id: f.project.id }, data: { deletedAt: new Date() } });
    else await db.task.update({ where: { id: f.taskId }, data: { clientId: f.otherClient.id } });
    const before = await counts(); await assert.rejects(preview(input(f, [f.techA]))); assert.deepEqual(await counts(), before);
  }
});

test('explicit permission revocation is evaluated from current rows, not the selected session cache', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  await db.userPermissionOverride.create({ data: { userId: f.techA.user.id, permission: 'service.write', allowed: false } });
  const result = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
});

test('a recipient does not need a fabricated browser session; the acting Admin does need a current one', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  await db.internalSession.update({ where: { id: f.techA.session.sessionId! }, data: { revokedAt: new Date() } });
  assert.equal((await preview(input(f, [f.techA]))).prepared.recipients.length, 1);
  const fresh = { user: admin.user, ...await syntheticSession(db, admin.user) };
  await db.internalSession.update({ where: { id: fresh.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(preview(input(f, [f.techA]), fresh));
  await assert.rejects(previewRecordReminder(db, admin.session, { ...leadProof(admin), stepUpToken: 'invalid' }, input(f, [f.techA])));
});

test('an assigned document that becomes unavailable cannot be bypassed by the reminder path', options, async () => {
  const f = await fixture(); await grant(f, f.techA, true, undefined, true); await grant(f, f.techB);
  await db.document.update({ where: { id: f.documents[0].doc.id }, data: { deletedAt: new Date() } });
  const result = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
});

test('the preview reports an authorization ending before the chosen reminder without extending it', options, async () => {
  const f = await fixture(); await grant(f, f.techA, true, future(5)); await grant(f, f.techB);
  const result = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
  assert(result.prepared.excluded.some(row => row.id === f.techA.user.id && row.reason === 'EXPIRES_BEFORE_REMINDER'));
});

test('client-only context admits the actual commercial owner and excludes the other commercial', options, async () => {
  const f = await fixture();
  const task = await db.task.create({ data: { clientId: f.client.id, title: 'Synthetic client deadline',
    dueAt: new Date(future(1440)), assignedToId: f.salesA.user.id, createdById: admin.user.id } });
  const result = await preview({ ...input(f, [f.salesA, f.salesB]), kind: 'CLIENT', recordId: f.client.id, taskId: task.id });
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.salesA.user.id]);
  await assert.rejects(preview({ ...input(f, [f.salesA]), kind: 'CLIENT', recordId: f.client.id }));
});

test('a financial task is unavailable even if its parent and recipients would be accessible', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  await db.task.update({ where: { id: f.taskId }, data: { title: 'Pagamento contratto riservato' } });
  const before = await counts(); await assert.rejects(preview(input(f, [f.techA]))); assert.deepEqual(await counts(), before);
});

test('new group membership changes the signed recipient selection and never silently reuses its proof', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  // This group has its own isolated members; preceding technical fixtures must
  // not turn this membership-change scenario into the separate recipient cap.
  await syntheticPerson(db, 'Initial synthetic administrative member', 'amministrazione');
  const raw = { ...input(f), selection: { people: [f.techA.user.id, f.techB.user.id], groups: ['amministrazione'] } };
  const old = await preview(raw);
  await syntheticPerson(db, 'New synthetic administrative member without grant', 'amministrazione');
  const current = await preview(raw);
  assert.throws(() => assertRecordReminderPreview(old.prepared.digest, current.prepared), /STALE/);
  assert.deepEqual(current.prepared.recipients.map(row => row.id).sort(), [f.techA.user.id, f.techB.user.id].sort());
  assert(current.prepared.excluded.length >= 2);
});

async function concurrentPreview(mutate: (tx: Prisma.TransactionClient) => Promise<unknown>, raw: unknown) {
  const application = `reminder_race_${randomUUID()}`, url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('application_name', application);
  const viewer = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const writer = db.$transaction(async tx => { await mutate(tx); entered(); await gate; }, { timeout: 15_000 });
  const writerResult = writer.then(() => null, error => error as Error);
  let reading: ReturnType<typeof previewRecordReminder> | undefined;
  try {
    await Promise.race([ready, writerResult.then(error => { throw error ?? new Error('WRITER_ENDED_BEFORE_GATE'); })]);
    reading = previewRecordReminder(viewer, admin.session, leadProof(admin), raw);
    // Observe an actual PostgreSQL lock wait, rather than assuming concurrency
    // from a delay or from a mocked service call.
    const outcome = reading.then(value => ({ value, error: null }), error => ({ value: null, error }));
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND application_name=${application} AND wait_event_type='Lock') AS blocked`;
      if (row.blocked) { blocked = true; break; }
      await pause(25);
    }
    assert(blocked, 'the preview must actually wait for the current writer');
    release(); await writer;
    const result = await outcome;
    if (result.error) {
      assert(result.error instanceof Prisma.PrismaClientKnownRequestError && (result.error.code === 'P2034'
        || (result.error.code === 'P2010' && ['40001', '40P01'].includes(String(result.error.meta?.code)))),
      `unexpected concurrency outcome: ${String(result.error?.code)} / ${String(result.error?.meta?.code)}`);
      return null;
    }
    return result.value;
  } finally {
    release(); await writerResult; await reading?.catch(() => undefined); await viewer.$disconnect();
  }
}

test('a deadline writer blocks preview; confirmed read-only retry yields the current generation', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), old = await preview(raw), changed = new Date(future(2880));
  const result = await concurrentPreview(tx => tx.task.update({ where: { id: f.taskId }, data: { dueAt: changed } }), raw);
  assert(result, 'the bounded read-only retry must complete after this single committed writer');
  assert.equal(result.prepared.source.dueAt, changed.toISOString());
  assert(result.prepared.source.generation > old.prepared.source.generation);
  assert.notEqual(result.prepared.digest, old.prepared.digest);
});

test('a permission writer blocks preview; no old recipient survives its committed revocation', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const result = await concurrentPreview(tx => tx.userPermissionOverride.create({
    data: { userId: f.techA.user.id, permission: 'service.write', allowed: false },
  }), input(f, [f.techA, f.techB]));
  assert(result, 'the bounded read-only retry must complete after this single committed writer');
  assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
  const current = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(current.prepared.recipients.map(row => row.id), [f.techB.user.id]);
});

test('confirmation atomically records only the selected current technicians in the existing CRM queue', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  const raw = input(f), proposed = await preview(raw), before = await counts();
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  const result = await confirm(raw, proposed.signed);
  assert.equal(result.confirmed, true); assert.equal(result.replayed, false);
  assertOneScheduled(before, await counts(), 2);
  assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: f.taskId } }), task);
  const event = await db.recordUpdateEvent.findUniqueOrThrow({ where: { id: result.eventId } });
  assert.equal(event.sourceKey, `record-reminder:${raw.commandId}`);
  assert.equal(event.event, 'DEADLINE'); assert.deepEqual(event.changed, ['dueDate']);
  assert(event.occurredAt < new Date(raw.remindAt), 'registration is not the future delivery instant');
  const deliveries = await db.recordUpdateDelivery.findMany({ where: { commandId: raw.commandId }, orderBy: { recipientId: 'asc' } });
  assert.deepEqual(deliveries.map(row => row.recipientId), [f.techA.user.id, f.techB.user.id].sort());
  assert(deliveries.every(row => row.mode === 'CRM' && !row.readAt && !row.ruleId));
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: raw.commandId, event: 'record_reminder_scheduled' } });
  assert.doesNotMatch(JSON.stringify({ event, deliveries, audit }), /PRIVATE_TITLE|PRIVATE_DESCRIPTION|NOTA_INTERNA|SCENARIO_PRIVATO/);
});

test('a repeated confirmed command retains one event and one immutable receipt', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw), before = await counts();
  const first = await confirm(raw, proposed.signed), second = await confirm(raw, proposed.signed);
  assert.equal(second.replayed, true); assert.equal(second.eventId, first.eventId);
  assertOneScheduled(before, await counts());
});

test('concurrent double confirmation cannot create a second event or recipient delivery', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw), before = await counts();
  const results = await Promise.allSettled([confirm(raw, proposed.signed), confirm(raw, proposed.signed)]);
  assert(results.some(row => row.status === 'fulfilled'));
  assertOneScheduled(before, await counts());
  const receipt = await readRecordReminderReceipt(db, admin.session, leadProof(admin), raw.commandId);
  assert.equal(receipt.confirmed, true);
});

test('changing and restoring the deadline rejects the retained confirmation without partial work', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw);
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  await db.task.update({ where: { id: task.id }, data: { dueAt: new Date(future(2880)) } });
  await db.task.update({ where: { id: task.id }, data: { dueAt: task.dueAt } });
  const before = await counts(); await assert.rejects(confirm(raw, proposed.signed), /STALE/);
  assert.deepEqual(await counts(), before);
});

test('revocation between preview and confirmation cannot silently save the smaller recipient list', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const raw = input(f, [f.techA, f.techB]), proposed = await preview(raw);
  await revokeTechnical(db, admin, f.target, f.techA);
  const before = await counts(); await assert.rejects(confirm(raw, proposed.signed), /STALE/);
  assert.deepEqual(await counts(), before);
});

test('changed time, recipients, key or an absent explicit confirmation cannot persist a schedule', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const raw = input(f, [f.techA]), proposed = await preview(raw), before = await counts();
  await assert.rejects(confirm({ ...raw, remindAt: future(15) }, proposed.signed));
  await assert.rejects(confirm({ ...raw, selection: { people: [f.techB.user.id], groups: [] } }, proposed.signed));
  await assert.rejects(confirm(raw, { ...proposed.signed, proof: '0'.repeat(64) }));
  await assert.rejects(confirmRecordReminder(db, admin.session, leadProof(admin), raw, proposed.signed, false));
  assert.deepEqual(await counts(), before);
});

test('another Admin session, a technician and a revoked session cannot confirm the signed decision', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw);
  const other = await syntheticPerson(db, 'Unrelated reminder Admin', 'admin');
  const fresh = { user: admin.user, ...await syntheticSession(db, admin.user) }, before = await counts();
  await assert.rejects(confirm(raw, proposed.signed, db, other));
  await assert.rejects(confirm(raw, proposed.signed, db, f.techA));
  await assert.rejects(confirm(raw, proposed.signed, db, fresh));
  await db.internalSession.update({ where: { id: fresh.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(confirm(raw, proposed.signed, db, fresh));
  assert.deepEqual(await counts(), before);
});

// Inject transport/application faults inside a real Prisma transaction, after
// preceding inserts have reached PostgreSQL. No mocked database or fake commit.
function faultDatabase(fault: 'throw' | 'omit-journal' | 'recipient' | 'audit', substitute = ''): PrismaClient {
  return new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      config: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) =>
      db.$transaction(async tx => callback(new Proxy(tx, { get(client, member) {
        if (member === '$executeRaw' && ['throw', 'omit-journal'].includes(fault)) {
          return async (query: TemplateStringsArray, ...values: unknown[]) => {
            if (query.join('').includes('INSERT INTO "RecordUpdateReminder"')) {
              if (fault === 'throw') throw new Error('SYNTHETIC_FAILURE_BEFORE_REMINDER_JOURNAL');
              return 1;
            }
            return client.$executeRaw(query, ...values);
          };
        }
        if (member === 'recordUpdateDelivery' && fault === 'recipient') return { ...client.recordUpdateDelivery,
          create: (args: Prisma.RecordUpdateDeliveryCreateArgs) => {
            assert('eventId' in args.data && typeof args.data.eventId === 'string');
            return client.recordUpdateDelivery.create({ ...args,
              data: { ...(args.data as Prisma.RecordUpdateDeliveryUncheckedCreateInput), recipientId: substitute } });
          } };
        if (member === 'auditLog' && fault === 'audit') return { ...client.auditLog,
          create: (args: Prisma.AuditLogCreateArgs) => client.auditLog.create({ ...args, data: { ...args.data, event: 'wrong_synthetic_event' } }) };
        const value = Reflect.get(client, member); return typeof value === 'function' ? value.bind(client) : value;
      } })), config);
  } });
}

for (const fault of ['throw', 'omit-journal', 'recipient', 'audit'] as const) {
  test(`a ${fault} fault rolls back command, event, deliveries, journal and audit together`, options, async () => {
    const f = await fixture(); await grant(f, f.techA);
    const raw = input(f, [f.techA]), proposed = await preview(raw), before = await counts();
    const reason = { throw: /SYNTHETIC_FAILURE/, 'omit-journal': /RECORD_REMINDER_JOURNAL_REQUIRED/,
      recipient: /RECORD_REMINDER_DELIVERIES_MISMATCH/, audit: /RECORD_REMINDER_ATOMIC_EVIDENCE_REQUIRED/ }[fault];
    await assert.rejects(confirm(raw, proposed.signed, faultDatabase(fault, f.salesB.user.id)), reason);
    assert.deepEqual(await counts(), before);
    assert.equal((await readRecordReminderReceipt(db, admin.session, leadProof(admin), raw.commandId)).confirmed, false);
  });
}

test('journal and audit are retained and a future reminder cannot acquire an early read receipt', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw);
  await confirm(raw, proposed.signed); const before = await counts();
  await assert.rejects(db.$executeRaw`UPDATE "RecordUpdateReminder" SET proof=${'f'.repeat(64)} WHERE "commandId"=${raw.commandId}::uuid`, /IMMUTABLE/);
  await assert.rejects(db.$executeRaw`DELETE FROM "RecordUpdateReminder" WHERE "commandId"=${raw.commandId}::uuid`, /IMMUTABLE/);
  await assert.rejects(db.auditLog.updateMany({ where: { entityId: raw.commandId }, data: { event: 'changed' } }), /IMMUTABLE/);
  await assert.rejects(db.recordUpdateDelivery.updateMany({ where: { commandId: raw.commandId }, data: { readAt: new Date() } }), /NOT_AVAILABLE/);
  assert.deepEqual(await counts(), before);
});

test('a lost response is reconciled by a read-only receipt and never fabricates availability or email delivery', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), proposed = await preview(raw), before = await counts();
  await assert.rejects((async () => { await confirm(raw, proposed.signed); throw new Error('SYNTHETIC_RESPONSE_LOST'); })(), /RESPONSE_LOST/);
  const receipt = await readRecordReminderReceipt(db, admin.session, leadProof(admin), raw.commandId);
  assert.equal(receipt.confirmed, true);
  assert.deepEqual(Object.keys(receipt).sort(), ['commandId', 'confirmed', 'eventId', 'registeredAt']);
  assertOneScheduled(before, await counts());
  const after = await counts();
  await readRecordReminderReceipt(db, admin.session, leadProof(admin), raw.commandId);
  const other = await syntheticPerson(db, 'Unrelated receipt Admin', 'admin');
  const hidden = await readRecordReminderReceipt(db, other.session, leadProof(other), raw.commandId);
  assert.deepEqual(hidden, { commandId: raw.commandId, confirmed: false });
  assert.deepEqual(await counts(), after);
});

async function scheduleForRead(f: Fixture, recipients = [f.techA], overrides: Record<string, unknown> = {}) {
  const raw = { ...input(f, recipients), remindAt: new Date(Date.now() + 6000).toISOString(), ...overrides };
  const proposed = await preview(raw);
  await confirm(raw, proposed.signed);
  const deliveries = await db.recordUpdateDelivery.findMany({ where: { commandId: raw.commandId } });
  return { raw, deliveries, wait: () => pause(Math.max(0, Date.parse(raw.remindAt) - Date.now() + 30)) };
}
const notice = (person: Person, id: string, markRead = false) =>
  readRecordReminderNotice(db, person.session, leadProof(admin).key, id, markRead);
const selectedNotices = (person: Person, limit = 100, unreadOnly = true) =>
  listSelectedRecordNotices(db, person.session, leadProof(admin).key, limit, unreadOnly);
const selectedNotice = (person: Person, id: string, markRead = false) =>
  readSelectedRecordNotice(db, person.session, leadProof(admin).key, id, markRead);

test('the real database clock makes only selected notices available and GET never marks them read', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  const s = await scheduleForRead(f, [f.techA, f.techB]), before = await counts();
  const a = s.deliveries.find(row => row.recipientId === f.techA.user.id)!, b = s.deliveries.find(row => row.recipientId === f.techB.user.id)!;
  assert.equal(await notice(f.techA, a.id), null);
  assert.equal(await notice(f.techA, a.id, true), null);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: a.id } })).readAt, null);
  await s.wait();
  const shown = await notice(f.techA, a.id); assert(shown);
  assert.equal(shown.state, 'AVAILABLE'); assert.equal(shown.emailSent, false); assert.equal(shown.readAt, null);
  assert.equal(shown.recordHref, `/technical-work/practices/${f.practice.id}/items/Task/${f.taskId}`);
  assert.equal(shown.availableAt, s.raw.remindAt);
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE_TITLE|PRIVATE_DESCRIPTION|SCENARIO_PRIVATO|NOTA_INTERNA|CONTRATTO_PRIVATO|PAGAMENTO_PRIVATO/);
  assert(await notice(f.techB, b.id));
  assert.equal(await notice(f.techB, a.id), null); assert.equal(await notice(f.salesA, a.id), null); assert.equal(await notice(admin, a.id), null);
  assert.deepEqual(await counts(), before);
  assert(s.deliveries.every(row => !row.readAt));
  assert.equal(await db.recordUpdateDelivery.count({ where: { commandId: s.raw.commandId, readAt: { not: null } } }), 0);
});

test('the existing notification surface lists only due personal notices without exposing technical private labels', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  const s = await scheduleForRead(f, [f.techA, f.techB]), before = await counts();
  assert.deepEqual(await selectedNotices(f.techA), []);
  assert.deepEqual(await selectedNotices(f.techB), []);
  await s.wait();
  for (const person of [f.techA, f.techB]) {
    const rows = await selectedNotices(person), own = s.deliveries.find(row => row.recipientId === person.user.id)!;
    assert.equal(rows.length, 1); assert.equal(rows[0].id, own.id);
    assert.equal(rows[0].href, `/notifications/updates/${own.id}`);
    assert.equal(rows[0].readAt, null);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_TITLE|PRIVATE_DESCRIPTION|SCENARIO_PRIVATO|NOTA_INTERNA|CONTRATTO_PRIVATO|PAGAMENTO_PRIVATO|accessUntil/);
  }
  assert.deepEqual(await selectedNotices(f.salesA), []);
  assert.deepEqual(await selectedNotices(f.salesB), []);
  assert.deepEqual(await counts(), before);
});

test('future cancelled and revoked work is excluded before the visible result limit', options, async () => {
  const f = await fixture(), other = await fixture();
  await grant(f, f.techA); await grant(other, f.techA);
  const good = await scheduleForRead(f);
  const removed = await scheduleForRead(f), revoked = await scheduleForRead(other, [f.techA]);
  await scheduleForRead(f, [f.techA], { remindAt: future(60) });
  await cancel(cancellationInput(removed.raw.commandId));
  await revokeTechnical(db, admin, other.target, f.techA);
  await revoked.wait(); const before = await counts();
  const rows = await selectedNotices(f.techA, 1);
  assert.deepEqual(rows.map(row => row.id), [good.deliveries[0].id]);
  assert.equal(await selectedNotice(f.techA, removed.deliveries[0].id), null);
  assert.equal(await selectedNotice(f.techA, revoked.deliveries[0].id), null);
  assert.deepEqual(await counts(), before);
});

test('explicit read through the existing detail removes only the unread notice and preserves its first receipt', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f); await s.wait(); const id = s.deliveries[0].id;
  assert.equal((await selectedNotices(f.techA)).length, 1);
  const before = await counts(), first = await selectedNotice(f.techA, id, true); assert(first?.readAt);
  assert.deepEqual(await selectedNotices(f.techA), []);
  const retained = await selectedNotices(f.techA, 100, false);
  assert.equal(retained.length, 1); assert.equal(retained[0].readAt?.toISOString(), first.readAt.toISOString());
  const repeated = await selectedNotice(f.techA, id, true);
  assert.equal(repeated?.readAt?.toISOString(), first.readAt.toISOString());
  await cancel(cancellationInput(s.raw.commandId));
  assert.deepEqual(await selectedNotices(f.techA, 100, false), []);
  assert.equal(await selectedNotice(f.techA, id), null);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id } })).readAt?.toISOString(), first.readAt.toISOString());
  assertOneCanceled(before, await counts());
});

test('ordinary record updates and reminders share one selected queue without changing commercial separation', options, async () => {
  const f = await fixture();
  const setup = await readRecordUpdateSetup(db, admin.session, 'CLIENT', f.client.id);
  assert.equal(setup.patch.kind, 'CLIENT');
  const raw: UpdateCommand = { commandId: randomUUID(), kind: 'CLIENT', recordId: f.client.id, operation: 'UPDATE',
    expectedVersion: setup.expectedVersion, ruleVersion: setup.rule?.version ?? 0,
    selection: { people: [f.salesA.user.id], groups: [] }, events: ['RECORD_CHANGED'], persistent: false, expiresAt: null,
    patch: { ...setup.patch, kind: 'CLIENT', displayName: 'Synthetic updated client', type: 'societa' } };
  const proposed = await previewRecordUpdate(db, admin.session, raw);
  await confirmRecordUpdate(db, admin.session, raw, proposed.digest, leadProof(admin));
  const task = await db.task.create({ data: { clientId: f.client.id, title: 'CLIENT_PRIVATE_TITLE',
    dueAt: new Date(future(1440)), assignedToId: f.salesA.user.id, createdById: admin.user.id } });
  const s = await scheduleForRead(f, [f.salesA, f.salesB], { kind: 'CLIENT', recordId: f.client.id, taskId: task.id });
  await s.wait(); const before = await counts(), rows = await selectedNotices(f.salesA);
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.id)).size, 2);
  assert(rows.some(row => row.category === 'Aggiornamento scelto dall’Admin'));
  assert(rows.some(row => row.category === 'Promemoria scelto dall’Admin'));
  assert.deepEqual(await selectedNotices(f.salesB), []);
  for (const row of rows) { assert(await selectedNotice(f.salesA, row.id)); assert.equal(await selectedNotice(f.salesB, row.id), null); }
  assert.doesNotMatch(JSON.stringify(rows), /CLIENT_PRIVATE_TITLE|SCENARIO_PRIVATO|NOTA_INTERNA|CONTRATTO_PRIVATO|PAGAMENTO_PRIVATO/);
  assert.deepEqual(await counts(), before);
});

test('an absent or unregistered key never falls back to ordinary admission for a scheduled notice', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f); await s.wait(); const before = await counts(), id = s.deliveries[0].id;
  assert.deepEqual(await listSelectedRecordNotices(db, f.techA.session, null), []);
  assert.equal(await readSelectedRecordNotice(db, f.techA.session, null, id), null);
  const bad = { ...leadProof(admin).key, secret: 'synthetic-unregistered-key' };
  await assert.rejects(listSelectedRecordNotices(db, f.techA.session, bad));
  await assert.rejects(readSelectedRecordNotice(db, f.techA.session, bad, id));
  for (const limit of [0, -1, 501, 1.5, NaN]) await assert.rejects(selectedNotices(f.techA, limit));
  assert.deepEqual(await counts(), before);
});

test('current session revocation closes both the selected list and its retained detail URL', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f); await s.wait(); assert.equal((await selectedNotices(f.techA)).length, 1);
  await db.internalSession.update({ where: { id: f.techA.session.sessionId! }, data: { revokedAt: new Date(), revokedReason: 'synthetic-list-revocation' } });
  const before = await counts();
  await assert.rejects(selectedNotices(f.techA));
  await assert.rejects(selectedNotice(f.techA, s.deliveries[0].id));
  assert.deepEqual(await counts(), before);
});

test('only an explicit recipient command marks read, and a repeated command preserves the first read time', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait();
  const before = await counts(), first = await notice(f.techA, id, true); assert(first?.readAt);
  assert(first.readAt >= new Date(s.raw.remindAt)); assert.equal(first.state, 'READ');
  const again = await notice(f.techA, id, true); assert(again?.readAt);
  assert.equal(again.readAt.toISOString(), first.readAt.toISOString());
  assert.equal((await notice(f.techA, id))?.state, 'READ');
  assert.deepEqual(await counts(), before);
});

test('a lost mark-read response is reconciled by GET without another write or a fabricated email receipt', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait();
  await assert.rejects((async () => { await notice(f.techA, id, true); throw new Error('SYNTHETIC_READ_RESPONSE_LOST'); })(), /RESPONSE_LOST/);
  const stored = await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id } }); assert(stored.readAt);
  const before = await counts(), observed = await notice(f.techA, id);
  assert.equal(observed?.readAt?.toISOString(), stored.readAt.toISOString()); assert.equal(observed?.emailSent, false);
  assert.deepEqual(await counts(), before);
});

test('revoking an open assignment blocks its retained notice while the second technician remains authorized', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const s = await scheduleForRead(f, [f.techA, f.techB]); await s.wait();
  const a = s.deliveries.find(row => row.recipientId === f.techA.user.id)!, b = s.deliveries.find(row => row.recipientId === f.techB.user.id)!;
  assert(await notice(f.techA, a.id)); await revokeTechnical(db, admin, f.target, f.techA);
  assert.equal(await notice(f.techA, a.id), null); assert.equal(await notice(f.techA, a.id, true), null);
  assert(await notice(f.techB, b.id));
  await grant(f, f.techA); assert.equal(await notice(f.techA, a.id), null, 'a new assignment is not the former signed recipient decision');
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id: a.id } })).readAt, null);
});

test('changing and restoring a deadline suppresses the retained notice rather than restoring old source authority', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait();
  assert(await notice(f.techA, id));
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  await db.task.update({ where: { id: task.id }, data: { dueAt: new Date(future(2880)) } });
  await db.task.update({ where: { id: task.id }, data: { dueAt: task.dueAt } });
  assert.equal(await notice(f.techA, id), null);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id } })).readAt, null);
});

test('a revoked current recipient session cannot read a notice even with its previously valid user and key', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait();
  assert(await notice(f.techA, id));
  await db.internalSession.update({ where: { id: f.techA.session.sessionId! }, data: { revokedAt: new Date() } });
  await assert.rejects(notice(f.techA, id), /DENIED/);
  await assert.rejects(notice(f.techA, id, true), /DENIED/);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id } })).readAt, null);
});

test('a group membership change suppresses the earlier decision without notifying the new group member', options, async () => {
  const f = await fixture(true); await grant(f, f.techA);
  const s = await scheduleForRead(f, [f.techA], { selection: { people: [f.techA.user.id], groups: ['amministrazione'] } });
  await s.wait(); const id = s.deliveries[0].id; assert(await notice(f.techA, id));
  const additional = await syntheticPerson(db, 'New isolated reminder group member', 'amministrazione');
  assert.equal(await notice(f.techA, id), null); assert.equal(await notice(additional, id), null);
  assert.equal(await db.recordUpdateDelivery.count({ where: { commandId: s.raw.commandId } }), 1);
});

test('the two commercial accounts retain their client-only isolation after a reminder becomes available', options, async () => {
  const f = await fixture();
  const task = await db.task.create({ data: { clientId: f.client.id, title: 'CLIENT_PRIVATE_TITLE',
    dueAt: new Date(future(1440)), assignedToId: f.salesA.user.id, createdById: admin.user.id } });
  const s = await scheduleForRead(f, [f.salesA, f.salesB], { kind: 'CLIENT', recordId: f.client.id, taskId: task.id });
  await s.wait(); const id = s.deliveries[0].id;
  assert.equal(s.deliveries.length, 1); assert.equal(s.deliveries[0].recipientId, f.salesA.user.id);
  const visible = await notice(f.salesA, id); assert(visible);
  assert.equal(visible.recordHref, `/clients/${f.client.id}`); assert.doesNotMatch(JSON.stringify(visible), /CLIENT_PRIVATE_TITLE/);
  assert.equal(await notice(f.salesB, id), null);
  await db.client.update({ where: { id: f.client.id }, data: { salesOwnerId: f.salesB.user.id } });
  assert.equal(await notice(f.salesA, id), null); assert.equal(await notice(f.salesB, id), null);
});

test('a selected linked document becoming unavailable closes the alternate reminder entry point', options, async () => {
  const f = await fixture(); await grant(f, f.techA, true, undefined, true);
  const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait(); assert(await notice(f.techA, id));
  await db.document.update({ where: { id: f.documents[0].doc.id }, data: { deletedAt: new Date() } });
  assert.equal(await notice(f.techA, id), null);
});

test('source completion and parent trash remove available notices without deleting their retained history', options, async () => {
  for (const change of ['complete', 'trash']) {
    const f = await fixture(); await grant(f, f.techA);
    const s = await scheduleForRead(f), id = s.deliveries[0].id; await s.wait(); assert(await notice(f.techA, id));
    if (change === 'complete') await db.task.update({ where: { id: f.taskId }, data: { status: 'completata' } });
    else await db.project.update({ where: { id: f.project.id }, data: { deletedAt: new Date() } });
    const before = await counts(); assert.equal(await notice(f.techA, id), null); assert.deepEqual(await counts(), before);
    assert.equal((await readRecordReminderReceipt(db, admin.session, leadProof(admin), s.raw.commandId)).confirmed, true);
  }
});

const cancellationInput = (reminderCommandId: string) => ({ commandId: randomUUID(), reminderCommandId });
const cancel = (raw: ReturnType<typeof cancellationInput>, client = db, actor = admin) =>
  cancelRecordReminder(client, actor.session, leadProof(actor), raw, true);
const cancellationReceipt = (raw: ReturnType<typeof cancellationInput>, actor = admin) =>
  readRecordReminderCancellation(db, actor.session, leadProof(actor), raw);
function assertOneCanceled(before: Awaited<ReturnType<typeof counts>>, after: Awaited<ReturnType<typeof counts>>) {
  assert.deepEqual(after, { ...before, commands: before.commands + 1, audits: before.audits + 1, cancellations: before.cancellations + 1 });
}

test('personal cancellation before availability preserves the schedule and prevents both selected notices', options, async () => {
  const f = await fixture(true); await grant(f, f.techA); await grant(f, f.techB);
  const s = await scheduleForRead(f, [f.techA, f.techB]), command = cancellationInput(s.raw.commandId);
  const before = await counts(), old = await readRecordReminderReceipt(db, admin.session, leadProof(admin), s.raw.commandId);
  const result = await cancel(command); assert(result.canceled); assert.equal(result.replayed, false);
  assertOneCanceled(before, await counts()); await s.wait();
  for (const row of s.deliveries) {
    const person = row.recipientId === f.techA.user.id ? f.techA : f.techB;
    assert.equal(await notice(person, row.id), null); assert.equal(await notice(person, row.id, true), null);
  }
  assert.deepEqual(await readRecordReminderReceipt(db, admin.session, leadProof(admin), s.raw.commandId), old);
  assert.equal(await db.recordUpdateDelivery.count({ where: { commandId: s.raw.commandId, readAt: { not: null } } }), 0);
});

test('cancellation after an explicit read hides the notice but preserves its actual read receipt', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f); await s.wait();
  const id = s.deliveries[0].id, first = await notice(f.techA, id, true); assert(first?.readAt);
  const before = await counts(); await cancel(cancellationInput(s.raw.commandId)); assertOneCanceled(before, await counts());
  assert.equal(await notice(f.techA, id), null);
  assert.equal((await db.recordUpdateDelivery.findUniqueOrThrow({ where: { id } })).readAt?.toISOString(), first.readAt.toISOString());
});

test('a recipient, another Admin, an invalid personal proof or an unconfirmed request cannot cancel', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), command = cancellationInput(s.raw.commandId);
  const other = await syntheticPerson(db, 'Unrelated cancellation Admin', 'admin'), before = await counts();
  for (const actor of [f.techA, f.salesA, other]) await assert.rejects(cancel(command, db, actor));
  await assert.rejects(cancelRecordReminder(db, admin.session, { ...leadProof(admin), stepUpToken: 'invalid' }, command, true));
  await assert.rejects(cancelRecordReminder(db, admin.session, leadProof(admin), command, false));
  assert.deepEqual(await cancellationReceipt(command, other), { ...command, canceled: false });
  assert.deepEqual(await counts(), before);
});

test('repeated cancellation retains one receipt and an existing command cannot target a different reminder', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const a = await scheduleForRead(f), b = await scheduleForRead(f), command = cancellationInput(a.raw.commandId);
  const first = await cancel(command), before = await counts(), second = await cancel(command);
  assert.equal(second.replayed, true); assert.equal(second.canceledAt, first.canceledAt);
  await assert.rejects(cancel({ ...command, reminderCommandId: b.raw.commandId }), /STALE/);
  assert.deepEqual(await counts(), before);
});

test('two concurrent cancellation commands commit exactly one terminal decision without duplicate audit', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), commands = [cancellationInput(s.raw.commandId), cancellationInput(s.raw.commandId)];
  const before = await counts(), outcomes = await Promise.allSettled(commands.map(command => cancel(command)));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assertOneCanceled(before, await counts());
  const receipts = await Promise.all(commands.map(command => cancellationReceipt(command)));
  assert.equal(receipts.filter(row => row.canceled).length, 1);
});

test('a lost cancellation response is reconciled by its own read-only receipt without repeating a mutation', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), command = cancellationInput(s.raw.commandId);
  await assert.rejects((async () => { await cancel(command); throw new Error('SYNTHETIC_CANCEL_RESPONSE_LOST'); })(), /RESPONSE_LOST/);
  const before = await counts(), receipt = await cancellationReceipt(command);
  assert.equal(receipt.canceled, true); assert('canceledAt' in receipt);
  assert.deepEqual(await cancellationReceipt(command), receipt); assert.deepEqual(await counts(), before);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_TITLE|PRIVATE_DESCRIPTION|SCENARIO_PRIVATO|CONTRATTO_PRIVATO/);
});

test('the current personal author can cancel after the source is trashed without reading or restoring it', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f), command = cancellationInput(s.raw.commandId);
  await db.project.update({ where: { id: f.project.id }, data: { deletedAt: new Date() } });
  const before = await counts(); assert.equal((await cancel(command)).canceled, true);
  assertOneCanceled(before, await counts());
  assert((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).deletedAt);
  assert.equal(await notice(f.techA, s.deliveries[0].id), null);
});

function faultyCancellationDb(fault: 'omit-cancellation' | 'audit') {
  return new Proxy(db, { get(target, property) {
    if (property !== '$transaction') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
    return (action: (tx: Prisma.TransactionClient) => Promise<unknown>, config: object) => db.$transaction(client => action(new Proxy(client, {
      get(tx, member) {
        if (member === '$executeRaw' && fault === 'omit-cancellation') return (query: TemplateStringsArray, ...values: unknown[]) =>
          query.join('').includes('INSERT INTO "RecordUpdateReminderCancellation"') ? Promise.resolve(0) : tx.$executeRaw(query, ...values);
        if (member === 'auditLog' && fault === 'audit') return { ...tx.auditLog,
          create: (args: Prisma.AuditLogCreateArgs) => tx.auditLog.create({ ...args, data: { ...args.data, event: 'wrong_synthetic_cancel_event' } }) };
        const value = Reflect.get(tx, member); return typeof value === 'function' ? value.bind(tx) : value;
      }
    })), config);
  } });
}

for (const fault of ['omit-cancellation', 'audit'] as const) {
  test(`a cancellation ${fault} fault rolls back its command and audit and leaves the original schedule intact`, options, async () => {
    const f = await fixture(); await grant(f, f.techA);
    const s = await scheduleForRead(f), command = cancellationInput(s.raw.commandId), before = await counts();
    await assert.rejects(cancel(command, faultyCancellationDb(fault)),
      fault === 'audit' ? /RECORD_REMINDER_CANCEL_ATOMIC_EVIDENCE_REQUIRED/ : /RECORD_REMINDER_CANCEL_JOURNAL_REQUIRED/);
    assert.deepEqual(await counts(), before); assert.equal((await cancellationReceipt(command)).canceled, false);
    assert.equal((await readRecordReminderReceipt(db, admin.session, leadProof(admin), s.raw.commandId)).confirmed, true);
  });
}

test('cancellation and its audit cannot be rewritten or removed, and an old open form cannot mark read afterward', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const s = await scheduleForRead(f); await s.wait(); const command = cancellationInput(s.raw.commandId);
  assert(await notice(f.techA, s.deliveries[0].id)); await cancel(command); const before = await counts();
  await assert.rejects(db.$executeRaw`UPDATE "RecordUpdateReminderCancellation" SET proof=${'f'.repeat(64)} WHERE "commandId"=${command.commandId}::uuid`, /IMMUTABLE/);
  await assert.rejects(db.$executeRaw`DELETE FROM "RecordUpdateReminderCancellation" WHERE "commandId"=${command.commandId}::uuid`, /IMMUTABLE/);
  await assert.rejects(db.auditLog.updateMany({ where: { entityId: command.commandId }, data: { event: 'rewritten' } }), /IMMUTABLE/);
  await assert.rejects(db.recordUpdateDelivery.updateMany({ where: { commandId: s.raw.commandId }, data: { readAt: new Date() } }), /CANCELED/);
  assert.equal(await notice(f.techA, s.deliveries[0].id, true), null);
  assert.deepEqual(await counts(), before);
});
