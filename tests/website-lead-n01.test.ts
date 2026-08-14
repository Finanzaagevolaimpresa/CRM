import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/integrations/website/leads/route';
import { authenticateWebsiteLead, MAX_WEBSITE_LEAD_BYTES, readBoundedBody, runWebsiteLeadTransactionWithRetry, WebsiteLeadBodyError, WebsiteLeadDeadline, WebsiteLeadDeadlineError, websiteLeadMode } from '../src/lib/website-lead-security';

test('N01 defaults every unknown mode, including v2, to disabled', () => {
  for (const value of [undefined, '', 'invalid', 'v2']) assert.equal(websiteLeadMode(value), 'disabled');
  assert.equal(websiteLeadMode('legacy'), 'legacy'); assert.equal(websiteLeadMode('shadow'), 'shadow');
});
test('N01 constant-time authentication has uniform invalid inputs', () => {
  assert.equal(authenticateWebsiteLead('correct', 'correct'), true);
  for (const pair of [[undefined,null],['correct',null],['correct','wrong'],['x'.repeat(513),'x'.repeat(513)] ] as const) assert.equal(authenticateWebsiteLead(pair[0], pair[1]), false);
  assert.match(readFileSync('src/lib/website-lead-security.ts','utf8'), /timingSafeEqual\(expected, supplied\)/);
});
test('bounded stream accepts exactly 16 KiB and rejects one byte over', async () => {
  const exact = new Request('http://local', { method:'POST', body:'a'.repeat(MAX_WEBSITE_LEAD_BYTES), duplex:'half' } as RequestInit);
  assert.equal((await readBoundedBody(exact, new AbortController().signal)).length, MAX_WEBSITE_LEAD_BYTES);
  const over = new Request('http://local', { method:'POST', body:'a'.repeat(MAX_WEBSITE_LEAD_BYTES + 1), duplex:'half' } as RequestInit);
  await assert.rejects(() => readBoundedBody(over, new AbortController().signal), (e: unknown) => e instanceof WebsiteLeadBodyError && e.status === 413);
});
test('bounded stream rejects malformed length and invalid UTF-8', async () => {
  for (const length of ['-1','oops','16385']) {
    const req = new Request('http://local', { method:'POST', headers:{'content-length':length}, body:'x', duplex:'half' } as RequestInit);
    await assert.rejects(() => readBoundedBody(req, new AbortController().signal), WebsiteLeadBodyError);
  }
  const invalid = new Request('http://local', { method:'POST', body:new Uint8Array([0xc3,0x28]), duplex:'half' } as RequestInit);
  await assert.rejects(() => readBoundedBody(invalid, new AbortController().signal), WebsiteLeadBodyError);
});
test('bounded stream cancels a slow client when the overall signal expires', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  });
  const request = new Request('http://local', { method: 'POST', body, duplex: 'half' } as RequestInit);
  const controller = new AbortController();
  const pending = readBoundedBody(request, controller.signal);
  controller.abort();
  await assert.rejects(pending, WebsiteLeadDeadlineError);
  assert.equal(cancelled, true);
});
test('the route interrupts a genuinely slow shadow body at the shared five-second deadline', async () => {
  const previous = { mode: process.env.WEBSITE_LEAD_MODE, secret: process.env.WEBSITE_LEAD_WEBHOOK_SECRET };
  process.env.WEBSITE_LEAD_MODE = 'shadow'; process.env.WEBSITE_LEAD_WEBHOOK_SECRET = 'synthetic-unit-secret';
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const request = new NextRequest('http://local/api/integrations/website/leads', { method:'POST', headers:{ 'content-type':'application/json', 'x-fai-webhook-secret':'synthetic-unit-secret' }, body, duplex:'half' } as unknown as ConstructorParameters<typeof NextRequest>[1]);
  const started = Date.now();
  try {
    const result = await POST(request);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 503); assert.equal(cancelled, true);
    assert.ok(elapsed >= 4_700 && elapsed < 6_000, `bounded elapsed milliseconds: ${elapsed}`);
  } finally {
    if (previous.mode === undefined) delete process.env.WEBSITE_LEAD_MODE; else process.env.WEBSITE_LEAD_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.WEBSITE_LEAD_WEBHOOK_SECRET; else process.env.WEBSITE_LEAD_WEBHOOK_SECRET = previous.secret;
  }
});
test('retry policy is dynamic, bounded to three, and shares one deadline', async () => {
  for (const error of [{ code:'P2034' }, { meta:{ code:'40001' } }, { meta:{ code:'40P01' } }]) {
    let attempts = 0; const deadline = new WebsiteLeadDeadline(0, () => 0);
    const result = await runWebsiteLeadTransactionWithRetry(deadline, async () => { attempts++; if (attempts === 1) throw error; return 'ok'; }, { sleep: async () => {}, jitter: () => 0 });
    assert.equal(result, 'ok'); assert.equal(attempts, 2);
  }
  let semanticAttempts = 0;
  await assert.rejects(() => runWebsiteLeadTransactionWithRetry(new WebsiteLeadDeadline(0, () => 0), async () => { semanticAttempts++; throw { code:'P2002' }; }, { sleep: async () => {}, jitter: () => 0 }));
  assert.equal(semanticAttempts, 1);
  let boundedAttempts = 0;
  await assert.rejects(() => runWebsiteLeadTransactionWithRetry(new WebsiteLeadDeadline(0, () => 0), async () => { boundedAttempts++; throw { code:'P2034' }; }, { sleep: async () => {}, jitter: () => 0 }));
  assert.equal(boundedAttempts, 3);
  let now = 0; let expiredAttempts = 0;
  await assert.rejects(() => runWebsiteLeadTransactionWithRetry(new WebsiteLeadDeadline(0, () => now), async () => { expiredAttempts++; now = 5_000; throw { code:'P2034' }; }, { sleep: async () => {}, jitter: () => 0 }), WebsiteLeadDeadlineError);
  assert.equal(expiredAttempts, 1);
});
test('migration 32 is additive and route contains containment invariants', () => {
  assert.equal(readdirSync('prisma/migrations').length, 32);
  const sql=readFileSync('prisma/migrations/20260813120000_website_lead_containment_atomicity_v1/migration.sql','utf8');
  assert.doesNotMatch(sql,/\b(?:DROP|ALTER|DELETE|UPDATE)\b/i); assert.match(sql,/WebsiteLeadReceipt/); assert.match(sql,/WebsiteLeadRateLimitBucket/);
  const route=readFileSync('src/app/api/integrations/website/leads/route.ts','utf8');
  assert.match(route,/mode === 'disabled'/); assert.match(route,/mode === 'shadow'/); assert.match(route,/Serializable/); assert.doesNotMatch(route,/request\.text\(/);
  const helper=readFileSync('src/lib/website-lead-security.ts','utf8');
  assert.match(helper, /attempt < 3/); assert.match(helper, /candidate\.code === 'P2034'/);
  assert.match(helper, /candidate\.meta\?\.code === '40001'/); assert.match(helper, /candidate\.meta\?\.code === '40P01'/);
  assert.doesNotMatch(helper, /P2002/);
  const dbTest=readFileSync('tests/db/website-lead-n01-db.test.ts','utf8');
  assert.match(dbTest, /\(COUNT\(DISTINCT tablename\) FILTER \(WHERE/);
  assert.match(dbTest, /\(COUNT\(DISTINCT indexname\) FILTER \(WHERE/);
});
