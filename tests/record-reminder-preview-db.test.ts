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
  return { tasks: await db.task.count(), origins: await db.technicalPrivateItemOrigin.count(),
    commands: await db.recordUpdateCommand.count(), events: await db.recordUpdateEvent.count(),
    deliveries: await db.recordUpdateDelivery.count(), audits: await db.auditLog.count(),
    grants: await db.technicalAssignment.count(), mail: await db.approvedCommunication.count() };
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
      assert(result.error instanceof Prisma.PrismaClientKnownRequestError && result.error.code === 'P2034',
        'only a serialization abort is an admissible concurrency outcome');
      return null;
    }
    return result.value;
  } finally {
    release(); await writerResult; await reading?.catch(() => undefined); await viewer.$disconnect();
  }
}

test('a deadline writer blocks preview; release yields current generation or a serialization abort', options, async () => {
  const f = await fixture(); await grant(f, f.techA);
  const raw = input(f, [f.techA]), old = await preview(raw), changed = new Date(future(2880));
  const result = await concurrentPreview(tx => tx.task.update({ where: { id: f.taskId }, data: { dueAt: changed } }), raw);
  if (result) {
    assert.equal(result.prepared.source.dueAt, changed.toISOString());
    assert(result.prepared.source.generation > old.prepared.source.generation);
    assert.notEqual(result.prepared.digest, old.prepared.digest);
  }
});

test('a permission writer blocks preview; no old recipient survives its committed revocation', options, async () => {
  const f = await fixture(); await grant(f, f.techA); await grant(f, f.techB);
  const result = await concurrentPreview(tx => tx.userPermissionOverride.create({
    data: { userId: f.techA.user.id, permission: 'service.write', allowed: false },
  }), input(f, [f.techA, f.techB]));
  if (result) assert.deepEqual(result.prepared.recipients.map(row => row.id), [f.techB.user.id]);
  const current = await preview(input(f, [f.techA, f.techB]));
  assert.deepEqual(current.prepared.recipients.map(row => row.id), [f.techB.user.id]);
});
