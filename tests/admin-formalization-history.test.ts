import assert from 'node:assert/strict';
import test from 'node:test';
import type { PracticeFormalization } from '@prisma/client';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { currentPracticeFormalization } from '../src/lib/admin-practice-formalization-store';

const original: PracticeFormalization = { id: 'formalization-original', practiceId: 'practice', offerRevisionId: 'accepted-original',
  offerAcceptanceId: 'acceptance-original', contractId: 'contract-original', signedDocumentId: 'document-original', signedDocumentVersionId: 'version-original',
  formalizedAt: new Date('2026-10-30T10:00:00.000Z'), formalizedById: 'original-person', payloadHash: 'a'.repeat(64) };
const originalBinding = { currentFormalizationId: original.id, acceptedOfferRevisionId: original.offerRevisionId, contractId: original.contractId,
  signedDocumentId: original.signedDocumentId, signedDocumentVersionId: original.signedDocumentVersionId };
const corrected = { ...originalBinding, contractId: 'contract-corrected', signedDocumentId: 'document-corrected', signedDocumentVersionId: 'version-corrected' };
type Binding = typeof originalBinding;
function receipt(before: Binding, after: Binding, commandId = 'administrative-command') {
  const snapshot = (values: Binding) => ({ id: 'PracticeReadiness:practice', changes: [{ model: 'PracticeReadiness', id: 'practice', values: { ...values } }] });
  return { commandId, actorId: 'administrative-person', createdAt: new Date('2026-10-30T11:00:00.000Z'), before: snapshot(before), after: snapshot(after),
    beforeHash: canonicalSha256(snapshot(before)), afterHash: canonicalSha256(snapshot(after)) };
}
function read(rows: ReturnType<typeof receipt>[], current = corrected, source = original, accepted = true) {
  const tx = { adminRecordRevision: { findMany: async () => rows },
    practiceOfferAcceptance: { findUnique: async () => accepted ? { id: 'acceptance-current' } : null } };
  return currentPracticeFormalization(tx as never, { id: 'practice', ...current }, source);
}

test('uncorrected operational binding keeps the original signed source distinctly attributed', async () => {
  const result = await read([], originalBinding);
  assert.deepEqual(result?.originalFormalization, original);
  assert.equal(result?.contractId, original.contractId);
  assert.equal(result?.administrativeCorrection, null);
  assert.equal(Object.hasOwn(result!, 'payloadHash'), false);
});
test('corrected references do not relabel the original signature, acceptance author or formalization date', async () => {
  const copy = structuredClone(original), result = await read([receipt(originalBinding, corrected)]);
  assert.equal(result?.contractId, corrected.contractId);
  assert.equal(result?.administrativeCorrection?.actorId, 'administrative-person');
  assert.deepEqual(result?.originalFormalization, copy); assert.deepEqual(original, copy);
  assert.equal(Object.hasOwn(result!, 'formalizedById'), false);
  assert.equal(Object.hasOwn(result!, 'payloadHash'), false);
});
test('a later restoration is another correction and must continue the exact current chain', async () => {
  const result = await read([receipt(originalBinding, corrected), receipt(corrected, originalBinding, 'restore-command')], originalBinding);
  assert.equal(result?.contractId, original.contractId); assert.equal(result?.administrativeCorrection?.commandId, 'restore-command');
  await assert.rejects(read([receipt(originalBinding, corrected), receipt(originalBinding, originalBinding)], originalBinding), /CONTEXT/);
});
test('tampered receipts, disconnected predecessors and inconsistent current references fail closed', async () => {
  const changed = receipt(originalBinding, corrected); changed.after.changes[0].values.contractId = 'unrecorded-contract';
  await assert.rejects(read([changed]), /CONTEXT/);
  await assert.rejects(read([receipt({ ...originalBinding, signedDocumentVersionId: 'unrelated' }, corrected)]), /CONTEXT/);
  await assert.rejects(read([receipt(originalBinding, corrected)], originalBinding), /CONTEXT/);
});
test('an administrative row cannot invent a replacement original formalization', async () => {
  await assert.rejects(read([receipt(originalBinding, { ...corrected, currentFormalizationId: 'invented-original' })]), /CONTEXT/);
});
test('a later native formalization keeps earlier administrative history without applying it to a different anchor', async () => {
  const source = { ...original, id: 'native-new-formalization', contractId: 'native-new-contract' };
  const current = { ...originalBinding, currentFormalizationId: source.id, contractId: source.contractId };
  const result = await read([receipt(originalBinding, corrected)], current, source);
  assert.equal(result?.contractId, source.contractId); assert.equal(result?.administrativeCorrection, null);
  assert.deepEqual(result?.originalFormalization, source);
});
test('a correction cannot manufacture a missing acceptance', async () => {
  await assert.rejects(read([receipt(originalBinding, corrected)], corrected, original, false), /CONTEXT/);
});
