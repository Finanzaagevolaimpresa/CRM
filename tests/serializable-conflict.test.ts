import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { mapSerializableConflict, SerializableConflictError } from '../src/lib/serializable';

test('concurrent row-lock failures use the same public conflict as Prisma transactions', () => {
  for (const [code, sqlState] of [['P2034', undefined], ['P2010', '40001'], ['P2010', '40P01']]) {
    const original = new Prisma.PrismaClientKnownRequestError('database detail', { code: code!, clientVersion: 'synthetic', meta: { code: sqlState } });
    const mapped = mapSerializableConflict(original);
    assert.ok(mapped instanceof SerializableConflictError);
    assert.equal(mapped.message, 'Operazione concorrente rilevata: riprovare.');
    assert.equal(mapped.cause, original);
  }
});

test('constraint, permission and generic database errors are not mislabeled as retryable conflicts', () => {
  const failures = [new Error('ordinary error'), ...['23505', '42501', undefined].map(code =>
    new Prisma.PrismaClientKnownRequestError('database detail', { code: 'P2010', clientVersion: 'synthetic', meta: { code } }))];
  for (const error of failures) assert.equal(mapSerializableConflict(error), error);
});
