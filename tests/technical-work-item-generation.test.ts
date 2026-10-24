import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { TechnicalAssignmentError } from '../src/lib/technical-assignment-transaction';
import { decodeTechnicalWorkItemGeneration, lockTechnicalWorkItemGeneration } from '../src/lib/technical-work-item-generation';

const expected = { kind: 'Task' as const, itemId: 'synthetic-shared-id' };
test('a generation distinguishes task and checklist even when canonical IDs coincide', () => {
  const task = { ...expected, generation: 4 };
  const checklist = { kind: 'ChecklistItem', itemId: expected.itemId, generation: 9 };
  assert.deepEqual(decodeTechnicalWorkItemGeneration([task], expected), task);
  assert.equal(decodeTechnicalWorkItemGeneration([checklist], expected), null);
  assert.equal(decodeTechnicalWorkItemGeneration([task], { ...expected, itemId: 'another-task' }), null);
  assert.equal(decodeTechnicalWorkItemGeneration([task, task], expected), null);
});
test('missing, reset, non-integer, overflow and extra-value rows fail closed', () => {
  for (const rows of [null, [], [{ ...expected, generation: 0 }], [{ ...expected, generation: -1 }],
    [{ ...expected, generation: 1.1 }], [{ ...expected, generation: 2147483648 }],
    [{ ...expected, generation: '4' }], [{ ...expected, generation: 4, notes: 'private' }]]) {
    assert.equal(decodeTechnicalWorkItemGeneration(rows, expected), null);
  }
});
test('malformed identifiers and an unknown lock intent fail before any SQL', async () => {
  let calls = 0;
  const tx = { $queryRaw: async () => { calls++; throw new Error('unexpected query'); } } as unknown as Prisma.TransactionClient;
  await assert.rejects(lockTechnicalWorkItemGeneration(tx, { ...expected, itemId: "x' OR true" }, 'read'));
  await assert.rejects(lockTechnicalWorkItemGeneration(tx, expected, 'upsert' as 'read'));
  assert.equal(calls, 0);
});
test('a missing generation never repairs or creates state during a read', async () => {
  let reads = 0, writes = 0;
  const tx = { $queryRaw: async () => { reads++; return []; },
    $executeRaw: async () => { writes++; throw new Error('forbidden write'); } } as unknown as Prisma.TransactionClient;
  await assert.rejects(lockTechnicalWorkItemGeneration(tx, expected, 'read'),
    error => error instanceof TechnicalAssignmentError && error.code === 'UNAVAILABLE');
  assert.equal(reads, 1); assert.equal(writes, 0);
});
