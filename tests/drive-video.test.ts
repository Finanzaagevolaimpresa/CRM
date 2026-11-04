import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseDriveVideoLink, driveVideoCommand, driveVideoAccount } from '../src/lib/drive-video-contract';
import { applicationSecurityHeaders, driveVideoSecurityHeaders } from '../src/lib/application-security-policy';
import { createVideoDecision, verifyVideoDecision } from '../src/lib/video-decision';

const id = 'synthetic_file_not_a_real_id_0001';
test('Drive file view/preview/open links become canonical references without a network request', () => {
  for (const raw of ['https://drive.google.com/file/d/' + id + '/view?usp=sharing',
    'https://drive.google.com/file/d/' + id + '/preview', 'https://drive.google.com/open?id=' + id]) {
    const parsed = parseDriveVideoLink(raw);
    assert.equal(parsed.viewUrl, 'https://drive.google.com/file/d/' + id + '/view');
    assert.equal(parsed.previewUrl, 'https://drive.google.com/file/d/' + id + '/preview');
  }
});
test('Drive resource key is retained exactly, unrelated query data never enters the embed', () => {
  const key = 'synthetic_resource_key_0001';
  assert.equal(parseDriveVideoLink('https://drive.google.com/open?id=' + id + '&resourcekey=' + key).previewUrl,
    'https://drive.google.com/file/d/' + id + '/preview?resourcekey=' + key);
});
test('folders, other providers, deceptive hosts, credentials and active URL schemes are rejected', () => {
  for (const raw of ['javascript:alert(1)', 'http://drive.google.com/file/d/' + id + '/view',
    'https://drive.google.com.evil.invalid/file/d/' + id + '/view', 'https://evil.invalid/?url=https://drive.google.com',
    'https://user:pass@drive.google.com/file/d/' + id + '/view', 'https://drive.google.com:444/file/d/' + id + '/view',
    'https://drive.google.com/drive/folders/' + id, 'https://docs.google.com/file/d/' + id + '/view',
    'https://drive.google.com/uc?export=download&id=' + id, 'https://drive.google.com/file/d/tiny/view',
    'https://drive.google.com/file/d/' + id + '/view#fragment', 'https://drive.google.com/open?id=' + id + '&id=other',
    'https://drive.google.com/file/d/' + id + '/view?redirect=https://evil.invalid',
    'https://drive.google.com/file/d/' + id + '/view?resourcekey=a&resourcekey=b']) assert.throws(() => parseDriveVideoLink(raw));
});
function command() {
  return driveVideoCommand.parse({ protocol: 'DRIVE_VIDEO_REFERENCE_V1', operation: 'SAVE_DRAFT', commandId: randomUUID(),
    videoId: randomUUID(), expectedVersion: 0, details: { url: 'https://drive.google.com/file/d/' + id + '/view',
      title: 'Synthetic neutral clip', description: '', category: '', position: 0, selection: { people: [], areas: [] },
      expiresAt: null, downloadAllowed: false, sourceAccount: driveVideoAccount, accountConfirmed: true } });
}
test('Drive cannot impersonate a local asset, enable downloads or use a different source account', () => {
  const input = command(); assert.ok('details' in input);
  for (const extra of [{ downloadAllowed: true }, { sourceAccount: 'another@invalid.test' }, { accountConfirmed: false }, { fileId: randomUUID() }]) {
    assert.throws(() => driveVideoCommand.parse({ ...input, details: { ...input.details, ...extra } }));
  }
});
test('exact preview binds source, audience, lifecycle and five-minute decision even within an Admin session', () => {
  const key = { version: 1, secret: 'synthetic-video-decision-key-0000000000000000000000000000000' };
  const identity = { actorId: 'synthetic-admin', actorEpoch: 1, sessionId: randomUUID() };
  const input = command(), now = new Date('2026-11-04T10:00:00Z'), digest = 'a'.repeat(64);
  const token = createVideoDecision(key, identity, input, digest, now);
  assert.equal(verifyVideoDecision(key, identity, input, token, new Date(now.getTime() + 299000)).decisionHash, digest);
  assert.throws(() => verifyVideoDecision(key, identity, input, token, new Date(now.getTime() + 300000)));
  assert.ok('details' in input);
  for (const change of [{ title: 'changed' }, { url: input.details.url.replace(id, id + 'b') },
    { selection: { people: ['new-person'], areas: [] } }]) {
    assert.throws(() => verifyVideoDecision(key, identity, { ...input, details: { ...input.details, ...change } }, token, now));
  }
  assert.throws(() => verifyVideoDecision(key, { ...identity, sessionId: randomUUID() }, input, token, now));
  assert.throws(() => verifyVideoDecision({ ...key, version: 2 }, identity, input, token, now));
});
test('Google embedding is scoped to Drive pages and preserves all other security directives', () => {
  for (const mode of ['enforced', 'report-only'] as const) {
    const base = applicationSecurityHeaders(mode), drive = driveVideoSecurityHeaders(mode);
    assert.equal(drive.length, base.length);
    for (let i = 0; i < base.length; i++) {
      assert.equal(drive[i].key, base[i].key);
      assert.equal(drive[i].value, base[i].key.startsWith('Content-Security-Policy')
        ? base[i].value + '; frame-src https://drive.google.com' : base[i].value);
    }
  }
});
