import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { readAdminRequestEntry, readAdminRequest, readAdminRequestQueue, readAdminRequestDraftPrefill,
  readAdminRequestOutcome } from '../src/lib/admin-request-service';
import { AdminRequestError } from '../src/lib/admin-request-admission';
import { SerializableConflictError } from '../src/lib/serializable';

const user = {} as AuthSession, id = '10000000-0000-4000-8000-000000000001';
const known = (code: string, state?: string) => new Prisma.PrismaClientKnownRequestError('SYNTHETIC_REQUEST_READ',
  { code, clientVersion: 'test', meta: state ? { code: state } : undefined });
const reads = {
  entry: (db: PrismaClient) => readAdminRequestEntry(db, user, {}),
  detail: (db: PrismaClient) => readAdminRequest(db, user, id),
  queue: (db: PrismaClient) => readAdminRequestQueue(db, user),
  prefill: (db: PrismaClient) => readAdminRequestDraftPrefill(db, user, id),
  outcome: (db: PrismaClient) => readAdminRequestOutcome(db, user, id),
};
for (const [name, read] of Object.entries(reads)) {
  test(name + ': confirmed aborted reads restart at most three times', async () => {
    for (const error of [known('P2034'), known('P2010', '40001'), known('P2010', '40P01')]) {
      let attempts = 0;
      const db = { $transaction: async () => { attempts++; if (attempts < 3) throw error; return 'fresh'; } } as unknown as PrismaClient;
      assert.equal(await read(db), 'fresh'); assert.equal(attempts, 3);
      attempts = 0;
      const blocked = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
      await assert.rejects(read(blocked), SerializableConflictError); assert.equal(attempts, 3);
    }
  });
  test(name + ': denials and uncertain outcomes are never retried', async () => {
    for (const error of [new AdminRequestError('DENIED'), new AdminRequestError('STALE'), known('P1001'),
      known('P2028'), known('P2010', '08006'), new Error('40P01'), { code: 'P2034' }]) {
      let attempts = 0;
      const db = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
      await assert.rejects(read(db), caught => caught === error); assert.equal(attempts, 1);
    }
  });
}
