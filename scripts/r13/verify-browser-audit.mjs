import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Pass the browser-audit.json printed by the local harness.');
const audit = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(audit.protocol, 'R13_SYNTHETIC_REAL_BROWSER_HARNESS');
assert.equal(new URL(audit.origin).hostname, '127.0.0.1');
assert.equal(audit.databaseUsed, false);
assert.equal(audit.providerUsed, false);
assert.equal(audit.realRecipientsAllowed, false);
assert.equal(audit.clientAvailable, true);
const posts = audit.submissions;
assert.equal(posts.length, 9);
const byCase = name => posts.filter(row => row.case === name);
const [known] = byCase('native-known');
const [unknown] = byCase('native-unknown');
assert.equal(known.httpStatus, 200); assert.equal(known.eventsBefore, 1); assert.equal(known.eventsAfter, 2);
assert.equal(unknown.httpStatus, 200); assert.equal(unknown.eventsBefore, 0); assert.equal(unknown.eventsAfter, 1);
assert.equal(known.responseSha256, unknown.responseSha256);
const [failed] = byCase('native-failure');
assert.equal(failed.httpStatus, 503); assert.equal(failed.eventsBefore, failed.eventsAfter);
assert.equal(failed.confirmationReturned, false);
const replay = byCase('native-replay'); assert.equal(replay.length, 2);
assert.equal(replay[0].requestId, replay[1].requestId);
assert.deepEqual(replay[0].suppressionEvents, replay[1].suppressionEvents);
assert.equal(replay[1].eventsBefore, 2); assert.equal(replay[1].eventsAfter, 2);
const enhanced = byCase('enhanced-known'); assert.equal(enhanced.length, 2);
assert.notEqual(enhanced[0].requestId, enhanced[1].requestId);
assert.equal(enhanced[0].eventsAfter, 2); assert.equal(enhanced[1].eventsAfter, 3);
const retry = byCase('enhanced-retry'); assert.equal(retry.length, 2);
assert.equal(retry[0].requestId, retry[1].requestId);
assert.equal(retry[0].httpStatus, 503); assert.equal(retry[0].eventsAfter, 1);
assert.equal(retry[1].httpStatus, 200); assert.equal(retry[1].eventsAfter, 2);
for (const post of posts) {
  assert.equal(post.originChecked, true);
  assert.equal(post.responseContainsEmail, false);
  assert.equal(post.grantPreserved, true);
  assert.equal(post.format, post.case.startsWith('native-') ? 'application/x-www-form-urlencoded' : 'application/json');
  if (post.httpStatus === 200) {
    assert.equal(post.confirmationReturned, true);
    assert.ok(post.commitHookCompletedUtc && post.commitHookCompletedUtc <= post.completedUtc);
  }
}
console.log(JSON.stringify({ status: 'PASS', browserCases: 6, checkedPosts: posts.length,
  nativeHtml: 'PASS', interactiveJson: 'PASS', databaseQualification: false }));
