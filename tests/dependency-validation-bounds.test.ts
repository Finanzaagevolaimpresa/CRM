import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { inboundBatchSchema } from '../src/lib/ordinary-email-inbound-contract';
import { technicalAssignmentSelection } from '../src/lib/technical-assignment-contract';

test('bounded validation rejects an oversized array before validating any element', () => {
  let visits = 0;
  const schema = z.array(z.string().superRefine(() => { visits++; })).max(25);
  assert.equal(schema.safeParse(Array(26).fill('synthetic')).success, false);
  assert.equal(visits, 0);
  assert.equal(schema.safeParse(Array(25).fill('synthetic')).success, true);
  assert.equal(visits, 25);
});

test('the inbound page bound rejects before reading untrusted messages', () => {
  let reads = 0;
  const item = { providerId: 'synthetic-uid', get message(): never {
    reads++; throw new Error('An oversized page must not descend into MIME evidence');
  } };
  assert.equal(inboundBatchSchema.safeParse({ generation: 'synthetic', fromCursor: null,
    nextCursor: 'synthetic-26', items: Array(26).fill(item) }).success, false);
  assert.equal(reads, 0);
});

test('technical document selections reject an oversized list before reading version evidence', () => {
  let reads = 0;
  const document = { get documentId(): never {
    reads++; throw new Error('An oversized selection must not descend into document evidence');
  } };
  assert.equal(technicalAssignmentSelection.safeParse({ kind: 'Project', userId: 'synthetic-tech',
    responsibility: 'supporto', actions: ['request_admin'], expiresAt: '2026-10-25T00:00:00Z',
    readableFields: ['title'], editableFields: [], documents: Array(21).fill(document) }).success, false);
  assert.equal(reads, 0);
});
