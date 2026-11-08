import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { listRecordUpdates, readRecordUpdate } from '../src/lib/record-update-delivery';
import { RecordUpdateError } from '../src/lib/record-update-contract';
import { SerializableConflictError } from '../src/lib/serializable';
import { readSharedOperationalPanel } from '../src/lib/shared-operational-updates';

const session = { userId: 'synthetic', role: 'admin', active: true,
  sessionId: '10000000-0000-4000-8000-000000000001' } as AuthSession;
const known = (code: string, state?: string) => new Prisma.PrismaClientKnownRequestError('SYNTHETIC',
  { code, clientVersion: 'test', meta: state ? { code: state } : undefined });
const reads = [
  (db: PrismaClient) => listRecordUpdates(db, session),
  (db: PrismaClient) => readRecordUpdate(db, session, 'synthetic', false),
  (db: PrismaClient) => readSharedOperationalPanel(db, session, { kind: 'PRACTICE', id: 'synthetic' }),
];
test('notification reads restart only a confirmed rollback, at most three times', async () => {
  for (const read of reads) for (const cause of [known('P2034'), known('P2010', '40001'), known('P2010', '40P01')])
    for (const error of [cause, new SerializableConflictError({ cause })]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; if (attempts < 3) throw error; return 'fresh'; } } as unknown as PrismaClient;
    assert.equal(await read(db), 'fresh'); assert.equal(attempts, 3);
    attempts = 0;
    const blocked = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
    await assert.rejects(read(blocked), caught => caught === error
      || (caught instanceof SerializableConflictError && caught.cause === error)); assert.equal(attempts, 3);
  }
});
test('notification reads never retry denials, disconnected or uncertain results', async () => {
  for (const read of reads) for (const error of [new RecordUpdateError('DENIED'), known('P1001'), known('P2028'),
    known('P2010', '08006'), known('P2010'), new Error('40P01'), { code: 'P2034' }, new SerializableConflictError(),
    new SerializableConflictError({ cause: known('P2028') })]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
    await assert.rejects(read(db), caught => caught === error); assert.equal(attempts, 1);
  }
});
test('marking a notification read is a write and is never automatically retried', async () => {
  const error = known('P2010', '40P01'); let attempts = 0;
  const db = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
  await assert.rejects(readRecordUpdate(db, session, 'synthetic', true), caught => caught === error);
  assert.equal(attempts, 1);
});
