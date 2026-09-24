import assert from 'node:assert/strict';
import test from 'node:test';
import { commercialOriginInput, commercialOriginSnapshot, sameCommercialOrigin } from '../src/lib/commercial-origin-contract';

const input = { clientId: 'client', expectedEntryId: '', acquiredById: 'sales-original', contractedById: '', sourceReference: 'Registro contratto 1', reason: 'Identità riscontrata nel registro storico' };
test('origin has explicit unknown identities, bounded evidence and a required correction reason', () => {
  assert.equal(commercialOriginInput.parse(input).contractedById, null);
  for (const invalid of [{ ...input, reason: '' }, { ...input, sourceReference: 'a' }, { ...input, acquiredById: 'a'.repeat(129) }, { ...input, salesOwnerId: 'injected' }]) {
    assert.equal(commercialOriginInput.safeParse(invalid).success, false);
  }
});
test('origin snapshot is versioned and cannot imply assignment or acceptance', () => {
  const parsed = commercialOriginInput.parse(input);
  const snapshot = commercialOriginSnapshot.parse({ protocol: 'R05_COMMERCIAL_ORIGIN_V1', clientId: parsed.clientId, revision: 1, predecessorId: null,
    acquiredById: parsed.acquiredById, contractedById: parsed.contractedById, sourceReference: parsed.sourceReference, reason: parsed.reason });
  assert.equal(sameCommercialOrigin(snapshot, parsed), true);
  assert.equal(sameCommercialOrigin(snapshot, { ...parsed, acquiredById: 'other' }), false);
  assert.equal(commercialOriginSnapshot.safeParse({ ...snapshot, revision: 0 }).success, false);
  assert.equal(commercialOriginSnapshot.safeParse({ ...snapshot, accepted: true }).success, false);
});
