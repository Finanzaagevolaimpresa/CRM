import assert from 'node:assert/strict';
import test from 'node:test';
import { securityReturnPath } from '../src/lib/security-return-path';
test('identity confirmation returns only to the explicit native lead inbox', () => {
  assert.equal(securityReturnPath('lead-inbox'), '/leads/inbox');
  for (const value of [undefined, null, '', 'https://outside.invalid', '//outside.invalid', '/leads/inbox', '/admin', ['lead-inbox'], 'lead-inbox\r\nLocation:https://outside.invalid'])
    assert.equal(securityReturnPath(value), null);
});
