import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { assertCommercialOfferTermsPreserved } from '../src/lib/commercial-offer-history';
test('native issued offer edits preserve material terms while admitting follow-up and a declared outcome', () => {
  const before = { status: 'inviata', title: 'Offerta sintetica', taxableAmount: new Prisma.Decimal('100'), vatAmount: new Prisma.Decimal('22'), totalAmount: new Prisma.Decimal('122'), validUntil: new Date('2030-01-01T00:00:00.000Z') };
  assert.doesNotThrow(() => assertCommercialOfferTermsPreserved(before, { ...before, taxableAmount: 100, status: 'accettata', followUpNote: 'Nota sintetica' }, false));
  for (const patch of [{ title: 'Testo sovrascritto' }, { taxableAmount: 101 }, { clientId: 'other' }, { status: 'bozza' }])
    assert.throws(() => assertCommercialOfferTermsPreserved(before, { ...before, ...patch }, false), /storiche/);
  assert.doesNotThrow(() => assertCommercialOfferTermsPreserved({ ...before, status: 'bozza' }, { ...before, title: 'Bozza correggibile' }, false));
  assert.throws(() => assertCommercialOfferTermsPreserved({ ...before, status: 'bozza' }, { ...before, title: 'Revisione immutabile' }, true), /storiche/);
});
