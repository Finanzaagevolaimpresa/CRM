import assert from 'node:assert/strict';
import test from 'node:test';
import { ordinaryEmailSenderNotice } from '../src/lib/ordinary-email-send-readiness';

const selected = { selectedMailboxId: 'synthetic-selected', selectedAddress: 'selected@example.test' };
const authority = { mailboxId: 'synthetic-qualified', mailboxAddress: 'qualified@example.test' };

test('only Admin receives selected or qualified sender diagnostics', () => {
  for (const channel of [authority, null]) {
    assert.equal(ordinaryEmailSenderNotice({ isAdmin: false, ...selected, authority: channel }), null);
  }
});

test('a different registered mailbox does not imply an active send channel', () => {
  assert.deepEqual(ordinaryEmailSenderNotice({ isAdmin: true, ...selected, authority }), {
    reason: 'DIFFERENT_QUALIFIED_SENDER', selectedAddress: selected.selectedAddress,
    availableAddress: authority.mailboxAddress,
  });
  assert.equal(ordinaryEmailSenderNotice({ isAdmin: true, ...selected,
    authority: { ...authority, mailboxId: selected.selectedMailboxId } })?.reason, 'DIFFERENT_QUALIFIED_SENDER');
});

test('matching mailbox identity and address need no mismatch notice, but provide no send authorization', () => {
  assert.equal(ordinaryEmailSenderNotice({ isAdmin: true, ...selected,
    authority: { mailboxId: selected.selectedMailboxId, mailboxAddress: selected.selectedAddress } }), null);
});

test('missing current authority makes no claim that any mailbox is ready', () => {
  assert.deepEqual(ordinaryEmailSenderNotice({ isAdmin: true, ...selected, authority: null }), {
    reason: 'NO_CURRENT_CHANNEL', selectedAddress: selected.selectedAddress, availableAddress: null,
  });
});
