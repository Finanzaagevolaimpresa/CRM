import assert from 'node:assert/strict';
import test from 'node:test';
import { nextProgressAction, parseProgressTaskType, progressTaskType, selectProgressTask } from '../src/lib/customer-progress-policy';
import { contractSignatureDeclarationSchema } from '../src/lib/contract-signature-policy';
const practice = '00000000-0000-4000-8000-000000000001';
const input = { started: false, canReadContracts: true, canReadPayments: true, missing: [] as string[] };

test('next action follows prerequisite order, never database order', () => {
  const missing = ['completezza_materiali', 'accredito_iniziale', 'incarico_formalizzato'];
  assert.equal(nextProgressAction({ ...input, missing }).key, 'signature');
  assert.deepEqual(nextProgressAction({ ...input, missing }), nextProgressAction({ ...input, missing: [...missing].reverse() }));
  assert.equal(nextProgressAction({ ...input, missing: ['accredito_iniziale', 'completezza_materiali'] }).key, 'funding');
  assert.equal(nextProgressAction(input).key, 'start');
  assert.equal(nextProgressAction({ ...input, missing: ['new_unknown_guard'] }).key, 'verify');
});
test('financial denial yields the same generic operational blocker for contract and funding', () => {
  const common = { ...input, canReadContracts: false, canReadPayments: false };
  const signature = nextProgressAction({ ...common, missing: ['incarico_formalizzato'] });
  const funding = nextProgressAction({ ...common, missing: ['accredito_iniziale'] });
  assert.deepEqual(signature, funding);
  assert.equal(/contratt|firma|pagament|accredit|import/i.test(JSON.stringify(signature)), false);
  assert.equal(nextProgressAction({ ...input, canReadPayments: false, missing: ['accredito_iniziale'] }).key, 'administrative');
});
test('old delivered version never marks the new draft delivered', () => {
  const current = { ...input, started: true, dossier: { currentVersionId: 'v2', approvedVersionId: 'v1', deliveredVersionIds: ['v1'] } };
  assert.equal(nextProgressAction(current).key, 'review');
  assert.equal(nextProgressAction({ ...current, dossier: { ...current.dossier, approvedVersionId: 'v2' } }).key, 'delivery');
  assert.equal(nextProgressAction({ ...current, dossier: { ...current.dossier, approvedVersionId: 'v2', deliveredVersionIds: ['v1', 'v2'] } }).key, 'delivered');
});
test('only explicitly linked tasks supply owner/date; tie-break is deterministic', () => {
  const type = progressTaskType(practice, 'materials');
  const row = { id: 'z', type, status: 'aperta', priority: 'media', dueAt: null };
  const dated = { ...row, id: 'b', dueAt: new Date('2026-01-02Z') };
  const unrelated = { ...dated, id: 'unrelated', type: 'generale', dueAt: new Date('2026-01-01Z') };
  const closed = { ...dated, id: 'closed', status: 'completata' };
  assert.equal(selectProgressTask([unrelated, closed], type), null);
  assert.equal(selectProgressTask([row, unrelated, dated], type)?.id, 'b');
  assert.equal(selectProgressTask([dated, { ...dated, id: 'a' }], type)?.id, 'a');
});
test('task references use generic administrative labels and reject malformed identifiers', () => {
  assert.equal(progressTaskType(practice, 'signature'), progressTaskType(practice, 'funding'));
  assert.equal(progressTaskType('bad', 'start'), null);
  assert.equal(progressTaskType(practice, '__proto__'), null);
  assert.equal(parseProgressTaskType('percorso:' + practice + ':materials'), progressTaskType(practice, 'materials'));
  assert.equal(parseProgressTaskType('percorso:' + practice + ':invalid'), null);
});
test('signature declaration requires explicit confirmation, provenance and a real date', () => {
  const claim = { contractId: 'contract', expectedVersion: '2026-01-01T00:00:00.000Z', expectedDeclarationId: null, signedOn: '2026-01-02', source: 'Comunicazione sintetica del cliente', confirmed: true };
  assert.equal(contractSignatureDeclarationSchema.safeParse(claim).success, true);
  for (const invalid of [{ confirmed: false }, { confirmed: undefined }, { source: ' ' }, { signedOn: '2026-02-30' }, { notes: 'firmato' }])
    assert.equal(contractSignatureDeclarationSchema.safeParse({ ...claim, ...invalid }).success, false);
});
