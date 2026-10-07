import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient, type TechnicalPracticeStatus } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import { assertTechnicalPracticeOperational } from '../../src/lib/client-operational-hold';
import { technicalPracticeStatusSchema } from '../../src/lib/validation';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
const clients: string[] = [], practiceIds: string[] = [];
const stopStates = ['da_progettare', 'respinta', 'archiviata'];
let admitted = false;
before(async () => { if (enabled) { await assertAiOrchestratorEphemeralDatabaseIdentity(db); admitted = true; } });
after(async () => {
  if (admitted) {
    await db.auditLog.deleteMany({ where: { entityId: { in: practiceIds } } });
    await db.technicalPractice.deleteMany({ where: { clientId: { in: clients } } });
    await db.client.deleteMany({ where: { id: { in: clients } } });
  }
  await db.$disconnect();
});
async function fixture(status: 'attivo' | 'sospeso' = 'sospeso') {
  const client = await db.client.create({ data: { displayName: `Synthetic hold ${randomUUID()}`, type: 'societa', status } });
  clients.push(client.id);
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, title: 'Synthetic held practice', practiceType: 'synthetic', targetEntity: 'synthetic', createdById: 'synthetic-hold-operator' } });
  practiceIds.push(practice.id);
  return { client, practice };
}
async function footprint(clientId: string) {
  const practices = await db.technicalPractice.findMany({ where: { clientId }, orderBy: { id: 'asc' } });
  const audits = await db.auditLog.findMany({ where: { entityId: { in: practiceIds } }, orderBy: { id: 'asc' } });
  return { practices, audits };
}
async function change(clientId: string, id: string, status: TechnicalPracticeStatus) {
  return db.$transaction(async tx => {
    await assertTechnicalPracticeOperational(tx, [clientId], status);
    await tx.technicalPractice.update({ where: { id }, data: { status } });
    await tx.auditLog.create({ data: { entityType: 'TechnicalPractice', entityId: id, event: 'synthetic_hold_transition' } });
  });
}

test('P2-01 every operational technical status denies creation and update without row or audit changes', { skip: !enabled }, async () => {
  const { client, practice } = await fixture(), beforeState = await footprint(client.id);
  for (const status of technicalPracticeStatusSchema.options.filter(value => !stopStates.includes(value))) {
    await assert.rejects(change(client.id, practice.id, status), /Operatività sospesa/);
    await assert.rejects(db.$transaction(async tx => {
      await assertTechnicalPracticeOperational(tx, [client.id], status);
      const created = await tx.technicalPractice.create({ data: { clientId: client.id, title: 'Must not exist', practiceType: 'synthetic', targetEntity: 'synthetic', status, createdById: 'synthetic-hold-operator' } });
      await tx.auditLog.create({ data: { entityId: created.id, entityType: 'TechnicalPractice', event: 'synthetic_hold_create' } });
    }), /Operatività sospesa/);
    assert.deepEqual(await footprint(client.id), beforeState);
  }
  const destination = await fixture('attivo');
  await assert.rejects(db.$transaction(tx => assertTechnicalPracticeOperational(tx, [client.id, destination.client.id], 'presentata')), /Operatività sospesa/);
  await assert.rejects(db.$transaction(tx => assertTechnicalPracticeOperational(tx, [destination.client.id, client.id], 'presentata')), /Operatività sospesa/);
});

test('P2-01 preparation and stopping remain allowed during suspension, active clients retain operations', { skip: !enabled }, async () => {
  const { client, practice } = await fixture();
  for (const status of ['respinta', 'archiviata', 'da_progettare'] as const) {
    await change(client.id, practice.id, status);
    assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: practice.id } })).status, status);
  }
  assert.equal(await db.auditLog.count({ where: { entityId: practice.id } }), 3);
  await db.client.update({ where: { id: client.id }, data: { status: 'attivo' } });
  await change(client.id, practice.id, 'in_progettazione');
  assert.equal((await db.technicalPractice.findUniqueOrThrow({ where: { id: practice.id } })).status, 'in_progettazione');
});

test('P2-01 a concurrent suspension commits before admission and denies the waiting transition', { skip: !enabled }, async () => {
  const { client, practice } = await fixture('attivo'), beforeState = await footprint(client.id);
  let release!: () => void, writerReady!: () => void, readerReady!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { writerReady = resolve; });
  const reading = new Promise<void>(resolve => { readerReady = resolve; });
  let writerPid = 0, readerPid = 0;
  const writer = db.$transaction(async tx => {
    [{ pid: writerPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await tx.client.update({ where: { id: client.id }, data: { status: 'sospeso' } });
    writerReady(); await latch;
  }, { timeout: 15000 });
  await ready;
  const reader = db.$transaction(async tx => {
    [{ pid: readerPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    readerReady();
    await assertTechnicalPracticeOperational(tx, [client.id], 'presentata');
    await tx.technicalPractice.update({ where: { id: practice.id }, data: { status: 'presentata' } });
    await tx.auditLog.create({ data: { entityId: practice.id, entityType: 'TechnicalPractice', event: 'synthetic_hold_transition' } });
  }, { timeout: 15000 });
  const rejected = assert.rejects(reader, /Operatività sospesa/);
  try {
    await reading;
    let observed = false;
    for (let attempt = 0; attempt < 100 && !observed; attempt++) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${writerPid}::int = ANY(pg_blocking_pids(${readerPid}::int)) AS blocked`;
      observed = row.blocked;
      if (!observed) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(observed, true, 'Admission must wait on the authoritative client lock');
  } finally { release(); await writer; await rejected; }
  assert.deepEqual(await footprint(client.id), beforeState);
});
