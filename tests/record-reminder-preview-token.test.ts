import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRecordReminder } from '../src/lib/record-reminder-contract';
import { signRecordReminderPreview, assertRecordReminderSignedPreview } from '../src/lib/record-reminder-preview-token';

const key = { version: 1, secret: 'synthetic-reminder-key-never-production-'.repeat(2) };
const now = new Date('2030-10-27T09:00:00.000Z');
function fixture() {
  return prepareRecordReminder({ commandId: '00000000-0000-4000-8000-000000000001', kind: 'CLIENT',
    recordId: 'synthetic-client-a', taskId: 'synthetic-task-a', remindAt: '2030-10-28T09:00:00.000Z',
    selection: { people: ['synthetic-sales-a'], groups: [] }, mode: 'CRM' }, {
    now: now.toISOString(), policyExpiresAt: null,
    actor: { id: 'synthetic-admin', sessionId: 'synthetic-session', role: 'admin', epoch: 1,
      active: true, sessionLive: true, canWriteRecord: true, canReadTaskDeadline: true, accessBinding: 'a'.repeat(64) },
    source: { kind: 'CLIENT', recordId: 'synthetic-client-a', taskId: 'synthetic-task-a', generation: 3, scopeGeneration: 2,
      dueAt: '2030-11-26T17:00:00.000Z', scopeDigest: 'b'.repeat(64), status: 'aperta', taskDeleted: false, recordDeleted: false },
    directory: [{ id: 'synthetic-sales-a', name: 'Synthetic sales', email: 'synthetic@example.invalid', role: 'commerciale',
      revision: '1', active: true, deleted: false }],
    recipients: [{ id: 'synthetic-sales-a', epoch: 1, canReadRecord: true, canReadTaskDeadline: true,
      accessBinding: 'c'.repeat(64), accessUntil: null }],
  });
}
test('a personally checked preview expires within five minutes and the session lifetime', () => {
  const prepared = fixture(), token = signRecordReminderPreview(key, prepared, now, Infinity);
  assert.equal(token.preview.expiresAt, '2030-10-27T09:05:00.000Z');
  assertRecordReminderSignedPreview(key, token, prepared, now);
  assert.equal(signRecordReminderPreview(key, prepared, now, now.getTime() + 1000).preview.expiresAt, '2030-10-27T09:00:01.000Z');
});
test('an expired, future-dated or altered token is rejected without a mutation', () => {
  const prepared = fixture(), token = signRecordReminderPreview(key, prepared, now, Infinity);
  assert.throws(() => assertRecordReminderSignedPreview(key, token, prepared, new Date(token.preview.expiresAt)), /STALE/);
  assert.throws(() => assertRecordReminderSignedPreview(key, token, prepared, new Date(now.getTime() - 1)), /STALE/);
  for (const change of [{ digest: 'd'.repeat(64) }, { actorId: 'another-admin' }, { sessionId: 'another-session' },
    { keyVersion: 2 }, { expiresAt: '2030-10-27T10:00:00.000Z' }]) {
    assert.throws(() => assertRecordReminderSignedPreview(key, { ...token, preview: { ...token.preview, ...change } }, prepared, now), /STALE/);
  }
});
test('same-digest input in another session or command cannot replay a preview', () => {
  const prepared = fixture(), token = signRecordReminderPreview(key, prepared, now, Infinity);
  for (const change of [{ sessionId: 'another-session' }, { authorId: 'another-admin' },
    { input: { ...prepared.input, commandId: '00000000-0000-4000-8000-000000000002' } }]) {
    assert.throws(() => assertRecordReminderSignedPreview(key, token, { ...prepared, ...change }, now), /STALE/);
  }
});
test('keys and other-purpose signatures cannot substitute for the dedicated preview proof', () => {
  const prepared = fixture(), token = signRecordReminderPreview(key, prepared, now, Infinity);
  assert.throws(() => assertRecordReminderSignedPreview({ ...key, secret: 'another-synthetic-key-'.repeat(3) }, token, prepared, now), /STALE/);
  for (const proof of ['', 'f'.repeat(64), '0'.repeat(63), 'z'.repeat(64)]) {
    assert.throws(() => assertRecordReminderSignedPreview(key, { ...token, proof }, prepared, now), /STALE/);
  }
});
test('a finished access window cannot produce a signed preview', () => {
  assert.throws(() => signRecordReminderPreview(key, fixture(), now, now.getTime()), /DENIED/);
  assert.throws(() => signRecordReminderPreview(key, fixture(), new Date('invalid'), Infinity), /DENIED/);
});

test('a retained digest cannot sign or confirm changed recipients or a different deadline', () => {
  const prepared = fixture(), token = signRecordReminderPreview(key, prepared, now, Infinity);
  for (const altered of [{ ...prepared, recipients: [] }, { ...prepared, source: { ...prepared.source, dueAt: '2030-11-27T17:00:00.000Z' } }]) {
    assert.throws(() => signRecordReminderPreview(key, altered, now, Infinity), /STALE/);
    assert.throws(() => assertRecordReminderSignedPreview(key, token, altered, now), /STALE/);
  }
});
