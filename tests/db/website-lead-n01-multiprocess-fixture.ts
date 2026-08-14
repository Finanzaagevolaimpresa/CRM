import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/integrations/website/leads/route';
import { prisma } from '../../src/lib/prisma';

const [scenario, worker, rawCount] = process.argv.slice(2);
const count = Number(rawCount);
if (!['same-key', 'same-identity', 'different-identities'].includes(scenario) || !/^\d+$/.test(worker ?? '') || !Number.isInteger(count) || count < 1 || count > 50) process.exit(2);
process.env.WEBSITE_LEAD_MODE = 'legacy';
process.env.WEBSITE_LEAD_WEBHOOK_SECRET = 'n01-ci-synthetic-secret';
process.env.WEBSITE_LEAD_RATE_LIMIT_REQUESTS = '1000';
process.env.WEBSITE_LEAD_RATE_LIMIT_WINDOW_SECONDS = '60';
function input(index: number) {
  const ordinal = Number(worker) * count + index;
  const key = scenario === 'same-key' ? 'multiprocess-common-key' : `multiprocess-key-${ordinal}`;
  const email = scenario === 'different-identities' ? `multiprocess-${ordinal}@n01-ci.invalid` : 'multiprocess-common@n01-ci.invalid';
  return new NextRequest('http://localhost/api/integrations/website/leads', {
    method:'POST', headers:{ 'content-type':'application/json', 'x-fai-webhook-secret':'n01-ci-synthetic-secret', 'idempotency-key':key },
    body:JSON.stringify({ firstName:'Synthetic', lastName:'Multiprocess', email, privacyAccepted:true }),
  });
}
try {
  const responses = await Promise.all(Array.from({ length:count }, (_, index) => POST(input(index))));
  const statuses = new Map<number, number>(); for (const response of responses) statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  process.stdout.write(JSON.stringify(Object.fromEntries(statuses)));
} finally { await prisma.$disconnect(); }
