import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingWithdrawalForm } from '../src/components/marketing-withdrawal-form';
import { addCalendarMonths, emailContactKey, eventSchema, PROPOSED_POLICY, retentionPlan, stripStoredFields } from '../src/lib/marketing-preferences/policy';
import { MarketingPreferences, type PreferenceTransaction } from '../src/lib/marketing-preferences/service';
import { createWithdrawalPost, marketingWithdrawalRuntime } from '../src/lib/marketing-preferences/withdrawal-http';
import { choice, EPOCH, id, MemoryPreferenceStore, readiness, SYNTHETIC_EMAIL, SYNTHETIC_KEY, SYNTHETIC_NOTICE } from './fixtures/r13-marketing-store';

function fixture() {
  const store = new MemoryPreferenceStore();
  let ready = readiness();
  const service = new MarketingPreferences(store, SYNTHETIC_KEY, async () => ({ ...ready, checkedAt: store.clock }));
  const grant = async (number = 1, at = store.clock, kind: 'GRANTED' | 'DENIED' = 'GRANTED') => {
    store.choices.set(id(number), choice(number, at, kind));
    return service.recordChoice(id(number), SYNTHETIC_NOTICE);
  };
  const state = () => store.rows.get(emailContactKey(SYNTHETIC_EMAIL, SYNTHETIC_KEY))!;
  return { store, service, grant, state, setReady: (patch: Partial<typeof ready>) => { ready = { ...ready, ...patch }; } };
}

test('R13 is dormant and the migration remains outside the automatic schema49 chain', async () => {
  assert.equal(marketingWithdrawalRuntime(), null);
  assert.equal((await createWithdrawalPost()(new Request('https://r13.invalid/'))).status, 503);
  assert.equal(PROPOSED_POLICY.approvalReference, null);
  assert.equal(readdirSync('prisma/migrations').filter(name => /^\d/u.test(name)).length, 49);
  const sql = readFileSync('prisma/proposals/r13-marketing-preferences/migration.sql', 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/u);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|ALTER TABLE|DELETE FROM) "(?:Lead|PrivacyEvidenceReceipt|PrivacyNoticeVersion)"/u);
  const f = fixture(); await f.grant(); f.setReady({ approvalReference: null });
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
});

test('calendar terms clamp leap days, preserve UTC time and expire at the exact boundary', async () => {
  assert.equal(addCalendarMonths('2024-02-29T23:59:59.123Z', 24), '2026-02-28T23:59:59.123Z');
  assert.equal(addCalendarMonths('2026-01-31T03:04:05.006Z', 1), '2026-02-28T03:04:05.006Z');
  const f = fixture(); await f.grant();
  f.store.clock = '2028-09-28T09:59:59.999Z';
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, true);
  f.store.clock = '2028-09-28T10:00:00.000Z';
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'CONSENT_EXPIRED');
});

test('missing consent, an explicit No and a public withdrawal all deny promotion', async () => {
  const f = fixture();
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).ticket, null);
  await f.grant(1, f.store.clock, 'DENIED');
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'DENIED');
  await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
  assert.equal(f.state().events[1].source, 'PUBLIC_REQUEST');
  assert.equal(f.state().events[1].operatorRef, null);
  assert.equal(f.state().events[1].outcome, 'PROMOTIONAL_BLOCKED');
});

test('withdrawal invalidates a queued selection before final handoff', async () => {
  const f = fixture(); await f.grant();
  const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
  f.store.clock = '2026-09-28T10:00:01.000Z';
  await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  let sent = 0;
  assert.equal((await f.service.atFinalHandoff(SYNTHETIC_EMAIL, ticket, async () => ++sent)).admitted, false);
  assert.equal(sent, 0);
  assert.equal(f.state().events[0].kind, 'GRANTED');
});

test('retry preserves the original request time, consent expiry and canonical notice bytes', async () => {
  const f = fixture(); await f.grant();
  const original = structuredClone(f.state().events[0]);
  f.store.clock = '2026-10-01T10:00:00.000Z';
  assert.equal(await f.service.recordChoice(id(1), SYNTHETIC_NOTICE), 'REPLAY');
  assert.deepEqual(f.state().events[0], original);
  assert.equal(original.canonicalNoticeText, SYNTHETIC_NOTICE);
  await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  f.store.clock = '2026-10-02T10:00:00.000Z';
  assert.equal(await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2)), 'REPLAY');
  assert.equal(f.state().events[1].occurredAt, '2026-10-01T10:00:00.000Z');
  assert.equal(f.state().revision, 2);
});

test('activity is not an accepted event and never renews consent', async () => {
  const f = fixture(); await f.grant();
  assert.equal(eventSchema.safeParse({ ...stripStoredFields(f.state().events[0]), kind: 'OPEN_CLICK_OR_PURCHASE' }).success, false);
  f.store.clock = '2028-09-28T10:00:00.000Z';
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).ticket, null);
});

test('a conflicting event identity commits quarantine instead of rolling it back', async () => {
  const f = fixture(); await f.grant();
  f.store.choices.set(id(1), choice(1, f.store.clock, 'DENIED'));
  assert.equal(await f.service.recordChoice(id(1), SYNTHETIC_NOTICE), 'CONFLICT');
  assert.equal(f.state().quarantined, true);
  assert.equal(f.state().events.length, 1);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'STATE_UNCERTAIN');
});

test('a new explicit grant may follow a withdrawal; an older delayed receipt cannot', async () => {
  const f = fixture(); await f.grant();
  f.store.clock = '2026-09-29T10:00:00.000Z'; await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  f.store.clock = '2026-10-01T10:00:00.000Z'; await f.grant(3, '2026-09-28T11:00:00.000Z');
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
  await f.grant(4);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, true);
});

test('negative wins a same-time race regardless of arrival order', async () => {
  for (const negativeFirst of [false, true]) {
    const f = fixture();
    const grant = () => f.grant();
    const block = () => f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
    await Promise.all(negativeFirst ? [block(), grant()] : [grant(), block()]);
    assert.equal(f.state().revision, 2);
    assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
  }
});

test('expiry or removal of a negative marker never authorizes an old grant', async () => {
  const f = fixture(); await f.grant();
  f.store.clock = '2026-09-29T10:00:00.000Z'; await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  f.store.clock = '2028-09-29T10:00:00.000Z';
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
  const state = f.state();
  f.store.rows.set(state.contactKey, { ...state, events: state.events.slice(0, 1) });
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'LEDGER_INCOMPLETE');
});

test('unreconciled, restored, wrong-key and unavailable states deny', async () => {
  const f = fixture(); await f.grant();
  f.setReady({ reconciled: false }); assert.equal((await f.service.select(SYNTHETIC_EMAIL)).ticket, null);
  f.setReady({ reconciled: true }); f.store.epoch = id(99);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'STATE_UNCERTAIN');
  f.store.epoch = EPOCH; f.setReady({ keyFingerprint: '0'.repeat(64) });
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'RUNTIME_UNQUALIFIED');
  f.setReady(readiness()); f.store.failRead = true;
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'STATE_UNAVAILABLE');
});

test('future source time is quarantined, not used as a later expiry anchor', async () => {
  const f = fixture();
  assert.equal(await f.grant(1, '2027-09-28T10:00:00.000Z'), 'CONFLICT');
  assert.equal(f.state().events.length, 0);
  assert.equal(f.state().quarantined, true);
});

test('a valid N04 receipt still needs an exact notice qualified for email marketing', async () => {
  const f = fixture(); await f.grant();
  f.setReady({ approvedEmailNotices: [{ noticeVersionId: id(901), contentHash: f.state().events[0].noticeHash! }] });
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'EMAIL_NOTICE_UNQUALIFIED');
  f.setReady({ approvedEmailNotices: [] });
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).ticket, null);
});

test('a stale reconciliation attestation cannot authorize a fresh selection', async () => {
  const f = fixture(); await f.grant();
  const frozen = new MarketingPreferences(f.store, SYNTHETIC_KEY, async () => readiness());
  f.store.clock = '2026-09-28T10:01:00.000Z';
  assert.equal((await frozen.select(SYNTHETIC_EMAIL)).ticket, null);
});

test('final handoff rechecks purpose, policy window, age, revision and expiry', async () => {
  for (const failure of ['purpose', 'approval', 'window', 'age', 'epoch']) {
    const f = fixture(); await f.grant();
    const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
    if (failure === 'purpose') f.setReady({ purposeOpen: false });
    if (failure === 'approval') f.setReady({ approvalReference: null });
    if (failure === 'window') f.setReady({ effectiveUntil: f.store.clock });
    if (failure === 'age') f.store.clock = '2026-09-28T10:01:00.000Z';
    if (failure === 'epoch') f.store.epoch = null;
    let invoked = false;
    assert.equal((await f.service.atFinalHandoff(SYNTHETIC_EMAIL, ticket, async () => { invoked = true; })).admitted, false);
    assert.equal(invoked, false);
  }
});

test('final handoff and withdrawal share the lock; an ambiguous handoff is never retried', async () => {
  const f = fixture(); await f.grant();
  const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
  const order: string[] = [];
  const sent = f.service.atFinalHandoff(SYNTHETIC_EMAIL, ticket, async () => { order.push('handoff'); return 'synthetic-only'; });
  const withdrawn = f.service.suppressPublic(SYNTHETIC_EMAIL, id(2)).then(() => order.push('block-committed'));
  assert.equal((await sent).admitted, true); await withdrawn;
  assert.deepEqual(order, ['handoff', 'block-committed']);
  const next = fixture(); await next.grant();
  const selected = await next.service.select(SYNTHETIC_EMAIL); assert.ok(selected.ticket);
  let attempts = 0;
  await assert.rejects(next.service.atFinalHandoff(SYNTHETIC_EMAIL, selected.ticket, async () => { attempts++; throw new Error('synthetic transport failure'); }), /OUTCOME_UNCERTAIN_DO_NOT_RETRY/u);
  assert.equal(attempts, 1);
});

test('a consent-capable store without a handoff coordinator cannot invoke a sender or fall back to its transaction', async () => {
  const f = fixture(); await f.grant();
  const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
  let transactionCalls = 0, admissionCalls = 0, callbacks = 0;
  const boundedStore = {
    verifiedChoice: f.store.verifiedChoice.bind(f.store),
    withContact: async <T,>(key: string, operation: (tx: PreferenceTransaction) => Promise<T>) => {
      transactionCalls++;
      return f.store.withContact(key, operation);
    },
  };
  const bounded = new MarketingPreferences(boundedStore, SYNTHETIC_KEY, async () => {
    admissionCalls++; return { ...readiness(), checkedAt: f.store.clock };
  });
  assert.deepEqual(await bounded.atFinalHandoff(SYNTHETIC_EMAIL, ticket, async () => ++callbacks),
    { admitted: false, reason: 'HANDOFF_SERIALIZATION_UNAVAILABLE' });
  assert.deepEqual({ transactionCalls, admissionCalls, callbacks }, { transactionCalls: 0, admissionCalls: 0, callbacks: 0 });
  assert.equal(await bounded.suppressPublic(SYNTHETIC_EMAIL, id(2)), 'RECORDED');
  assert.equal((await bounded.select(SYNTHETIC_EMAIL)).decision.eligible, false);
});

test('the synthetic non-expiring coordinator keeps a concurrent suppression pending until the callback actually settles', async () => {
  const f = fixture(); await f.grant();
  const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let effects = 0, suppressed = false;
  const final = f.service.atFinalHandoff(SYNTHETIC_EMAIL, ticket, async () => {
    enter(); await pending; effects++; return 'synthetic-only';
  });
  await entered;
  const withdrawal = f.service.suppressPublic(SYNTHETIC_EMAIL, id(2)).then(result => { suppressed = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(effects, 0); assert.equal(suppressed, false);
  } finally { release(); }
  assert.deepEqual(await final, { admitted: true, value: 'synthetic-only' });
  assert.equal(await withdrawal, 'RECORDED'); assert.equal(effects, 1);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
});

test('a selection for one recipient cannot be reused for a different recipient', async () => {
  const f = fixture(); await f.grant();
  const { ticket } = await f.service.select(SYNTHETIC_EMAIL); assert.ok(ticket);
  let invoked = false;
  const result = await f.service.atFinalHandoff('different@r13.invalid', ticket, async () => { invoked = true; });
  assert.deepEqual(result, { admitted: false, reason: 'RECIPIENT_MISMATCH' });
  assert.equal(invoked, false);
});

test('closing a purpose cannot be undone by later consent', async () => {
  const f = fixture(); await f.grant();
  await f.service.recordOperatorBlock({ email: SYNTHETIC_EMAIL, eventId: id(2), kind: 'PURPOSE_CLOSED', operatorRef: 'synthetic-admin' });
  f.store.clock = '2026-10-01T10:00:00.000Z'; await f.grant(3);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.reason, 'PURPOSE_CLOSED');
});

test('retention uses cycle end, scoped holds and original deadlines after hold release', async () => {
  const f = fixture(); await f.grant();
  f.store.clock = '2026-09-29T10:00:00.000Z'; await f.service.suppressPublic(SYNTHETIC_EMAIL, id(2));
  const events = f.state().events.map(stripStoredFields);
  const hold = { eventIds: [id(1)], caseReference: 'synthetic-case', reason: 'synthetic dispute', responsibleRole: 'direzione',
    reviewAt: '2028-01-01T00:00:00.000Z', releaseCondition: 'synthetic resolution', releasedAt: null };
  const held = retentionPlan(events, [hold], '2029-01-01T00:00:00.000Z');
  assert.equal(held[0].ordinaryEligibleAt, '2028-09-29T10:00:00.000Z');
  assert.equal(held[0].disposition, 'HOLD_REVIEW_DUE');
  assert.equal(held[1].disposition, 'ELIGIBLE_FOR_CONTROLLED_REVIEW');
  const released = retentionPlan(events, [{ ...hold, releasedAt: '2028-12-01T00:00:00.000Z' }], '2029-01-01T00:00:00.000Z');
  assert.equal(released[0].ordinaryEligibleAt, held[0].ordinaryEligibleAt);
  assert.equal(released[0].disposition, 'ELIGIBLE_FOR_CONTROLLED_REVIEW');
  assert.equal(released[0].executable, false);
  assert.throws(() => retentionPlan(events, [{ ...hold, reason: '' }], '2029-01-01T00:00:00.000Z'), /HOLD_INVALID/u);
  assert.equal((await f.service.select(SYNTHETIC_EMAIL)).decision.eligible, false);
});

function request(email = SYNTHETIC_EMAIL, requestId = id(20), extra: Record<string, unknown> = {}) {
  return new Request('https://r13.invalid/api/preferenze-email', { method: 'POST',
    headers: { origin: 'https://r13.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ email, requestId, ...extra }) });
}
function postFor(f: ReturnType<typeof fixture>) {
  return createWithdrawalPost({ service: f.service, publicOrigin: 'https://r13.invalid', admitRequest: async () => true });
}

test('HTTP confirmation waits for commit; a failed commit returns 503 and saves nothing', async () => {
  const f = fixture(); f.store.failCommit = true;
  assert.equal((await postFor(f)(request())).status, 503);
  assert.equal(f.store.rows.size, 0);
  f.store.failCommit = false;
  let release!: () => void;
  let reached!: () => void;
  const reachedCommit = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.store.beforeCommit = async () => { reached(); await barrier; };
  let confirmed = false;
  const response = postFor(f)(request()).then(result => { confirmed = true; return result; });
  await reachedCommit; assert.equal(confirmed, false); assert.equal(f.store.rows.size, 0);
  release(); assert.equal((await response).status, 200); assert.equal(f.state().events.length, 1);
});

test('public responses cannot enumerate contacts or reveal personal data', async () => {
  const f = fixture(); await f.grant();
  const known = await postFor(f)(request());
  const unknown = await postFor(f)(request('unknown@r13.invalid'));
  const replay = await postFor(f)(request());
  assert.equal(known.status, 200); assert.equal(unknown.status, 200); assert.equal(replay.status, 200);
  const text = await known.text(); assert.equal(await unknown.text(), text); assert.equal(await replay.text(), text);
  assert.equal(known.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(text, /@r13\.invalid/u);
  assert.doesNotMatch(JSON.stringify([...f.store.rows.values()]), /recipient@|unknown@/u);
});

test('HTTP rejects extra consent fields, foreign origins, oversized bodies and limiter failure', async () => {
  const f = fixture(); const post = postFor(f);
  assert.equal((await post(request(SYNTHETIC_EMAIL, id(20), { decision: 'GRANTED' }))).status, 400);
  const foreign = request(); foreign.headers.set('origin', 'https://elsewhere.invalid');
  assert.equal((await post(foreign)).status, 403);
  const huge = request(SYNTHETIC_EMAIL, id(20), { padding: 'x'.repeat(1024) });
  assert.equal((await post(huge)).status, 400);
  const limited = createWithdrawalPost({ service: f.service, publicOrigin: 'https://r13.invalid', admitRequest: async () => false });
  assert.equal((await limited(request())).status, 429);
  const unavailable = createWithdrawalPost({ service: f.service, publicOrigin: 'https://r13.invalid', admitRequest: async () => { throw new Error('down'); } });
  assert.equal((await unavailable(request())).status, 503);
  assert.equal(f.store.rows.size, 0);
});

test('public screen asks only for email and exposes an accessible withdrawal button', () => {
  const html = renderToStaticMarkup(createElement(MarketingWithdrawalForm, { endpoint: '/api/preferenze-email', requestId: id(30) }));
  assert.match(html, /Preferenze email/u); assert.match(html, /Non inviarmi più email promozionali/u);
  assert.equal((html.match(/type="email"/gu) ?? []).length, 1);
  assert.match(html, new RegExp(`type="hidden" name="requestId" value="${id(30)}"`, 'u'));
  assert.match(html, /type="email"/u); assert.match(html, /role="status"/u);
  assert.match(html, /method="post"/u);
  assert.doesNotMatch(html, /type="(?:password|checkbox)"/u);
  assert.throws(() => renderToStaticMarkup(createElement(MarketingWithdrawalForm, { endpoint: 'https://elsewhere.invalid/', requestId: id(30) })), /SAME_SITE/u);
  assert.throws(() => renderToStaticMarkup(createElement(MarketingWithdrawalForm, { endpoint: '/api/preferenze-email', requestId: '' })), /SERVER_REQUEST_ID/u);
});

function nativeFormRequest(email = SYNTHETIC_EMAIL) {
  const html = renderToStaticMarkup(createElement(MarketingWithdrawalForm, { endpoint: '/api/preferenze-email', requestId: id(30) }));
  const action = /<form[^>]*action="([^"]+)"/u.exec(html)?.[1];
  const requestId = /name="requestId" value="([^"]+)"/u.exec(html)?.[1];
  assert.ok(action); assert.ok(requestId);
  return new Request(new URL(action, 'https://r13.invalid'), { method: 'POST',
    headers: { origin: 'https://r13.invalid', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, requestId }).toString() });
}

test('native HTML form reaches persistent suppression and returns HTML only after commit, with safe replay', async () => {
  const f = fixture(); let release!: () => void; let reached!: () => void;
  const committed = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.store.beforeCommit = async () => { reached(); await barrier; };
  let responded = false;
  const result = postFor(f)(nativeFormRequest()).then(response => { responded = true; return response; });
  await committed; assert.equal(responded, false); assert.equal(f.store.rows.size, 0);
  release(); const response = await result;
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /^text\/html/u);
  assert.equal(f.state().events[0].eventId, id(30)); assert.equal(f.state().events[0].kind, 'SUPPRESSED');
  const body = await response.text(); assert.match(body, /Richiesta registrata/u); assert.doesNotMatch(body, /recipient@/u);
  f.store.beforeCommit = null; f.store.clock = '2026-10-01T10:00:00.000Z';
  assert.equal((await postFor(f)(nativeFormRequest())).status, 200);
  assert.equal(f.state().revision, 1); assert.equal(f.state().events[0].occurredAt, '2026-09-28T10:00:00.000Z');
});

test('native HTML failure, unknown address and malformed fields never produce a false confirmation', async () => {
  const f = fixture(); f.store.failCommit = true;
  const failed = await postFor(f)(nativeFormRequest());
  assert.equal(failed.status, 503); assert.match(failed.headers.get('content-type')!, /^text\/html/u);
  assert.doesNotMatch(await failed.text(), /Richiesta registrata/u); assert.equal(f.store.rows.size, 0);
  f.store.failCommit = false;
  const known = await postFor(f)(nativeFormRequest());
  const unknown = await postFor(f)(nativeFormRequest('unknown@r13.invalid'));
  assert.equal(await known.text(), await unknown.text());
  for (const body of [new URLSearchParams({ email: SYNTHETIC_EMAIL }).toString(),
    `email=${SYNTHETIC_EMAIL}&email=second@r13.invalid&requestId=${id(31)}`]) {
    const malformed = new Request('https://r13.invalid/api/preferenze-email', { method: 'POST',
      headers: { origin: 'https://r13.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal((await postFor(f)(malformed)).status, 400);
  }
});
