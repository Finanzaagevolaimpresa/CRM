import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoDecision, verifyVideoDecision } from '../src/lib/video-decision';
import type { VideoCommand } from '../src/lib/video-input';

const key = { version: 1, secret: 'synthetic-video-decision-secret-at-least-thirty-two-characters' };
const identity = { actorId: 'synthetic-admin', actorEpoch: 4, sessionId: 'f7ff823a-f06a-48fb-89dd-c3d9ba15f915' };
const command: VideoCommand = { commandId: 'b8736420-9259-4778-80ca-aa9425c83c98',
  videoId: '4f8d7ef9-ab98-4528-86ab-b9ad4822bca6', expectedVersion: 2, operation: 'ARCHIVE' };
const start = new Date('2026-10-30T10:00:00Z');
const token = createVideoDecision(key, identity, command, 'a'.repeat(64), start);

test('video decision expires at five minutes independently of a longer Admin confirmation', () => {
  assert.equal(verifyVideoDecision(key, identity, command, token, new Date(start.getTime() + 299_000)).decisionHash, 'a'.repeat(64));
  assert.throws(() => verifyVideoDecision(key, identity, command, token, new Date(start.getTime() + 300_000)));
  assert.throws(() => verifyVideoDecision(key, identity, command, token, new Date(start.getTime() + 1_799_000)));
  assert.equal(verifyVideoDecision(key, identity, command, token, new Date(start.getTime() + 1_799_000), { closing: true }).requestHash.length, 64);
});
test('a decision cannot move to another actor, session, epoch, key or command', () => {
  for (const changed of [{ ...identity, actorId: 'other' }, { ...identity, actorEpoch: 5 },
    { ...identity, sessionId: 'fcd66d50-22e4-47d2-a660-c9eb935c88e1' }]) {
    assert.throws(() => verifyVideoDecision(key, changed, command, token, start, { closing: true }));
  }
  assert.throws(() => verifyVideoDecision({ ...key, version: 2 }, identity, command, token, start));
  assert.throws(() => verifyVideoDecision({ ...key, secret: 'different-synthetic-key' }, identity, command, token, start));
  assert.throws(() => verifyVideoDecision(key, identity, { ...command, operation: 'RESTORE_DRAFT' }, token, start, { closing: true }));
  assert.throws(() => verifyVideoDecision(key, identity, command, token, new Date(start.getTime() - 1_000)));
  assert.throws(() => verifyVideoDecision(key, identity, command, token + 'tampered', start));
});
