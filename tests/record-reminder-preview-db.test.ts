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
    const preview = await previewPrivateTechnicalItem(db, admin.session, leadProof(admin), command);
    await confirmPrivateTechnicalItem(db, admin.session, leadProof(admin), command, preview.token, true);
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
  return { tasks: await db.task.count(), origins: await db.technicalPrivateItemOrigin.count(),
    commands: await db.recordUpdateCommand.count(), events: await db.recordUpdateEvent.count(),
    deliveries: await db.recordUpdateDelivery.count(), audits: await db.auditLog.count(),
    grants: await db.technicalAssignment.count(), mail: await db.approvedCommunication.count(), reminders: Number(scheduled.count) };
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
