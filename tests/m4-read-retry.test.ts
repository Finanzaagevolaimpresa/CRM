import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { readCommunicationAdministration } from '../src/lib/approved-communications';
import { ApprovedCommunicationError } from '../src/lib/approved-communication-contract';

const session = {} as AuthSession;
const known = (code: string, state?: string) => new Prisma.PrismaClientKnownRequestError('SYNTHETIC_M4',
  { code, clientVersion: 'test', meta: state ? { code: state } : undefined });

test('M4 reads retry only confirmed transaction aborts and stop after three total attempts', async () => {
  for (const error of [known('P2034'), known('P2010', '40001'), known('P2010', '40P01')]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; if (attempts < 3) throw error; return 'fresh-read'; } } as unknown as PrismaClient;
    assert.equal(await readCommunicationAdministration(db, session), 'fresh-read');
    assert.equal(attempts, 3);
    attempts = 0;
    const blocked = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
    await assert.rejects(readCommunicationAdministration(blocked, session), caught => caught === error);
    assert.equal(attempts, 3);
  }
});

test('M4 reads preserve denials and uncertain or unknown errors without retry', async () => {
  for (const error of [new ApprovedCommunicationError('DENIED'), new ApprovedCommunicationError('CONFLICT'),
    known('P1001'), known('P2028'), known('P2010', '08006'), known('P2010'), new Error('40P01'),
    { code: 'P2034' }]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
    await assert.rejects(readCommunicationAdministration(db, session), caught => caught === error);
    assert.equal(attempts, 1);
  }
});
