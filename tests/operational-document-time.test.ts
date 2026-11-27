import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { actualArchiveAction, DocumentActionRedirect } from './operational-documents/action-harness';
import { formatProformaArchiveTime, resolveProformaArchiveTime } from '../src/lib/operational-document-time';

const session = { userId: 'synthetic', role: 'admin', active: true } as AuthSession;
const proof = { key: { version: 1, secret: 'synthetic-only' }, sessionToken: 'synthetic-only', stepUpToken: 'synthetic-only' };
function form(local: string, choice = '', zone = 'Europe/Rome') {
  const data = new FormData(); data.set('occurredAt', local); data.set('occurredAtTimeZone', zone);
  if (choice) data.set('occurredAtInstant', choice); return data;
}
test('azione archivio interpreta inverno, estate e entrambe le occorrenze autunnali in Roma anche con server UTC', async () => {
  const previous = process.env.TZ, instants: string[] = [];
  try {
    process.env.TZ = 'UTC';
    const action = actualArchiveAction({} as PrismaClient, session, proof, async (_db, _session, raw) => {
      instants.push((raw as { occurredAt: string }).occurredAt); return { id: 'synthetic', replay: false };
    });
    for (const [local, choice, expected] of [
      ['2030-01-07T10:00', '', '2030-01-07T09:00:00.000Z'],
      ['2030-07-07T10:00', '', '2030-07-07T08:00:00.000Z'],
      ['2030-10-27T02:30', '2030-10-27T00:30:00.000Z', '2030-10-27T00:30:00.000Z'],
      ['2030-10-27T02:30', '2030-10-27T01:30:00.000Z', '2030-10-27T01:30:00.000Z'],
    ]) {
      await assert.rejects(action({ error: null }, form(local, choice)), DocumentActionRedirect);
      assert.equal(instants.at(-1), expected);
    }
    assert.equal(instants.length, 4);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('azione archivio rifiuta ora inesistente, ambigua senza scelta e valori o fusi manipolati prima della scrittura', async () => {
  let writes = 0;
  const action = actualArchiveAction({} as PrismaClient, session, proof, async () => { writes++; return { id: 'synthetic', replay: false }; });
  for (const data of [form('2030-03-31T02:30'), form('2030-10-27T02:30'), form('2030-10-27T02:30', '2030-10-27T02:30:00.000Z'),
    form('2030-01-07T10:00', '', 'UTC'), form('2030-01-07T10:00Z'), form('2030-02-30T10:00'), form('2030-07-07T10:00', '2030-07-07T09:00:00.000Z')]) {
    assert.match((await action({ error: null }, data)).error!, /Europe\/Rome/);
  }
  assert.equal(writes, 0);
});
test('istante e visualizzazione archivio sono indipendenti dal fuso host e distinguono l’ora ripetuta', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(resolveProformaArchiveTime('2030-01-07T10:00', 'Europe/Rome', null), '2030-01-07T09:00:00.000Z');
      assert.match(formatProformaArchiveTime('2030-10-27T00:30:00.000Z'), /02:30:00 GMT\+2 \(Europe\/Rome\)/);
      assert.match(formatProformaArchiveTime('2030-10-27T01:30:00.000Z'), /02:30:00 GMT\+1 \(Europe\/Rome\)/);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
