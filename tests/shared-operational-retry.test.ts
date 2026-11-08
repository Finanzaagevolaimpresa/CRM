import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { SerializableConflictError } from '../src/lib/serializable';
import { confirmedSharedWriteRetry } from '../src/lib/shared-operational-retry';
import { SharedOperationalUpdateError } from '../src/lib/shared-operational-update-contract';

const known = (code: string, state?: string) => new Prisma.PrismaClientKnownRequestError('SYNTHETIC_ABORT',
  { code, clientVersion: 'test', meta: state ? { code: state } : undefined });
test('shared writes retry only a confirmed rollback with the same closure, at most three admissions', async () => {
  for (const cause of [known('P2034'), known('P2010', '40001')]) for (const error of [cause, new SerializableConflictError({ cause })]) {
    let attempts = 0;
    const result = { commandId: 'same-immutable-command', eventId: 'same-event' };
    const write = async () => { attempts++; if (attempts < 3) throw error; return result; };
    assert.equal(await confirmedSharedWriteRetry(write), result); assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(confirmedSharedWriteRetry(async () => { attempts++; throw error; }), e => e === error);
    assert.equal(attempts, 3);
  }
});
test('shared writes never retry denial, stale input, unknown commit, transport failure or an explicit deadlock', async () => {
  for (const error of [new SharedOperationalUpdateError('DENIED'), new SharedOperationalUpdateError('STALE'),
    known('P2028'), known('P1001'), known('P2010', '08006'), known('P2010', '40P01'),
    new SerializableConflictError({ cause: known('P2028') }), new SerializableConflictError(),
    new Error('40001'), { code: 'P2034' }]) {
    let attempts = 0;
    await assert.rejects(confirmedSharedWriteRetry(async () => { attempts++; throw error; }), e => e === error);
    assert.equal(attempts, 1);
  }
});
