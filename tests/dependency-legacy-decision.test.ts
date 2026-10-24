import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { ApprovedMessageSnapshot } from '../src/lib/approved-communication-contract';
import type { OrdinaryChannel } from '../src/lib/ordinary-email-candidate';
import { checkPersistedOrdinaryDecision, type OrdinaryDecisionCurrentState } from '../src/lib/ordinary-email-decision';
import { decodeStoredOrdinaryAttachment } from '../src/lib/ordinary-email-inbound-mime';

// Produced with the unchanged PR216 tree, Zod 3.25.76 and postal-mime 4.0.7.
// Only synthetic messages, IDs, key and attachment bytes; no sockets or database.
const legacy = JSON.parse(readFileSync('tests/fixtures/ordinary-email-decision-pre-zod4.json', 'utf8'));
const material = { snapshot: legacy.snapshot as ApprovedMessageSnapshot, channel: legacy.channel as OrdinaryChannel,
  materials: new Map<string, Buffer>([['version-one', Buffer.from(legacy.bytes, 'base64')]]) };
const current: OrdinaryDecisionCurrentState = { ...legacy.current, actor: { ...legacy.current.actor,
  expiresAt: new Date(legacy.current.actor.expiresAt), registryExpiresAt: new Date(legacy.current.actor.registryExpiresAt) } };
const now = new Date('2026-10-16T12:00:00Z');

test('synthetic inbound MIME persisted before the parser update rebuilds the same private attachment', async () => {
  const stored = JSON.parse(readFileSync('tests/fixtures/ordinary-email-inbound-pre-postal408.json', 'utf8'));
  const expected = stored.mime.attachments[0];
  const decoded = await decodeStoredOrdinaryAttachment(stored, 0, expected.sha256);
  assert.deepEqual(decoded.manifest, expected);
  assert.deepEqual(decoded.bytes, Buffer.from('SYNTHETIC_PRIVATE_ATTACHMENT'));
  await assert.rejects(decodeStoredOrdinaryAttachment({ ...stored, body: 'Changed projection' }, 0, expected.sha256));
});

test('a synthetic decision signed before the validator update retains its exact MIME and signature meaning', () => {
  const result = checkPersistedOrdinaryDecision(legacy.decision, legacy.proof, material, current, legacy.key, now);
  assert.deepEqual(result.decision, legacy.decision);
  assert.equal(result.prepared.mimeHash, legacy.expectedMimeHash);
});

test('an old signed decision still cannot authorize changed recipients, expanded fields or stale authority', () => {
  assert.throws(() => checkPersistedOrdinaryDecision(legacy.decision, legacy.proof,
    { ...material, snapshot: { ...material.snapshot, to: ['different@invalid.test'] } }, current, legacy.key, now));
  assert.throws(() => checkPersistedOrdinaryDecision({ ...legacy.decision, authorizeAnyRecipient: true },
    legacy.proof, material, current, legacy.key, now));
  assert.throws(() => checkPersistedOrdinaryDecision(legacy.decision, legacy.proof, material,
    { ...current, authority: { ...current.authority, revision: current.authority.revision + 1 } }, legacy.key, now));
  assert.throws(() => checkPersistedOrdinaryDecision(legacy.decision, legacy.proof, material, current, legacy.key,
    new Date(legacy.decision.validUntil)));
});
