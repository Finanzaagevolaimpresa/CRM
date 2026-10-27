import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHandoffInput, handoffProof, verifyHandoffProof } from '../src/lib/project-handoff-contract';
const key = { version: 1, secret: 'synthetic-project-handoff-key-00000000000000000' };
const input = { commandId: '477c4c70-cb30-4381-ab2e-82f360620b02', projectId: 'project-synthetic', expectedHash: 'a'.repeat(64),
  title: 'Preparazione', practiceType: 'Sintetica', targetEntity: 'Da definire', commercialOwnerId: null, technicalOwnerId: null };
test('handoff accepts only preparation fields, bounded strings and an explicit canonical project', () => {
  assert.deepEqual(projectHandoffInput.parse(input), input);
  for (const extra of [{ clientId: 'other' }, { status: 'presentata' }, { documents: ['doc'] }, { grants: ['user'] }, { submittedAt: new Date().toISOString() }])
    assert.equal(projectHandoffInput.safeParse({ ...input, ...extra }).success, false);
  assert.equal(projectHandoffInput.safeParse({ ...input, title: 'x'.repeat(241) }).success, false);
  assert.equal(projectHandoffInput.safeParse({ ...input, projectId: '../other' }).success, false);
});
test('preview proof binds exact content, expiry and key generation with a distinct domain', () => {
  const value = { digest: 'b'.repeat(64), expiresAt: '2026-10-27T11:00:00.000Z' }, proof = handoffProof(key, value);
  assert(verifyHandoffProof(key, value, proof));
  assert(!verifyHandoffProof(key, { ...value, digest: 'c'.repeat(64) }, proof));
  assert(!verifyHandoffProof(key, { ...value, expiresAt: '2027-01-01T11:00:00.000Z' }, proof));
  assert(!verifyHandoffProof({ ...key, version: 2 }, value, proof));
  assert(!verifyHandoffProof(key, value, 'broken'));
  assert.throws(() => handoffProof({ version: 1, secret: 'short' }, value));
});
