import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { canonicalJson } from '../src/lib/canonical-json';
import type { TechnicalPrivateItemOrigin } from '../src/lib/technical-private-item-contract';
import { signTechnicalPrivateItemOrigin, readTechnicalPrivateItemOriginProof } from '../src/lib/technical-private-item-proof';
import { filterOrdinaryTechnicalWorkItems, readTechnicalPrivateItemOrigin } from '../src/lib/technical-private-item-storage';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
const key = { version: 4, secret: 'synthetic-private-item-origin-key-material' };
const ref = { kind: 'Task' as const, itemId: '3af4ac86-074f-4c26-acb4-177e35c13e68' };
const origin: TechnicalPrivateItemOrigin = { protocol: 'TECHNICAL_PRIVATE_ITEM_ORIGIN_V1',
  commandId: '8908dbb5-d8ce-4d09-8de5-44472b37556e', ...ref,
  target: { kind: 'TechnicalPractice', targetId: 'synthetic-practice-a' }, clientId: 'synthetic-client',
  projectId: 'synthetic-project', serviceId: null, companyId: null, actorId: 'synthetic-admin',
  createdAt: '2026-10-26T16:00:00.000Z' };
const originProof = signTechnicalPrivateItemOrigin(key, origin);
function response(value: unknown): Db { return { $queryRaw: async () => value } as unknown as Db; }

test('a retained origin is bound to its exact item, target and cryptographic domain', () => {
  assert.deepEqual(readTechnicalPrivateItemOriginProof(key, origin, originProof, ref), origin);
  for (const changed of [{ ...origin, target: { ...origin.target, targetId: 'synthetic-practice-b' } },
    { ...origin, clientId: 'other-client' }, { ...origin, commandId: '8c76ea27-a215-4412-844b-cc57eb3d4684' },
    { ...origin, recipientId: 'implicit-recipient' }]) {
    assert.equal(readTechnicalPrivateItemOriginProof(key, changed, originProof, ref), null);
  }
  assert.equal(readTechnicalPrivateItemOriginProof(key, origin, originProof, { ...ref, kind: 'ChecklistItem' }), null);
  assert.equal(readTechnicalPrivateItemOriginProof({ ...key, version: 5 }, origin, originProof, ref), null);
  assert.equal(readTechnicalPrivateItemOriginProof({ ...key, secret: 'synthetic-other-key-material-123456' }, origin, originProof, ref), null);
});

test('successful absence is distinct from unavailable, corrupt or ambiguous origin storage', async () => {
  assert.equal(await readTechnicalPrivateItemOrigin(response([]), key, ref), null);
  const saved = { ...ref, origin, originProof };
  assert.deepEqual(await readTechnicalPrivateItemOrigin(response([saved]), key, ref), origin);
  for (const rows of [null, undefined, {}, [saved, saved], [{ ...saved, itemId: 'other' }],
    [{ ...saved, originProof: 'a'.repeat(64) }], [{ ...saved, origin: { ...origin, companyId: 'other' } }]]) {
    await assert.rejects(readTechnicalPrivateItemOrigin(response(rows), key, ref));
  }
  const failure = new Error('synthetic-storage-unavailable');
  const db = { $queryRaw: async () => { throw failure; } } as unknown as Db;
  await assert.rejects(readTechnicalPrivateItemOrigin(db, key, ref), error => error === failure);
});

test('an origin committed after session loading is excluded by the subsequent resource lookup', async () => {
  const rows = [{ id: ref.itemId, title: 'Private task' }, { id: 'historical-task', title: 'Existing task' }];
  let created = false, calls = 0;
  const db = { $queryRaw: async () => { calls++; return created ? [ref] : []; } } as unknown as Db;
  assert.deepEqual(await filterOrdinaryTechnicalWorkItems(db, 'Task', rows), rows);
  created = true;
  assert.deepEqual(await filterOrdinaryTechnicalWorkItems(db, 'Task', rows), [rows[1]]);
  assert.equal(calls, 2); // No cache from the earlier request or session.
});

test('ordinary exclusion is independent of recipient, role, proof validity or later assignment revocation', async () => {
  // Only existence is read here: parsing an invalid proof must never turn a
  // private row into a legacy public/owner-based resource.
  const rows = [{ id: ref.itemId, title: 'Private content' }];
  for (const lifecycle of ['unassigned', 'assigned', 'expired', 'revoked', 'origin-proof-invalid']) {
    assert.deepEqual(await filterOrdinaryTechnicalWorkItems(response([ref]), 'Task', rows), [], lifecycle);
  }
});

test('batching preserves original ordering, kind and duplicates while never returning a partial result', async () => {
  const items = Array.from({ length: 520 }, (_, i) => ({ id: `synthetic-${String(i).padStart(4, '0')}` })).reverse();
  const seen: string[][] = [];
  const db = { $queryRaw: async (query: Prisma.Sql) => {
    assert.equal(query.values[0], 'ChecklistItem');
    const ids = query.values.slice(1) as string[]; seen.push(ids);
    assert.ok(ids.length <= 256);
    return ids.filter(id => Number(id.slice(-4)) % 2 === 0).map(itemId => ({ kind: 'ChecklistItem', itemId }));
  } } as unknown as Db;
  const duplicated = [...items, items[0]];
  assert.deepEqual(await filterOrdinaryTechnicalWorkItems(db, 'ChecklistItem', duplicated),
    duplicated.filter(item => Number(item.id.slice(-4)) % 2 === 1));
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.flat()).size, 520);
  let count = 0;
  const broken = { $queryRaw: async () => { if (++count === 2) throw new Error('synthetic-second-batch-failure'); return []; } } as unknown as Db;
  await assert.rejects(filterOrdinaryTechnicalWorkItems(broken, 'ChecklistItem', items), /second-batch-failure/);
});

test('malformed input or unexpected database rows cannot be treated as an empty exclusion set', async () => {
  const items = [{ id: ref.itemId }];
  for (const rows of [null, [{ ...ref, kind: 'ChecklistItem' }], [{ ...ref, itemId: 'unexpected' }],
    [ref, ref], [{ ...ref, unexpected: true }]]) {
    await assert.rejects(filterOrdinaryTechnicalWorkItems(response(rows), 'Task', items));
  }
  const never = { $queryRaw: async () => { assert.fail('No query expected'); } } as unknown as Db;
  assert.deepEqual(await filterOrdinaryTechnicalWorkItems(never, 'Task', []), []);
  await assert.rejects(filterOrdinaryTechnicalWorkItems(never, 'Task', [{ id: '' }]));
  await assert.rejects(filterOrdinaryTechnicalWorkItems(never, 'Task', [{ id: "x' OR 1=1" }]));
  assert.equal(canonicalJson(items), canonicalJson([{ id: ref.itemId }]));
});
