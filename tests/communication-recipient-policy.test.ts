import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCommunicationRecipientSelection, resolveCommunicationRecipients } from '../src/lib/communication-recipient-policy';

const first = { id: 'sales-a', name: 'Commerciale A', email: 'a@example.test', role: 'commerciale', active: true, deletedAt: null };
const second = { id: 'tech-b', name: 'Tecnico B', email: 'b@example.test', role: 'consulente', active: true, deletedAt: null };
const none = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };

test('selection resolves actual existing people and never manufactures a department address', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.groups = ['commerciali']; selection.cc.userIds = ['tech-b'];
  const resolved = resolveCommunicationRecipients(selection, [first, second], none);
  assert.deepEqual(resolved.recipients, { to: ['a@example.test'], cc: ['b@example.test'], bcc: [] });
  assert.equal(resolved.people.cc[0].name, 'Tecnico B');
});
test('group membership, role, email and activation changes invalidate the approval evidence', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.groups = ['commerciali'];
  const initial = resolveCommunicationRecipients(selection, [first, second], none);
  for (const changed of [{ ...second, role: 'commerciale' }, { ...first, id: 'sales-c', email: 'c@example.test' }]) {
    assert.notEqual(resolveCommunicationRecipients(selection, [first, changed], none).evidenceHash, initial.evidenceHash);
  }
  assert.notEqual(resolveCommunicationRecipients(selection, [{ ...first, email: 'new@example.test' }, second], none).evidenceHash, initial.evidenceHash);
  assert.throws(() => resolveCommunicationRecipients(selection, [{ ...first, active: false }, second], none));
});
test('named inactive/deleted/absent people cannot become recipients', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.userIds = [first.id];
  for (const directory of [[], [{ ...first, active: false }], [{ ...first, deletedAt: new Date() }]])
    assert.throws(() => resolveCommunicationRecipients(selection, directory, none));
});
test('internal communication has only explicitly admitted participants, without an external address escape', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.userIds = [first.id];
  assert.deepEqual(resolveCommunicationRecipients(selection, [first, second], none, [first.id]).recipients.to, [first.email]);
  assert.throws(() => resolveCommunicationRecipients(selection, [first, second], none, [second.id]));
  assert.throws(() => resolveCommunicationRecipients(selection, [first, second], { ...none, cc: ['external@example.test'] }, [first.id]));
  selection.to.groups = ['tecnico'];
  assert.throws(() => resolveCommunicationRecipients(selection, [first, second], none, [first.id]));
});
test('duplicate A/CC/BCC addresses and overlarge groups are rejected without truncation', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.groups = ['commerciali']; selection.bcc.userIds = [first.id];
  assert.throws(() => resolveCommunicationRecipients(selection, [first], none));
  selection.bcc.userIds = [];
  const large = Array.from({ length: 21 }, (_, index) => ({ ...first, id: `sales-${index}`, email: `${index}@example.test` }));
  assert.throws(() => resolveCommunicationRecipients(selection, large, none));
  assert.throws(() => resolveCommunicationRecipients(selection, [first], { ...none, to: ['A@example.test'] }));
});
test('explicit user plus matching group is one choice, and no unselected person is added', () => {
  const selection = emptyCommunicationRecipientSelection(); selection.to.userIds = [first.id]; selection.to.groups = ['commerciali'];
  assert.deepEqual(resolveCommunicationRecipients(selection, [first, second], none).recipients.to, [first.email]);
  assert.throws(() => resolveCommunicationRecipients({ ...selection, departmentMailbox: 'tech@example.test' }, [first], none));
});
